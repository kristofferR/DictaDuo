import type { Destination } from "./controller.ts";

const preview = (): Destination => ({ deliver: async () => "preview", close() {} });

/** Overlapping takes share a helper only while its retained field is unchanged. */
export class NativeDestinations {
  private sessions = new Map<string, NativeSession>();
  private capturing: Promise<unknown> = Promise.resolve();
  private revision = 0;

  capture(helper: string, target: string): Promise<Destination> {
    const revision = this.revision;
    const capture = this.capturing.then(async () => {
      if (revision !== this.revision) return preview();
      let session = this.sessions.get(target);
      // Reserve a reference while joining so an in-flight delivery cannot close it.
      let destination = session?.destination();
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
          return preview();
        }
      }
      if (revision !== this.revision) {
        destination?.close();
        session.close();
        return preview();
      }
      this.sessions.set(target, session);
      return destination ?? session.destination();
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

  constructor(
    helper: string,
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
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
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

  private command(value: string | boolean, active = () => true): Promise<string> {
    const command = this.pending.then(async () => {
      if (this.closed || !active()) return "preview";
      this.input.write(JSON.stringify(value) + "\n");
      await this.input.flush();
      return this.line(1500);
    });
    this.pending = command.catch(() => {});
    return command;
  }

  async ready(): Promise<boolean> {
    return this.line(1400).then(
      (value) => value === "ready",
      () => false,
    );
  }

  async join(): Promise<boolean> {
    const ready = await this.command(true).then(
      (value) => value === "ready",
      () => false,
    );
    if (!ready) this.close();
    return ready;
  }

  destination(): Destination {
    this.references++;
    let closed = false;
    let attempted = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (--this.references === 0) this.close();
    };
    return {
      close,
      deliver: async (text, held = () => false) => {
        if (closed || attempted || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
          close();
          return "preview";
        }
        attempted = true;
        let deferred = false;
        let result: string;
        try {
          result = await this.command(text, () => !closed && !(deferred = held()));
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
