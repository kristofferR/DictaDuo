import { homedir } from "node:os";
import { join } from "node:path";

export class PortalKeyboard {
  status: "disabled" | "requesting" | "ready" | "unavailable" = "disabled";
  private child?: Bun.Subprocess<"pipe", "pipe", "ignore">;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private read?: (timeout?: number) => Promise<string>;
  private generation = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private token: string;
  constructor(
    private helper: string,
    private environment: typeof process.env = process.env,
  ) {
    this.token = join(
      environment.XDG_STATE_HOME || join(homedir(), ".local/state"),
      "dictaduo",
      "keyboard-portal-token",
    );
    void Bun.file(this.token)
      .exists()
      .then((exists) => {
        if (exists && !this.closed) this.enable(true);
      });
  }
  enable(restoreOnly = false): void {
    if (this.closed || this.status === "ready" || this.status === "requesting") return;
    this.status = "requesting";
    const generation = ++this.generation;
    void this.start(generation, restoreOnly).catch(() => {
      if (this.generation === generation) this.abort("unavailable");
    });
  }
  private async start(generation: number, restoreOnly: boolean): Promise<void> {
    const restore = await Bun.file(this.token).exists();
    if (this.closed || this.generation !== generation) return;
    if (restoreOnly && !restore) {
      this.abort();
      return;
    }
    const child = Bun.spawn([this.helper, restore ? "--restore" : "--authorize"], {
      env: this.environment,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    this.child = child;
    const reader = child.stdout.getReader();
    this.reader = reader;
    let buffer = "";
    const read = async (timeout = 2000): Promise<string> => {
      const timer = setTimeout(() => {
        if (this.child === child) this.abort("unavailable");
      }, timeout);
      try {
        while (!buffer.includes("\n")) {
          const next = await reader.read();
          if (next.done) return "unavailable";
          buffer += new TextDecoder().decode(next.value);
          if (buffer.length > 100) return "unavailable";
        }
        const at = buffer.indexOf("\n");
        const value = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        return value;
      } finally {
        clearTimeout(timer);
      }
    };
    this.read = read;
    void child.exited.then(() => {
      if (this.child === child) {
        this.child = undefined;
        this.status = "unavailable";
      }
    });
    if ((await read(125000)) !== "ready") {
      if (this.child === child) this.abort("unavailable");
      return;
    }
    if (!this.closed && this.child === child) this.status = "ready";
  }
  type(text: string, paste: boolean): Promise<boolean> {
    const next = this.pending.then(async () => {
      const child = this.child;
      const read = this.read;
      if (this.status !== "ready" || !child || !read || this.closed) return false;
      try {
        child.stdin.write(JSON.stringify(paste ? { paste: true } : { text }) + "\n");
        await child.stdin.flush();
        if ((await read()) === "sent" && this.child === child) return true;
      } catch {}
      if (this.child === child) this.abort("unavailable");
      return false;
    });
    this.pending = next.catch(() => {});
    return next;
  }
  abort(status: "disabled" | "unavailable" = "disabled"): void {
    const child = this.child;
    this.generation++;
    this.child = undefined;
    this.read = undefined;
    void this.reader?.cancel();
    this.reader = undefined;
    this.status = status;
    if (!child) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 500);
    void child.exited.finally(() => clearTimeout(timer));
  }
  close(): void {
    this.closed = true;
    this.abort();
  }
}
