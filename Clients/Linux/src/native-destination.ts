import type { Destination } from "./controller.ts";
import { dirname, join } from "node:path";
import { typingChunks, type TextInsertionMethod } from "./text-insertion.ts";

const preview = (reason?: string): Destination => ({
  reason,
  deliver: async () => "preview",
  close() {},
});

/** Overlapping takes share a helper only while its retained field is unchanged. */
export class NativeDestinations {
  private sessions = new Map<string, NativeSession>();
  private capturing: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private warmed = new Map<string, number>();

  /** Start the accessibility registry before a take, without reading fields. */
  warm(helper: string, target?: string): void {
    const key = target ?? "all";
    if (Date.now() - (this.warmed.get(key) ?? 0) < 3000) return;
    if (this.warmed.size >= 64) this.warmed.clear();
    this.warmed.set(key, Date.now());
    try {
      const child = Bun.spawn(target ? [helper, "--warm", target] : [helper, "--warm"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      void child.exited.finally(() => clearTimeout(timer));
    } catch {
      /* Capture will report an unavailable helper. */
    }
  }

  capture(
    helper: string,
    target: string,
    method: TextInsertionMethod = "automatic",
  ): Promise<Destination> {
    const revision = this.revision;
    const capture = this.capturing.then(async () => {
      if (revision !== this.revision) return preview();
      let session = this.sessions.get(target);
      // Reserve a reference while joining so an in-flight delivery cannot close it.
      let destination = session?.destination(method);
      if (session && !(await session.join())) {
        destination?.close();
        this.sessions.delete(target);
        session = undefined;
        destination = undefined;
      }
      if (!session) {
        session = new NativeSession(helper, target, () => {
          if (this.sessions.get(target) === session) this.sessions.delete(target);
        });
        if (!(await session.ready())) {
          session.close();
          return preview(session.reason);
        }
      }
      if (revision !== this.revision) {
        destination?.close();
        session.close();
        return preview();
      }
      this.sessions.set(target, session);
      return destination ?? session.destination(method);
    });
    this.capturing = capture.catch(() => {});
    return capture.catch(() => preview());
  }

  invalidate(): void {
    this.revision++;
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

class NativeSession {
  private child;
  private input;
  private reader;
  private decoder = new TextDecoder();
  private buffer = "";
  private closed = false;
  private references = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private web = false;
  private chromium = false;
  private keyboard?: Bun.Subprocess<"pipe", "ignore", "ignore">;
  private typingSupported?: boolean;
  reason?: string;

  constructor(
    private helper: string,
    target: string,
    private onClose: () => void,
  ) {
    this.child = Bun.spawn([helper, target, "queue"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    this.input = this.child.stdin;
    this.reader = this.child.stdout.getReader();
    void this.child.exited.then(() => this.close());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.keyboard?.kill("SIGKILL");
    this.child.kill("SIGKILL");
    this.onClose();
  }

  private async line(timeout: number): Promise<string> {
    const timer = setTimeout(() => this.close(), timeout);
    try {
      while (!this.buffer.includes("\n")) {
        const next = await this.reader.read();
        if (next.done) throw new Error("Destination helper stopped.");
        this.buffer += this.decoder.decode(next.value, { stream: true });
        if (this.buffer.length > 100) throw new Error("Invalid destination helper response.");
      }
      const at = this.buffer.indexOf("\n");
      const value = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      return value;
    } finally {
      clearTimeout(timer);
    }
  }

  private transaction<T>(run: () => Promise<T>): Promise<T> {
    const pending = this.pending.then(run);
    this.pending = pending.catch(() => {});
    return pending;
  }

  private async command(
    value: boolean | { text: string; method: TextInsertionMethod } | { type: string },
  ): Promise<string> {
    if (this.closed) return "preview";
    this.input.write(JSON.stringify(value) + "\n");
    await this.input.flush();
    const result = await this.line(2000);
    if (result.startsWith("preview:")) {
      this.reason =
        result === "preview:changed"
          ? "The original field, text or caret changed. Your dictation is saved in History."
          : "This app did not expose a readable, focused text field. Your dictation is saved in History.";
      return "preview";
    }
    return result;
  }

  /** An empty probe checks compositor support without sending keys. Payloads
   * use stdin, keeping transcripts out of process arguments and shell parsing. */
  private async type(text: string): Promise<boolean> {
    const helper = join(dirname(this.helper), "dictaduo-type");
    if (this.closed || !process.env.WAYLAND_DISPLAY || !(await Bun.file(helper).exists()))
      return false;
    const child = Bun.spawn(text ? [helper] : [helper, "--probe"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, LC_ALL: "C.UTF-8" },
    });
    this.keyboard = child;
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    try {
      child.stdin.write(text);
      await child.stdin.end();
      return (await child.exited) === 0 && !this.closed;
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (this.keyboard === child) this.keyboard = undefined;
    }
  }

  private async canType(): Promise<boolean> {
    if (this.closed) return false;
    const supported = this.typingSupported === true || (await this.type(""));
    if (supported && !this.closed) {
      this.typingSupported = true;
      this.reason = undefined;
    }
    if (!supported)
      this.reason =
        "Type text needs a supported Wayland virtual keyboard. Choose Automatic or copy from History.";
    return supported;
  }

  private async insert(
    text: string,
    method: TextInsertionMethod,
    held: () => boolean,
  ): Promise<string> {
    if (this.closed) return "preview";
    if (held()) return "held";
    const chunks = typingChunks(text);
    // Browser accessibility often advertises EditableText without implementing
    // its writes. Prefer verified keyboard input when the compositor supports it.
    const typing =
      method === "unicodeTyping" || (this.web && chunks !== undefined && (await this.canType()));
    if (!typing) {
      if (held()) return "held";
      this.reason = undefined;
      const result = await this.command({ text, method: "automatic" });
      if (result !== "typing") return result;
    }
    // "typing" means no accessible write was attempted. Every other failure is
    // terminal; dispatch success alone never proves that text reached the field.
    if (!chunks) {
      this.reason =
        "Type text cannot safely enter line breaks, tabs or control characters. Choose Automatic or copy from History.";
      return "preview";
    }
    // Chromium 153 failed readback for supplementary symbols on Wayland.
    // Refuse before the first packet rather than corrupting an emoji mid-take.
    if (this.chromium && /[\u{10000}-\u{10ffff}]/u.test(text)) {
      this.reason =
        "Chromium cannot safely receive emoji through Wayland keyboard input. Copy this dictation from History.";
      return "preview";
    }
    if (!(await this.canType())) return "preview";
    let attempted = false;
    for (const chunk of chunks) {
      if (held()) return attempted ? "uncertain" : "held";
      const ready = await this.command({ type: chunk });
      if (ready !== "ready") return attempted ? "uncertain" : "preview";
      if (held()) return attempted ? "uncertain" : "held";
      attempted = true;
      if (!(await this.type(chunk))) return "uncertain";
      if ((await this.command(false)) !== "inserted") return "uncertain";
    }
    return "inserted";
  }

  async ready(): Promise<boolean> {
    return this.line(2000).then(
      (value) => {
        this.chromium = value === "ready:chromium";
        this.web = value === "ready:web" || this.chromium;
        if (value === "preview:service")
          this.reason =
            "The accessibility service is unavailable. Your dictation will stay in History.";
        else if (value.startsWith("preview"))
          this.reason =
            "This app did not expose a readable, focused text field. Your dictation will stay in History.";
        return value === "ready" || this.web;
      },
      () => false,
    );
  }

  async join(): Promise<boolean> {
    const ready = await this.transaction(() => this.command(true)).then(
      (value) => value === "ready",
      () => false,
    );
    if (!ready) this.close();
    return ready;
  }

  destination(method: TextInsertionMethod): Destination {
    const thisSession = this;
    this.references++;
    let closed = false;
    let attempted = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (--this.references === 0) this.close();
    };
    return {
      get reason() {
        return thisSession.reason;
      },
      close,
      deliver: async (text, held = () => false) => {
        if (closed || attempted || !text || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
          close();
          return "preview";
        }
        attempted = true;
        let deferred = false;
        let result: string;
        try {
          result = await this.transaction(async () => {
            if (closed) return "preview";
            const result = await this.insert(text, method, held);
            deferred = result === "held";
            return result;
          });
        } catch {
          this.close();
          close();
          return "uncertain";
        }
        // Nothing was sent, and a held newer take shares this helper, so keep both
        // open for the caller to retry.
        if (deferred) {
          attempted = false;
          return "held";
        }
        close();
        if (result === "inserted") return result;
        this.close();
        return result === "preview" ? result : "uncertain";
      },
    };
  }
}
