import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RecordingService } from "../src/recording-service.ts";
import { LiveRecognition, type LiveRunState } from "../src/recording-recognition.ts";
import { defaultPreferences } from "../src/generation-service.ts";
import { sha256 } from "../src/storage.ts";
import { InferenceError } from "../src/inference/inference-error.ts";
import type { LiveSpeechHandlers, StartLiveSpeechStream } from "../src/inference/soniox.ts";
import type { ServerPreferences } from "../src/api.ts";
type RecognitionMode = NonNullable<ServerPreferences["recognitionMode"]>;
import type { RecordingSnapshot } from "../src/recording-contract.ts";
import { FakeInference } from "./support.ts";

/** Each finalized segment reports how many frames it received since the last one. */
class FakeLiveProvider {
  streams: { frames: number; finalized: number; closed: boolean; handlers: LiveSpeechHandlers }[] =
    [];
  failNext = false;
  /** A provider that never answers finalize leaves the run uncommitted. */
  finalizes = true;
  start: StartLiveSpeechStream = (_config, _language, _terms, _reference, handlers) => {
    const stream = { frames: 0, finalized: 0, closed: false, handlers };
    this.streams.push(stream);
    if (this.failNext) {
      this.failNext = false;
      queueMicrotask(() => handlers.failed("Provider unavailable."));
    }
    return {
      send: (audio) => {
        stream.frames += audio.length / 4;
      },
      finalize: () => {
        if (!this.finalizes) return;
        const frames = stream.frames - stream.finalized;
        stream.finalized = stream.frames;
        queueMicrotask(() => handlers.finalized({ text: `[${frames}]`, language: "nb" }));
      },
      keepalive: () => {},
      close: () => {
        stream.closed = true;
      },
    };
  };
  fail(index: number) {
    this.streams[index]!.handlers.failed("Provider dropped the session.");
  }
}
class CountingInference extends FakeInference {
  windows = 0;
  override async transcribe(path: string) {
    const wav = await readFile(path);
    this.windows++;
    return {
      text: `local ${wav.readUInt32LE(40) / 4}`,
      audioSeconds: 1,
      processingSeconds: 0.01,
      language: "en",
      engineVersion: "fixture",
    };
  }
}

const resources: { service: RecordingService; path: string }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.service.shutdown();
    await rm(resource.path, { recursive: true, force: true });
  }
});
async function setup(
  mode: RecognitionMode,
  provider = new FakeLiveProvider(),
  inference = new CountingInference(),
) {
  const path = await mkdtemp(join(tmpdir(), "sottoduo-live-test-"));
  const preferences = defaultPreferences();
  preferences.preferences.keepOriginalAudio = false;
  preferences.preferences.textCorrectionEnabled = false;
  preferences.preferences.recognitionMode = mode;
  const service = await RecordingService.open(
    {
      dataDirectory: path,
      development: true,
      soniox: { apiKey: "test", model: "stt-rt-test", endpoint: "wss://soniox.invalid" },
      startLiveSpeechStream: provider.start,
    },
    inference,
    { getPreferences: async () => structuredClone(preferences) },
  );
  resources.push({ service, path });
  return { service, provider, inference };
}
async function record(service: RecordingService, seconds: number[]) {
  const created = await service.create({
    requestID: randomUUID(),
    device: { id: "test-device", name: "Test Mac" },
    mode: "test",
  });
  const snapshot = await service.resume(created.id);
  const runID = randomUUID().toUpperCase();
  let frame = 0;
  for (const [sequence, length] of seconds.entries()) {
    const pcm = Buffer.alloc(length * 64_000);
    await service.appendAudio(
      snapshot.id,
      {
        type: "audio",
        epoch: snapshot.epoch,
        runID,
        kind: "inference",
        sequence,
        firstFrame: frame,
        frameCount: pcm.length / 4,
        format: { sampleRate: 16000, channels: 1 },
        sha256: sha256(pcm),
      },
      pcm,
    );
    frame += pcm.length / 4;
  }
  return { snapshot, runID, frames: frame };
}
async function waitFor(
  service: RecordingService,
  id: string,
  condition: (value: RecordingSnapshot) => boolean,
) {
  for (let count = 0; count < 2000; count++) {
    const snapshot = await service.get(id);
    if (condition(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Recording did not reach expected state.");
}

test("live provider text is committed once per frame and labels the result", async () => {
  const { service, provider, inference } = await setup("automatic");
  const { snapshot, runID, frames } = await record(service, [1, 1]);
  expect(snapshot.recognition).toEqual({ provider: "soniox" });
  await service.stop(snapshot.id, snapshot.epoch, [{ runID, inferenceFrames: frames }]);
  await waitFor(service, snapshot.id, (value) => value.processingState === "completed");
  const detail = await service.detail(snapshot.id);
  expect(detail.result?.finalText).toBe(`[${frames}]`);
  expect(detail.result?.speech?.backend).toBe("soniox/websocket");
  expect(detail.result?.recognition).toEqual({ provider: "soniox" });
  expect(provider.streams.reduce((sum, stream) => sum + stream.frames, 0)).toBe(frames);
  expect(inference.windows).toBe(0);
});

test("automatic mode continues with local windows from the committed cursor", async () => {
  const { service, provider, inference } = await setup("automatic");
  const { snapshot, runID, frames } = await record(service, [1]);
  await waitFor(service, snapshot.id, () => provider.streams[0]?.frames === 16_000);
  provider.fail(0);
  const fallen = await waitFor(
    service,
    snapshot.id,
    (value) => value.recognition?.provider === "whisper",
  );
  expect(fallen.recognition?.fallbackReason).toBe("Provider dropped the session.");
  await service.stop(snapshot.id, snapshot.epoch, [{ runID, inferenceFrames: frames }]);
  await waitFor(service, snapshot.id, (value) => value.processingState === "completed");
  expect((await service.detail(snapshot.id)).result?.recognition?.fallbackReason).toBe(
    "Provider dropped the session.",
  );
  expect(inference.windows).toBeGreaterThan(0);
});

test("cloud-only mode backs off between provider retries, then preserves audio and fails", async () => {
  const provider = new FakeLiveProvider();
  const context = await setup("cloud", provider);
  const { service, inference } = context;
  const { snapshot, runID, frames } = await record(service, [1]);
  await waitFor(service, snapshot.id, () => provider.streams.length === 1);
  for (let attempt = 0; attempt < 4; attempt++) {
    await waitFor(service, snapshot.id, () => provider.streams.length === attempt + 1);
    const failedAt = Date.now();
    provider.fail(attempt);
    if (attempt < 3) {
      await waitFor(service, snapshot.id, () => provider.streams.length === attempt + 2);
      expect(Date.now() - failedAt).toBeGreaterThanOrEqual(900 * 2 ** attempt);
    }
  }
  const failed = await waitFor(service, snapshot.id, (value) => value.processingState === "failed");
  expect(failed.error).toContain("Captured audio has been preserved.");
  expect(inference.windows).toBe(0);
  // Stopping keeps the exhausted failure retryable, and its preserved audio exportable.
  const stopped = await service.stop(snapshot.id, snapshot.epoch, [
    { runID, inferenceFrames: frames },
  ]);
  expect(stopped).toMatchObject({ captureState: "stopped", processingState: "failed" });
  await (await service.artifact(snapshot.id, "inference")).close();
  // A restart keeps the failure until the user retries; it never replays the provider.
  await service.shutdown();
  const restarted = await RecordingService.open(
    {
      dataDirectory: resources.at(-1)!.path,
      development: true,
      soniox: { apiKey: "test", model: "stt-rt-test", endpoint: "wss://soniox.invalid" },
      startLiveSpeechStream: provider.start,
    },
    inference,
    { getPreferences: async () => ({ ...defaultPreferences() }) },
  );
  resources.at(-1)!.service = restarted;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await restarted.get(snapshot.id)).toMatchObject({
    processingState: "failed",
    error: failed.error,
  });
  expect(provider.streams).toHaveLength(4);
}, 20_000);

test("a large backlog reaches the provider no faster than near real time", async () => {
  const { service, provider } = await setup("cloud");
  await record(service, [10]);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  // A 2 s burst plus 1.5x real time, and at most one half-second read in flight.
  expect(provider.streams[0]!.frames).toBeLessThanOrEqual((2 + 1.5 * 1.2 + 0.5) * 16_000);
  expect(provider.streams[0]!.frames).toBeGreaterThan(2 * 16_000);
});

test("after a restart a new stream resumes exactly at the committed cursor", async () => {
  const provider = new FakeLiveProvider();
  const context = await setup("automatic", provider);
  const { snapshot, runID, frames } = await record(context.service, [1, 1]);
  await context.service.pause(
    snapshot.id,
    snapshot.epoch,
    [{ runID, inferenceFrames: frames }],
    [{ runID, startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T10:00:02.000Z" }],
  );
  await waitFor(context.service, snapshot.id, (value) => value.transcribedFrames === frames);
  const sent = provider.streams.reduce((sum, stream) => sum + stream.frames, 0);
  await context.service.shutdown();
  const service = await RecordingService.open(
    {
      dataDirectory: resources.at(-1)!.path,
      development: true,
      soniox: { apiKey: "test", model: "stt-rt-test", endpoint: "wss://soniox.invalid" },
      startLiveSpeechStream: provider.start,
    },
    context.inference,
    { getPreferences: async () => ({ ...defaultPreferences() }) },
  );
  resources.at(-1)!.service = service;
  const resumed = await service.resume(snapshot.id);
  await service.stop(snapshot.id, resumed.epoch, [{ runID, inferenceFrames: frames }]);
  await waitFor(service, snapshot.id, (value) => value.processingState === "completed");
  // Committed audio is never sent twice, even across the restart.
  expect(provider.streams.reduce((sum, stream) => sum + stream.frames, 0)).toBe(sent);
  expect((await service.detail(snapshot.id)).result?.finalText).toBe(`[${frames}]`);
});

test("retrying a failed session resumes locally without the provider or delivery", async () => {
  const provider = new FakeLiveProvider();
  provider.finalizes = false;
  const { service, inference } = await setup("cloud", provider);
  const { snapshot, runID, frames } = await record(service, [1]);
  await expect(service.retry(snapshot.id)).rejects.toMatchObject({ code: "not_retryable" });
  await service.stop(snapshot.id, snapshot.epoch, [{ runID, inferenceFrames: frames }]);
  for (let attempt = 0; attempt < 4; attempt++) {
    await waitFor(service, snapshot.id, () => provider.streams.length === attempt + 1);
    provider.fail(attempt);
  }
  await waitFor(service, snapshot.id, (value) => value.processingState === "failed");
  // Reconnecting must not silently replay a stopped failure.
  expect(await service.resume(snapshot.id)).toMatchObject({ processingState: "failed" });
  const retried = await service.retry(snapshot.id);
  expect(retried).toMatchObject({
    processingState: "queued",
    recognition: { provider: "whisper" },
  });
  expect(retried.error).toBeUndefined();
  await waitFor(service, snapshot.id, (value) => value.processingState === "completed");
  const detail = await service.detail(snapshot.id);
  expect(detail.result?.finalText).toBe(`local ${frames}`);
  expect(detail.result?.delivery).toBeUndefined();
  expect(provider.streams).toHaveLength(4);
  expect(inference.windows).toBe(1);
}, 20_000);

test("a rollover drains the provider session under continuous audio", async () => {
  const now = Date.now.bind(Date);
  let offset = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now() + offset);
  const streams: { frames: number; closed: boolean; handlers: LiveSpeechHandlers }[] = [];
  let wokeAfterClose = false;
  const recognition = new LiveRecognition(
    { apiKey: "test", model: "stt-rt-test", endpoint: "wss://soniox.invalid" },
    (_config, _language, _terms, _reference, handlers) => {
      const stream = { frames: 0, closed: false, handlers };
      streams.push(stream);
      return {
        send: (audio) => {
          stream.frames += audio.length / 4;
        },
        // The provider answers slowly while audio keeps arriving.
        finalize: () => {
          setTimeout(() => handlers.finalized({ text: "x", language: "nb" }), 300);
        },
        keepalive: () => {},
        close: () => {
          stream.closed = true;
        },
      };
    },
    {
      read: async (_id, _run, _first, count) => Buffer.alloc(count * 4),
      preview() {},
      // A stopped take gets no further audio, so the worker must be woken to reopen.
      segment() {
        if (streams[0]?.closed) wokeAfterClose = true;
      },
      failed() {},
    },
  );
  try {
    const state: LiveRunState = {
      runID: "run",
      cursorFrame: 0,
      availableFrames: 3600 * 16_000,
      language: "nb",
      terms: [],
      cloudOnly: true,
    };
    recognition.sync("id", state);
    await new Promise((resolve) => setTimeout(resolve, 200));
    offset = 4 * 60 * 60 * 1000 + 1;
    streams[0]!.handlers.endpoint();
    for (let count = 0; count < 300 && !streams[0]!.closed; count++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const segment = recognition.sync("id", state);
      if (!segment) continue;
      state.cursorFrame = segment.endFrame;
      recognition.consumed("id", segment);
    }
    expect(streams[0]!.closed).toBe(true);
    expect(state.cursorFrame).toBe(streams[0]!.frames);
    expect(wokeAfterClose).toBe(true);
  } finally {
    recognition.shutdown();
    clock.mockRestore();
  }
});

test("a timed-out speech window fails at once instead of spending a second budget", async () => {
  class TimingOut extends CountingInference {
    override async transcribe(): Promise<never> {
      this.windows++;
      throw new InferenceError("timeout", "Speech inference timed out.");
    }
  }
  const inference = new TimingOut();
  const { service } = await setup("local", undefined, inference);
  const { snapshot, runID, frames } = await record(service, [1]);
  await service.stop(snapshot.id, snapshot.epoch, [{ runID, inferenceFrames: frames }]);
  const failed = await waitFor(service, snapshot.id, (value) => value.processingState === "failed");
  expect(failed.error).toContain("timed out");
  expect(inference.windows).toBe(1);
});
