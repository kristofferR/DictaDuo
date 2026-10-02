import type { RecognitionState, ServerPreferences } from "../api.ts";
import type { InferenceBackend } from "./native-inference.ts";
import { InferenceError } from "./inference-error.ts";
import {
  startSonioxStream,
  type SonioxConfiguration,
  type StartSpeechStream,
  type StreamingSpeechSession,
} from "./soniox.ts";

/** Keeps provider policy out of the archive, text pipeline, and native helpers. */
export class RecognitionSession {
  private stream?: StreamingSpeechSession;
  private error?: string;
  private cancelled = false;
  private readonly mode;
  readonly state: RecognitionState;
  constructor(
    private readonly local: InferenceBackend,
    private readonly settings: ServerPreferences,
    private readonly terms: string[],
    private readonly config: SonioxConfiguration | undefined,
    id: string,
    private readonly changed: (state: RecognitionState) => void,
    start: StartSpeechStream = startSonioxStream,
  ) {
    this.mode = settings.recognitionMode ?? "automatic";
    this.state = { provider: this.mode === "local" || !config ? "whisper" : "soniox" };
    if (this.mode === "local") return;
    if (!config) {
      this.fail("Soniox is not configured.");
      return;
    }
    try {
      this.stream = start(
        config,
        settings.language,
        terms,
        id,
        (text) => {
          if (this.cancelled || this.error) return;
          this.state.partialText = text;
          this.changed({ ...this.state });
        },
        (reason) => this.fail(reason),
      );
    } catch {
      this.fail("Could not connect to Soniox.");
    }
  }
  private fail(reason: string) {
    if (this.cancelled) return;
    this.error = reason;
    delete this.state.partialText;
    if (this.mode === "automatic") {
      this.state.provider = "whisper";
      this.state.fallbackReason = reason;
    }
    this.changed({ ...this.state });
  }
  send(bytes: Buffer) {
    if (!this.error && !this.cancelled) this.stream?.send(bytes);
  }
  end() {
    if (!this.error && !this.cancelled) void this.stream?.finish().catch(() => {});
  }
  cancel() {
    this.cancelled = true;
    this.stream?.cancel();
  }
  private checkCancellation(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.cancelled) throw new DOMException("Recognition cancelled.", "AbortError");
  }
  async transcribe(path: string, progress: (value: number) => void, signal: AbortSignal) {
    this.checkCancellation(signal);
    if (this.stream && !this.error) {
      try {
        const speech = await this.stream.finish();
        this.checkCancellation(signal);
        return { ...speech, modelID: this.config!.model, backend: "soniox/websocket" };
      } catch {
        this.checkCancellation(signal);
        if (!this.error) this.fail("Soniox transcription failed.");
      }
    }
    if (this.mode === "cloud") throw new Error(this.error ?? "Soniox is unavailable.");
    // Replay the entire sealed recording. Never join cloud tokens to a local suffix.
    const transcribe = () =>
      this.local.transcribe(path, this.settings.language, this.terms, progress, signal);
    // The sealed audio is still on disk, so a transient engine failure gets one
    // more attempt before the recording is reported as failed. A timeout already
    // spent the whole speech budget; a second one would outlive the client's
    // event stream, so it fails immediately.
    const speech = await transcribe().catch((error: unknown) => {
      this.checkCancellation(signal);
      if (
        error instanceof InferenceError &&
        (error.code === "cancelled" || error.code === "timeout")
      )
        throw error;
      return transcribe();
    });
    return {
      ...speech,
      modelID: "whisper-large-v3-turbo",
      backend: process.platform === "darwin" ? "whisper.cpp/Metal" : "whisper.cpp",
    };
  }
}
