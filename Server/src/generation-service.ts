import { defaultProofreadingPrompt, preferencesValidationError } from "./domain/preferences.ts";
export { defaultProofreadingPrompt, preferencesValidationError } from "./domain/preferences.ts";
import { RecognitionSession } from "./inference/recognition.ts";
import type { SonioxConfiguration, StartSpeechStream } from "./inference/soniox.ts";
import { constants } from "node:fs";
import { access, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { CaptureSessions, type CaptureProvider, type CaptureStore } from "./capture-sessions.ts";
import { ButtonDestinations } from "./button-destinations.ts";
import { MicrophoneSharing } from "./microphone-sharing.ts";
import type {
  AudioArtifact,
  AudioChunkReceipt,
  AudioKind,
  AudioStreamFormat,
  CreateGenerationRequest,
  DeliveryReceipt,
  DictationContinuation,
  FinishGenerationRequest,
  GenerationPage,
  GenerationRecord,
  PreferencesSnapshot,
  ServerHealth,
  ServerPreferences,
  TextProcessingRecord,
  WisprFlowArtifactName,
  WisprFlowImportRequest,
  WisprFlowKnownIDsRequest,
} from "./api.ts";
import { API_VERSION, type RecognitionEngine } from "./api.ts";
import type { components } from "./generated/api.ts";
import { decodePersonalDictionary } from "./domain/dictionary.ts";
import { validateBody } from "./validation.ts";
import type { InferenceBackend } from "./inference/native-inference.ts";
import { ServiceError } from "./errors.ts";
import {
  detectedLanguage,
  engineName,
  localSpeechModel,
  recognitionEngine,
  selectedEngine,
} from "./inference/engines.ts";
import {
  atomicPrivateWrite,
  ensureDirectory,
  readRegularFile,
  requireDiskSpace,
  requireRegularDirectory,
} from "./storage.ts";
import { WisprFlowImports } from "./imports.ts";
import {
  applyDictionary,
  defaultDictionary,
  dictionaryVocabularyTerms,
  recognitionVocabularyTerms,
} from "./domain/dictionary.ts";
import { cleanTranscript } from "./domain/cleaner.ts";
import { composeDictation } from "./domain/composition.ts";
import { formatSpokenList } from "./domain/lists.ts";
import { evaluateCorrectionInWorker } from "./domain/correction-runtime.ts";
import { maxInputCharacters, modelHints, processingRecord } from "./domain/correction.ts";
import type { RecordingSnapshot } from "./recording-contract.ts";

const MAX_METADATA_BYTES = 1_048_576;
const CONTINUATION_INPUT = "continuation-input.json";
/** Private copy of the output a retry replaced, restored if the retry fails. */
const PREVIOUS_OUTPUT = "previous-output.json";
const outputKeys = [
  "rawText",
  "finalText",
  "insertionText",
  "previewText",
  "detectedLanguage",
  "recognitionHints",
  "speech",
  "formattingRejectionReason",
  "consumedListControls",
  "textProcessing",
  "proofreadingHints",
  "proofreading",
  "continuation",
] as const;
const MAX_PREFERENCES_BYTES = 262_144;
const MAX_CHUNK_BYTES = 1_048_576;
const terminal = (record: GenerationRecord) =>
  ["completed", "failed", "cancelled"].includes(record.status);
const now = () => new Date().toISOString();
const uuid = () => randomUUID().toUpperCase();
const isUUID = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const copy = <T>(value: T): T => structuredClone(value);
const graphemes = (text: string) =>
  [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;

export const defaultPreferences = (): PreferencesSnapshot => ({
  revision: 0,
  preferences: {
    recognitionMode: "automatic",
    recognitionEngine: "whisper",
    language: "en",
    proofreadingPrompt: defaultProofreadingPrompt,
    vocabulary: "",
    dictionary: copy(defaultDictionary),
    textCorrectionEnabled: true,
    keepOriginalAudio: true,
  },
});

function normalizePreferences(
  value: components["schemas"]["ServerPreferences"],
): ServerPreferences {
  const dictionary = decodePersonalDictionary(value.dictionary);
  if (dictionary.error) throw new ServiceError(400, "invalid_preferences", dictionary.error);
  return {
    ...value,
    recognitionMode: value.recognitionMode ?? "automatic",
    recognitionEngine: selectedEngine(value),
    dictionary: dictionary.value!,
    proofreadingPrompt: value.proofreadingPrompt ?? defaultProofreadingPrompt,
  };
}

interface ServiceConfiguration {
  captureProvider?: CaptureProvider;
  soniox?: SonioxConfiguration;
  startSpeechStream?: StartSpeechStream;
  dataDirectory: string;
  development: boolean;
}
interface Upload {
  format: AudioStreamFormat;
  chunks: { offset: number; count: number }[];
  bytes: number;
}
interface Watcher {
  queue: GenerationRecord[];
  wake?: () => void;
  done: boolean;
}

/** All durable mutations share one queue. Model work proceeds outside it. */
export class GenerationService {
  captures: CaptureSessions;
  readonly buttons: ButtonDestinations;
  private readonly sharing: MicrophoneSharing;
  private recordings?: CaptureStore & {
    detail(id: string): Promise<{ result?: GenerationRecord }>;
    onDiscard?: (id: string) => void;
  };
  private preferences: PreferencesSnapshot = defaultPreferences();
  private records = new Map<string, GenerationRecord>();
  private uploads = new Map<string, Partial<Record<AudioKind, Upload>>>();
  private recognition = new Map<string, RecognitionSession>();
  private endedInference = new Map<string, number>();
  private processingControllers = new Map<string, AbortController>();
  private processingQueue: Promise<void> = Promise.resolve();
  private warmController?: AbortController;
  private warmTask?: Promise<void>;
  /** The engine warming now, and engines to warm in turn once it or a run ends. */
  private warming?: RecognitionEngine;
  private queuedWarmups = new Set<RecognitionEngine>();
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;
  private queue: Promise<unknown> = Promise.resolve();
  private subscribers = new Map<string, Set<Watcher>>();
  private readonly imports: WisprFlowImports;
  private constructor(
    private readonly configuration: ServiceConfiguration,
    private readonly inference: InferenceBackend,
  ) {
    this.buttons = new ButtonDestinations(
      this,
      Date.now,
      join(configuration.dataDirectory, "button-target.json"),
    );
    this.sharing = new MicrophoneSharing(
      join(configuration.dataDirectory, "microphone-sharing.json"),
    );
    this.captures = new CaptureSessions(
      unavailableCaptureStore,
      this.buttons,
      configuration.captureProvider,
      this.sharing,
    );
    this.imports = new WisprFlowImports({
      dataDirectory: configuration.dataDirectory,
      getPreferences: () => copy(this.preferences),
      getRecord: (id) => this.getInternal(id),
      publish: (record) => this.publish(record),
      requireDiskSpace: () => requireDiskSpace(configuration.dataDirectory),
    });
  }
  static async open(configuration: ServiceConfiguration, inference: InferenceBackend) {
    const service = new GenerationService(configuration, inference);
    await service.initialize();
    return service;
  }
  private mutate<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  private directory(id: string) {
    return join(this.configuration.dataDirectory, "generations", id);
  }
  private getInternal(id: string) {
    const record = this.records.get(id.toUpperCase());
    if (!record) throw new ServiceError(404, "not_found", "Recording not found.");
    return copy(record);
  }
  private async initialize() {
    const data = resolve(this.configuration.dataDirectory);
    await mkdir(dirname(data), { recursive: true, mode: 0o700 });
    await ensureDirectory(data);
    await ensureDirectory(join(data, "generations"));
    await this.imports.initialize();
    const path = join(data, "preferences.json");
    try {
      const raw: unknown = JSON.parse(
        (await readRegularFile(path, MAX_PREFERENCES_BYTES)).toString("utf8"),
      );
      if (typeof raw !== "object" || raw === null || !("preferences" in raw))
        throw new ServiceError(500, "invalid_preferences", "Server preferences are invalid.");
      const loaded = validateBody("PreferencesSnapshot", raw) as PreferencesSnapshot;
      loaded.preferences = normalizePreferences(loaded.preferences);
      const error = preferencesValidationError(loaded.preferences);
      if (!Number.isSafeInteger(loaded.revision) || loaded.revision < 0 || error)
        throw new ServiceError(
          500,
          "invalid_preferences",
          error ?? "Server preference revision is invalid.",
        );
      this.preferences = loaded;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await atomicPrivateWrite(path, JSON.stringify(this.preferences));
    }
    for (const name of await readdir(join(data, "generations"))) {
      if (!isUUID(name)) continue;
      const id = name.toUpperCase();
      await requireRegularDirectory(join(data, "generations", name));
      // Swift UUID filenames are uppercase; normalize migrated lowercase dirs.
      if (name !== id) await rename(join(data, "generations", name), this.directory(id));
      let record: GenerationRecord;
      try {
        record = validateBody(
          "GenerationRecord",
          JSON.parse(
            (
              await readRegularFile(join(this.directory(id), "metadata.json"), MAX_METADATA_BYTES)
            ).toString("utf8"),
          ),
        ) as GenerationRecord;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      record.settings.preferences = normalizePreferences(record.settings.preferences);
      if (
        record.id.toUpperCase() !== id ||
        record.schemaVersion !== 1 ||
        ![
          "receiving",
          "queued",
          "transcribing",
          "proofreading",
          "completed",
          "failed",
          "cancelled",
        ].includes(record.status)
      )
        throw new ServiceError(500, "invalid_archive", "A generation has invalid metadata.");
      record.id = id;
      if (!terminal(record)) {
        if (record.capture) record.capture.state = "stopped";
        record.status = "failed";
        record.error = "Server restarted before this generation completed.";
        await this.restorePreviousOutput(record);
        if (record.recognition) delete record.recognition.partialText;
        record.updatedAt = now();
        delete record.progress;
        await this.cleanPartial(id);
        if (Buffer.byteLength(JSON.stringify(record)) <= MAX_METADATA_BYTES)
          await atomicPrivateWrite(
            join(this.directory(id), "metadata.json"),
            JSON.stringify(record),
          );
      }
      this.records.set(id, record);
      this.imports.indexRecord(record);
    }
  }
  start() {
    if (this.stopping || this.timer) return;
    this.beginWarmup();
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 2000);
    this.timer.unref();
  }
  private async tick() {
    await this.mutate(async () => {
      for (const [id, watchers] of this.subscribers) {
        const record = this.records.get(id);
        if (record) for (const watcher of watchers) this.yieldTo(watcher, record);
      }
      await this.imports.expireImportStages();
    });
    const stale = await this.mutate(() =>
      [...this.records.values()]
        .filter(
          (record) =>
            record.status === "receiving" &&
            (Date.now() - Date.parse(record.updatedAt) > 45_000 ||
              Date.now() - Date.parse(record.createdAt) > 300_000),
        )
        .map((record) => record.id),
    );
    for (const id of stale) await this.cancel(id);
  }
  async shutdown() {
    this.buttons.shutdown();
    this.stopping = true;
    await this.captures.shutdown();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.warmController?.abort();
    await this.mutate(async () => {
      for (const record of this.records.values())
        if (!terminal(record)) await this.cancelRecord(record.id);
    });
    await this.inference.shutdown();
    await Promise.allSettled(
      [this.processingQueue, this.warmTask].filter((task): task is Promise<void> => Boolean(task)),
    );
    await this.mutate(() => {
      for (const watchers of this.subscribers.values())
        for (const watcher of watchers) {
          watcher.done = true;
          watcher.wake?.();
        }
      this.subscribers.clear();
    });
  }
  async health(): Promise<ServerHealth> {
    const engine = recognitionEngine(this.preferences.preferences, this.engines);
    const state = await this.inference.readiness(false, engine);
    let writable = true;
    try {
      await access(this.configuration.dataDirectory, constants.W_OK);
      await requireDiskSpace(this.configuration.dataDirectory);
    } catch {
      writable = false;
    }
    return this.mutate(() => {
      const cloud = this.prefersCloud;
      const ready =
        (this.preferences.preferences.recognitionMode === "cloud"
          ? cloud
          : state.available && state.speechLoaded) && writable;
      const message = !writable
        ? "Server storage is unavailable or full."
        : ready
          ? "Server ready."
          : this.preferences.preferences.recognitionMode === "cloud" && !this.configuration.soniox
            ? "Soniox API key is not configured."
            : this.warming
              ? "Loading server models…"
              : "Server models are unavailable.";
      if (!state.speechLoaded) this.beginWarmup();
      return {
        apiVersion: API_VERSION,
        generationRetry: true,
        recognitionEngines: [...this.engines],
        serverVersion: "0.1.0",
        isDev: this.configuration.development,
        ready,
        speech: {
          ...(cloud
            ? { modelID: this.configuration.soniox!.model, backend: "soniox/websocket" }
            : localSpeechModel(engine)),
          ready:
            this.preferences.preferences.recognitionMode === "cloud"
              ? cloud
              : state.available && state.speechLoaded,
          message: cloud ? "Cloud configured; connection checked per recording." : undefined,
        },
        proofreading: {
          modelID: "Qwen3-4B-Instruct-2507",
          backend: this.proofBackend,
          ready: state.proofLoaded,
          message: this.preferences.preferences.textCorrectionEnabled
            ? state.proofLoaded
              ? undefined
              : "Unavailable; deterministic text is preserved."
            : "Disabled",
        },
        message,
      };
    });
  }
  getPreferences() {
    return this.mutate(() => copy(this.preferences));
  }
  resolveRecordingContinuation(id: string, snapshot: RecordingSnapshot) {
    return this.mutate(() => {
      const previous = this.records.get(id.toUpperCase());
      if (
        !previous ||
        previous.status !== "completed" ||
        previous.device.id !== snapshot.device.id ||
        previous.mode !== snapshot.mode
      )
        return;
      const age = Date.parse(snapshot.createdAt) - Date.parse(previous.updatedAt);
      if (!Number.isFinite(age) || age < 0 || age >= 900_000) return;
      if (
        previous.mode !== "test" &&
        !["inserted", "listUpdated"].includes(previous.delivery?.status ?? "")
      )
        return;
      return copy(previous.continuation);
    });
  }
  updatePreferences(update: components["schemas"]["PreferencesSnapshot"]) {
    return this.mutate(async () => {
      if (update.revision !== this.preferences.revision)
        throw new ServiceError(
          409,
          "stale_preferences",
          "Preferences changed on another device. Reload and try again.",
        );
      const current = this.preferences.preferences;
      const normalized = normalizePreferences({
        ...update.preferences,
        recognitionMode: update.preferences.recognitionMode ?? current.recognitionMode,
        recognitionEngine: update.preferences.recognitionEngine ?? current.recognitionEngine,
      });
      const engine = selectedEngine(normalized);
      // Keeping an engine that was since uninstalled is allowed; choosing one is not.
      if (engine !== selectedEngine(current) && !this.engines.includes(engine))
        throw new ServiceError(
          400,
          "invalid_preferences",
          `${engineName(engine)} is not installed on this server.`,
        );
      const error = preferencesValidationError(normalized);
      if (error) throw new ServiceError(400, "invalid_preferences", error);
      const next = { revision: this.preferences.revision + 1, preferences: normalized };
      const data = JSON.stringify(next);
      if (Buffer.byteLength(data) > MAX_PREFERENCES_BYTES)
        throw new ServiceError(
          413,
          "preferences_too_large",
          "Server preferences exceeded the 256 KiB storage limit.",
        );
      await atomicPrivateWrite(join(this.configuration.dataDirectory, "preferences.json"), data);
      this.preferences = next;
      this.beginWarmup();
      return copy(next);
    });
  }
  async create(
    request: CreateGenerationRequest,
    remote?: { source: components["schemas"]["AudioSourceIdentity"]; owner: string },
  ) {
    const checked = recognitionEngine(this.preferences.preferences, this.engines);
    let state = await this.inference.readiness(false, checked);
    return this.mutate(async () => {
      if (this.stopping)
        throw new ServiceError(503, "server_stopping", "The server is shutting down.");
      // The take freezes the preferences current now; a concurrent engine switch is checked again.
      const engine = recognitionEngine(this.preferences.preferences, this.engines);
      if (engine !== checked) state = await this.inference.readiness(false, engine);
      const validLabel = (text: string) =>
        text.length > 0 &&
        graphemes(text) <= 128 &&
        text === text.trim() &&
        !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text);
      if (!validLabel(request.device.id) || !validLabel(request.device.name))
        throw new ServiceError(
          400,
          "invalid_device",
          "Device ID and name must be nonempty single-line text of at most 128 characters.",
        );
      const existing = [...this.records.values()].find(
        (record) =>
          record.requestID.toUpperCase() === request.requestID.toUpperCase() &&
          record.device.id === request.device.id,
      );
      if (existing) {
        if (existing.capture || remote) {
          if (
            !existing.capture ||
            !remote ||
            existing.capture.source.hostID !== remote.source.hostID ||
            existing.capture.source.id !== remote.source.id ||
            existing.mode !== request.mode
          )
            throw new ServiceError(
              409,
              "conflicting_request",
              "This request already selects another source or mode.",
            );
          await this.authorizeCapture(existing.id, remote.owner);
        }
        return copy(existing);
      }
      if (this.preferences.preferences.recognitionMode === "cloud" && !this.configuration.soniox)
        throw new ServiceError(
          503,
          "cloud_unavailable",
          "Configure a Soniox API key on the server, or choose automatic/local recognition.",
        );
      if (this.preferences.preferences.recognitionMode !== "cloud" && !state.available) {
        this.beginWarmup();
        throw new ServiceError(503, "server_unavailable", state.message);
      }
      if (this.preferences.preferences.recognitionMode !== "cloud" && !state.speechLoaded) {
        this.beginWarmup();
        throw new ServiceError(
          503,
          "server_warming",
          "The server is loading its models. Recording will be available when it is ready.",
        );
      }
      await requireDiskSpace(this.configuration.dataDirectory);
      const record = this.newRecord(
        uuid(),
        request.requestID.toUpperCase(),
        request.device,
        request.mode,
        now(),
      );
      await mkdir(this.directory(record.id), { mode: 0o700 });
      if (remote) {
        record.capture = { source: copy(remote.source), state: "preparing" };
        await atomicPrivateWrite(
          join(this.directory(record.id), "capture-owner.sha256"),
          createHash("sha256").update(remote.owner).digest("hex"),
        );
      }
      await this.save(record);
      this.uploads.set(record.id, {});
      const session = new RecognitionSession(
        this.inference,
        record.settings.preferences,
        recognitionVocabularyTerms(
          record.settings.preferences.dictionary,
          record.settings.preferences.vocabulary,
        ),
        this.configuration.soniox,
        record.id,
        (recognition) => {
          void this.mutate(() => {
            const current = this.records.get(record.id);
            if (!current || terminal(current)) return;
            // Preview activity must not refresh the upload expiry timestamp.
            current.recognition = recognition;
            this.publish(current);
          });
        },
        this.configuration.startSpeechStream,
      );
      this.recognition.set(record.id, session);
      record.recognition = { ...session.state };
      this.publish(record);
      return copy(record);
    });
  }
  findRequest(requestID: string, deviceID: string) {
    return this.mutate(() =>
      copy(
        [...this.records.values()].find(
          (record) =>
            record.requestID.toUpperCase() === requestID.toUpperCase() &&
            record.device.id === deviceID,
        ),
      ),
    );
  }
  private newRecord(
    id: string,
    requestID: string,
    device: CreateGenerationRequest["device"],
    mode: CreateGenerationRequest["mode"],
    date: string,
  ): GenerationRecord {
    return {
      schemaVersion: 1,
      id,
      requestID,
      device: copy(device),
      mode,
      status: "receiving",
      createdAt: date,
      updatedAt: date,
      settings: copy(this.preferences),
      rawText: "",
      finalText: "",
      insertionText: "",
      previewText: "",
    };
  }
  appendAudio(
    id: string,
    kind: AudioKind,
    sequence: number,
    format: AudioStreamFormat,
    data: Uint8Array,
  ): Promise<AudioChunkReceipt> {
    const bytes = Buffer.from(data);
    return this.mutate(async () => {
      const record = this.getInternal(id);
      id = record.id;
      if (record.status !== "receiving")
        throw new ServiceError(
          409,
          "upload_closed",
          "This recording is no longer accepting audio.",
        );
      if (kind === "original" && !record.settings.preferences.keepOriginalAudio)
        throw new ServiceError(
          400,
          "original_disabled",
          "Original audio retention was disabled for this recording.",
        );
      if (!Number.isInteger(sequence) || sequence < 0 || sequence >= 4096)
        throw new ServiceError(
          413,
          "chunk_limit",
          "This recording exceeded its audio chunk limit.",
        );
      if (
        !Number.isInteger(format.sampleRate) ||
        !Number.isInteger(format.channels) ||
        format.sampleRate < 8000 ||
        format.sampleRate > 192000 ||
        format.channels < 1 ||
        format.channels > 8 ||
        (kind === "inference" && (format.sampleRate !== 16000 || format.channels !== 1))
      )
        throw new ServiceError(
          400,
          "invalid_format",
          "Inference audio must be mono 16 kHz. Original audio must have 1–8 channels at 8–192 kHz.",
        );
      if (!bytes.length || bytes.length > MAX_CHUNK_BYTES || bytes.length % (format.channels * 4))
        throw new ServiceError(
          bytes.length > MAX_CHUNK_BYTES ? 413 : 400,
          "invalid_chunk",
          "Audio chunks must contain complete float32 frames and fit within 1 MiB.",
        );
      for (let offset = 0; offset < bytes.length; offset += 4)
        if ((bytes.readUInt32LE(offset) & 0x7f800000) === 0x7f800000)
          throw new ServiceError(
            400,
            "invalid_samples",
            "Audio must contain finite float32 samples.",
          );
      const streams = this.uploads.get(id) ?? {};
      const upload = streams[kind] ?? { format: copy(format), chunks: [], bytes: 0 };
      if (
        upload.format.sampleRate !== format.sampleRate ||
        upload.format.channels !== format.channels
      )
        throw new ServiceError(
          409,
          "format_changed",
          "An audio stream cannot change format during recording.",
        );
      await requireRegularDirectory(this.directory(id));
      const path = join(this.directory(id), `${kind}.raw`);
      if (sequence < upload.chunks.length) {
        const chunk = upload.chunks[sequence]!;
        const file = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size !== upload.bytes)
            throw new ServiceError(500, "invalid_archive", "An audio upload changed unexpectedly.");
          const replay = Buffer.alloc(chunk.count);
          const result = await file.read(replay, 0, replay.length, chunk.offset);
          if (
            chunk.count !== bytes.length ||
            result.bytesRead !== replay.length ||
            !replay.equals(bytes)
          )
            throw new ServiceError(
              409,
              "conflicting_chunk",
              "A repeated audio chunk did not match the original.",
            );
        } finally {
          await file.close();
        }
        return {
          nextSequence: upload.chunks.length,
          frameCount: upload.bytes / (format.channels * 4),
        };
      }
      if (sequence !== upload.chunks.length)
        throw new ServiceError(409, "missing_chunk", "Audio chunks must arrive in sequence.");
      if (kind === "inference" && this.endedInference.has(id))
        throw new ServiceError(409, "audio_ended", "Inference audio has already ended.");
      const nextBytes = upload.bytes + bytes.length;
      if (nextBytes / (format.sampleRate * format.channels * 4) > 180.1 || nextBytes > 268_435_456)
        throw new ServiceError(
          413,
          "recording_limit",
          "Recordings are limited to 180 seconds and 256 MiB per audio stream.",
        );
      await requireDiskSpace(this.configuration.dataDirectory);
      const file = await open(
        path,
        constants.O_WRONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (upload.bytes ? 0 : constants.O_CREAT | constants.O_EXCL),
        0o600,
      );
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size !== upload.bytes)
          throw new ServiceError(500, "invalid_archive", "An audio upload changed unexpectedly.");
        let written = 0;
        while (written < bytes.length) {
          const result = await file.write(
            bytes,
            written,
            bytes.length - written,
            upload.bytes + written,
          );
          if (!result.bytesWritten) throw new Error("Audio write failed.");
          written += result.bytesWritten;
        }
        await file.sync();
      } finally {
        await file.close();
      }
      upload.chunks.push({ offset: upload.bytes, count: bytes.length });
      upload.bytes = nextBytes;
      streams[kind] = upload;
      this.uploads.set(id, streams);
      record.updatedAt = now();
      this.records.set(id, record);
      if (kind === "inference") this.recognition.get(id)?.send(bytes);
      return {
        nextSequence: upload.chunks.length,
        frameCount: upload.bytes / (format.channels * 4),
      };
    });
  }
  endInference(id: string, frames: number) {
    return this.mutate(() => {
      const record = this.getInternal(id);
      id = record.id;
      const uploaded = this.uploads.get(id)?.inference;
      if (
        record.status !== "receiving" ||
        !uploaded ||
        !Number.isSafeInteger(frames) ||
        frames <= 0 ||
        uploaded.bytes / 4 !== frames
      )
        throw new ServiceError(
          409,
          "incomplete_audio",
          "Inference audio has not been completely uploaded.",
        );
      if (!this.endedInference.has(id)) {
        record.updatedAt = now();
        this.records.set(id, record);
        this.endedInference.set(id, frames);
        this.recognition.get(id)?.end();
      }
    });
  }
  finish(id: string, request: FinishGenerationRequest) {
    return this.mutate(async () => {
      const record = this.getInternal(id);
      id = record.id;
      if (record.status !== "receiving") {
        if (
          record.inferenceAudio?.frameCount !== request.inferenceFrames ||
          record.originalAudio?.frameCount !== request.originalFrames
        )
          throw new ServiceError(
            409,
            "conflicting_finish",
            "The recording was already sealed with different audio counts.",
          );
        return copy(record);
      }
      const streams = this.uploads.get(id),
        speech = streams?.inference;
      if (!speech || speech.bytes / 4 !== request.inferenceFrames)
        throw new ServiceError(
          409,
          "incomplete_audio",
          "Inference audio has not been completely uploaded.",
        );
      const duration = speech.bytes / 64000;
      if (duration < 0.25 || duration > 180)
        throw new ServiceError(
          400,
          "invalid_duration",
          "Recordings must be between 0.25 and 180 seconds.",
        );
      const original = streams?.original;
      if (record.settings.preferences.keepOriginalAudio) {
        if (!original || original.bytes / (original.format.channels * 4) !== request.originalFrames)
          throw new ServiceError(
            409,
            "incomplete_original",
            "Original audio has not been completely uploaded.",
          );
        if (
          Math.abs(
            original.bytes / (original.format.sampleRate * original.format.channels * 4) - duration,
          ) > 0.075
        )
          throw new ServiceError(
            400,
            "audio_mismatch",
            "Original and inference audio must cover the same recording interval.",
          );
      } else if (request.originalFrames !== undefined || original)
        throw new ServiceError(
          400,
          "unexpected_original",
          "This recording does not retain original audio.",
        );
      this.endedInference.set(id, request.inferenceFrames);
      this.recognition.get(id)?.end();
      const previous = this.continuation(request.continuationID, record);
      try {
        record.inferenceAudio = await this.seal(id, "inference", speech);
        if (original) record.originalAudio = await this.seal(id, "original", original);
        if (record.capture) {
          record.capture.state = "sealed";
          record.capture.continuationID = request.continuationID?.toUpperCase();
        }
        record.status = "queued";
        record.updatedAt = now();
        record.progress = 0;
        await this.save(record);
      } catch {
        record.status = "failed";
        record.error = "The server could not preserve the complete recording.";
        record.updatedAt = now();
        await this.save(record).catch(() => this.publish(record));
        await this.cleanPartial(id);
        throw new ServiceError(500, "audio_storage_failed", record.error);
      }
      this.uploads.delete(id);
      // Private to the server: lets a retry format lists exactly as this run did.
      if (previous)
        await atomicPrivateWrite(
          join(this.directory(id), CONTINUATION_INPUT),
          JSON.stringify(previous),
        ).catch(() => {});
      this.enqueueProcessing(id, previous);
      return copy(record);
    });
  }
  /**
   * Sealed audio outlives a failed or cancelled run, so the same recording can be
   * transcribed again without re-uploading. Retries use local Whisper: a live
   * Soniox stream cannot be replayed.
   */
  async retry(id: string) {
    const engine = recognitionEngine(this.getInternal(id).settings.preferences, this.engines);
    const state = await this.inference.readiness(false, engine);
    return this.mutate(async () => {
      if (this.stopping)
        throw new ServiceError(503, "server_stopping", "The server is shutting down.");
      const record = this.getInternal(id);
      if (record.importedSource || !record.inferenceAudio)
        throw new ServiceError(
          409,
          "not_retryable",
          "This recording has no saved audio to transcribe again.",
        );
      if (record.status !== "failed" && record.status !== "cancelled")
        throw new ServiceError(
          409,
          "not_retryable",
          "Only failed or cancelled recordings can be transcribed again.",
        );
      if (!state.available) {
        // The take's frozen engine may differ from the shared preference.
        this.beginWarmup(engine);
        throw new ServiceError(503, "server_unavailable", state.message);
      }
      // Keep the saved audio and metadata, but drop the previous run's output.
      // A transcript it replaces stays recoverable until the retry succeeds.
      if (record.rawText)
        await atomicPrivateWrite(
          join(this.directory(record.id), PREVIOUS_OUTPUT),
          JSON.stringify(Object.fromEntries(outputKeys.map((key) => [key, record[key]]))),
        );
      delete record.error;
      for (const key of outputKeys) delete record[key];
      record.rawText = record.finalText = record.insertionText = record.previewText = "";
      const session = new RecognitionSession(
        this.inference,
        { ...record.settings.preferences, recognitionMode: "local" },
        recognitionVocabularyTerms(
          record.settings.preferences.dictionary,
          record.settings.preferences.vocabulary,
        ),
        undefined,
        record.id,
        () => {},
      );
      this.recognition.get(record.id)?.cancel();
      this.recognition.set(record.id, session);
      record.recognition = { ...session.state };
      record.status = "queued";
      record.progress = 0;
      record.updatedAt = now();
      await this.save(record);
      this.enqueueProcessing(record.id, await this.savedContinuation(record.id));
      return copy(record);
    });
  }
  /**
   * A retry that failed before producing new speech gives back the transcript
   * it replaced; newer text from the retry wins.
   */
  private async restorePreviousOutput(record: GenerationRecord) {
    const path = join(this.directory(record.id), PREVIOUS_OUTPUT);
    if (!record.rawText) {
      try {
        const previous = JSON.parse(
          (await readRegularFile(path, MAX_METADATA_BYTES)).toString("utf8"),
        ) as Partial<GenerationRecord>;
        for (const key of outputKeys)
          if (previous[key] !== undefined) Object.assign(record, { [key]: previous[key] });
      } catch {}
    }
    await rm(path, { force: true }).catch(() => {});
  }
  private async savedContinuation(id: string): Promise<DictationContinuation | undefined> {
    try {
      const data = await readRegularFile(
        join(this.directory(id), CONTINUATION_INPUT),
        MAX_METADATA_BYTES,
      );
      return JSON.parse(data.toString("utf8")) as DictationContinuation;
    } catch {
      return undefined;
    }
  }
  get(id: string) {
    return this.mutate(() => this.getInternal(id));
  }
  /** Owner hashes are private artifacts, never part of history or downloadable metadata. */
  async authorizeCapture(id: string, owner?: string) {
    const record = this.getInternal(id);
    if (!record.capture) return;
    if (!owner || !/^[0-9a-f]{64}$/.test(owner))
      throw new ServiceError(
        403,
        "capture_owner_required",
        "This action requires the capture owner's secret.",
      );
    const expected = await readRegularFile(
      join(this.directory(record.id), "capture-owner.sha256"),
      64,
    ).catch(() => Buffer.alloc(0));
    const actual = Buffer.from(createHash("sha256").update(owner).digest("hex"));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new ServiceError(
        403,
        "capture_owner_required",
        "This action requires the capture owner's secret.",
      );
  }
  updateCapture(id: string, state: components["schemas"]["RemoteCapture"]["state"], peak?: number) {
    return this.mutate(async () => {
      const record = this.getInternal(id);
      if (!record.capture || terminal(record)) return record;
      record.capture.state = state;
      if (peak === undefined || !Number.isFinite(peak)) {
        delete record.capture.peak;
        await this.save(record);
      } else if (Number.isFinite(peak)) {
        record.capture.peak = Math.max(0, Math.min(1, peak));
        this.publish(record);
      }
      return record;
    });
  }
  async requireClientUpload(id: string) {
    if ((await this.get(id)).capture)
      throw new ServiceError(
        409,
        "remote_capture",
        "Remote audio is supplied only by the capture provider.",
      );
  }
  history(limit = 50, before?: string, source?: string): Promise<GenerationPage> {
    return this.mutate(() => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new ServiceError(
          400,
          "invalid_limit",
          "History page size must be between 1 and 100.",
        );
      if (source !== undefined && source !== "wispr-flow" && source !== "sottoduo")
        throw new ServiceError(400, "invalid_source", "Choose Wispr Flow or SottoDuo history.");
      const sorted = [...this.records.values()]
        .filter((record) =>
          !source || source === "wispr-flow"
            ? !source || record.importedSource?.provider === "wispr-flow"
            : !record.importedSource,
        )
        .sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id),
        );
      let start = 0;
      if (before) {
        const index = sorted.findIndex((record) => record.id === before.toUpperCase());
        if (index < 0)
          throw new ServiceError(
            400,
            "invalid_cursor",
            "The history cursor is no longer valid. Reload history.",
          );
        start = index + 1;
      }
      const items = sorted.slice(start, start + limit);
      return {
        items: copy(items),
        nextCursor: start + items.length < sorted.length ? items.at(-1)?.id : undefined,
      };
    });
  }
  async events(id: string): Promise<AsyncIterable<GenerationRecord>> {
    const watcher = await this.mutate(() => {
      const record = this.getInternal(id);
      id = record.id;
      const group = this.subscribers.get(id) ?? new Set<Watcher>();
      if (group.size >= 8)
        throw new ServiceError(
          429,
          "stream_limit",
          "Too many connections are watching this recording.",
        );
      const watcher: Watcher = { queue: [record], done: terminal(record) };
      if (!watcher.done) {
        group.add(watcher);
        this.subscribers.set(id, group);
      }
      return watcher;
    });
    const service = this;
    const iterator: AsyncIterableIterator<GenerationRecord> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      async next() {
        while (true) {
          const record = watcher.queue.shift();
          if (record) return { value: record, done: false };
          if (watcher.done) return { value: undefined, done: true };
          await new Promise<void>((resolve) => {
            watcher.wake = resolve;
          });
          watcher.wake = undefined;
        }
      },
      async return() {
        watcher.done = true;
        watcher.queue = [];
        watcher.wake?.();
        await service.mutate(() => {
          const group = service.subscribers.get(id);
          group?.delete(watcher);
          if (!group?.size) service.subscribers.delete(id);
        });
        return { value: undefined, done: true };
      },
    };
    return iterator;
  }

  cancel(id: string, message = "Recording cancelled.") {
    return this.mutate(() => this.cancelRecord(id, message));
  }
  /**
   * Remote capture records durable recording sessions; the server-hosted
   * microphone stops whenever its session is discarded.
   */
  attachRecordings(recordings: NonNullable<GenerationService["recordings"]>) {
    this.recordings = recordings;
    this.captures = new CaptureSessions(
      recordings,
      this.buttons,
      this.configuration.captureProvider,
      this.sharing,
    );
    recordings.onDiscard = (id) => this.captures.abort(id);
  }
  /** A completed result from either legacy generations or recording sessions. */
  async resolveResult(id: string): Promise<GenerationRecord> {
    try {
      return await this.get(id);
    } catch (error) {
      if (!(error instanceof ServiceError && error.status === 404) || !this.recordings) throw error;
      const result = (await this.recordings.detail(id)).result;
      if (!result) throw new ServiceError(404, "not_found", "Recording not found.");
      return result;
    }
  }
  /** Aborting only this recording's signal leaves earlier and later queued work running. */
  private async cancelRecord(id: string, message = "Recording cancelled.") {
    const record = this.getInternal(id);
    if (terminal(record)) return record;
    record.status = "cancelled";
    if (record.capture) record.capture.state = "stopped";
    if (record.recognition) delete record.recognition.partialText;
    record.error = message;
    delete record.progress;
    await this.restorePreviousOutput(record);
    record.updatedAt = now();
    this.processingControllers.get(record.id)?.abort();
    await this.save(record).catch(() => this.publish(record));
    await this.cleanPartial(record.id);
    return copy(record);
  }
  recordDelivery(id: string, receipt: DeliveryReceipt) {
    return this.mutate(async () => {
      const record = this.getInternal(id);
      if (record.importedSource)
        throw new ServiceError(
          400,
          "imported_delivery",
          "Imported history cannot receive a delivery receipt.",
        );
      if (
        record.status !== "completed" ||
        ![
          "inserted",
          "copied",
          "unconfirmed",
          "failed",
          "tested",
          "listUpdated",
          "cancelled",
          "none",
        ].includes(receipt.status) ||
        Buffer.byteLength(receipt.message ?? "") > 4096
      )
        throw new ServiceError(
          400,
          "invalid_delivery",
          "A valid delivery receipt requires a completed generation.",
        );
      if (record.delivery) {
        if (
          record.delivery.status !== receipt.status ||
          record.delivery.message !== receipt.message
        )
          throw new ServiceError(
            409,
            "delivery_recorded",
            "This recording already has a delivery outcome.",
          );
        return record;
      }
      record.delivery = { status: receipt.status, message: receipt.message, reportedAt: now() };
      record.updatedAt = now();
      await this.save(record);
      return copy(record);
    });
  }
  delete(id: string) {
    return this.mutate(async () => {
      const record = this.getInternal(id);
      if (!terminal(record))
        throw new ServiceError(
          409,
          "generation_active",
          "Cancel or finish a recording before deleting it.",
        );
      await requireRegularDirectory(this.directory(record.id));
      await rm(this.directory(record.id), { recursive: true });
      this.records.delete(record.id);
      this.imports.removeRecord(record);
    });
  }
  artifact(id: string, filename: string) {
    return this.mutate(async () => {
      const record = this.getInternal(id);
      const allowed = [
        "metadata.json",
        "transcript.txt",
        "inference.wav",
        "original.wav",
        ...(record.importedSource?.artifactNames ?? []),
      ];
      if (
        !allowed.includes(filename) ||
        (filename === "inference.wav" && !record.inferenceAudio) ||
        (filename === "original.wav" && !record.originalAudio) ||
        (filename === "transcript.txt" && record.status !== "completed")
      )
        throw new ServiceError(404, "artifact_not_found", "Artifact not found.");
      const path = join(this.directory(record.id), filename);
      await requireRegularDirectory(dirname(path));
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ).catch(() => undefined);
      if (!file) throw new ServiceError(404, "artifact_not_found", "Artifact not found.");
      try {
        const info = await file.stat();
        if (!info.isFile())
          throw new ServiceError(404, "artifact_not_found", "Artifact not found.");
        return file;
      } catch (error) {
        await file.close();
        throw error;
      }
    });
  }
  knownWisprFlowIDs(request: WisprFlowKnownIDsRequest) {
    return this.mutate(() => this.imports.knownWisprFlowIDs(request));
  }
  beginWisprFlowImport(request: WisprFlowImportRequest) {
    return this.mutate(() => {
      if (this.stopping)
        throw new ServiceError(503, "server_stopping", "The server is shutting down.");
      return this.imports.beginWisprFlowImport(request);
    });
  }
  uploadWisprFlowArtifact(id: string, filename: WisprFlowArtifactName, data: Uint8Array) {
    return this.mutate(() => this.imports.uploadWisprFlowArtifact(id, filename, data));
  }
  completeWisprFlowImport(id: string) {
    return this.mutate(() => this.imports.completeWisprFlowImport(id));
  }
  cancelWisprFlowImport(id: string) {
    return this.mutate(() => this.imports.cancelWisprFlowImport(id));
  }
  archiveWisprFlowDictionary(data: Uint8Array) {
    return this.mutate(() => this.imports.archiveWisprFlowDictionary(data));
  }
  private async seal(id: string, kind: AudioKind, upload: Upload): Promise<AudioArtifact> {
    const directory = this.directory(id);
    await requireRegularDirectory(directory);
    const source = await open(
      join(directory, `${kind}.raw`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const partial = join(directory, `${kind}.wav.partial`);
    try {
      const info = await source.stat();
      if (!info.isFile() || info.size !== upload.bytes)
        throw new Error("Audio changed before sealing.");
      const output = await open(
        partial,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
      try {
        const header = Buffer.alloc(44);
        header.write("RIFF");
        header.writeUInt32LE(upload.bytes + 36, 4);
        header.write("WAVEfmt ", 8);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(3, 20);
        header.writeUInt16LE(upload.format.channels, 22);
        header.writeUInt32LE(upload.format.sampleRate, 24);
        header.writeUInt32LE(upload.format.sampleRate * upload.format.channels * 4, 28);
        header.writeUInt16LE(upload.format.channels * 4, 32);
        header.writeUInt16LE(32, 34);
        header.write("data", 36);
        header.writeUInt32LE(upload.bytes, 40);
        await output.writeFile(header);
        const buffer = Buffer.alloc(MAX_CHUNK_BYTES);
        let offset = 0;
        while (offset < upload.bytes) {
          const result = await source.read(
            buffer,
            0,
            Math.min(buffer.length, upload.bytes - offset),
            offset,
          );
          if (!result.bytesRead) throw new Error("Audio ended before sealing.");
          await output.writeFile(buffer.subarray(0, result.bytesRead));
          offset += result.bytesRead;
        }
        await output.sync();
      } finally {
        await output.close();
      }
    } finally {
      await source.close();
    }
    await rename(partial, join(directory, `${kind}.wav`));
    await rm(join(directory, `${kind}.raw`));
    return {
      filename: `${kind}.wav`,
      sampleRate: upload.format.sampleRate,
      channels: upload.format.channels,
      frameCount: upload.bytes / (upload.format.channels * 4),
      byteCount: upload.bytes + 44,
      encoding: "pcm_f32le",
    };
  }
  private continuation(
    id: string | undefined,
    record: GenerationRecord,
  ): DictationContinuation | undefined {
    if (!id) return;
    const previous = this.records.get(id.toUpperCase());
    if (
      !previous ||
      previous.device.id !== record.device.id ||
      previous.status !== "completed" ||
      Date.now() - Date.parse(previous.updatedAt) < 0 ||
      Date.now() - Date.parse(previous.updatedAt) >= 900_000 ||
      previous.mode !== record.mode ||
      (previous.mode !== "test" &&
        !["inserted", "listUpdated"].includes(previous.delivery?.status ?? ""))
    )
      return;
    return copy(previous.continuation);
  }
  private enqueueProcessing(id: string, previous: DictationContinuation | undefined) {
    const controller = new AbortController();
    this.processingControllers.set(id, controller);
    // A sealed recording waits for all earlier processing and cancellation cleanup.
    // Uploads, live recognition, and subscribers stay independent of this queue.
    this.processingQueue = this.processingQueue
      .then(async () => {
        if (!this.stopping && !controller.signal.aborted)
          await this.process(id, previous, controller.signal);
      })
      .catch(() => {})
      .finally(() => {
        // A retry can queue the same recording again before this run unwinds.
        if (this.processingControllers.get(id) === controller)
          this.processingControllers.delete(id);
        this.beginWarmup();
      });
  }
  private async process(
    id: string,
    previous: DictationContinuation | undefined,
    signal: AbortSignal,
  ) {
    // A retry replaces the session; this run must only clean up its own.
    const recognition = this.recognition.get(id);
    try {
      let record = await this.mutate(async () => {
        const record = this.getInternal(id);
        signal.throwIfAborted();
        if (terminal(record)) return undefined;
        record.status = "transcribing";
        await this.save(record);
        return record;
      });
      if (!record) return;
      const settings = record.settings.preferences;
      if (!recognition) throw new Error("Recognition session is unavailable.");
      const speech = await recognition.transcribe(
        join(this.directory(id), "inference.wav"),
        (value) => {
          void this.mutate(() => this.progress(id, value));
        },
        signal,
      );
      signal.throwIfAborted();
      record.recognition = { ...recognition.state };
      delete record.recognition.partialText;
      record.rawText = speech.text;
      record.detectedLanguage = detectedLanguage(speech.language);
      record.recognitionHints = speech.hints;
      record.speech = {
        modelID: speech.modelID,
        modelSHA256: speech.modelSHA256,
        backend: speech.backend,
        engineVersion: speech.engineVersion,
        processingSeconds: speech.processingSeconds,
      };
      const cleaned = cleanTranscript(speech.text);
      const transcript = applyDictionary(settings.dictionary, cleaned, 24 * 1024);
      const structured = formatSpokenList(transcript, previous?.list);
      record.formattingRejectionReason = structured.formattingRejectionReason;
      record.consumedListControls = structured.consumedControls;
      if (settings.textCorrectionEnabled && structured.text) {
        const updated = await this.mutate(async () => {
          signal.throwIfAborted();
          if (terminal(this.getInternal(id))) return false;
          record!.status = "proofreading";
          delete record!.progress;
          await this.save(record!);
          return true;
        });
        if (!updated) return;
      }
      const processing = await this.proofread(
        structured.text,
        settings,
        cleaned !== transcript,
        detectedLanguage(speech.language) ?? settings.language,
        signal,
      );
      signal.throwIfAborted();
      record.textProcessing = processing;
      if (["applied", "unchanged", "rejected"].includes(processing.status)) {
        const all = dictionaryVocabularyTerms(settings.dictionary),
          included = modelHints(all);
        record.proofreadingHints = {
          includedTerms: included,
          omittedTerms: all.filter((term) => !included.includes(term)),
        };
      }
      if (settings.textCorrectionEnabled)
        record.proofreading = {
          modelID: "Qwen3-4B-Instruct-2507",
          modelSHA256: processing.modelSHA256,
          backend: this.proofBackend,
          engineVersion: processing.engineVersion,
          processingSeconds: processing.processingSeconds,
        };
      const formatted = { ...structured, text: processing.outputText };
      const composition = composeDictation(formatted, previous);
      record.finalText = formatted.text;
      record.insertionText = composition.insertion;
      record.previewText = composition.preview;
      record.continuation = composition.continuation;
      record.status = "completed";
      record.updatedAt = now();
      record.progress = 1;
      await this.mutate(async () => {
        signal.throwIfAborted();
        if (terminal(this.getInternal(id))) return;
        await atomicPrivateWrite(join(this.directory(id), "transcript.txt"), record!.finalText);
        await this.save(record!);
        await rm(join(this.directory(id), PREVIOUS_OUTPUT), { force: true }).catch(() => {});
      });
    } catch (error) {
      await this.mutate(async () => {
        const record = this.records.get(id);
        // Aborts come from cancelRecord, which already saved the cancellation.
        // A retry may have queued the record again since, so leave it alone.
        if (!record || terminal(record) || signal.aborted) return;
        const failed = copy(record);
        await this.restorePreviousOutput(failed);
        if (failed.recognition) delete failed.recognition.partialText;
        failed.status = "failed";
        failed.error = error instanceof Error ? error.message : "Processing failed.";
        failed.updatedAt = now();
        delete failed.progress;
        await this.save(failed).catch(() => this.publish(failed));
      });
    } finally {
      await this.mutate(() => {
        if (this.recognition.get(id) !== recognition) return;
        recognition?.cancel();
        this.recognition.delete(id);
        this.endedInference.delete(id);
      });
    }
  }
  private async proofread(
    text: string,
    settings: ServerPreferences,
    dictionaryChanged: boolean,
    language: string,
    signal: AbortSignal,
  ) {
    const started = performance.now(),
      terms = dictionaryVocabularyTerms(settings.dictionary);
    const make = (
      status: TextProcessingRecord["status"],
      extra: Partial<TextProcessingRecord> = {},
    ) =>
      processingRecord({
        dictionaryTerms: terms,
        dictionaryChangedText: dictionaryChanged,
        inputText: text,
        outputText: text,
        enabled: settings.textCorrectionEnabled,
        status,
        modelID: settings.textCorrectionEnabled ? "Qwen3-4B-Instruct-2507" : undefined,
        wallSeconds: (performance.now() - started) / 1000,
        ...extra,
      });
    if (!settings.textCorrectionEnabled) return make("disabled");
    if (!text) return make("skipped", { reason: "No text to correct." });
    if (graphemes(text) > maxInputCharacters)
      return make("skipped", { reason: "The transcript exceeded the correction length limit." });
    try {
      const proof = await this.inference.correct(
        text,
        modelHints(terms),
        language,
        settings.proofreadingPrompt,
        signal,
      );
      signal.throwIfAborted();
      const candidate = applyDictionary(settings.dictionary, proof.text.trim(), 24 * 1024);
      const evaluation = await evaluateCorrectionInWorker(text, candidate, terms, signal);
      signal.throwIfAborted();
      const extra = {
        proposedText: candidate,
        verifiedRepairs: evaluation.verifiedRepairs,
        processingSeconds: proof.processingSeconds,
        engineVersion: proof.engineVersion,
        modelSHA256: proof.modelSHA256,
      };
      return evaluation.rejectionReason
        ? make("rejected", { ...extra, reason: evaluation.rejectionReason })
        : make(candidate === text ? "unchanged" : "applied", { ...extra, outputText: candidate });
    } catch (error) {
      signal.throwIfAborted();
      return make("failed", {
        reason: error instanceof Error ? error.message : "Proofreading failed.",
      });
    }
  }
  private async save(record: GenerationRecord) {
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > MAX_METADATA_BYTES)
      throw new ServiceError(
        413,
        "metadata_too_large",
        "The generation metadata exceeded its 1 MiB storage limit.",
      );
    await atomicPrivateWrite(join(this.directory(record.id), "metadata.json"), data);
    this.publish(record);
  }
  private publish(record: GenerationRecord) {
    this.records.set(record.id.toUpperCase(), copy(record));
    const group = this.subscribers.get(record.id);
    if (group)
      for (const watcher of group) {
        this.yieldTo(watcher, record);
        if (terminal(record)) {
          watcher.done = true;
          watcher.wake?.();
        }
      }
    if (terminal(record)) this.subscribers.delete(record.id);
  }
  private yieldTo(watcher: Watcher, record: GenerationRecord) {
    watcher.queue.push(copy(record));
    if (watcher.queue.length > 8) watcher.queue.shift();
    watcher.wake?.();
  }
  private progress(id: string, value: number) {
    const record = this.records.get(id);
    if (!record || record.status !== "transcribing" || !Number.isFinite(value)) return;
    record.progress = Math.max(0, Math.min(1, value));
    for (const watcher of this.subscribers.get(id) ?? []) this.yieldTo(watcher, record);
  }
  private async cleanPartial(id: string) {
    this.recognition.get(id)?.cancel();
    this.recognition.delete(id);
    this.endedInference.delete(id);
    this.uploads.delete(id);
    for (const name of [
      "inference.raw",
      "original.raw",
      "inference.wav.partial",
      "original.wav.partial",
    ])
      await rm(join(this.directory(id), name), { force: true }).catch(() => {});
  }
  private beginWarmup(requested?: RecognitionEngine) {
    if (this.stopping) return;
    const selected = () => recognitionEngine(this.preferences.preferences, this.engines);
    if (this.warming || this.processingControllers.size) {
      // A retry's frozen engine or a newly selected one must not be dropped.
      const engine = requested ?? selected();
      if (engine !== this.warming) this.queuedWarmups.add(engine);
      return;
    }
    const engine = requested ?? this.queuedWarmups.values().next().value ?? selected();
    this.queuedWarmups.delete(engine);
    this.warming = engine;
    const controller = new AbortController();
    this.warmController = controller;
    this.warmTask = this.inference
      .warmUp(this.preferences.preferences.textCorrectionEnabled, controller.signal, engine)
      .catch(() => {})
      .finally(() => {
        this.warming = undefined;
        this.warmController = undefined;
        this.warmTask = undefined;
        if (this.queuedWarmups.size) this.beginWarmup();
      });
  }
  private get prefersCloud() {
    return this.preferences.preferences.recognitionMode !== "local" && !!this.configuration.soniox;
  }
  private get engines() {
    return this.inference.engines ?? ["whisper"];
  }
  private get proofBackend() {
    return process.platform === "darwin" ? "MLX" : "llama.cpp";
  }
}

const unavailableCapture = () =>
  Promise.reject(
    new ServiceError(503, "capture_unavailable", "Remote capture requires recording sessions."),
  );
/** Until recording sessions are attached, remote capture admission is unavailable. */
const unavailableCaptureStore: CaptureStore = {
  findRequest: async () => undefined,
  createCapture: unavailableCapture,
  authorizeCapture: unavailableCapture,
  appendCaptureAudio: unavailableCapture,
  updateCapture: unavailableCapture,
  stopCapture: unavailableCapture,
  get: unavailableCapture,
  discard: unavailableCapture,
};
