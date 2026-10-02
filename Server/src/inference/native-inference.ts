import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { availableParallelism } from "node:os";
import type { ModelHintUsage, RecognitionEngine } from "../api";
import { HelperProcess, type HelperResponse } from "./helper-process";
import { checkCancellation, InferenceError } from "./inference-error";
import { ModelVerifier, type ModelPin } from "./model-verification";
import { engineName } from "./engines";
import {
  linuxProofModelPin,
  macProofManifestSHA256,
  parakeetModelPin,
  speechModelPin,
} from "./model-pins";

export { InferenceError } from "./inference-error";

export interface InferenceConfiguration {
  speechHelper: string;
  /** The Whisper model, always installed. */
  speechModel: string;
  /** An optional Parakeet model served by the same speech helper. */
  parakeetModel?: string;
  vadModel: string;
  proofHelper: string;
  proofModel: string;
  threads: number;
  speechLoadTimeout: number;
  speechTimeout: number;
  proofLoadTimeout: number;
  proofTimeout: number;
}

type ConfigurationInput = Pick<
  InferenceConfiguration,
  "speechHelper" | "speechModel" | "vadModel" | "proofHelper" | "proofModel"
> &
  Partial<
    Omit<
      InferenceConfiguration,
      "speechHelper" | "speechModel" | "vadModel" | "proofHelper" | "proofModel"
    >
  >;

function deadline(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) && value > 0 && value <= 3600
    ? value
    : fallback;
}

export function createInferenceConfiguration(input: ConfigurationInput): InferenceConfiguration {
  const threads = input.threads ?? Math.min(8, Math.max(2, Math.floor(availableParallelism() / 2)));
  return {
    ...input,
    threads: Number.isFinite(threads) ? Math.min(32, Math.max(1, Math.trunc(threads))) : 2,
    speechLoadTimeout: deadline(input.speechLoadTimeout, 120),
    speechTimeout: deadline(input.speechTimeout, 180),
    proofLoadTimeout: deadline(input.proofLoadTimeout, 30),
    proofTimeout: deadline(input.proofTimeout, 18),
  };
}

export interface InferenceReadiness {
  available: boolean;
  message: string;
  speechLoaded: boolean;
  proofLoaded: boolean;
}

export interface SpeechInferenceResult {
  text: string;
  audioSeconds: number;
  processingSeconds: number;
  language: string;
  engineVersion?: string;
  modelSHA256?: string;
  hints?: ModelHintUsage;
  /** Exact text pieces with request-relative acoustic timestamps, in order. */
  spans?: SpeechSpan[];
  /** Whole decoder segments, used for stable source checkpoints. */
  segmentSpans?: SpeechSpan[];
}

export interface SpeechSpan {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface ProofInferenceResult {
  text: string;
  processingSeconds: number;
  engineVersion?: string;
  modelSHA256?: string;
}

/** Every speech call names its engine; omitted means Whisper. */
export interface InferenceBackend {
  readonly timedSpeechSpans?: boolean;
  /** Installed local recognition engines. Omitted means Whisper only. */
  readonly engines?: readonly RecognitionEngine[];
  findSpeechBoundary?(
    audioPath: string,
    signal?: AbortSignal,
    engine?: RecognitionEngine,
  ): Promise<number | undefined>;
  readiness(proofreadingEnabled?: boolean, engine?: RecognitionEngine): Promise<InferenceReadiness>;
  warmUp(
    proofreadingEnabled?: boolean,
    signal?: AbortSignal,
    engine?: RecognitionEngine,
  ): Promise<void>;
  transcribe(
    audioPath: string,
    language: string,
    vocabularyTerms: string[],
    onProgress?: (value: number) => void,
    signal?: AbortSignal,
    engine?: RecognitionEngine,
  ): Promise<SpeechInferenceResult>;
  correct(
    text: string,
    terms: string[],
    language: string,
    systemPrompt: string,
    signal?: AbortSignal,
  ): Promise<ProofInferenceResult>;
  cancel(): Promise<void>;
  shutdown(): Promise<void>;
}

function bytes(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function validLanguage(language: string) {
  return language.length > 0 && bytes(language) <= 32 && !language.includes("\0");
}

export function validSpeechSpans(spans: SpeechSpan[] | undefined, duration: number, text: string) {
  if (!spans || !Number.isFinite(duration) || duration < 0 || spans.length > 65_536) return false;
  let start = 0;
  let end = 0;
  for (const span of spans) {
    if (
      !span.text.length ||
      span.text.includes("\0") ||
      !Number.isFinite(span.startSeconds) ||
      !Number.isFinite(span.endSeconds) ||
      span.startSeconds < start ||
      span.endSeconds < end ||
      span.endSeconds < span.startSeconds ||
      span.endSeconds > duration ||
      span.startSeconds < 0
    )
      return false;
    start = span.startSeconds;
    end = span.endSeconds;
  }
  return (
    spans
      .map((span) => span.text)
      .join("")
      .trim() === text
  );
}

function vocabularyDiagnostics(
  response: HelperResponse,
  terms: string[],
): ModelHintUsage | undefined {
  const { includedTerms: included, omittedTerms: omitted, tokenCount, tokenBudget } = response;
  if (
    included === undefined &&
    omitted === undefined &&
    tokenCount === undefined &&
    tokenBudget === undefined
  )
    return;
  if (
    included &&
    omitted &&
    tokenCount !== undefined &&
    tokenBudget !== undefined &&
    tokenCount >= 0 &&
    tokenBudget >= 0 &&
    // An engine without vocabulary prompting reports a zero budget and no hints.
    (tokenBudget > 0 || included.length === 0) &&
    tokenCount <= tokenBudget &&
    included.length + omitted.length === terms.length
  ) {
    const includedSet = new Set(included);
    const omittedSet = new Set(omitted);
    const combined = new Set([...included, ...omitted]);
    if (
      included.every((term) => !omittedSet.has(term)) &&
      combined.size === terms.length &&
      terms.every((term) => combined.has(term)) &&
      JSON.stringify(included) === JSON.stringify(terms.filter((term) => includedSet.has(term))) &&
      JSON.stringify(omitted) === JSON.stringify(terms.filter((term) => omittedSet.has(term)))
    ) {
      return { includedTerms: included, omittedTerms: omitted, tokenCount, tokenBudget };
    }
  }
  throw new InferenceError("invalidResponse", "Speech returned invalid vocabulary diagnostics.");
}

interface SpeechEngine {
  helper: HelperProcess;
  model: string;
  pin?: ModelPin;
}

/** The helper executables own inference; the server owns paths, deadlines and pins. */
export class NativeInference implements InferenceBackend {
  readonly timedSpeechSpans = true;
  readonly engines: readonly RecognitionEngine[];
  private readonly configuration: InferenceConfiguration;
  private readonly speech: Partial<Record<RecognitionEngine, SpeechEngine>> = {};
  private readonly proof: HelperProcess;
  private readonly verifier = new ModelVerifier();
  private readonly proofPin?: ModelPin;
  private readonly proofManifestSHA256?: string;

  constructor(
    configuration: ConfigurationInput,
    fixturePins?: { speech?: ModelPin; parakeet?: ModelPin; proof?: ModelPin },
  ) {
    this.configuration = createInferenceConfiguration(configuration);
    // Constructor-only fixture injection is never exposed by server configuration
    // or the CLI. Production always enforces the immutable native-model pins.
    this.proofPin = fixturePins
      ? fixturePins.proof
      : process.platform === "darwin"
        ? undefined
        : linuxProofModelPin;
    this.proofManifestSHA256 =
      !fixturePins && process.platform === "darwin" ? macProofManifestSHA256 : undefined;
    const config = this.configuration;
    const models: [RecognitionEngine, string | undefined, ModelPin | undefined][] = [
      ["whisper", config.speechModel, fixturePins ? fixturePins.speech : speechModelPin],
      ["parakeet", config.parakeetModel, fixturePins ? fixturePins.parakeet : parakeetModelPin],
    ];
    for (const [engine, model, pin] of models) {
      if (!model) continue;
      // Each engine is its own warm process; a take never waits for a reload.
      this.speech[engine] = {
        model,
        pin,
        helper: new HelperProcess({
          name: engineName(engine),
          executable: config.speechHelper,
          arguments: [
            "--model",
            model,
            "--vad-model",
            config.vadModel,
            // The helper defaults to Whisper; omitting it keeps reused older helpers working.
            ...(engine === "whisper" ? [] : ["--engine", engine]),
            "--threads",
            String(config.threads),
          ],
          requiredFiles: [model, config.vadModel],
          loadTimeout: config.speechLoadTimeout,
          lineLimit: 1_048_576,
        }),
      };
    }
    this.engines = models.flatMap(([engine]) => (this.speech[engine] ? [engine] : []));
    this.proof = new HelperProcess({
      name: "Qwen",
      executable: config.proofHelper,
      arguments: ["--model", config.proofModel, "--threads", String(config.threads)],
      requiredFiles: [config.proofModel],
      loadTimeout: config.proofLoadTimeout,
      lineLimit: 65_536,
    });
  }

  private engine(engine: RecognitionEngine = "whisper") {
    const selected = this.speech[engine];
    if (!selected)
      throw new InferenceError(
        "unavailable",
        `${engineName(engine)} is not installed on this server. Choose another recognition engine.`,
      );
    return selected;
  }

  async readiness(
    proofreadingEnabled = true,
    engine: RecognitionEngine = "whisper",
  ): Promise<InferenceReadiness> {
    const config = this.configuration;
    const speech = this.speech[engine];
    if (!speech)
      return {
        available: false,
        message: `${engineName(engine)} is not installed on this server.`,
        speechLoaded: false,
        proofLoaded: this.proof.snapshot().loaded,
      };
    const speechState = speech.helper.snapshot();
    const proofState = this.proof.snapshot();
    const helpers = proofreadingEnabled
      ? [config.speechHelper, config.proofHelper]
      : [config.speechHelper];
    const models = [
      speech.model,
      config.vadModel,
      ...(proofreadingEnabled ? [config.proofModel] : []),
    ];
    let missing: string | undefined;
    for (const [paths, mode] of [
      [helpers, constants.X_OK],
      [models, constants.R_OK],
    ] as const) {
      for (const path of paths) {
        try {
          await access(path, mode);
        } catch {
          missing ??= path;
        }
      }
    }
    const speechVerified = await this.verifier.isVerified(speech.model, speech.pin);
    const proofFileVerified = await this.verifier.isVerified(config.proofModel, this.proofPin);
    const proofVerified = proofFileVerified && (!this.proofManifestSHA256 || proofState.loaded);
    const warm = speechState.loaded && (!proofreadingEnabled || proofState.loaded);
    return {
      available: !missing && speechVerified && (!proofreadingEnabled || proofVerified),
      message: missing
        ? `Missing or inaccessible inference asset: ${missing}`
        : !speechVerified || (proofreadingEnabled && !proofVerified)
          ? "Models need integrity verification."
          : warm
            ? "Models are warm and ready."
            : "Models need to warm up.",
      speechLoaded: speechState.loaded,
      proofLoaded: proofState.loaded,
    };
  }

  async warmUp(proofreadingEnabled = true, signal?: AbortSignal, engine?: RecognitionEngine) {
    const speech = this.engine(engine);
    await this.verifier.verify(speech.model, speech.pin, signal);
    await speech.helper.ensureLoaded(signal);
    if (proofreadingEnabled) {
      await this.verifier.verify(this.configuration.proofModel, this.proofPin, signal);
      await this.proof.ensureLoaded(signal);
    }
  }

  async transcribe(
    audioPath: string,
    language: string,
    vocabularyTerms: string[],
    onProgress?: (value: number) => void,
    signal?: AbortSignal,
    engine?: RecognitionEngine,
  ): Promise<SpeechInferenceResult> {
    checkCancellation(signal);
    const speech = this.engine(engine);
    const name = engineName(engine ?? "whisper");
    let readable = true;
    try {
      await access(audioPath, constants.R_OK);
    } catch {
      readable = false;
    }
    if (
      !readable ||
      !validLanguage(language) ||
      vocabularyTerms.length > 8192 ||
      vocabularyTerms.some(
        (term) =>
          !term.length ||
          bytes(term) > 16_384 ||
          term !== term.trim() ||
          /[\p{Cc}\p{Cf}]/u.test(term),
      ) ||
      vocabularyTerms.reduce((total, term) => total + bytes(term), 0) > 384 * 1024
    ) {
      throw new InferenceError("invalidRequest", `Audio, language, or ${name} prompt is invalid.`);
    }
    if (new Set(vocabularyTerms).size !== vocabularyTerms.length)
      throw new InferenceError("invalidRequest", `${name} vocabulary terms must be unique.`);
    const digest = await this.verifier.verify(speech.model, speech.pin, signal);
    const request = {
      type: "transcribe",
      id: randomUUID(),
      path: audioPath,
      language,
      vocabularyTerms,
    };
    if (bytes(JSON.stringify(request)) >= 1_048_576)
      throw new InferenceError("invalidRequest", "The encoded vocabulary exceeds 1 MB.");
    const response = await speech.helper.request(
      request,
      request.id,
      this.configuration.speechTimeout,
      onProgress,
      signal,
    );
    if (
      response.text === undefined ||
      bytes(response.text) > 256 * 1024 ||
      response.text.includes("\0") ||
      response.duration === undefined ||
      !Number.isFinite(response.duration) ||
      response.duration < 0 ||
      response.elapsed === undefined ||
      !Number.isFinite(response.elapsed) ||
      response.elapsed < 0 ||
      response.language === undefined ||
      !response.language.length ||
      bytes(response.language) > 32
    ) {
      await speech.helper.shutdown();
      throw new InferenceError("invalidResponse", `${name} returned an invalid transcript.`);
    }
    let hints: ModelHintUsage | undefined;
    try {
      hints = vocabularyDiagnostics(response, vocabularyTerms);
      if (!validSpeechSpans(response.spans, response.duration, response.text))
        throw new InferenceError(
          "invalidResponse",
          `${name} returned missing or invalid timed speech spans. Rebuild the speech helper to match this server.`,
        );
      if (!validSpeechSpans(response.segmentSpans, response.duration, response.text))
        throw new InferenceError(
          "invalidResponse",
          `${name} returned invalid whole-segment coverage.`,
        );
    } catch (error) {
      await speech.helper.shutdown();
      throw error;
    }
    const state = speech.helper.snapshot();
    return {
      text: response.text,
      audioSeconds: response.duration,
      processingSeconds: response.elapsed,
      language: response.language,
      spans: response.spans,
      segmentSpans: response.segmentSpans,
      ...(state.engineVersion !== undefined ? { engineVersion: state.engineVersion } : {}),
      ...(digest !== undefined ? { modelSHA256: digest } : {}),
      ...(hints !== undefined ? { hints } : {}),
    };
  }

  async findSpeechBoundary(audioPath: string, signal?: AbortSignal, engine?: RecognitionEngine) {
    checkCancellation(signal);
    // Both helpers carry the same speech detector; ask the one already warm.
    const speech = this.engine(engine);
    await this.verifier.verify(speech.model, speech.pin, signal);
    const id = randomUUID();
    const response = await speech.helper.request(
      { type: "boundary", id, path: audioPath },
      id,
      this.configuration.speechTimeout,
      undefined,
      signal,
    );
    if (
      response.duration === undefined ||
      !Number.isFinite(response.duration) ||
      response.duration < 0.2 ||
      response.duration > 180 ||
      (response.boundarySeconds !== undefined &&
        (!Number.isFinite(response.boundarySeconds) ||
          response.boundarySeconds < 30 ||
          response.boundarySeconds > response.duration - 0.1))
    ) {
      await speech.helper.shutdown();
      throw new InferenceError(
        "invalidResponse",
        `${engineName(engine ?? "whisper")} returned an invalid acoustic boundary.`,
      );
    }
    return response.boundarySeconds;
  }

  async correct(
    text: string,
    terms: string[],
    language: string,
    systemPrompt: string,
    signal?: AbortSignal,
  ): Promise<ProofInferenceResult> {
    checkCancellation(signal);
    if (
      !text.trim().length ||
      bytes(text) > 24 * 1024 ||
      text.includes("\0") ||
      terms.length > 256 ||
      terms.some((term) => !term.length || bytes(term) > 256 || term.includes("\0")) ||
      terms.reduce((total, term) => total + bytes(term), 0) > 16_384 ||
      !validLanguage(language) ||
      !systemPrompt.trim().length ||
      bytes(systemPrompt) > 4096 ||
      systemPrompt.includes("\0")
    ) {
      throw new InferenceError(
        "invalidRequest",
        "The transcript or dictionary exceeds the Qwen correction limit.",
      );
    }
    const request = { type: "correct", id: randomUUID(), text, terms, language, systemPrompt };
    if (bytes(JSON.stringify(request)) > 64 * 1024)
      throw new InferenceError("invalidRequest", "The encoded correction request exceeds 64 KB.");
    const digest = await this.verifier.verify(this.configuration.proofModel, this.proofPin, signal);
    const response = await this.proof.request(
      request,
      request.id,
      this.configuration.proofTimeout,
      undefined,
      signal,
    );
    if (
      response.text === undefined ||
      !response.text.length ||
      bytes(response.text) > 24 * 1024 ||
      response.text.includes("\0") ||
      response.elapsed === undefined ||
      !Number.isFinite(response.elapsed) ||
      response.elapsed < 0
    ) {
      await this.proof.shutdown();
      throw new InferenceError("invalidResponse", "Qwen returned an invalid correction.");
    }
    const state = this.proof.snapshot();
    const modelSHA256 = digest ?? this.proofManifestSHA256;
    return {
      text: response.text,
      processingSeconds: response.elapsed,
      ...(state.engineVersion !== undefined ? { engineVersion: state.engineVersion } : {}),
      ...(modelSHA256 !== undefined ? { modelSHA256 } : {}),
    };
  }

  private get speechHelpers() {
    return Object.values(this.speech).map((speech) => speech.helper);
  }
  async cancel() {
    this.verifier.cancel();
    for (const helper of this.speechHelpers) helper.cancel();
    this.proof.cancel();
  }
  async shutdown() {
    await Promise.all([
      this.verifier.shutdown(),
      ...this.speechHelpers.map((helper) => helper.shutdown()),
      this.proof.shutdown(),
    ]);
  }
}
