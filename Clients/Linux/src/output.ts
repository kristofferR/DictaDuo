import { command } from "./desktop.ts";

type Run = (args: string[]) => Promise<string>;

/**
 * Mutes the default PipeWire output while a take records, like the speaker
 * mute key. Volume is never changed, and only outputs this muter silenced are
 * restored: anything the user had already muted stays muted.
 */
export class OutputMuter {
  private readonly muted = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private retry?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly run: Run = (args) => command(["wpctl", ...args]),
    private readonly retryDelays = [250, 1000, 3000],
  ) {}

  mute() {
    return this.serial(async () => {
      // A new take suspends pending retries so they cannot unmute it; its own
      // restore retries them.
      this.cancelRetry();
      const id = await this.defaultSink();
      if (
        id &&
        !this.muted.has(id) &&
        (await this.isMuted(id)) === false &&
        (await this.set(id, true))
      )
        this.muted.add(id);
    });
  }

  /** An unmute that fails (e.g. the output disappeared) is retried a few times. */
  restore() {
    return this.serial(async () => {
      this.cancelRetry();
      await this.unmutePending();
      this.schedule(0);
    });
  }

  /** Quitting awaits the bounded retries so a transient failure cannot leave the desktop muted. */
  async finish() {
    this.cancelRetry();
    for (const delay of [0, ...this.retryDelays]) {
      if (delay) await Bun.sleep(delay);
      await this.serial(() => this.unmutePending());
      if (!this.muted.size) return;
    }
  }

  private schedule(attempt: number) {
    const delay = this.retryDelays[attempt];
    if (!this.muted.size || delay === undefined) return;
    this.retry = setTimeout(() => {
      void this.serial(async () => {
        await this.unmutePending();
        this.schedule(attempt + 1);
      });
    }, delay);
  }

  private cancelRetry() {
    clearTimeout(this.retry);
    this.retry = undefined;
  }

  private async unmutePending() {
    for (const id of [...this.muted]) if (await this.set(id, false)) this.muted.delete(id);
  }

  private async defaultSink() {
    try {
      return /^id (\d+),/.exec(await this.run(["inspect", "@DEFAULT_AUDIO_SINK@"]))?.[1];
    } catch {
      return undefined;
    }
  }

  private async isMuted(id: string) {
    try {
      const volume = await this.run(["get-volume", id]);
      return volume.startsWith("Volume:") ? volume.includes("[MUTED]") : undefined;
    } catch {
      return undefined;
    }
  }

  private async set(id: string, muted: boolean) {
    try {
      await this.run(["set-mute", id, muted ? "1" : "0"]);
      return true;
    } catch {
      return false;
    }
  }

  private serial(work: () => Promise<void>) {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
}
