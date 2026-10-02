import { randomBytes, randomUUID } from "node:crypto";
import { APIError, type API, type Device, type Generation } from "./api.ts";
import { candidates, sourceKey, type SourceID, type SourcePreferences } from "./sources.ts";
import { RecordingFeedback } from "./feedback.ts";
import type { OutputMuter } from "./output.ts";
const recordingLimitMS = 174000;
export interface Destination {
  /** Returns "held", without attempting, if `held` is true when the insertion is sent. */
  deliver(
    text: string,
    held?: () => boolean,
  ): Promise<"inserted" | "preview" | "uncertain" | "held">;
  close(): void;
}
export interface Desktop {
  kind?: "hyprland" | "plasma";
  unlocked(since?: number): Promise<boolean>;
  capture(): Promise<Destination>;
  defaultInput(hostID: string): Promise<SourceID | undefined>;
  notify(message: string): void;
}
type Phase =
  | "idle"
  | "preparing"
  | "recording"
  | "processing"
  | "delivering"
  | "completed"
  | "cancelled"
  | "failed";
type Activity = {
  phase: Phase;
  source?: string;
  startedAt?: number;
  trigger?: "shortcut" | "pairing" | "test";
};
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
  feedback: RecordingFeedback;
  feedbackAbort: AbortController;
  atLimit: boolean;
  /** Fixed at start, so a settings change mid-take still restores the output. */
  output?: Output;
  muting?: Promise<void>;
  activity: Activity;
  state: string;
  watchdog?: ReturnType<typeof setInterval>;
  watching: boolean;
  lastTick: number;
  startContext?: unknown;
  /** Resolves when this take's delivery slot is free, in recording order. */
  delivered: () => void;
  turn: Promise<void>;
};
type Output = Pick<OutputMuter, "mute" | "restore">;
export interface Result {
  id: string;
  text: string;
  delivery: "inserted" | "preview" | "uncertain";
}
/**
 * The capturing take owns the microphone until the server seals it. Sealed takes
 * process and deliver in recording order while the next take records. Restart
 * never reloads a generation for delivery.
 */
export class Controller {
  private take?: Take;
  private processing: Take[] = [];
  private tasks = new Set<Promise<void>>();
  private deliveryTail: Promise<void> = Promise.resolve();
  /** The shown take's cancellation, until its server cleanup finishes. */
  private cancelling?: Promise<void>;
  feedback = new RecordingFeedback();
  captureAllowed: () => boolean = () => true;
  output?: Output;
  muteOutput = false;
  /** Client deadline once a take leaves the server queue. */
  processingTimeoutMS = 360_000;
  /** Returns per-take context that is handed back to onComplete for that take. */
  onStart?: (ticket?: string) => unknown;
  onComplete?: (
    id: string | undefined,
    ticket: string | undefined,
    succeeded: boolean,
    context: unknown,
  ) => void;
  activity: Activity = { phase: "idle" };
  get busy() {
    return this.take !== undefined || this.processing.length > 0;
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
    // Later cancels target this take, not an earlier one still cleaning up.
    this.cancelling = undefined;
    const startedAt = Date.now();
    const take: Take = {
      owner: randomBytes(32).toString("hex"),
      requestID: randomUUID().toUpperCase(),
      released: false,
      cancelled: false,
      startedAt,
      sealed: false,
      sealMayHaveSucceeded: false,
      button,
      preview,
      feedback: new RecordingFeedback(),
      feedbackAbort: new AbortController(),
      atLimit: false,
      activity: {
        phase: "preparing",
        startedAt,
        trigger: preview ? "test" : button ? "pairing" : "shortcut",
      },
      state: "preparing",
      watching: false,
      lastTick: startedAt,
      delivered: () => {},
      turn: Promise.resolve(),
      output: this.muteOutput ? this.output : undefined,
    };
    this.take = take;
    this.feedback = take.feedback;
    take.startContext = this.onStart?.(button?.ticket);
    this.setState(take, "preparing", "preparing");
    take.muting = take.output?.mute().catch(() => {});
    take.watchdog = setInterval(() => {
      void this.watch(take);
    }, 1000);
    const task: Promise<void> = this.run(take)
      .catch(async () => {
        if (!take.cancelled)
          this.setState(take, "Capture failed. Any completed result remains in shared history.");
        await this.cancelTake(take);
      })
      .finally(() => {
        // A sealed take restored at its seal; a newer take may be muting now.
        if (!take.sealed) void take.output?.restore();
        take.feedbackAbort.abort();
        take.feedback.finish(take.atLimit);
        take.destination?.close();
        clearInterval(take.watchdog);
        // A failed or cancelled take still frees its slot for later deliveries.
        take.delivered();
        if (this.take === take) this.take = undefined;
        this.processing = this.processing.filter((other) => other !== take);
        const next = this.foreground;
        if (this.feedback === take.feedback && next) {
          this.feedback = next.feedback;
          this.announce(next.state, next.activity.phase, next.activity);
        }
        this.tasks.delete(task);
        this.onComplete?.(
          take.id,
          take.button?.ticket,
          take.completed === true && !take.cancelled,
          take.startContext,
        );
      });
    this.tasks.add(task);
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
    const takes = [this.take, ...this.processing].filter(
      (take): take is Take =>
        take !== undefined &&
        !!take.button &&
        (!ticket || take.button.ticket === ticket) &&
        !["delivering", "completed"].includes(take.activity.phase),
    );
    // Revoke every destination synchronously before waiting for server cleanup.
    await Promise.all(takes.map((take) => this.cancelOne(take)));
  }
  toggle(): void {
    if (this.take) this.stop();
    else this.start();
  }
  /** Cancels the take the overlay shows; earlier takes keep processing. */
  async cancel(): Promise<void> {
    // The overlay shows the cancelled take until its cleanup finishes, so a repeat
    // joins that cancellation unless a new take has started since.
    if (this.cancelling) return this.cancelling;
    const take = this.foreground;
    if (take) await this.cancelOne(take);
    else {
      // Earlier takes' results stay recoverable while another take is cancelled.
      this.result = undefined;
      this.announce("cancelled", "cancelled");
    }
  }
  /** Cancels every take, or only those not yet delivering. */
  async cancelAll(includeDelivery = true): Promise<void> {
    const takes = [this.take, ...this.processing].filter(
      (take): take is Take =>
        take !== undefined &&
        (includeDelivery || !["delivering", "completed"].includes(take.activity.phase)),
    );
    // Revoke every destination synchronously before waiting for server cleanup.
    await Promise.all(takes.map((take) => this.cancelOne(take)));
  }
  async settled(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }
  private get foreground(): Take | undefined {
    if (this.take && !this.take.cancelled) return this.take;
    // A completed take awaiting only its receipt no longer holds the overlay.
    return this.processing.findLast(
      (take) => !take.cancelled && take.activity.phase !== "completed",
    );
  }
  /** A newer take is capturing and its shortcut or button is still held. */
  private get held() {
    return !!this.take && !this.take.released && !this.take.cancelled;
  }
  private live(take: Take) {
    return !take.cancelled && (this.take === take || this.processing.includes(take));
  }
  private announce(state: string, phase: Phase, activity: Activity = this.activity) {
    this.activity = { ...activity, phase };
    this.state = state;
    this.desktop.notify(state);
  }
  /** Only the foreground take drives the overlay; earlier takes only notify. */
  private setState(take: Take, state: string, phase: Phase = "failed") {
    const shown = take === this.foreground;
    take.state = state;
    take.activity = { ...take.activity, phase };
    if (shown) this.announce(state, phase, take.activity);
    else if (
      phase === "failed" ||
      state.startsWith("Insertion uncertain") ||
      state.startsWith("Text ready")
    )
      this.desktop.notify(`Earlier dictation: ${state}`);
  }
  private async cancelOne(take: Take) {
    const shown = take === this.foreground;
    if (!shown) return this.cancelTake(take);
    this.setState(take, "cancelled", "cancelled");
    const cleanup = this.cancelTake(take);
    this.cancelling = cleanup;
    await cleanup;
    // A newer take or cancellation owns the overlay now.
    if (this.cancelling !== cleanup) return;
    this.cancelling = undefined;
    const next = this.foreground;
    if (next) {
      this.feedback = next.feedback;
      this.announce(
        "Cancelled · earlier dictation is still processing",
        next.activity.phase,
        next.activity,
      );
    }
  }
  private async cancelTake(take: Take) {
    take.cancelled = true;
    take.activity = { ...take.activity, phase: "cancelled" };
    take.feedbackAbort.abort();
    take.feedback.finish(take.atLimit);
    take.feedback.unavailable();
    take.destination?.close();
    if (take.id && !take.sealed && !take.sealMayHaveSucceeded)
      await this.api.cancel(take.id, take.owner).catch(() => {});
    // An admission with an unknown ID loses its server lease within five seconds.
  }
  private async watch(take: Take) {
    if (take.watching || !this.live(take)) return;
    take.watching = true;
    try {
      const now = Date.now();
      const slept = now - take.lastTick > 2500 || now < take.lastTick;
      take.lastTick = now;
      const unlocked = await this.desktop.unlocked(take.startedAt);
      if (!this.live(take)) return;
      if (["delivering", "completed"].includes(take.activity.phase)) return;
      if (slept || !unlocked) {
        await this.cancelOne(take);
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
      if (this.live(take) && !["delivering", "completed"].includes(take.activity.phase)) {
        // Announce before cancelling, while the take still decides the overlay.
        this.setState(take, "Connection lost; dictation cancelled.");
        await this.cancelTake(take);
      }
    } finally {
      take.watching = false;
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
        this.setState(take, "idle", "idle");
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
        take.activity = { ...take.activity, source: source.name };
        take.feedback.begin(take.startedAt + recordingLimitMS);
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
              take.feedback.update(
                update.capture.state === "recording" ? update.capture.peak : undefined,
                update.recognition?.partialText,
                update.status,
              );
            })
            .catch(() => {
              if (this.live(take) && !take.feedbackAbort.signal.aborted)
                take.feedback.unavailable();
            });
        }
        this.setState(take, `recording · ${source.name}`, "recording");
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
    take.feedback.finish(take.atLimit);
    this.setState(take, "processing", "processing");
    take.sealMayHaveSucceeded = true;
    let record = await this.api.stop(take.id, take.owner);
    this.verify(record, take);
    if (record.capture?.state !== "sealed") throw new Error("Capture was not sealed.");
    take.sealed = true;
    // The microphone has stopped; processing runs with the output restored.
    void take.output?.restore();
    // The server microphone is free: hand off so the next take can record while
    // this one processes. Handoff order is recording order, so is delivery order.
    if (this.take === take) {
      this.take = undefined;
      this.processing.push(take);
      const previous = this.deliveryTail;
      let delivered!: () => void;
      const slot = new Promise<void>((resolve) => (delivered = resolve));
      take.delivered = delivered;
      take.turn = previous;
      this.deliveryTail = previous.then(() => slot);
    }
    // Queue wait has no client deadline; allow cold loading and the server's
    // speech and proofreading limits once this take starts processing.
    let deadline: number | undefined;
    while (this.live(take) && !["completed", "failed", "cancelled"].includes(record.status)) {
      if (record.status !== "queued") deadline ??= Date.now() + this.processingTimeoutMS;
      if (deadline !== undefined && Date.now() >= deadline)
        throw new Error("Processing timed out.");
      await Bun.sleep(300);
      if (!this.live(take)) return;
      record = await this.api.get(take.id);
    }
    if (!this.live(take)) return;
    this.verify(record, take);
    if (record.status !== "completed") throw new Error("Transcription did not complete.");
    // Deliver after every earlier take, and never while a newer take is held.
    await take.turn;
    let delivery: Awaited<ReturnType<Destination["deliver"]>>;
    do {
      do {
        while (this.live(take) && this.held) await Bun.sleep(40);
        if (!(await this.desktop.unlocked(take.startedAt)) || !this.live(take)) {
          if (this.live(take)) await this.cancelOne(take);
          return;
        }
        // A new take may have started while the unlock check was pending.
      } while (this.held);
      // Exactly one attempt; an uncertain result is never retried or auto-copied.
      this.setState(take, "Delivering text", "delivering");
      // The destination's own checks are async, so it rechecks for a held take too
      // and defers without attempting if one started meanwhile.
      delivery = await take.destination.deliver(record.insertionText, () => this.held);
      if (delivery === "held") this.setState(take, "processing", "processing");
    } while (delivery === "held");
    // Only the insertion transaction holds up later takes, not its receipt.
    take.delivered();
    if (!this.live(take)) return;
    this.result = { id: take.id, text: record.insertionText, delivery };
    this.setState(
      take,
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
