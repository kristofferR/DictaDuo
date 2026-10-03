import type { components } from "./generated/api.ts";
import type {
  AudioKind,
  AudioStreamFormat,
  FinishGenerationRequest,
  PreferencesSnapshot,
  StartCaptureRequest,
} from "./api.ts";
import type { ButtonDestinations } from "./button-destinations.ts";
import type { RecordingSnapshot } from "./recording-contract.ts";
import { ServiceError } from "./errors.ts";
import { validateBody } from "./validation.ts";
import { MicrophoneSharing } from "./microphone-sharing.ts";
import { hostname } from "node:os";

type Source = components["schemas"]["AudioSource"];
type StartRequest = components["schemas"]["StartCaptureRequest"];
type StopRequest = components["schemas"]["StopCaptureRequest"];
export const captureLimits = {
  readyMS: 5_000,
  leaseMS: 6_000,
  drainMS: 5_000,
  sourceAgeMS: 3_500,
  /** Backoff for sealing an interrupted take's checkpoint after a transient failure. */
  sealRetryMS: [250, 1_000, 3_000, 10_000],
} as const;
type CaptureState = NonNullable<RecordingSnapshot["capture"]>["state"];
type Counts = Omit<FinishGenerationRequest, "continuationID">;

/** Durable session storage for provider audio; implemented by RecordingService. */
export interface CaptureStore {
  findRequest(requestID: string, deviceID: string): Promise<RecordingSnapshot | undefined>;
  createCapture(request: StartCaptureRequest, owner: string): Promise<RecordingSnapshot>;
  authorizeCapture(id: string, owner?: string): Promise<void>;
  appendCaptureAudio(
    id: string,
    kind: AudioKind,
    sequence: number,
    firstFrame: number,
    format: AudioStreamFormat,
    bytes: Uint8Array,
  ): Promise<void>;
  updateCapture(
    id: string,
    state: CaptureState,
    peak?: number,
  ): Promise<RecordingSnapshot | undefined>;
  stopCapture(
    id: string,
    counts: Counts,
    continuationID?: string,
    interruption?: string,
  ): Promise<RecordingSnapshot>;
  get(id: string): Promise<RecordingSnapshot>;
  discard(id: string): Promise<RecordingSnapshot>;
}

export interface CaptureHandle {
  /** Stop the device, drain acknowledged writes, then return the exact retained frame counts. */
  stop(): Promise<Counts>;
}
export interface CaptureProvider {
  /** Bounded cached observations only. Never open audio or connect Bluetooth for discovery. */
  sources(): Source[];
  /** Abort must stop hardware independently of this promise settling, including during startup. */
  start(options: {
    generation: {
      id: string;
      settings: PreferencesSnapshot;
      capture?: { source: components["schemas"]["AudioSourceIdentity"] };
    };
    signal: AbortSignal;
    write(
      kind: AudioKind,
      sequence: number,
      format: AudioStreamFormat,
      bytes: Uint8Array,
    ): Promise<void>;
    level(peak: number): void;
    lost(): void;
  }): Promise<CaptureHandle>;
}
interface Session {
  id: string;
  source: StartRequest["source"];
  device: StartRequest["device"];
  /** Admitted for a client on this computer, which may use unshared sources. */
  local: boolean;
  controller: AbortController;
  leaseUntil: number;
  startedAt: number;
  state: "preparing" | "recording" | "stopping";
  ready: Promise<RecordingSnapshot>;
  handle?: CaptureHandle;
  stopping?: Promise<RecordingSnapshot>;
  /** Frames durably written per kind; a failed take is sealed at these counts. */
  frames: Record<AudioKind, number>;
  /** Appends in flight; they settle before a failed take reads its counts. */
  writes: Set<Promise<void>>;
  retainsOriginal: boolean;
  continuationID?: string;
  timer?: ReturnType<typeof setInterval>;
  lastLevelAt: number;
  failure?: ServiceError;
  detachButton?: () => void;
  buttonReady?: () => void;
}
const sameSource = (a: StartRequest["source"], b: StartRequest["source"]) =>
  a.hostID === b.hostID && a.id === b.id;
const closed = () => new ServiceError(409, "capture_closed", "This capture is no longer active.");

/** Coordinates a trusted local provider and admits one remote capture at a time. */
export class CaptureSessions {
  private active?: Session;
  private admission: Promise<unknown> = Promise.resolve();
  private stopping = false;
  constructor(
    private readonly store: CaptureStore,
    private readonly buttons: ButtonDestinations,
    private readonly provider?: CaptureProvider,
    readonly sharing = new MicrophoneSharing(),
  ) {}

  /**
   * What a client may see. Other computers only see shared sources; a client on
   * this computer sees every source and which ones are shared.
   */
  sourcesFor(local: boolean): components["schemas"]["AudioSourceList"] {
    const active = this.active;
    const sources = this.sources()
      .sources.map((source) => ({
        ...source,
        shared: this.sharing.isShared(source.identity),
        // The provider records one take at a time, so a take holds every source.
        ...(active ? { recordingFor: structuredClone(active.device) } : {}),
      }))
      .filter((source) => local || source.shared);
    return { sources, sharingHost: { name: hostname().slice(0, 128) || "server", local } };
  }
  async setSharing(source: StartRequest["source"], shared: boolean, local: boolean) {
    if (!local)
      throw new ServiceError(
        403,
        "sharing_local_only",
        "Change microphone sharing on the computer the microphone is plugged into.",
      );
    if (!this.sources().sources.some((item) => sameSource(item.identity, source)))
      throw new ServiceError(404, "source_not_found", "This microphone is not connected.");
    await this.sharing.set(source, shared);
    // Unsharing also ends another computer's take on that microphone.
    const active = this.active;
    if (!shared && active && !active.local && sameSource(active.source, source))
      await this.fail(active, "The microphone stopped being shared, so recording stopped.");
    return this.sourcesFor(local);
  }

  sources(): components["schemas"]["AudioSourceList"] {
    const snapshot = structuredClone(this.provider?.sources() ?? []);
    validateBody("AudioSourceList", { sources: snapshot });
    this.sharing.observe(snapshot.map((source) => source.identity));
    const identities = new Set<string>();
    for (const source of snapshot) {
      const identity = JSON.stringify([source.identity.hostID, source.identity.id]);
      if (identities.has(identity))
        throw new ServiceError(503, "invalid_sources", "Capture source identities are not unique.");
      identities.add(identity);
      source.observedAt = new Date(source.observedAt).toISOString().replace(/\.\d{3}Z$/, "Z");
      const age = Date.now() - Date.parse(source.observedAt);
      if (age < 0 || age > captureLimits.sourceAgeMS) {
        source.link = "unknown";
        source.capture = "unknown";
        source.audioHealth = "unknown";
        source.reason = "Source status is stale.";
      }
    }
    return { sources: snapshot };
  }
  private eligible(identity: StartRequest["source"]) {
    const source = this.sources().sources.find((source) => sameSource(source.identity, identity));
    return (
      source?.present &&
      source.capture === "available" &&
      (source.link === "connected" || source.link === "notApplicable") &&
      source.audioHealth !== "degraded"
    );
  }
  /** `local` requests come from this computer and may use unshared sources. */
  start(request: StartRequest, owner?: string, local = true): Promise<RecordingSnapshot> {
    if (!owner || !/^[0-9a-f]{64}$/.test(owner))
      return Promise.reject(
        new ServiceError(
          403,
          "capture_owner_required",
          "Supply a unique 256-bit capture owner secret.",
        ),
      );
    let button: ReturnType<ButtonDestinations["claim"]> | undefined;
    try {
      if (request.buttonTicket) button = this.buttons.claim(request, owner);
    } catch (error) {
      return Promise.reject(error);
    }
    // Serialize reservation, not hardware startup; cancel/heartbeat remain responsive while preparing.
    const admitted = this.admission.then(async () => {
      button?.signal.throwIfAborted();
      if (this.stopping)
        throw new ServiceError(503, "server_stopping", "The server is shutting down.");
      const existing = await this.store.findRequest(request.requestID, request.device.id);
      const active = this.active;
      if (existing && active?.id === existing.id) {
        if (
          !existing.capture ||
          !sameSource(existing.capture.source, request.source) ||
          existing.mode !== request.mode
        )
          throw new ServiceError(
            409,
            "conflicting_request",
            "This request already selects another source or mode.",
          );
        await this.store.authorizeCapture(existing.id, owner);
        if (this.active !== active) throw closed();
        return { ready: active.ready };
      }
      // Recordings queue for processing, but one provider records one take at a time.
      if (!existing && active)
        throw new ServiceError(
          409,
          "capture_busy",
          "The server microphone is recording another take. Try again when it stops.",
        );
      if (!existing && (!this.provider || !this.eligible(request.source)))
        throw new ServiceError(
          503,
          "source_unavailable",
          "The selected microphone is not available. Resolve another input before recording.",
        );
      // Same code as an unavailable source, so clients fall back to their next input.
      if (!existing && !local && !this.sharing.isShared(request.source))
        throw new ServiceError(
          503,
          "source_unavailable",
          "This microphone is not shared with other computers.",
        );
      const record = await this.store.createCapture(request, owner);
      // Sharing may have been turned off while the session was being created.
      if (button?.signal.aborted || (!local && !this.sharing.isShared(request.source))) {
        await this.store.discard(record.id);
        throw closed();
      }
      button?.admitted(record.id);
      if (this.active?.id === record.id) return { ready: this.active.ready };
      if (record.capture?.state !== "preparing") return { ready: Promise.resolve(record) };
      const session: Session = {
        id: record.id,
        source: structuredClone(request.source),
        device: structuredClone(request.device),
        local,
        controller: new AbortController(),
        leaseUntil: Date.now() + captureLimits.leaseMS,
        startedAt: Date.now(),
        state: "preparing",
        ready: Promise.resolve(record),
        lastLevelAt: 0,
        buttonReady: button?.ready,
        frames: { inference: 0, original: 0 },
        writes: new Set(),
        retainsOriginal: record.settings.preferences.keepOriginalAudio,
      };
      this.active = session;
      if (button) {
        const aborted = () => {
          void this.fail(session, "The button destination was disarmed or disconnected.");
        };
        button.signal.addEventListener("abort", aborted, { once: true });
        session.detachButton = () => button?.signal.removeEventListener("abort", aborted);
      }
      session.timer = setInterval(() => {
        if (session.state !== "stopping" && Date.now() >= session.leaseUntil)
          void this.fail(session, "The destination stopped renewing its recording lease.");
        else if (!this.safeEligible(session.source)) {
          if (session.state === "preparing")
            this.abortPreparation(
              session,
              new ServiceError(
                503,
                "source_unavailable",
                "The microphone became unavailable before recording was ready.",
              ),
            );
          else void this.fail(session, "The microphone became unavailable or its status expired.");
        }
      }, 250);
      session.timer.unref();
      session.ready = this.prepare(session, record);
      return { ready: session.ready };
    });
    this.admission = admitted.catch(() => {});
    return admitted.then(({ ready }) => ready);
  }
  private safeEligible(identity: StartRequest["source"]) {
    try {
      return this.eligible(identity);
    } catch {
      return false;
    }
  }
  private async prepare(session: Session, generation: RecordingSnapshot) {
    try {
      session.handle = await this.bounded(
        session,
        this.provider!.start({
          generation: {
            id: generation.id,
            settings: generation.settings,
            capture: generation.capture,
          },
          signal: session.controller.signal,
          write: (kind, sequence, format, bytes) => {
            const write = (async () => {
              this.requireActive(session);
              await this.store.appendCaptureAudio(
                session.id,
                kind,
                sequence,
                session.frames[kind],
                format,
                bytes,
              );
              session.frames[kind] += bytes.length / (format.channels * 4);
            })();
            session.writes.add(write);
            const settle = () => session.writes.delete(write);
            write.then(settle, settle);
            return write;
          },
          level: (peak) => {
            if (
              !Number.isFinite(peak) ||
              this.active !== session ||
              session.state !== "recording" ||
              Date.now() - session.lastLevelAt < 100
            )
              return;
            session.lastLevelAt = Date.now();
            void this.store.updateCapture(session.id, "recording", peak).catch(() => {});
          },
          lost: () => {
            if (session.state === "preparing")
              this.abortPreparation(
                session,
                new ServiceError(
                  503,
                  "capture_failed",
                  "The microphone could not start recording.",
                ),
              );
            else void this.fail(session, "The microphone lost its audio source.");
          },
        }),
        captureLimits.readyMS,
      );
      this.requireActive(session);
      if (!this.safeEligible(session.source))
        throw new ServiceError(
          503,
          "source_unavailable",
          "The microphone became unavailable before recording was ready.",
        );
      session.state = "recording";
      const record = (await this.store.updateCapture(session.id, "recording"))!;
      this.requireActive(session);
      session.buttonReady?.();
      return record;
    } catch (error) {
      await this.fail(session, "The microphone could not start recording.");
      throw error instanceof ServiceError
        ? error
        : new ServiceError(503, "capture_failed", "The microphone could not start recording.");
    }
  }
  private requireActive(session: Session) {
    if (
      this.active !== session ||
      session.controller.signal.aborted ||
      (session.state !== "stopping" && Date.now() >= session.leaseUntil)
    )
      throw closed();
  }
  private bounded<T>(session: Session, work: Promise<T>, milliseconds: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(session.failure ?? closed());
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new ServiceError(503, "capture_timeout", "The microphone did not respond in time."));
        session.controller.abort();
      }, milliseconds);
      const cleanup = () => {
        clearTimeout(timer);
        session.controller.signal.removeEventListener("abort", abort);
      };
      session.controller.signal.addEventListener("abort", abort, { once: true });
      if (session.controller.signal.aborted) abort();
      work.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }
  private abortPreparation(session: Session, error: ServiceError) {
    if (this.active !== session || session.state !== "preparing") return;
    session.failure = error;
    session.controller.abort();
  }
  async heartbeat(id: string, owner?: string) {
    await this.store.authorizeCapture(id, owner);
    const session = this.active;
    if (!session || session.id !== id.toUpperCase()) throw closed();
    this.requireActive(session);
    session.leaseUntil = Date.now() + captureLimits.leaseMS;
  }
  async stop(id: string, request: StopRequest, owner?: string) {
    await this.store.authorizeCapture(id, owner);
    const record = await this.store.get(id);
    if (!record.capture) throw closed();
    const session = this.active;
    if (!session || session.id !== record.id) {
      if (record.capture.state === "sealed") {
        if (record.capture.continuationID !== request.continuationID?.toUpperCase())
          throw new ServiceError(
            409,
            "conflicting_stop",
            "The capture was already stopped with different continuation context.",
          );
        return record;
      }
      throw closed();
    }
    this.requireActive(session);
    if (session.stopping) {
      if (session.continuationID !== request.continuationID?.toUpperCase())
        throw new ServiceError(
          409,
          "conflicting_stop",
          "The capture was already stopped with different continuation context.",
        );
      return session.stopping;
    }
    if (session.state !== "recording" || !session.handle)
      throw new ServiceError(
        409,
        "capture_not_ready",
        "Wait for recording readiness or cancel this take.",
      );
    session.state = "stopping";
    session.continuationID = request.continuationID?.toUpperCase();
    session.stopping = this.finish(session);
    return session.stopping;
  }
  private async finish(session: Session) {
    try {
      await this.store.updateCapture(session.id, "stopping");
      const counts = await this.bounded(session, session.handle!.stop(), captureLimits.drainMS);
      this.requireActive(session);
      const record = await this.store.stopCapture(session.id, counts, session.continuationID);
      this.abort(session.id);
      return record;
    } catch (error) {
      await this.fail(session, "The microphone could not complete the recording.");
      throw error instanceof ServiceError
        ? error
        : new ServiceError(
            503,
            "capture_failed",
            "The microphone could not complete the recording.",
          );
    }
  }
  abort(id: string) {
    const session = this.active;
    if (!session || session.id !== id.toUpperCase()) return;
    this.active = undefined;
    clearInterval(session.timer);
    session.detachButton?.();
    session.controller.abort();
  }
  /**
   * Stops the hardware. Audio already written is sealed at its exact counts and
   * finishes archive-only; a take with no audio is discarded.
   */
  private async fail(session: Session, message: string) {
    if (this.active !== session) return;
    this.abort(session.id);
    // Aborting fences new writes; an append already in flight may still land.
    await Promise.allSettled(session.writes);
    const { inference, original } = session.frames;
    if (inference === 0) {
      await this.store.discard(session.id).catch(() => {});
      return;
    }
    const counts = {
      inferenceFrames: inference,
      ...(session.retainsOriginal ? { originalFrames: original } : {}),
    };
    // Nothing else retries this seal once the session left `active`, so a
    // transient failure retries the same counts. Never discard retained audio
    // here: if the server stops first, startup recovery seals this prefix.
    for (const delay of [0, ...captureLimits.sealRetryMS]) {
      if (delay) {
        if (this.stopping) return;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        await this.store.stopCapture(session.id, counts, undefined, message);
        return;
      } catch (error) {
        if (error instanceof ServiceError && error.status < 500) return;
      }
    }
  }
  async shutdown() {
    this.stopping = true;
    await this.admission;
    if (this.active) await this.fail(this.active, "The capture host is shutting down.");
    // A first discovery after upgrading records which microphones stay shared.
    await this.sharing.settled();
  }
}
