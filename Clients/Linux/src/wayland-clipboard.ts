/** The broker snapshots every format and owns restoration independently of a
 * destination helper. Closing stdin restores its lease; it can then keep the
 * original clipboard alive until another application becomes its owner. */
export class WaylandClipboard {
  private child?: Bun.Subprocess<"pipe", "pipe", "ignore">;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  private decoder = new TextDecoder();
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private active = false;
  private blocked = false;

  constructor(
    private helper: string,
    private environment: typeof process.env = process.env,
  ) {}

  private async line(): Promise<string> {
    const child = this.child;
    const reader = this.reader;
    const timer = setTimeout(() => {
      if (this.child !== child) return;
      // An unconfirmed lease must not become another broker's clipboard backup.
      this.blocked ||= this.active;
      this.detach();
    }, 3000);
    try {
      while (!this.buffer.includes("\n")) {
        const next = await reader?.read();
        if (!next || next.done) throw new Error("Clipboard broker stopped.");
        this.buffer += this.decoder.decode(next.value, { stream: true });
        if (this.buffer.length > 100) throw new Error("Invalid clipboard response.");
      }
      const index = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      return line;
    } finally {
      clearTimeout(timer);
    }
  }
  private async ready(): Promise<boolean> {
    if (this.closed || this.blocked) return false;
    if (this.child) return true;
    if (!this.environment.WAYLAND_DISPLAY) return false;
    for (const helper of [this.helper, this.helper + "-ext"]) {
      if (!(await Bun.file(helper).exists())) continue;
      this.child = Bun.spawn([helper], {
        env: this.environment,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      this.reader = this.child.stdout.getReader();
      const child = this.child;
      void child.exited.then(() => {
        if (this.child === child) {
          this.blocked ||= this.active;
          this.detach();
        }
      });
      this.buffer = "";
      try {
        if ((await this.line()) === "ready") return true;
      } catch {}
      this.detach();
      if (this.closed) return false;
    }
    return false;
  }
  private async command(
    value: { stage: string } | { restore: true } | { check: true },
  ): Promise<string> {
    if (!this.child || this.closed) return "unavailable";
    this.child.stdin.write(JSON.stringify(value) + "\n");
    await this.child.stdin.flush();
    return this.line();
  }
  lease(text: string, run: (owns: () => Promise<boolean>) => Promise<string>): Promise<string> {
    const next = this.pending.then(async () => {
      if (!(await this.ready())) return "preview";
      this.active = true;
      try {
        if ((await this.command({ stage: text })) !== "staged") return "preview";
        return await run(async () => (await this.command({ check: true })) === "owned");
      } finally {
        try {
          if (!this.closed && (await this.command({ restore: true })) !== "restored") {
            this.blocked = true;
            this.detach();
          }
        } finally {
          this.active = false;
        }
      }
    });
    this.pending = next.catch(() => {});
    return next;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
  }
  private detach(): void {
    // Do not kill the broker: EOF gives it a chance to restore, and its scope
    // keeps the restored source alive across background-client restarts.
    void this.child?.stdin.end();
    void this.reader?.cancel();
    this.child?.unref();
    this.child = undefined;
    this.reader = undefined;
    this.buffer = "";
  }
}
