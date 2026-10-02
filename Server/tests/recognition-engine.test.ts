import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { GenerationService } from "../src/generation-service.ts";
import { RecordingService } from "../src/recording-service.ts";
import { createHTTPServer } from "../src/http-server.ts";
import { sha256 } from "../src/storage.ts";
import { validateBody } from "../src/validation.ts";
import type { RecognitionEngine } from "../src/api.ts";
import { FakeInference } from "./support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Records which engine each call used; Parakeet reports no language. */
class Engines extends FakeInference {
  calls: { engine: RecognitionEngine; terms: string[] }[] = [];
  proofLanguages: string[] = [];
  /** Engines whose model is unverified, as after a restart, until warmed. */
  cold = new Set<RecognitionEngine>();
  warmed: RecognitionEngine[] = [];
  failures = 0;
  constructor(readonly engines: readonly RecognitionEngine[] = ["whisper", "parakeet"]) {
    super();
  }
  override async readiness(_proofreading?: boolean, engine: RecognitionEngine = "whisper") {
    return { ...(await super.readiness()), available: !this.cold.has(engine) };
  }
  override async warmUp(
    _proofreading?: boolean,
    _signal?: AbortSignal,
    engine?: RecognitionEngine,
  ) {
    this.warmed.push(engine ?? "whisper");
    this.cold.delete(engine ?? "whisper");
  }
  override async transcribe(
    path: string,
    language: string,
    terms: string[],
    progress?: (value: number) => void,
    _signal?: AbortSignal,
    engine: RecognitionEngine = "whisper",
  ) {
    if (this.failures-- > 0) throw new Error("Helper exited.");
    this.calls.push({ engine, terms });
    const speech = await super.transcribe(path, language, terms, progress);
    return { ...speech, language: engine === "parakeet" ? "auto" : "en" };
  }
  override async correct(text: string, _terms?: string[], language = "") {
    this.proofLanguages.push(language);
    return { text, processingSeconds: 0.01, engineVersion: "fixture" };
  }
}

async function open(inference = new Engines()) {
  const path = await mkdtemp(join(tmpdir(), "sottoduo-engine-"));
  const service = await GenerationService.open(
    { dataDirectory: path, development: true },
    inference,
  );
  cleanups.push(async () => {
    await service.shutdown();
    await rm(path, { recursive: true, force: true });
  });
  return { service, inference, path };
}

async function select(service: GenerationService, engine: RecognitionEngine) {
  const preferences = await service.getPreferences();
  preferences.preferences.recognitionEngine = engine;
  preferences.preferences.recognitionMode = "local";
  preferences.preferences.language = "sv";
  preferences.preferences.keepOriginalAudio = false;
  return service.updatePreferences(preferences);
}

test("the engine is a shared preference that must be installed to be chosen", async () => {
  const whisperOnly = await open(new Engines(["whisper"]));
  expect((await whisperOnly.service.getPreferences()).preferences.recognitionEngine).toBe(
    "whisper",
  );
  expect((await whisperOnly.service.health()).recognitionEngines).toEqual(["whisper"]);
  await expect(select(whisperOnly.service, "parakeet")).rejects.toMatchObject({
    code: "invalid_preferences",
  });

  const { service } = await open();
  expect((await service.health()).recognitionEngines).toEqual(["whisper", "parakeet"]);
  await select(service, "parakeet");
  // An older client's update omits the engine and keeps the selection.
  const saved = await service.getPreferences();
  delete saved.preferences.recognitionEngine;
  saved.preferences.textCorrectionEnabled = false;
  await service.updatePreferences(saved);
  expect((await service.getPreferences()).preferences.recognitionEngine).toBe("parakeet");
  expect((await service.health()).speech).toMatchObject({ modelID: "parakeet-tdt-0.6b-v3" });
});

test("a legacy take is recognized by its frozen engine without inventing a language", async () => {
  const { service, inference } = await open();
  await select(service, "parakeet");
  const record = await service.create({
    requestID: randomUUID(),
    device: { id: "fixture", name: "Test Mac" },
    mode: "test",
  });
  // Changing the preference later does not move a take that already started.
  await select(service, "whisper");
  await service.appendAudio(
    record.id,
    "inference",
    0,
    { sampleRate: 16000, channels: 1 },
    Buffer.alloc(16_000),
  );
  await service.finish(record.id, { inferenceFrames: 4000 });
  let done;
  for await (const value of await service.events(record.id))
    if (["completed", "failed", "cancelled"].includes(value.status)) {
      done = value;
      break;
    }
  expect(done?.status).toBe("completed");
  expect(inference.calls.map((call) => call.engine)).toEqual(["parakeet"]);
  expect(done?.speech?.modelID).toBe("parakeet-tdt-0.6b-v3");
  expect(done?.detectedLanguage).toBeUndefined();
  // Proofreading falls back to the configured language.
  expect(inference.proofLanguages).toEqual(["sv"]);
});

test("recording sessions recognize every window with the session's engine", async () => {
  const inference = new Engines();
  const { service, path } = await open(inference);
  await select(service, "parakeet");
  const recordings = await RecordingService.open(
    { dataDirectory: path, development: true },
    inference,
    { getPreferences: () => service.getPreferences() },
  );
  cleanups.push(() => recordings.shutdown());
  const created = await recordings.create({
    requestID: randomUUID(),
    device: { id: "fixture", name: "Test Mac" },
    mode: "test",
  });
  const session = await recordings.resume(created.id);
  const runID = randomUUID().toUpperCase();
  const pcm = Buffer.alloc(64_000);
  await recordings.appendAudio(
    session.id,
    {
      type: "audio",
      epoch: session.epoch,
      runID,
      kind: "inference",
      sequence: 0,
      firstFrame: 0,
      frameCount: 16_000,
      format: { sampleRate: 16000, channels: 1 },
      sha256: sha256(pcm),
    },
    pcm,
  );
  await recordings.stop(session.id, session.epoch, [{ runID, inferenceFrames: 16_000 }]);
  for (let count = 0; (await recordings.get(session.id)).processingState !== "completed"; count++) {
    if (count > 400) throw new Error("Session did not complete.");
    await Bun.sleep(5);
  }
  const result = (await recordings.detail(session.id)).result!;
  expect(inference.calls.every((call) => call.engine === "parakeet")).toBe(true);
  expect(result.speech?.modelID).toBe("parakeet-tdt-0.6b-v3");
  expect(result.detectedLanguage).toBeUndefined();
});

test("a selection whose engine was uninstalled runs on Whisper and says so", async () => {
  const path = await mkdtemp(join(tmpdir(), "sottoduo-engine-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  const before = await GenerationService.open(
    { dataDirectory: path, development: true },
    new Engines(),
  );
  await select(before, "parakeet");
  await before.shutdown();
  // The server restarts without Parakeet; the stored selection is kept.
  const inference = new Engines(["whisper"]);
  const service = await GenerationService.open(
    { dataDirectory: path, development: true },
    inference,
  );
  cleanups.push(() => service.shutdown());
  expect((await service.getPreferences()).preferences.recognitionEngine).toBe("parakeet");
  expect((await service.health()).speech.modelID).toBe("whisper-large-v3-turbo");
  const record = await service.create({
    requestID: randomUUID(),
    device: { id: "fixture", name: "Test Mac" },
    mode: "test",
  });
  await service.appendAudio(
    record.id,
    "inference",
    0,
    { sampleRate: 16000, channels: 1 },
    Buffer.alloc(16_000),
  );
  await service.finish(record.id, { inferenceFrames: 4000 });
  for await (const value of await service.events(record.id))
    if (["completed", "failed", "cancelled"].includes(value.status)) {
      expect(value.status).toBe("completed");
      expect(value.speech?.modelID).toBe("whisper-large-v3-turbo");
      break;
    }
  expect(inference.calls.map((call) => call.engine)).toEqual(["whisper"]);
});

async function until(condition: () => boolean | Promise<boolean>) {
  for (let count = 0; !(await condition()); count++) {
    if (count > 400) throw new Error("Condition was not met.");
    await Bun.sleep(5);
  }
}

test("retrying a take after a restart warms the take's engine, not the preference", async () => {
  const { service, inference } = await open();
  await select(service, "parakeet");
  const record = await service.create({
    requestID: randomUUID(),
    device: { id: "fixture", name: "Test Mac" },
    mode: "test",
  });
  await service.appendAudio(
    record.id,
    "inference",
    0,
    { sampleRate: 16000, channels: 1 },
    Buffer.alloc(16_000),
  );
  inference.failures = 2;
  await service.finish(record.id, { inferenceFrames: 4000 });
  await until(async () => (await service.get(record.id)).status === "failed");
  await select(service, "whisper");
  inference.cold.add("parakeet");
  await expect(service.retry(record.id)).rejects.toMatchObject({ code: "server_unavailable" });
  await until(() => inference.warmed.includes("parakeet"));
  expect((await service.retry(record.id)).status).toBe("queued");
  await until(async () => (await service.get(record.id)).status === "completed");
  expect(inference.calls.map((call) => call.engine)).toEqual(["parakeet"]);
});

test("retrying a recording session warms the session's engine", async () => {
  const inference = new Engines();
  const { service, path } = await open(inference);
  await select(service, "parakeet");
  const recordings = await RecordingService.open(
    { dataDirectory: path, development: true },
    inference,
    { getPreferences: () => service.getPreferences() },
  );
  cleanups.push(() => recordings.shutdown());
  const created = await recordings.create({
    requestID: randomUUID(),
    device: { id: "fixture", name: "Test Mac" },
    mode: "test",
  });
  const session = await recordings.resume(created.id);
  const runID = randomUUID().toUpperCase();
  const pcm = Buffer.alloc(64_000);
  await recordings.appendAudio(
    session.id,
    {
      type: "audio",
      epoch: session.epoch,
      runID,
      kind: "inference",
      sequence: 0,
      firstFrame: 0,
      frameCount: 16_000,
      format: { sampleRate: 16000, channels: 1 },
      sha256: sha256(pcm),
    },
    pcm,
  );
  inference.failures = Number.MAX_SAFE_INTEGER;
  await recordings.stop(session.id, session.epoch, [{ runID, inferenceFrames: 16_000 }]);
  await until(async () => (await recordings.get(session.id)).processingState === "failed");
  inference.failures = 0;
  await select(service, "whisper");
  inference.cold.add("parakeet");
  await expect(recordings.retry(session.id)).rejects.toMatchObject({
    code: "server_unavailable",
  });
  await until(() => inference.warmed.includes("parakeet"));
  expect((await recordings.retry(session.id)).processingState).toBe("queued");
  await until(async () => (await recordings.get(session.id)).processingState === "completed");
  expect(inference.calls.every((call) => call.engine === "parakeet")).toBe(true);
});

test("responses include engine fields only for clients that request them", async () => {
  const { service, inference, path } = await open();
  await select(service, "parakeet");
  const recordings = await RecordingService.open(
    { dataDirectory: path, development: true },
    inference,
    { getPreferences: () => service.getPreferences() },
  );
  const app = createHTTPServer(service, undefined, undefined, recordings);
  cleanups.push(async () => {
    await app.close();
    await recordings.shutdown();
  });
  const headers = { "x-sottoduo-recognition-engine": "engine-v1" };
  const legacy = await app.inject({ url: "/v1/preferences" });
  expect(legacy.body).not.toContain("recognitionEngine");
  expect((await app.inject({ url: "/v1/health" })).body).not.toContain("recognitionEngines");
  const modern = await app.inject({ url: "/v1/preferences", headers });
  expect(validateBody("PreferencesSnapshot", modern.json()).preferences.recognitionEngine).toBe(
    "parakeet",
  );
  const health = validateBody(
    "ServerHealth",
    (await app.inject({ url: "/v1/health", headers })).json(),
  );
  expect(health.recognitionEngines).toEqual(["whisper", "parakeet"]);
  // v2 recording snapshots carry frozen preferences, negotiated the same way.
  const create = (extra = {}) =>
    app.inject({
      method: "POST",
      url: "/v2/recordings",
      headers: extra,
      payload: {
        requestID: randomUUID(),
        device: { id: "fixture", name: "Test Mac" },
        mode: "test",
      },
    });
  const strict = await create();
  expect(strict.statusCode).toBe(201);
  expect(strict.body).not.toContain("recognitionEngine");
  // A settled session's event stream ends after its snapshot.
  const id = strict.json().id;
  expect(
    (await app.inject({ method: "POST", url: `/v2/recordings/${id}/discard` })).body,
  ).not.toContain("recognitionEngine");
  const events = await app.inject({ url: `/v2/recordings/${id}/events` });
  expect(events.body).toContain(id);
  expect(events.body).not.toContain("recognitionEngine");
  const aware = await create(headers);
  expect(
    validateBody("RecordingSnapshot", aware.json()).settings.preferences.recognitionEngine,
  ).toBe("parakeet");
});
