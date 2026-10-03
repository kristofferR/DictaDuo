import WebSocket from "ws";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationService } from "../src/generation-service.ts";
import { createHTTPServer } from "../src/http-server.ts";
import { FakeInference } from "./support.ts";
import type { StartSpeechStream } from "../src/inference/soniox.ts";
import { validateBody } from "../src/validation.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
class Local extends FakeInference {
  calls = 0;
  audio?: Buffer;
  override async transcribe(path: string) {
    this.calls++;
    this.audio = (await readFile(path)).subarray(44);
    return super.transcribe(path, "en", []);
  }
}
async function setup(mode: "automatic" | "cloud" | "local" = "automatic", configured = true) {
  const path = await mkdtemp(join(tmpdir(), "dictaduo-recognition-"));
  const local = new Local();
  const chunks: Buffer[] = [];
  let starts = 0,
    ends = 0,
    cancellations = 0;
  let cloudFailure: string | undefined;
  let emit: (text: string) => void = () => {};
  let reject: (reason: string) => void = () => {};
  const startSpeechStream: StartSpeechStream = (
    _config,
    _language,
    _terms,
    _id,
    update,
    failed,
  ) => {
    starts++;
    emit = update;
    reject = (reason) => {
      cloudFailure = reason;
      failed(reason);
    };
    return {
      send(bytes) {
        chunks.push(Buffer.from(bytes));
      },
      async finish() {
        ends++;
        if (cloudFailure) throw new Error(cloudFailure);
        return {
          text: "Cloud transcript.",
          language: "en",
          audioSeconds: 0.25,
          processingSeconds: 0.01,
        };
      },
      cancel() {
        cancellations++;
      },
    };
  };
  const config = {
    dataDirectory: path,
    development: true,
    startSpeechStream,
    soniox: configured
      ? { apiKey: "secret", model: "stt-rt-v5", endpoint: "wss://example.invalid" }
      : undefined,
  };
  const service = await GenerationService.open(config, local);
  cleanups.push(async () => {
    await service.shutdown();
    await rm(path, { recursive: true, force: true });
  });
  const preferences = await service.getPreferences();
  preferences.preferences.recognitionMode = mode;
  preferences.preferences.textCorrectionEnabled = false;
  await service.updatePreferences(preferences);
  const create = () =>
    service.create({
      requestID: crypto.randomUUID(),
      device: { id: "fixture", name: "Test Mac" },
      mode: "test",
    });
  return {
    service,
    local,
    path,
    chunks,
    create,
    config,
    emit: (text: string) => emit(text),
    fail: (reason: string) => reject(reason),
    counters: () => ({ starts, ends, cancellations }),
  };
}
const format = { sampleRate: 16000, channels: 1 };
const pcm = Buffer.alloc(16_000);
async function finish(service: GenerationService, id: string) {
  await service.appendAudio(
    id,
    "original",
    0,
    { sampleRate: 48000, channels: 2 },
    Buffer.alloc(96_000),
  );
  await service.finish(id, { inferenceFrames: 4000, originalFrames: 12000 });
  for await (const record of await service.events(id)) {
    if (["completed", "failed", "cancelled"].includes(record.status)) return record;
  }
  throw new Error("Missing terminal result");
}

test("cloud receives only new durable chunks, preserves audio and writes the existing transcript artifacts", async () => {
  const f = await setup();
  const record = await f.create();
  expect(record.settings.preferences.recognitionMode).toBe("automatic");
  expect(record.recognition?.provider).toBe("soniox");
  await f.service.appendAudio(record.id, "inference", 0, format, pcm);
  await f.service.appendAudio(record.id, "inference", 0, format, pcm);
  expect(f.chunks).toEqual([pcm]);
  f.emit("Provisional");
  expect((await f.service.get(record.id)).recognition?.partialText).toBe("Provisional");
  await f.service.endInference(record.id, 4000);
  expect(f.counters().ends).toBe(1);
  await expect(f.service.appendAudio(record.id, "inference", 1, format, pcm)).rejects.toThrow(
    "ended",
  );
  const result = await finish(f.service, record.id);
  expect(result.status).toBe("completed");
  expect(result.finalText).toBe("Cloud transcript.");
  expect(result.speech?.backend).toBe("soniox/websocket");
  expect(result.recognition?.partialText).toBeUndefined();
  expect(f.local.calls).toBe(0);
  expect(
    (await readFile(join(f.path, "generations", record.id, "inference.wav"))).subarray(44),
  ).toEqual(pcm);
  expect((await readFile(join(f.path, "generations", record.id, "original.wav"))).length).toBe(
    96044,
  );
  expect(await readFile(join(f.path, "generations", record.id, "transcript.txt"), "utf8")).toBe(
    result.finalText,
  );
  const metadata = await readFile(join(f.path, "generations", record.id, "metadata.json"), "utf8");
  expect(metadata).not.toContain("secret");
  validateBody("GenerationRecord", JSON.parse(metadata));
});

test("midstream cloud failure transcribes the entire recording locally without mixing partial text", async () => {
  const f = await setup();
  const record = await f.create();
  await f.service.appendAudio(record.id, "inference", 0, format, pcm.subarray(0, 8000));
  f.emit("Wrong cloud prefix");
  f.fail("Connection lost.");
  await f.service.appendAudio(record.id, "inference", 1, format, pcm.subarray(8000));
  const result = await finish(f.service, record.id);
  expect(result.finalText).toBe("Hello world.");
  expect(result.recognition).toEqual({ provider: "whisper", fallbackReason: "Connection lost." });
  expect(f.local.audio).toEqual(pcm);
  expect(f.local.calls).toBe(1);
  expect(f.chunks).toHaveLength(1);
});

test("cloud-only failures retain sealed audio and never invoke Whisper", async () => {
  const f = await setup("cloud");
  const record = await f.create();
  f.fail("Cloud unavailable.");
  await f.service.appendAudio(record.id, "inference", 0, format, pcm);
  const result = await finish(f.service, record.id);
  expect(result.status).toBe("failed");
  expect(result.inferenceAudio?.frameCount).toBe(4000);
  expect(result.originalAudio?.frameCount).toBe(12000);
  expect(f.local.calls).toBe(0);
});

test.each(["local", "automatic"] as const)(
  "%s without cloud configuration retains the native path",
  async (mode) => {
    const f = await setup(mode, mode === "local");
    const record = await f.create();
    await f.service.appendAudio(record.id, "inference", 0, format, pcm);
    const result = await finish(f.service, record.id);
    expect(result.finalText).toBe("Hello world.");
    expect(f.counters().starts).toBe(0);
    expect(f.local.calls).toBe(1);
  },
);

test("cloud-only without a key blocks admission; cancellation closes active cloud sessions", async () => {
  const missing = await setup("cloud", false);
  expect((await missing.service.health()).ready).toBe(false);
  await expect(missing.create()).rejects.toThrow("Soniox API key");
  const f = await setup();
  const record = await f.create();
  await f.service.cancel(record.id);
  f.emit("Late preview");
  expect((await f.service.get(record.id)).status).toBe("cancelled");
  expect(f.counters().cancellations).toBe(1);
});

test("stream upgrade uses existing authentication, acknowledges PCM and ends before original audio is sealed", async () => {
  const f = await setup();
  const record = await f.create();
  const app = createHTTPServer(f.service, "token");
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => app.close());
  const endpoint = address.replace("http:", "ws:") + `/v1/generations/${record.id}/stream`;
  const rejected = new WebSocket(endpoint);
  await new Promise<void>((resolve) => rejected.addEventListener("close", () => resolve()));
  expect(rejected.readyState).toBe(WebSocket.CLOSED);
  const socket = new WebSocket(endpoint, { headers: { authorization: "Bearer token" } });
  const opened = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const receipts: unknown[] = [];
  socket.addEventListener("open", () => opened.resolve());
  socket.addEventListener("error", () => {
    opened.reject(new Error("Upgrade failed"));
    ended.reject(new Error("Stream failed"));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "ack") receipts.push(message);
    if (message.type === "ended") ended.resolve();
    if (message.type === "error") ended.reject(new Error(message.message));
  });
  await opened.promise;
  const packet = Buffer.alloc(pcm.length + 4);
  pcm.copy(packet, 4);
  socket.send(packet);
  socket.send(JSON.stringify({ type: "end", frameCount: 4000 }));
  await ended.promise;
  expect(receipts).toEqual([{ type: "ack", nextSequence: 1, frameCount: 4000 }]);
  expect((await f.service.get(record.id)).status).toBe("receiving");
  socket.close();
  expect((await finish(f.service, record.id)).status).toBe("completed");
});

test("recognition mode is frozen per take; legacy preference saves preserve explicit local-only policy", async () => {
  const f = await setup("local");
  const legacy = await f.service.getPreferences();
  delete legacy.preferences.recognitionMode;
  await f.service.updatePreferences(legacy);
  expect((await f.service.getPreferences()).preferences.recognitionMode).toBe("local");
  const record = await f.create();
  const next = await f.service.getPreferences();
  next.preferences.recognitionMode = "cloud";
  await f.service.updatePreferences(next);
  await f.service.appendAudio(record.id, "inference", 0, format, pcm);
  expect((await finish(f.service, record.id)).speech?.backend).toContain("whisper.cpp");
  expect(f.counters().starts).toBe(0);
});

test("cancelling while cloud finalization is pending unblocks processing and never starts fallback", async () => {
  const f = await setup();
  const pending = Promise.withResolvers<never>();
  void pending.promise.catch(() => {});
  f.config.startSpeechStream = () => ({
    send() {},
    finish() {
      return pending.promise;
    },
    cancel() {
      pending.reject(new Error("Cancelled"));
    },
  });
  const record = await f.create();
  await f.service.appendAudio(record.id, "inference", 0, format, pcm);
  const completing = finish(f.service, record.id);
  // The original upload and /finish run through the same mutation queue.
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await f.service.get(record.id)).status === "transcribing") break;
    await Bun.sleep(1);
  }
  await f.service.cancel(record.id);
  expect((await completing).status).toBe("cancelled");
  expect(f.local.calls).toBe(0);
  const next = await f.create();
  expect(next.status).toBe("receiving");
  await f.service.cancel(next.id);
});

test.each([false, true])(
  "automatic requires usable local fallback (available=%s)",
  async (available) => {
    const f = await setup();
    f.local.readiness = async () => ({
      available,
      speechLoaded: false,
      proofLoaded: false,
      message: "Local unavailable.",
    });
    expect((await f.service.health()).ready).toBe(false);
    await expect(f.create()).rejects.toThrow(available ? "loading" : "Local unavailable");
    expect(f.counters().starts).toBe(0);
    f.local.readiness = async () => ({
      available: true,
      speechLoaded: true,
      proofLoaded: true,
      message: "Ready.",
    });
    expect((await f.service.health()).ready).toBe(true);
    const record = await f.create();
    expect(record.recognition?.provider).toBe("soniox");
  },
);

test("explicit cloud-only remains usable without local models", async () => {
  const f = await setup("cloud");
  f.local.readiness = async () => ({
    available: false,
    speechLoaded: false,
    proofLoaded: false,
    message: "Local unavailable.",
  });
  expect((await f.service.health()).ready).toBe(true);
  const record = await f.create();
  await f.service.appendAudio(record.id, "inference", 0, format, pcm);
  expect((await finish(f.service, record.id)).status).toBe("completed");
  expect(f.local.calls).toBe(0);
});
