import type { components } from "./generated/api.ts";
import type {
  AudioKind,
  AudioStreamFormat,
  GenerationRecord,
  FinishGenerationRequest,
} from "./api.ts";
import type { GenerationService } from "./generation-service.ts";
import { ServiceError } from "./errors.ts";
import { validateBody } from "./validation.ts";

type Source = components["schemas"]["AudioSource"];
type StartRequest = components["schemas"]["StartCaptureRequest"];
type StopRequest = components["schemas"]["StopCaptureRequest"];
export const captureLimits = {
  readyMS: 5_000,
  leaseMS: 6_000,
  drainMS: 5_000,
  sourceAgeMS: 3_500,
  maximumMS: 180_000,
} as const;

export interface CaptureHandle {
  /** Stop the device, drain acknowledged writes, then return the exact retained frame counts. */
  stop(): Promise<Omit<FinishGenerationRequest, "continuationID">>;
}
export interface CaptureProvider {
  /** Bounded cached observations only. Never open audio or connect Bluetooth for discovery. */
  sources(): Source[];
  /** Abort must stop hardware independently of this promise settling, including during startup. */
  start(options: {
    generation: GenerationRecord;
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
  controller: AbortController;
  leaseUntil: number;
  startedAt: number;
  state: "preparing" | "recording" | "stopping";
  ready: Promise<GenerationRecord>;
  handle?: CaptureHandle;
  stopping?: Promise<GenerationRecord>;
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
    private readonly service: GenerationService,
    private readonly provider?: CaptureProvider,
  ) {}

  sources(): components["schemas"]["AudioSourceList"] {
    const snapshot = structuredClone(this.provider?.sources() ?? []);
    validateBody("AudioSourceList", { sources: snapshot });
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
  start(request: StartRequest, owner?: string): Promise<GenerationRecord> {
    if (!owner || !/^[0-9a-f]{64}$/.test(owner))
      return Promise.reject(
        new ServiceError(
          403,
          "capture_owner_required",
          "Supply a unique 256-bit capture owner secret.",
        ),
      );
    let button: ReturnType<GenerationService["buttons"]["claim"]> | undefined;
    try {
      if (request.buttonTicket) button = this.service.buttons.claim(request, owner);
    } catch (error) {
      return Promise.reject(error);
    }
    // Serialize reservation, not hardware startup; cancel/heartbeat remain responsive while preparing.
    const admitted = this.admission.then(async () => {
      button?.signal.throwIfAborted();
      if (this.stopping)
        throw new ServiceError(503, "server_stopping", "The server is shutting down.");
      const existing = await this.service.findRequest(request.requestID, request.device.id);
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
        await this.service.authorizeCapture(existing.id, owner);
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
      const record = await this.service.create(request, { source: request.source, owner });
      if (button?.signal.aborted) {
        await this.service.cancel(record.id, "The button destination is no longer available.");
        throw closed();
      }
      button?.admitted(record.id);
      if (this.active?.id === record.id) return { ready: this.active.ready };
      if (record.capture?.state !== "preparing" || record.status !== "receiving")
        return { ready: Promise.resolve(record) };
      const session: Session = {
        id: record.id,
        source: structuredClone(request.source),
        controller: new AbortController(),
        leaseUntil: Date.now() + captureLimits.leaseMS,
        startedAt: Date.now(),
        state: "preparing",
        ready: Promise.resolve(record),
        lastLevelAt: 0,
        buttonReady: button?.ready,
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
        else if (
          session.state !== "stopping" &&
          Date.now() - session.startedAt >= captureLimits.maximumMS
        )
          void this.fail(session, "The recording reached its time limit.");
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
  private async prepare(session: Session, generation: GenerationRecord) {
    try {
      session.handle = await this.bounded(
        session,
        this.provider!.start({
          generation,
          signal: session.controller.signal,
          write: async (kind, sequence, format, bytes) => {
            this.requireActive(session);
            await this.service.appendAudio(session.id, kind, sequence, format, bytes);
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
            void this.service.updateCapture(session.id, "recording", peak).catch(() => {});
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
      const record = await this.service.updateCapture(session.id, "recording");
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
    await this.service.authorizeCapture(id, owner);
    const session = this.active;
    if (!session || session.id !== id.toUpperCase()) throw closed();
    this.requireActive(session);
    session.leaseUntil = Date.now() + captureLimits.leaseMS;
  }
  async stop(id: string, request: StopRequest, owner?: string) {
    await this.service.authorizeCapture(id, owner);
    const record = await this.service.get(id);
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
      await this.service.updateCapture(session.id, "stopping");
      const counts = await this.bounded(session, session.handle!.stop(), captureLimits.drainMS);
      this.requireActive(session);
      const record = await this.service.finish(session.id, {
        ...counts,
        continuationID: session.continuationID,
      });
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
  private async fail(session: Session, message: string) {
    if (this.active !== session) return;
    this.abort(session.id);
    await this.service.cancel(session.id, message).catch(() => {});
  }
  async shutdown() {
    this.stopping = true;
    await this.admission;
    if (this.active) await this.fail(this.active, "The capture host is shutting down.");
  }
}
