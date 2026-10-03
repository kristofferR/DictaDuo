import { randomBytes, randomUUID } from "node:crypto";
import { APIError, type API, type Device, type Recording, type RecordingDetail } from "./api.ts";
import { candidates, sourceKey, type SourceID, type SourcePreferences } from "./sources.ts";
import { RecordingFeedback } from "./feedback.ts";
import type { OutputMuter } from "./output.ts";
/** The server rejects shorter recordings, so they are discarded outright. */
const minimumTakeMS = 250;
const undoWindowMS = 4000;
type Notice = readonly [title: string, body: string];
/**
 * Desktop notifications are reserved for outcomes that need attention; progress,
 * a clean paste and a cancel show in the overlay and window instead.
 */
const notices = {
  uncertain: [
    "Check the field",
    "The paste couldn't be confirmed. If it's missing, copy it from the tray.",
  ],
  ready: ["Not pasted", "Your text is ready. Copy it from the tray or SottoDuo."],
  transcription: [
    "Couldn't transcribe",
    "The audio is saved. Open History to transcribe it again.",
  ],
  microphone: [
    "Recording stopped",
    "The microphone stopped. Anything recorded is saved in History.",
  ],
  connection: [
    "Dictation cancelled",
    "Lost the connection to the server. Try again when it's back.",
  ],
  // Unsealed takes are discarded, so these never promise saved audio.
  startup: ["Couldn't start dictation", "The microphone or server wasn't ready. Try again."],
  discarded: [
    "Recording stopped",
    "Something went wrong while recording, so the take was not saved. Try again.",
  ],
  safety: [
    "Dictation cancelled",
    "The screen locked or the computer slept, so the take was not saved.",
  ],
  undo: ["Not pasted", "Press the dictation key within 4 seconds to paste it."],
} as const satisfies Record<string, Notice>;
/**
 * Decides whether a finished take is inserted. A cancelled take waits here until
 * the user undoes the cancellation or its undo window closes.
 */
class DeliveryGate {
  state: "deliver" | "pending" | "discard";
  private consumed = false;
  private waiter?: (deliver: boolean) => void;
  constructor(pending = false) {
    this.state = pending ? "pending" : "deliver";
  }
  /** Re-open the decision for a take still processing; false once inserting began. */
  hold() {
    if (this.consumed || this.state !== "deliver") return false;
    this.state = "pending";
    return true;
  }
  decide(deliver: boolean) {
    if (this.state !== "pending") return;
    this.state = deliver ? "deliver" : "discard";
    this.waiter?.(deliver);
    this.waiter = undefined;
  }
  /** Waits for a pending decision. Called once, just before inserting. */
  consume(): Promise<boolean> {
    this.consumed = true;
    if (this.state !== "pending") return Promise.resolve(this.state === "deliver");
    return new Promise((resolve) => (this.waiter = resolve));
  }
}
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
  /** Shows one notification, replacing the previous one. */
  notify(title: string, body?: string): void;
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
  /** The computer sharing the microphone, when it is not this one. */
  host?: string;
  startedAt?: number;
  trigger?: "shortcut" | "pairing" | "test";
  /** Epoch milliseconds until which a cancelled take can still be inserted. */
  undoUntil?: number;
  /** A cancelled take that was saved to history without inserting. */
  kept?: boolean;
  /** The server fell back from cloud to local recognition for this take. */
  cloudUnavailable?: boolean;
};
type Take = {
  owner: string;
  requestID: string;
  id?: string;
  destination?: Destination;
  released: boolean;
  cancelled: boolean;
  startedAt: number;
  recordingAt?: number;
  gate: DeliveryGate;
  sealed: boolean;
  sealMayHaveSucceeded: boolean;
  /** Set when the server closed the capture itself; it keeps any recorded audio. */
  interrupted?: { state: string; notice: Notice };
  button?: { ticket: string; source: SourceID };
  completed?: boolean;
  preview: boolean;
  feedback: RecordingFeedback;
  feedbackAbort: AbortController;
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
  private undoTake?: Take;
  private undoUntil?: number;
  private undoOpenedAt = 0;
  private undoTimer?: ReturnType<typeof setTimeout>;
  /** The shown take's cancellation, until its server cleanup finishes. */
  private cancelling?: { take: Take; cleanup: Promise<void> };
  /** The take whose state the overlay shows. */
  private displayed?: Take;
  feedback = new RecordingFeedback();
  captureAllowed: () => boolean = () => true;
  /** The GUI shows progress; without it, recording start is announced by notification. */
  feedbackVisible: () => boolean = () => false;
  output?: Output;
  muteOutput = false;
  /** Background retries for a discard that failed transiently. */
  discardRetryDelaysMS = [1_000, 2_000, 4_000, 8_000, 15_000];
  private readonly retryingDiscards = new Set<Promise<void>>();
  /**
   * Client deadline once a take leaves the server queue: two speech attempts
   * (120 s loading + 180 s each), cloud fallback, and proofreading (30 s
   * loading + 18 s), with margin for polling and storage.
   */
  processingTimeoutMS = 720_000;
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
  /** A new take can start once the previous one is sealed, while it still processes. */
  get canStartTake() {
    return this.take === undefined && this.captureAllowed();
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
      "sources" | "start" | "heartbeat" | "stop" | "cancel" | "recording" | "delivery" | "context"
    > &
      Partial<Pick<API, "events">>,
    private desktop: Desktop,
    private device: Device,
    private preferences: SourcePreferences,
  ) {}
  start(button?: Take["button"], preview = false): boolean {
    // The dictation key doubles as the undo shortcut while the window is open.
    if (!button && !preview && this.undoTake) {
      this.undo();
      return true;
    }
    if (this.take || !this.captureAllowed()) return false;
    // Starting a new take settles an open undo window: the cancelled take is kept.
    this.closeUndo();
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
      gate: new DeliveryGate(),
      sealed: false,
      sealMayHaveSucceeded: false,
      button,
      preview,
      feedback: new RecordingFeedback(),
      feedbackAbort: new AbortController(),
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
          this.setState(
            take,
            "Capture failed. Any completed result remains in shared history.",
            "failed",
            // Once sealing began, the audio is on the server and only processing failed.
            take.sealMayHaveSucceeded
              ? notices.transcription
              : take.recordingAt === undefined
                ? notices.startup
                : notices.discarded,
          );
        await this.cancelTake(take);
      })
      .finally(() => {
        // A take handed off at its seal restored then; a newer take may be muting now.
        if (this.take === take) void take.output?.restore();
        take.feedbackAbort.abort();
        take.feedback.finish();
        take.destination?.close();
        clearInterval(take.watchdog);
        // A failed or cancelled take still frees its slot for later deliveries.
        take.delivered();
        if (this.undoTake === take) this.clearUndo();
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
    // Pairing-button taps are declined while any take records or processes.
    if (this.busy) return false;
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
    // A cancelled take may still be sealing; the press is its undo, not a stop.
    if (this.take && !this.undoTake) this.stop();
    else this.start();
  }
  /**
   * Cancels the take the overlay shows; earlier takes keep processing. A take with
   * usable audio is still transcribed into history, and for a few seconds the
   * dictation key or `sottoduo undo` inserts it after all. A second cancel closes
   * that window early.
   */
  async cancel(): Promise<void> {
    if (this.undoTake) {
      // One cancel can arrive through two paths; only a later one closes the window.
      if (Date.now() - this.undoOpenedAt > 300) this.closeUndo();
      return;
    }
    // The overlay shows the cancelled take until its cleanup finishes, so a repeat
    // joins that cancellation, unless a new take started or another take is shown.
    if (this.cancelling && this.displayed === this.cancelling.take) return this.cancelling.cleanup;
    const take = this.foreground;
    if (!take) {
      // Earlier takes' results stay recoverable while another take is cancelled.
      this.result = undefined;
      return this.announce("cancelled", "cancelled");
    }
    if (
      take === this.take &&
      take.activity.phase === "recording" &&
      take.recordingAt !== undefined &&
      Date.now() - take.recordingAt >= minimumTakeMS
    ) {
      take.gate = new DeliveryGate(true);
      take.released = true;
      this.openUndo(take);
      return;
    }
    // A take past recording, even one still sealing, is kept like queued work.
    const sealed = take !== this.take || take.activity.phase === "processing";
    if (sealed && take.gate.state === "discard") return;
    if (sealed && take.gate.hold()) {
      this.openUndo(take);
      return;
    }
    await this.cancelOne(take);
  }
  /** Inserts a cancelled take after all, as though it had ended normally. */
  undo() {
    const take = this.undoTake;
    if (!take) return;
    this.clearUndo();
    take.gate.decide(true);
    if (take === this.foreground) this.announce("processing", "processing", take.activity);
  }
  private openUndo(take: Take) {
    this.clearUndo();
    this.undoTake = take;
    this.undoOpenedAt = Date.now();
    this.undoUntil = this.undoOpenedAt + undoWindowMS;
    this.undoTimer = setTimeout(() => this.closeUndo(), undoWindowMS);
    this.announce(
      "Not pasted. Press the dictation key to paste.",
      take.activity.phase,
      take.activity,
    );
    // Daemon-only setups have nothing else to offer the undo.
    if (!this.feedbackVisible()) this.desktop.notify(...notices.undo);
  }
  private clearUndo() {
    clearTimeout(this.undoTimer);
    this.undoTake = undefined;
    this.undoUntil = undefined;
    this.activity = { ...this.activity, undoUntil: undefined };
  }
  /** Keeps the cancelled take in history only. */
  closeUndo() {
    const take = this.undoTake;
    if (!take) return;
    this.clearUndo();
    take.gate.decide(false);
    if (take === this.foreground)
      this.announce("Saving to history", take.activity.phase, take.activity);
  }
  /**
   * Cancels every take, or only those not yet delivering. `safety` is an automatic
   * cancellation (lock, suspend, lost session monitor), which is reported.
   */
  async cancelAll(includeDelivery = true, safety = false): Promise<void> {
    const takes = [this.take, ...this.processing].filter(
      (take): take is Take =>
        take !== undefined &&
        (includeDelivery || !["delivering", "completed"].includes(take.activity.phase)),
    );
    if (safety && takes.some((take) => !take.preview)) this.desktop.notify(...notices.safety);
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
    this.activity = { ...activity, phase, undoUntil: this.undoUntil };
    this.state = state;
  }
  /**
   * Only the foreground take drives the overlay. A notice is shown for any take
   * except a microphone test, whose outcome stays in the window.
   */
  private setState(take: Take, state: string, phase: Phase = "failed", notice?: Notice) {
    const shown = take === this.foreground;
    take.state = state;
    take.activity = { ...take.activity, phase };
    if (shown) {
      this.displayed = take;
      this.announce(state, phase, take.activity);
    }
    if (notice && !take.preview)
      this.desktop.notify(notice[0], shown ? notice[1] : `Earlier dictation: ${notice[1]}`);
  }
  private async cancelOne(take: Take) {
    if (this.undoTake === take) this.clearUndo();
    const shown = take === this.foreground;
    if (!shown) return this.cancelTake(take);
    this.setState(take, "cancelled", "cancelled");
    const cleanup = this.cancelTake(take);
    this.cancelling = { take, cleanup };
    await cleanup;
    // A newer take or cancellation owns the overlay now.
    if (this.cancelling?.cleanup !== cleanup) return;
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
    take.gate.decide(false);
    take.activity = { ...take.activity, phase: "cancelled" };
    take.feedbackAbort.abort();
    take.feedback.finish();
    take.feedback.unavailable();
    take.destination?.close();
    if (take.id && !take.sealed && !take.sealMayHaveSucceeded)
      await this.discard(take.id, take.owner);
    // The server discards an admission whose requester gave up before learning its ID.
  }
  /**
   * An explicit cancel must win over the server's archive-only sealing of an
   * expired lease, so a discard that fails transiently keeps retrying in the
   * background through a brief outage.
   */
  private async discard(id: string, owner: string) {
    const transient = (error: unknown) =>
      !(error instanceof APIError) || error.status >= 500 || [408, 429].includes(error.status);
    try {
      await this.api.cancel(id, owner);
    } catch (error) {
      if (!transient(error)) return;
      const retrying = (async () => {
        for (const delay of this.discardRetryDelaysMS) {
          await Bun.sleep(delay);
          try {
            return await this.api.cancel(id, owner);
          } catch (retry) {
            if (!transient(retry)) return;
          }
        }
      })().finally(() => this.retryingDiscards.delete(retrying));
      this.retryingDiscards.add(retrying);
    }
  }
  /** Quitting waits for discards still retrying, so a cancelled take is never archived. */
  async discardsSettled() {
    await Promise.allSettled([...this.retryingDiscards]);
  }
  /**
   * The server closed the capture: it seals recorded audio archive-only or drops
   * an empty take, so this take ends without discarding the recording.
   */
  private interrupt(take: Take, state: string, notice: Notice) {
    if (take.sealMayHaveSucceeded) return;
    take.sealed = true;
    take.interrupted ??= { state, notice };
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
        if (!take.preview) this.desktop.notify(...notices.safety);
        await this.cancelOne(take);
        return;
      }
      if (take.id && !take.sealed && this.live(take)) {
        try {
          await this.api.heartbeat(take.id, take.owner);
        } catch (error) {
          const closed =
            error instanceof APIError && error.status === 409 && error.code === "capture_closed";
          if (closed && !take.released)
            this.interrupt(
              take,
              "The microphone stopped. Any recorded audio is saved in history.",
              notices.microphone,
            );
          else if (!take.sealed && !closed) throw error;
        }
      }
    } catch {
      if (take.sealMayHaveSucceeded) return;
      if (this.live(take) && !["delivering", "completed"].includes(take.activity.phase)) {
        // Announce before cancelling, while the take still decides the overlay.
        this.setState(take, "Connection lost; dictation cancelled.", "failed", notices.connection);
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
    const [{ sources, sharingHost }, defaultID] = await Promise.all([
      this.api.sources(),
      this.desktop.defaultInput(this.preferences.hostID),
      take.muting,
    ]);
    const options = take.button
      ? sources.filter((source) => sourceKey(source.identity) === sourceKey(take.button!.source))
      : candidates(sources, this.preferences, defaultID, this.device.id);
    // One take at a time per server: another computer's take holds every microphone.
    const holder = sources.find(
      (source) => source.recordingFor && source.recordingFor.id !== this.device.id,
    )?.recordingFor;
    if (!options.length && holder) {
      const remote = sharingHost?.local === false ? sharingHost.name : undefined;
      this.setState(
        take,
        `${remote ?? "This computer"} is busy with ${holder.name}. Try again when it is free.`,
        "failed",
        [
          "Microphone in use",
          `${holder.name} is using the microphone on ${remote ?? "this computer"}. Try again when it's free.`,
        ],
      );
      return;
    }
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
        // This client keeps no cross-take continuation; release the server's context hold.
        void this.api.context(record.id, take.owner).catch(() => {});
        take.activity = {
          ...take.activity,
          source: source.name,
          host: sharingHost && !sharingHost.local ? sharingHost.name : undefined,
        };
        take.feedback.begin();
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
              if (update.capture.state === "stopped" && update.captureState !== "discarded")
                this.interrupt(
                  take,
                  `${update.error ?? "The microphone stopped."} The recording is saved in history.`,
                  notices.microphone,
                );
              else if (
                update.capture.state === "recording" &&
                update.processingState === "failed" &&
                !take.sealMayHaveSucceeded
              ) {
                // Recognition gave up mid-take: seal what was captured and keep it for retry.
                this.interrupt(
                  take,
                  update.error ?? "Recognition failed. The recording is saved in history.",
                  notices.transcription,
                );
                void this.api.stop(record.id, take.owner).catch(() => {});
              }
              this.noteRecognition(take, update);
              take.feedback.update(
                update.capture.state === "recording" ? update.capture.peak : undefined,
                update.previewText,
                update.processingState === "processing" ? "transcribing" : update.processingState,
              );
            })
            .catch(() => {
              if (this.live(take) && !take.feedbackAbort.signal.aborted)
                take.feedback.unavailable();
            });
        }
        take.recordingAt = Date.now();
        this.setState(
          take,
          `recording · ${source.name}`,
          "recording",
          // Daemon-only setups have no overlay to say when speech is captured.
          this.feedbackVisible() || take.preview ? undefined : ["Recording", "Speak now."],
        );
        break;
      } catch (error) {
        if (take.button || !(error instanceof APIError && error.allowsFallback)) throw error;
        take.requestID = randomUUID().toUpperCase();
        take.owner = randomBytes(32).toString("hex");
      }
    }
    if (!take.id) throw new Error("No available microphone.");
    // Recording sessions have no duration limit; the take ends on release.
    while (this.live(take) && !take.released && !take.interrupted) await Bun.sleep(40);
    if (!this.live(take)) return;
    if (take.interrupted) {
      this.setState(take, take.interrupted.state, "failed", take.interrupted.notice);
      return;
    }
    take.feedback.finish();
    this.setState(take, "processing", "processing");
    take.sealMayHaveSucceeded = true;
    const stopped = await this.api.stop(take.id, take.owner);
    this.verify(stopped, take);
    this.noteRecognition(take, stopped);
    if (stopped.capture?.state !== "sealed") throw new Error("Capture was not sealed.");
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
    // Speech is processed during capture. Once the server starts on this take
    // (queue wait has no client deadline), allow two speech attempts with cold
    // loading, cloud fallback and proofreading, or a step as long as the take.
    // Every server checkpoint renews the deadline, so a slow backlog of
    // windows never times out while the server is still making progress.
    const seconds =
      (stopped.stopRuns ?? []).reduce((sum, run) => sum + run.inferenceFrames, 0) / 16000;
    const budget = Math.max(this.processingTimeoutMS, seconds * 1000);
    const settled = (value: Recording) =>
      value.captureState === "discarded" || ["completed", "failed"].includes(value.processingState);
    let detail: RecordingDetail = { snapshot: stopped };
    let deadline: number | undefined;
    let revision: number | undefined;
    let failingSince: number | undefined;
    while (this.live(take) && !settled(detail.snapshot)) {
      if (detail.snapshot.processingState !== "queued" && detail.snapshot.revision !== revision) {
        revision = detail.snapshot.revision;
        deadline = Date.now() + budget;
      }
      if (deadline !== undefined && Date.now() >= deadline)
        throw new Error("Processing timed out.");
      await Bun.sleep(300);
      if (!this.live(take)) return;
      try {
        detail = await this.api.recording(take.id);
        failingSince = undefined;
        // The live stream is optional; polled snapshots also carry a fallback.
        this.noteRecognition(take, detail.snapshot);
      } catch (error) {
        // The sealed take is durable on the server, so ride out a brief outage.
        if (error instanceof APIError && error.status < 500) throw error;
        failingSince ??= Date.now();
        if (Date.now() - failingSince >= this.processingTimeoutMS) throw error;
      }
    }
    if (!this.live(take)) return;
    this.verify(detail.snapshot, take);
    const record = detail.result;
    if (detail.snapshot.processingState !== "completed" || !record)
      throw new Error("Transcription did not complete.");
    // Deliver after every earlier take, and never while a newer take is held.
    await take.turn;
    if (!this.live(take)) return;
    // Decide only now, so a take still queued behind another can be cancelled with undo.
    if (!(await take.gate.consume())) {
      // Cancelled and not undone: the transcript stays in history only.
      // Nothing is inserted, so later takes need not wait for the receipt.
      take.delivered();
      if (!this.live(take)) return;
      take.activity = { ...take.activity, kept: true };
      this.setState(take, "Saved to history", "cancelled");
      await this.api.delivery(take.id, take.owner, "cancelled").catch(() => {});
      return;
    }
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
    if (delivery === "inserted") this.setState(take, "Text inserted", "completed");
    else if (delivery === "uncertain")
      this.setState(
        take,
        "Insertion uncertain. Check the field before copying.",
        "completed",
        notices.uncertain,
      );
    else
      this.setState(
        take,
        "Text ready. Use sottoduo result or sottoduo copy.",
        "completed",
        notices.ready,
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
        console.warn("Delivery receipt could not be saved; insertion will not be retried.");
      });
  }
  /** Mirrors the Mac: local recognition with a fallback reason means cloud is unavailable. */
  private noteRecognition(take: Take, update: Recording) {
    const fallback =
      update.recognition?.provider === "whisper" && !!update.recognition.fallbackReason;
    if (fallback === !!take.activity.cloudUnavailable) return;
    take.activity = { ...take.activity, cloudUnavailable: fallback };
    if (take === this.foreground) this.activity = { ...this.activity, cloudUnavailable: fallback };
  }
  private verify(record: Recording, take: Take) {
    if (
      record.id !== take.id ||
      record.requestID !== take.requestID ||
      record.device.id !== this.device.id
    )
      throw new Error("Mismatched generation.");
  }
}
