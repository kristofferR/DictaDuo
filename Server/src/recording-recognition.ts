import type {
  LiveSpeechStream,
  SonioxConfiguration,
  StartLiveSpeechStream,
} from "./inference/soniox.ts";

const SAMPLE_RATE = 16_000;
/** After the speaker pauses, commit once this much audio is uncommitted. */
const COMMIT_AFTER_ENDPOINT_FRAMES = 20 * SAMPLE_RATE;
/** Continuous speech still commits; the cut may fall inside an utterance. */
const FORCE_COMMIT_FRAMES = 90 * SAMPLE_RATE;
/** Well below the provider's 300-minute session cap. */
const ROLLOVER_MS = 4 * 60 * 60 * 1000;
/** The provider expects near real-time pacing; replays may run slightly faster. */
const PACE = 1.5;
const BURST_FRAMES = 2 * SAMPLE_RATE;
const FEED_FRAMES = SAMPLE_RATE / 2;
/** The provider closes a session after about 20 s without audio. */
const KEEPALIVE_MS = 5_000;
/** A provider that never answers a finalize request is treated as failed. */
const FINALIZE_TIMEOUT_MS = 30_000;
/** Automatic mode hands a backlog this large to local recognition. */
const BACKLOG_FRAMES = 60 * SAMPLE_RATE;
const TICK_MS = 100;

/** Final provider text covering exactly [startFrame, endFrame) of one capture run. */
export interface LiveSegment {
  runID: string;
  startFrame: number;
  endFrame: number;
  text: string;
  language: string;
  processingSeconds: number;
}

export interface LiveRunState {
  runID: string;
  /** First run frame without committed text. */
  cursorFrame: number;
  /** Durably acknowledged run frames. */
  availableFrames: number;
  /** Set once the run's endpoint is fixed by pause or stop. */
  endFrame?: number;
  language: string;
  terms: string[];
  /** Cloud-only sessions replay a backlog instead of falling back. */
  cloudOnly: boolean;
}

interface LiveStream {
  state: LiveRunState;
  stream: LiveSpeechStream;
  /** Times are monotonic, so wall-clock changes never stall pacing or deadlines. */
  startedAt: number;
  startFrame: number;
  fedFrame: number;
  commitFrame: number;
  finalizing?: { endFrame: number; sentAt: number };
  /** Set once a rollover begins: feeding stops so the session can drain and close. */
  rollingOver: boolean;
  endpointSeen: boolean;
  feeding: boolean;
  lastSentAt: number;
  /** Token bucket: frames that may be sent now without exceeding the pace. */
  credit: number;
  creditAt: number;
  ready: LiveSegment[];
}

export interface LiveRecognitionCallbacks {
  read(id: string, runID: string, firstFrame: number, frameCount: number): Promise<Buffer>;
  preview(id: string, text: string): void;
  /** A segment is ready for the recording worker. */
  segment(id: string): void;
  failed(id: string, reason: string): void;
}

/**
 * Streams each recording's durable inference audio to a live provider exactly
 * once, from its committed text cursor, and turns finalized provider text into
 * frame-exact segments. Provider state is never durable: after a restart or
 * failure a new stream resumes from the committed cursor.
 */
export class LiveRecognition {
  private readonly streams = new Map<string, LiveStream>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly configuration: SonioxConfiguration,
    private readonly start: StartLiveSpeechStream,
    private readonly callbacks: LiveRecognitionCallbacks,
  ) {}

  /**
   * Updates a run's state and returns the next ready segment at its cursor.
   * Starts a stream at the cursor when none is running for this run.
   */
  sync(id: string, state: LiveRunState): LiveSegment | undefined {
    let live = this.streams.get(id);
    if (live && (live.state.runID !== state.runID || live.commitFrame < state.cursorFrame)) {
      this.close(id);
      live = undefined;
    }
    if (!live) {
      if (state.endFrame !== undefined && state.cursorFrame >= state.endFrame) return undefined;
      live = this.open(id, state);
    }
    live.state = state;
    const next = live.ready[0];
    if (next && next.startFrame === state.cursorFrame) return next;
    if (next && next.startFrame < state.cursorFrame) live.ready.shift();
    return undefined;
  }

  /** The worker committed this segment; drop it from the ready queue. */
  consumed(id: string, segment: LiveSegment) {
    const live = this.streams.get(id);
    if (live?.ready[0] === segment) live.ready.shift();
    if (live && live.ready.length === 0 && this.finished(live)) this.close(id);
  }

  /** New durable audio arrived; feeding happens on the next tick. */
  notify(id: string, runID: string, availableFrames: number) {
    const live = this.streams.get(id);
    if (live?.state.runID === runID)
      live.state.availableFrames = Math.max(live.state.availableFrames, availableFrames);
  }

  close(id: string) {
    this.streams.get(id)?.stream.close();
    this.streams.delete(id);
    if (!this.streams.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  shutdown() {
    for (const id of [...this.streams.keys()]) this.close(id);
  }

  /** Ends a failed stream; the worker falls back or retries from its cursor. */
  private fail(id: string, reason: string) {
    this.close(id);
    this.callbacks.failed(id, reason);
  }

  private finished(live: LiveStream) {
    return live.state.endFrame !== undefined && live.commitFrame >= live.state.endFrame;
  }

  private open(id: string, state: LiveRunState) {
    const now = performance.now();
    const live: LiveStream = {
      state,
      startedAt: now,
      startFrame: state.cursorFrame,
      fedFrame: state.cursorFrame,
      commitFrame: state.cursorFrame,
      rollingOver: false,
      endpointSeen: false,
      feeding: false,
      lastSentAt: now,
      credit: BURST_FRAMES,
      creditAt: now,
      ready: [],
      stream: undefined!,
    };
    live.stream = this.start(this.configuration, state.language, state.terms, id, {
      partial: (text) => {
        if (this.streams.get(id) === live) this.callbacks.preview(id, text);
      },
      endpoint: () => {
        live.endpointSeen = true;
      },
      finalized: ({ text, language }) => {
        if (this.streams.get(id) !== live || !live.finalizing) return;
        live.ready.push({
          runID: live.state.runID,
          startFrame: live.commitFrame,
          endFrame: live.finalizing.endFrame,
          text,
          language,
          processingSeconds: (performance.now() - live.finalizing.sentAt) / 1000,
        });
        live.commitFrame = live.finalizing.endFrame;
        live.finalizing = undefined;
        this.callbacks.segment(id);
      },
      failed: (reason) => {
        if (this.streams.get(id) === live) this.fail(id, reason);
      },
    });
    this.streams.set(id, live);
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    return live;
  }

  private tick() {
    const now = performance.now();
    for (const [id, live] of this.streams) {
      const state = live.state;
      const target = state.endFrame ?? state.availableFrames;
      if (
        !state.cloudOnly &&
        Math.min(target, state.availableFrames) - live.fedFrame > BACKLOG_FRAMES
      ) {
        this.fail(id, "Cloud transcription fell behind, so the server transcribed locally.");
        continue;
      }
      // Pace against recent sending, so a long upload gap never becomes a burst.
      live.credit = Math.min(
        BURST_FRAMES,
        live.credit + ((now - live.creditAt) / 1000) * SAMPLE_RATE * PACE,
      );
      live.creditAt = now;
      const rollover = now - live.startedAt > ROLLOVER_MS;
      if (!live.feeding) {
        const until = Math.min(
          state.availableFrames,
          target,
          live.fedFrame + Math.min(FEED_FRAMES, Math.floor(live.credit)),
        );
        if (live.fedFrame < until && !live.rollingOver) {
          live.credit -= until - live.fedFrame;
          void this.feed(id, live, until);
        } else if (now - live.lastSentAt > KEEPALIVE_MS) {
          live.stream.keepalive();
          live.lastSentAt = now;
        }
      }
      if (live.finalizing) {
        if (now - live.finalizing.sentAt > FINALIZE_TIMEOUT_MS) {
          this.fail(id, "Live recognition did not finalize in time.");
        }
        continue;
      }
      const uncommitted = live.fedFrame - live.commitFrame;
      const runFed = state.endFrame !== undefined && live.fedFrame >= state.endFrame;
      if (
        uncommitted > 0 &&
        (runFed ||
          (live.endpointSeen && uncommitted >= COMMIT_AFTER_ENDPOINT_FRAMES) ||
          uncommitted >= FORCE_COMMIT_FRAMES ||
          (rollover && (live.endpointSeen || live.rollingOver)))
      ) {
        live.finalizing = { endFrame: live.fedFrame, sentAt: now };
        live.rollingOver ||= rollover;
        live.endpointSeen = false;
        live.stream.finalize();
      } else if (rollover && uncommitted === 0 && !live.ready.length) {
        // Wake the worker: its next sync resumes from the committed cursor on a
        // fresh session, even when a stopped take gets no further audio.
        this.close(id);
        this.callbacks.segment(id);
      }
    }
  }

  private async feed(id: string, live: LiveStream, until: number) {
    live.feeding = true;
    try {
      const audio = await this.callbacks.read(
        id,
        live.state.runID,
        live.fedFrame,
        until - live.fedFrame,
      );
      if (this.streams.get(id) !== live) return;
      live.stream.send(audio);
      live.fedFrame = until;
      live.lastSentAt = performance.now();
    } catch {
      if (this.streams.get(id) === live)
        this.fail(id, "Saved audio could not be read for live recognition.");
    } finally {
      live.feeding = false;
    }
  }
}
