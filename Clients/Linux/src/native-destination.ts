import type { Destination } from "./controller.ts";
import { dirname, join } from "node:path";
import { literalTextChunks, typingChunks, type TextInsertionMethod } from "./text-insertion.ts";
import { WaylandClipboard } from "./wayland-clipboard.ts";
import { PortalKeyboard } from "./portal-keyboard.ts";

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
  private clipboard?: WaylandClipboard;
  private keyboard?: PortalKeyboard;
  get keyboardAccess() {
    return this.keyboard?.status ?? "disabled";
  }
  enableKeyboardAccess(): void {
    this.keyboard?.enable();
  }

  /** Start the accessibility registry before a take, without reading fields. */
  warm(helper: string, target?: string): void {
    this.keyboard ??= new PortalKeyboard(join(dirname(helper), "dictaduo-portal-keyboard"));
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
        this.clipboard ??= new WaylandClipboard(join(dirname(helper), "dictaduo-clipboard"));
        this.keyboard ??= new PortalKeyboard(join(dirname(helper), "dictaduo-portal-keyboard"));
        session = new NativeSession(
          helper,
          target,
          () => {
            if (this.sessions.get(target) === session) this.sessions.delete(target);
          },
          this.clipboard,
          this.keyboard,
        );
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
  close(): void {
    this.invalidate();
    this.clipboard?.close();
    this.keyboard?.close();
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
  private typingBackend?: "wayland" | "portal";
  private portalActive = false;
  private literal?: Bun.Subprocess<"pipe", "pipe", "ignore">;
  private literalReader?: ReadableStreamDefaultReader<Uint8Array>;
  private literalBuffer = "";
  reason?: string;

  constructor(
    private helper: string,
    target: string,
    private onClose: () => void,
    private clipboard: WaylandClipboard,
    private portal: PortalKeyboard,
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
    if (this.portalActive) {
      this.portal.abort();
      this.portal.enable(true);
    }
    this.literal?.kill("SIGKILL");
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
    value:
      | boolean
      | { disarm: true }
      | { text: string; method: TextInsertionMethod }
      | { type: string; transport?: "paste" | "literal" | "portal" },
  ): Promise<string> {
    if (this.closed) return "preview";
    this.input.write(JSON.stringify(value) + "\n");
    await this.input.flush();
    const result = await this.line(2000);
    if (result.startsWith("preview:")) {
      this.reason =
        result === "preview:modifiers"
          ? "Release modifier keys and mouse buttons before insertion. Your dictation is saved in History."
          : result === "preview:multiline"
            ? "This field does not support paragraphs. Your dictation is saved in History."
            : result === "preview:changed"
              ? "The original field, text or caret changed. Your dictation is saved in History."
              : "This app did not expose a readable, focused text field. Your dictation is saved in History.";
      return "preview";
    }
    return result;
  }

  /** An empty probe checks compositor support without sending keys. Payloads
   * use stdin, keeping transcripts out of process arguments and shell parsing. */
  private async type(text: string, paste = false): Promise<boolean> {
    if ((text || paste) && this.typingBackend === "portal") {
      this.portalActive = true;
      try {
        return (await this.portal.type(text, paste)) && !this.closed;
      } finally {
        this.portalActive = false;
      }
    }
    const helper = join(dirname(this.helper), "dictaduo-type");
    if (this.closed || !process.env.WAYLAND_DISPLAY || !(await Bun.file(helper).exists()))
      return false;
    const child = Bun.spawn(paste ? [helper, "--paste"] : text ? [helper] : [helper, "--probe"], {
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

  private async literalLine(): Promise<string> {
    const timer = setTimeout(() => this.literal?.kill("SIGKILL"), 1500);
    try {
      while (!this.literalBuffer.includes("\n")) {
        const next = await this.literalReader?.read();
        if (!next || next.done) return "unavailable";
        this.literalBuffer += new TextDecoder().decode(next.value);
        if (this.literalBuffer.length > 100) return "unavailable";
      }
      const at = this.literalBuffer.indexOf("\n");
      const value = this.literalBuffer.slice(0, at);
      this.literalBuffer = this.literalBuffer.slice(at + 1);
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
  private async canCommitLiteral(): Promise<boolean> {
    if (this.literal) return true;
    const helper = join(dirname(this.helper), "dictaduo-literal");
    if (!(await Bun.file(helper).exists())) return false;
    this.literal = Bun.spawn([helper], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    this.literalReader = this.literal.stdout.getReader();
    if ((await this.literalLine()) === "ready" && !this.closed) return true;
    this.literal.kill("SIGKILL");
    this.literal = undefined;
    return false;
  }
  private async commitLiteral(text: string, held: () => boolean): Promise<string> {
    let attempted = false;
    for (const value of literalTextChunks(text)) {
      if (held()) return attempted ? "uncertain" : "held";
      if ((await this.command({ type: value, transport: "literal" })) !== "ready")
        return attempted ? "uncertain" : "preview";
      if (held() || this.closed) {
        await this.command({ disarm: true });
        return attempted ? "uncertain" : "held";
      }
      attempted = true;
      this.literal!.stdin.write(JSON.stringify(value) + "\n");
      await this.literal!.stdin.flush();
      if ((await this.literalLine()) !== "sent" || (await this.command(false)) !== "inserted")
        return "uncertain";
    }
    return "inserted";
  }
  private async paste(text: string, held: () => boolean): Promise<string> {
    if (!(await this.canType())) return "preview";
    let attempted = false;
    try {
      return await this.clipboard.lease(text, async (owns) => {
        if (held()) return "held";
        if ((await this.command({ type: text, transport: "paste" })) !== "ready") return "preview";
        if (held()) {
          await this.command({ disarm: true });
          return "held";
        }
        if (this.closed || !(await owns())) {
          this.reason =
            "The clipboard changed before insertion. Your dictation is saved in History.";
          return "preview";
        }
        if (held()) {
          await this.command({ disarm: true });
          return "held";
        }
        attempted = true;
        if (!(await this.type("", true))) return "uncertain";
        return (await this.command(false)) === "inserted" ? "inserted" : "uncertain";
      });
    } catch {
      this.reason =
        "The clipboard could not be preserved safely. Your dictation is saved in History.";
      return attempted ? "uncertain" : "preview";
    }
  }

  private async canType(): Promise<boolean> {
    if (this.closed) return false;
    const virtual = this.typingBackend === "wayland" || (await this.type(""));
    const supported = virtual || this.portal.status === "ready";
    if (supported) this.typingBackend = virtual ? "wayland" : "portal";
    if (supported && !this.closed) {
      this.reason = undefined;
    }
    if (!supported)
      this.reason =
        "Keyboard access is unavailable. Enable keyboard access in This computer, or copy from History.";
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
    const requiresLiteral = !chunks || (this.chromium && /[\u{10000}-\u{10ffff}]/u.test(text));
    if (requiresLiteral) {
      // Native writes and input-method commits carry literal text, never Return
      // or Tab actions. A potentially applied native write is never retried.
      if (!this.web) {
        const result = await this.command({ text, method: "automatic" });
        if (result !== "typing") return result;
      }
      if (await this.canCommitLiteral()) return this.commitLiteral(text, held);
      if (method === "automatic") return this.paste(text, held);
      this.reason =
        "This field has no clipboard-free literal-text transport. Choose Automatic or copy from History.";
      return "preview";
    }
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
    if (!(await this.canType())) return method === "automatic" ? this.paste(text, held) : "preview";
    let attempted = false;
    for (const chunk of chunks!) {
      if (held()) return attempted ? "uncertain" : "held";
      const ready = await this.command({
        type: chunk,
        ...(this.typingBackend === "portal" ? { transport: "portal" as const } : {}),
      });
      if (ready !== "ready") return attempted ? "uncertain" : "preview";
      if (held()) {
        await this.command({ disarm: true });
        return attempted ? "uncertain" : "held";
      }
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
        if (
          closed ||
          attempted ||
          !text ||
          /[\u0000-\u0008\u000b-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(
            text,
          )
        ) {
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
