import type { ModelHintUsage } from "../api.ts";
import type { SpeechInferenceResult } from "./native-inference.ts";

export interface SonioxConfiguration {
  apiKey: string;
  model: string;
  endpoint: string;
}
export interface StreamingSpeechSession {
  send(audio: Buffer): void;
  finish(): Promise<SpeechInferenceResult>;
  cancel(): void;
}
export type StartSpeechStream = (
  configuration: SonioxConfiguration,
  language: string,
  terms: string[],
  reference: string,
  update: (text: string) => void,
  failed: (reason: string) => void,
) => StreamingSpeechSession;

// Bound context conservatively in UTF-8 bytes, independent of provider tokenization.
export function sonioxHints(terms: string[]): ModelHintUsage {
  const includedTerms: string[] = [],
    omittedTerms: string[] = [];
  let bytes = 0;
  for (const term of terms) {
    const size = Buffer.byteLength(JSON.stringify(term)) + 1;
    if (bytes + size <= 6000) {
      includedTerms.push(term);
      bytes += size;
    } else omittedTerms.push(term);
  }
  return { includedTerms, omittedTerms };
}

/** One take, one socket. Failed streams are never resumed with ambiguous audio offsets. */
export const startSonioxStream: StartSpeechStream = (
  config,
  language,
  terms,
  reference,
  update,
  failed,
) => {
  const hints = sonioxHints(terms);
  const socket = new WebSocket(config.endpoint);
  let state: "connecting" | "streaming" | "finishing" | "closed" = "connecting";
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let audioBytes = 0;
  let finalText = "";
  let detectedLanguage = language === "auto" ? "en" : language;
  let finishedAt = 0;
  let endRequested = false;
  const completion = Promise.withResolvers<SpeechInferenceResult>();
  // A provider can fail during capture, long before the coordinator awaits finish().
  void completion.promise.catch(() => {});
  let deadline: ReturnType<typeof setTimeout>;
  const cleanup = () => {
    clearTimeout(deadline);
    pending = [];
    pendingBytes = 0;
    socket.close();
  };
  const fail = (reason: string) => {
    if (state === "closed") return;
    state = "closed";
    cleanup();
    completion.reject(new Error(reason));
    failed(reason);
  };
  const setDeadline = (ms: number, reason: string) => {
    clearTimeout(deadline);
    deadline = setTimeout(() => fail(reason), ms);
    deadline.unref();
  };
  const end = () => {
    state = "finishing";
    finishedAt = performance.now();
    socket.send("");
    setDeadline(10_000, "Soniox finalization timed out.");
  };
  setDeadline(5_000, "Soniox connection timed out.");
  socket.addEventListener("open", () => {
    if (state === "closed") {
      socket.close();
      return;
    }
    try {
      socket.send(
        JSON.stringify({
          api_key: config.apiKey,
          model: config.model,
          audio_format: "pcm_f32le",
          sample_rate: 16000,
          num_channels: 1,
          ...(language === "auto" ? {} : { language_hints: [language] }),
          enable_language_identification: true,
          enable_endpoint_detection: true,
          context: { terms: hints.includedTerms },
          client_reference_id: reference,
        }),
      );
      state = "streaming";
      setDeadline(300_000, "Soniox session timed out.");
      for (const audio of pending) socket.send(audio);
      pending = [];
      pendingBytes = 0;
      if (endRequested) end();
    } catch {
      fail("Could not start Soniox streaming.");
    }
  });
  socket.addEventListener("message", (event) => {
    if (state === "closed") return;
    try {
      if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 262_144)
        throw new Error("Invalid Soniox response.");
      const response: unknown = JSON.parse(event.data);
      if (!response || typeof response !== "object") throw new Error("Invalid Soniox response.");
      if ("error_code" in response || "error_type" in response) {
        // Never archive provider-supplied messages, which may echo request credentials/context.
        const code =
          "error_code" in response && typeof response.error_code === "number"
            ? response.error_code
            : "unknown";
        fail(`Soniox request failed (${code}). Check server credentials, quota, and connectivity.`);
        return;
      }
      let partialText = "";
      if ("tokens" in response) {
        if (!Array.isArray(response.tokens)) throw new Error("Invalid Soniox tokens.");
        for (const token of response.tokens as unknown[]) {
          if (
            !token ||
            typeof token !== "object" ||
            !("text" in token) ||
            typeof token.text !== "string" ||
            !("is_final" in token) ||
            typeof token.is_final !== "boolean"
          )
            throw new Error("Invalid Soniox token.");
          if (token.text === "<end>" || token.text === "<fin>") continue;
          if (token.is_final) {
            finalText += token.text;
            if (
              "language" in token &&
              typeof token.language === "string" &&
              token.language.length <= 32
            )
              detectedLanguage = token.language;
          } else partialText += token.text;
        }
        if (Buffer.byteLength(finalText + partialText) > 96_000)
          throw new Error("Soniox transcript exceeded its limit.");
        update(finalText + partialText);
      }
      if ("finished" in response && response.finished === true) {
        if (state !== "finishing") throw new Error("Soniox ended before all audio was sent.");
        state = "closed";
        cleanup();
        completion.resolve({
          text: finalText,
          language: detectedLanguage,
          hints,
          audioSeconds: audioBytes / 64000,
          processingSeconds: (performance.now() - finishedAt) / 1000,
        });
      }
    } catch {
      fail("Soniox returned an invalid or incomplete response.");
    }
  });
  socket.addEventListener("error", () => fail("Soniox connection failed."));
  socket.addEventListener("close", () =>
    fail("Soniox disconnected before transcription completed."),
  );
  return {
    send(audio) {
      if (state === "closed") return;
      if (endRequested) {
        fail("Audio arrived after Soniox finalization.");
        return;
      }
      audioBytes += audio.length;
      if (pendingBytes + socket.bufferedAmount + audio.length > 128_000) {
        fail("Soniox connection could not keep up with the recording.");
        return;
      }
      try {
        if (state === "connecting") {
          pending.push(Buffer.from(audio));
          pendingBytes += audio.length;
        } else socket.send(audio);
      } catch {
        fail("Soniox audio transfer failed.");
      }
    },
    finish() {
      if (!endRequested && state !== "closed") {
        endRequested = true;
        if (state === "streaming") {
          try {
            end();
          } catch {
            fail("Soniox finalization failed.");
          }
        }
      }
      return completion.promise;
    },
    cancel() {
      if (state === "closed") return;
      state = "closed";
      cleanup();
      completion.reject(new Error("Recognition cancelled."));
    },
  };
};

export interface LiveSpeechHandlers {
  /** Finalized plus provisional text since the last finalized segment, for previews. */
  partial(text: string): void;
  /** The provider detected the end of an utterance; a quiet cut is safe now. */
  endpoint(): void;
  /** All audio sent before the matching finalize() is now final. */
  finalized(segment: { text: string; language: string }): void;
  failed(reason: string): void;
}
export interface LiveSpeechStream {
  send(audio: Buffer): void;
  /** Ask the provider to finalize every pending token; answered by `finalized`. */
  finalize(): void;
  keepalive(): void;
  close(): void;
}
export type StartLiveSpeechStream = (
  configuration: SonioxConfiguration,
  language: string,
  terms: string[],
  reference: string,
  handlers: LiveSpeechHandlers,
) => LiveSpeechStream;

/**
 * A long-lived Soniox stream that commits text in segments. Unlike a single
 * take, it has no duration deadline: the caller rolls over before the
 * provider's session cap and bounds uncommitted text by finalizing.
 */
export const startSonioxLiveStream: StartLiveSpeechStream = (
  config,
  language,
  terms,
  reference,
  handlers,
) => {
  const hints = sonioxHints(terms);
  const socket = new WebSocket(config.endpoint);
  let state: "connecting" | "streaming" | "closed" = "connecting";
  let pending: (string | Buffer)[] = [];
  let pendingBytes = 0;
  let finalText = "";
  let detectedLanguage = language === "auto" ? "en" : language;
  let connectTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => fail("Soniox connection timed out."),
    5_000,
  );
  connectTimer.unref();
  const fail = (reason: string) => {
    if (state === "closed") return;
    state = "closed";
    clearTimeout(connectTimer);
    pending = [];
    socket.close();
    handlers.failed(reason);
  };
  const deliver = (message: string | Buffer) => {
    if (state === "connecting") {
      pending.push(message);
      pendingBytes += typeof message === "string" ? Buffer.byteLength(message) : message.length;
      if (pendingBytes > 2_000_000) fail("Soniox connection could not keep up with the recording.");
      return;
    }
    if (socket.bufferedAmount > 2_000_000) {
      fail("Soniox connection could not keep up with the recording.");
      return;
    }
    socket.send(message);
  };
  socket.addEventListener("open", () => {
    if (state === "closed") {
      socket.close();
      return;
    }
    clearTimeout(connectTimer);
    connectTimer = undefined;
    try {
      socket.send(
        JSON.stringify({
          api_key: config.apiKey,
          model: config.model,
          audio_format: "pcm_f32le",
          sample_rate: 16000,
          num_channels: 1,
          ...(language === "auto" ? {} : { language_hints: [language] }),
          enable_language_identification: true,
          enable_endpoint_detection: true,
          context: { terms: hints.includedTerms },
          client_reference_id: reference,
        }),
      );
      state = "streaming";
      for (const item of pending) socket.send(item);
      pending = [];
      pendingBytes = 0;
    } catch {
      fail("Could not start Soniox streaming.");
    }
  });
  socket.addEventListener("message", (event) => {
    if (state === "closed") return;
    try {
      if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 262_144)
        throw new Error("Invalid Soniox response.");
      const response: unknown = JSON.parse(event.data);
      if (!response || typeof response !== "object") throw new Error("Invalid Soniox response.");
      if ("error_code" in response || "error_type" in response) {
        // Never archive provider-supplied messages, which may echo request credentials/context.
        const code =
          "error_code" in response && typeof response.error_code === "number"
            ? response.error_code
            : "unknown";
        fail(`Soniox request failed (${code}). Check server credentials, quota, and connectivity.`);
        return;
      }
      if (!("tokens" in response)) return;
      if (!Array.isArray(response.tokens)) throw new Error("Invalid Soniox tokens.");
      let partialText = "",
        endpoint = false,
        finalized = false;
      for (const token of response.tokens as unknown[]) {
        if (
          !token ||
          typeof token !== "object" ||
          !("text" in token) ||
          typeof token.text !== "string" ||
          !("is_final" in token) ||
          typeof token.is_final !== "boolean"
        )
          throw new Error("Invalid Soniox token.");
        if (token.text === "<end>") {
          endpoint = true;
          continue;
        }
        if (token.text === "<fin>") {
          finalized = true;
          continue;
        }
        if (token.is_final) {
          finalText += token.text;
          if (
            "language" in token &&
            typeof token.language === "string" &&
            token.language.length <= 32
          )
            detectedLanguage = token.language;
        } else partialText += token.text;
      }
      if (Buffer.byteLength(finalText + partialText) > 96_000)
        throw new Error("Soniox transcript segment exceeded its limit.");
      handlers.partial(finalText + partialText);
      if (finalized) {
        const segment = { text: finalText, language: detectedLanguage };
        finalText = "";
        handlers.finalized(segment);
      }
      if (endpoint) handlers.endpoint();
    } catch {
      fail("Soniox returned an invalid or incomplete response.");
    }
  });
  socket.addEventListener("error", () => fail("Soniox connection failed."));
  socket.addEventListener("close", () =>
    fail("Soniox disconnected before transcription completed."),
  );
  return {
    send(audio) {
      if (state !== "closed") deliver(Buffer.from(audio));
    },
    finalize() {
      if (state !== "closed") deliver(JSON.stringify({ type: "finalize" }));
    },
    keepalive() {
      if (state === "streaming") deliver(JSON.stringify({ type: "keepalive" }));
    },
    close() {
      if (state === "closed") return;
      state = "closed";
      clearTimeout(connectTimer);
      pending = [];
      socket.close();
    },
  };
};
