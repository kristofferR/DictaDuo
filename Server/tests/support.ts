import type { InferenceBackend } from "../src/inference/native-inference.ts";
import { GenerationService } from "../src/generation-service.ts";
import { RecordingService, type RecordingConfiguration } from "../src/recording-service.ts";
import type { CaptureProvider } from "../src/capture-sessions.ts";

export class FakeInference implements InferenceBackend {
  async readiness() {
    return { available: true, message: "Ready.", speechLoaded: true, proofLoaded: true };
  }
  async warmUp() {}
  async transcribe(
    _path: string,
    _language: string,
    _terms: string[],
    progress?: (value: number) => void,
  ) {
    progress?.(0.5);
    return {
      text: "Hello world.",
      audioSeconds: 1,
      processingSeconds: 0.01,
      language: "en",
      engineVersion: "fixture",
    };
  }
  async correct(text: string, _terms?: string[], _language?: string) {
    return { text, processingSeconds: 0.01, engineVersion: "fixture" };
  }
  async cancel() {}
  async shutdown() {}
}

/**
 * Legacy generations plus recording sessions, wired the way the server is: a
 * remote capture provider records durable sessions.
 */
export async function openCaptureServices(
  dataDirectory: string,
  captureProvider: CaptureProvider | undefined,
  inference: InferenceBackend = new FakeInference(),
  live: Pick<RecordingConfiguration, "soniox" | "startLiveSpeechStream"> = {},
) {
  const service = await GenerationService.open(
    { dataDirectory, development: true, captureProvider },
    inference,
  );
  const recordings = await RecordingService.open(
    { dataDirectory, development: true, ...live },
    inference,
    {
      getPreferences: () => service.getPreferences(),
      resolveContinuation: (id, snapshot) => service.resolveRecordingContinuation(id, snapshot),
    },
  );
  service.attachRecordings(recordings);
  return {
    service,
    recordings,
    async close() {
      await Promise.allSettled([recordings.shutdown(), service.shutdown()]);
    },
  };
}
