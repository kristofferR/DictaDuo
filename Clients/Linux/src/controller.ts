import { randomBytes, randomUUID } from "node:crypto";
import { APIError, type API, type Device, type Generation } from "./api.ts";
import { candidates, sourceKey, type SourceID, type SourcePreferences } from "./sources.ts";
import { RecordingFeedback } from "./feedback.ts";
import type { OutputMuter } from "./output.ts";
const recordingLimitMS = 174000;
export interface Destination {
  deliver(text: string): Promise<"inserted" | "preview" | "uncertain">;
  close(): void;
}
export interface Desktop {
  kind?: "hyprland" | "plasma";
  unlocked(since?: number): Promise<boolean>;
  capture(): Promise<Destination>;
  defaultInput(hostID: string): Promise<SourceID | undefined>;
  notify(message: string): void;
}
type Take = {
  owner: string;
  requestID: string;
  id?: string;
  destination?: Destination;
  released: boolean;
  cancelled: boolean;
  startedAt: number;
  sealed: boolean;
  sealMayHaveSucceeded: boolean;
  button?: { ticket: string; source: SourceID };
  completed?: boolean;
  preview: boolean;
  feedbackAbort: AbortController;
  atLimit: boolean;
  /** Fixed at start, so a settings change mid-take still restores the output. */
  output?: Output;
  muting?: Promise<void>;
};
type Output = Pick<OutputMuter, "mute" | "restore">;
export interface Result {
  id: string;
  text: string;
  delivery: "inserted" | "preview" | "uncertain";
}
/** A process owns only its current take. Restart never reloads a generation for delivery. */
export class Controller {
  private take?: Take;
  private pending?: Promise<void>;
  private watchdog?: ReturnType<typeof setInterval>;
  private watching = false;
  private lastTick = Date.now();
  feedback = new RecordingFeedback();
  captureAllowed: () => boolean = () => true;
  output?: Output;
  muteOutput = false;
  onStart?: (ticket?: string) => void;
  onComplete?: (id: string | undefined, ticket: string | undefined, succeeded: boolean) => void;
  activity: {
    phase:
      | "idle"
      | "preparing"
      | "recording"
      | "processing"
      | "delivering"
      | "completed"
      | "cancelled"
      | "failed";
    source?: string;
    startedAt?: number;
    trigger?: "shortcut" | "pairing" | "test";
  } = { phase: "idle" };
  get busy() {
    return this.take !== undefined;
  }
  updatePreferences(preferences: SourcePreferences) {
    if (this.busy) throw new Error("Finish dictation before changing microphones.");
    this.preferences = preferences;
  }
  state = "idle";
  result?: Result;
  constructor(
    private api: Pick<
      API,
      "sources" | "start" | "heartbeat" | "stop" | "cancel" | "get" | "delivery"
    > &
      Partial<Pick<API, "events">>,
    private desktop: Desktop,
    private device: Device,
    private preferences: SourcePreferences,
  ) {}
  start(button?: Take["button"], preview = false): boolean {
    if (this.take || !this.captureAllowed()) return false;
    this.result = undefined;
    this.feedback = new RecordingFeedback();
    const take: Take = {
      owner: randomBytes(32).toString("hex"),
      requestID: randomUUID().toUpperCase(),
      released: false,
      cancelled: false,
      startedAt: Date.now(),
      sealed: false,
      sealMayHaveSucceeded: false,
      button,
      preview,
      feedbackAbort: new AbortController(),
      atLimit: false,
      output: this.muteOutput ? this.output : undefined,
    };
    this.take = take;
    this.activity = {
      phase: "preparing",
      startedAt: take.startedAt,
      trigger: preview ? "test" : button ? "pairing" : "shortcut",
    };
    this.onStart?.(button?.ticket);
    this.lastTick = Date.now();
    this.setState("preparing", "preparing");
    take.muting = take.output?.mute().catch(() => {});
    this.watchdog = setInterval(() => {
      void this.watch(take);
    }, 1000);
    this.pending = this.run(take)
      .catch(async () => {
        if (!take.cancelled)
          this.setState("Capture failed. Any completed result remains in shared history.");
        await this.cancelTake(take);
      })
      .finally(() => {
        void take.output?.restore();
        take.feedbackAbort.abort();
        this.feedback.finish(take.atLimit);
        take.destination?.close();
        if (this.take === take) {
          clearInterval(this.watchdog);
          this.take = undefined;
          this.onComplete?.(
            take.id,
            take.button?.ticket,
            take.completed === true && !take.cancelled,
          );
        }
      });
    return true;
  }
  stop(): void {
    if (this.take && !this.take.button) this.take.released = true;
  }
  startButton(ticket: string, source: SourceID): boolean {
    return this.start({ ticket, source });
  }
  stopButton(ticket: string): void {
    if (this.take?.button?.ticket === ticket) this.take.released = true;
  }
  async cancelButton(ticket?: string): Promise<void> {
    if (["delivering", "completed"].includes(this.activity.phase)) return;
    if (this.take?.button && (!ticket || this.take.button.ticket === ticket)) await this.cancel();
  }
  toggle(): void {
    if (this.take) this.stop();
    else this.start();
  }
  async cancel(): Promise<void> {
    const take = this.take;
    this.result = undefined;
    this.setState("cancelled", "cancelled");
    if (take) await this.cancelTake(take);
  }
  async settled(): Promise<void> {
    await this.pending;
  }
  private live(take: Take) {
    return this.take === take && !take.cancelled;
  }
  private setState(state: string, phase: Controller["activity"]["phase"] = "failed") {
    this.activity = { ...this.activity, phase };
    this.state = state;
    this.desktop.notify(state);
  }
  private async cancelTake(take: Take) {
    take.cancelled = true;
    take.feedbackAbort.abort();
    this.feedback.finish(take.atLimit);
    this.feedback.unavailable();
    take.destination?.close();
    if (take.id && !take.sealed && !take.sealMayHaveSucceeded)
      await this.api.cancel(take.id, take.owner).catch(() => {});
    // An admission with an unknown ID loses its server lease within five seconds.
  }
  private async watch(take: Take) {
    if (this.watching || !this.live(take)) return;
    this.watching = true;
    try {
      const now = Date.now();
      const slept = now - this.lastTick > 2500 || now < this.lastTick;
      this.lastTick = now;
      const unlocked = await this.desktop.unlocked(take.startedAt);
      if (!this.live(take)) return;
      if (["delivering", "completed"].includes(this.activity.phase)) return;
      if (slept || !unlocked) {
        await this.cancel();
        return;
      }
      if (take.id && !take.sealed && this.live(take)) {
        try {
          await this.api.heartbeat(take.id, take.owner);
        } catch (error) {
          if (
            !take.sealed &&
            !(
              take.released &&
              error instanceof APIError &&
              error.status === 409 &&
              error.code === "capture_closed"
            )
          )
            throw error;
        }
      }
    } catch {
      if (take.sealMayHaveSucceeded) return;
      if (this.live(take) && !["delivering", "completed"].includes(this.activity.phase)) {
        await this.cancelTake(take);
        this.setState("Connection lost; dictation cancelled.");
      }
    } finally {
      this.watching = false;
    }
  }
  private async run(take: Take) {
    // Establish the focus-change guard immediately, before slower lock/discovery checks.
    take.destination = take.preview
      ? { deliver: async () => "preview", close() {} }
      : await this.desktop.capture();
    if (!this.live(take)) return;
    if (!(await this.desktop.unlocked(take.startedAt)))
      throw new Error("Desktop is locked or unavailable.");
    // The microphone opens only once playback is silenced.
    const [sources, defaultID] = await Promise.all([
      this.api.sources(),
      this.desktop.defaultInput(this.preferences.hostID),
      take.muting,
    ]);
    const options = take.button
      ? sources.filter((source) => sourceKey(source.identity) === sourceKey(take.button!.source))
      : candidates(sources, this.preferences, defaultID);
    for (const source of options.slice(0, 2)) {
      if (!this.live(take)) return;
      if (take.released) {
        this.setState("idle", "idle");
        return;
      }
      const remaining = 3000 - (Date.now() - take.startedAt);
      if (remaining <= 0) throw new Error("Activation timed out.");
      try {
        const record = await this.api.start(
          take.requestID,
          this.device,
          take.preview ? "test" : "dictation",
          source.identity,
          take.owner,
          remaining,
          take.button?.ticket,
        );
        take.id = record.id;
        if (!this.live(take)) {
          await this.cancelTake(take);
          return;
        }
        if (
          record.capture?.state !== "recording" ||
          sourceKey(record.capture.source) !== sourceKey(source.identity) ||
          record.device.id !== this.device.id ||
          record.requestID !== take.requestID
        )
          throw new Error("Invalid capture admission.");
        this.activity = { ...this.activity, source: source.name };
        this.feedback.begin(take.startedAt + recordingLimitMS);
        if (this.api.events) {
          void this.api
            .events(record.id, take.feedbackAbort.signal, (update) => {
              if (!this.live(take)) return;
              this.verify(update, take);
              if (
                !update.capture ||
                sourceKey(update.capture.source) !== sourceKey(source.identity)
              )
                throw new Error("Mismatched feedback source.");
              this.feedback.update(
                update.capture.state === "recording" ? update.capture.peak : undefined,
                update.recognition?.partialText,
                update.status,
              );
            })
            .catch(() => {
              if (this.live(take) && !take.feedbackAbort.signal.aborted)
                this.feedback.unavailable();
            });
        }
        this.setState(`recording · ${source.name}`, "recording");
        break;
      } catch (error) {
        if (take.button || !(error instanceof APIError && error.allowsFallback)) throw error;
        take.requestID = randomUUID().toUpperCase();
        take.owner = randomBytes(32).toString("hex");
      }
    }
    if (!take.id) throw new Error("No available microphone.");
    while (this.live(take) && !take.released) {
      if (Date.now() >= take.startedAt + recordingLimitMS) {
        take.atLimit = true;
        take.released = true;
      } else await Bun.sleep(40);
    }
    if (!this.live(take)) return;
    this.feedback.finish(take.atLimit);
    this.setState("processing", "processing");
    take.sealMayHaveSucceeded = true;
    let record = await this.api.stop(take.id, take.owner);
    this.verify(record, take);
    if (record.capture?.state !== "sealed") throw new Error("Capture was not sealed.");
    take.sealed = true;
    // The microphone has stopped; processing runs with the output restored.
    void take.output?.restore();
    // Include cold model loading plus the server's speech and proofreading limits.
    const deadline = Date.now() + 360_000;
    while (this.live(take) && !["completed", "failed", "cancelled"].includes(record.status)) {
      if (Date.now() >= deadline) throw new Error("Processing timed out.");
      await Bun.sleep(300);
      if (!this.live(take)) return;
      record = await this.api.get(take.id);
    }
    if (!this.live(take)) return;
    this.verify(record, take);
    if (record.status !== "completed") throw new Error("Transcription did not complete.");
    if (!(await this.desktop.unlocked(take.startedAt)) || !this.live(take)) {
      await this.cancel();
      return;
    }
    // Exactly one attempt; an uncertain result is never retried or auto-copied.
    this.setState("Delivering text", "delivering");
    const delivery = await take.destination.deliver(record.insertionText);
    if (!this.live(take)) return;
    this.result = { id: take.id, text: record.insertionText, delivery };
    this.setState(
      delivery === "inserted"
        ? "Text inserted"
        : delivery === "uncertain"
          ? "Insertion uncertain. Check the field before copying."
          : "Text ready. Use sottoduo result or sottoduo copy.",
      "completed",
    );
    take.completed =
      !take.preview && Boolean(record.insertionText.trim()) && delivery !== "uncertain";
    await this.api
      .delivery(
        take.id,
        take.owner,
        delivery === "preview" ? "none" : delivery === "uncertain" ? "unconfirmed" : "inserted",
      )
      .catch(() => {
        this.desktop.notify("Delivery receipt could not be saved; insertion will not be retried.");
      });
  }
  private verify(record: Generation, take: Take) {
    if (
      record.id !== take.id ||
      record.requestID !== take.requestID ||
      record.device.id !== this.device.id
    )
      throw new Error("Mismatched generation.");
  }
}
