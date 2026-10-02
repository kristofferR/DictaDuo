import { afterEach, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHTTPServer } from "../src/http-server.ts";
import type { CaptureProvider } from "../src/capture-sessions.ts";
import type { components } from "../src/generated/api.ts";
import { RECORDING_WS_PROTOCOL, type RecordingSnapshot } from "../src/recording-contract.ts";
import { sha256 } from "../src/storage.ts";
import { FakeInference, openCaptureServices } from "./support.ts";
import { validateBody } from "../src/validation.ts";

type StartOptions = Parameters<CaptureProvider["start"]>[0];
class FakeCapture implements CaptureProvider {
  calls = 0;
  options?: StartOptions;
  gate?: Promise<void>;
  stopGate?: Promise<void>;
  stopCalls = 0;
  available = true;
  failBeforeReady = false;
  age = 0;
  originalFrames = 48_000;
  /** Write one second before stop, like a live microphone, so failures have audio. */
  writeAtStart = false;
  /** Sources plugged in after the first discovery. */
  later: components["schemas"]["AudioSource"][] = [];
  sources(): components["schemas"]["AudioSource"][] {
    return [
      ...this.later,
      {
        identity: { hostID: "host-stable", id: "usb-dji-stable" },
        name: "DJI",
        transport: "usb",
        present: true,
        link: this.available ? "connected" : "disconnected",
        capture: "available",
        audioHealth: "unknown",
        observedAt: new Date(Date.now() - this.age).toISOString(),
      },
    ];
  }
  async start(options: StartOptions) {
    this.calls++;
    this.options = options;
    if (this.failBeforeReady) {
      options.lost();
      throw new Error("Fixture source failed before readiness");
    }
    await this.gate;
    if (this.writeAtStart)
      await options.write(
        "inference",
        0,
        { sampleRate: 16_000, channels: 1 },
        Buffer.alloc(64_000),
      );
    return {
      stop: async () => {
        this.stopCalls++;
        await this.stopGate;
        if (this.writeAtStart) return { inferenceFrames: 16_000 };
        await options.write(
          "inference",
          0,
          { sampleRate: 16_000, channels: 1 },
          Buffer.alloc(64_000),
        );
        if (options.generation.settings.preferences.keepOriginalAudio) {
          await options.write(
            "original",
            0,
            { sampleRate: 48_000, channels: 1 },
            Buffer.alloc(this.originalFrames * 4),
          );
          return { inferenceFrames: 16_000, originalFrames: this.originalFrames };
        }
        return { inferenceFrames: 16_000 };
      },
    };
  }
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(
  provider: FakeCapture | undefined = new FakeCapture(),
  inference = new FakeInference(),
) {
  const directory = await mkdtemp(join(tmpdir(), "sottoduo-capture-"));
  const services = await openCaptureServices(directory, provider, inference);
  const app = createHTTPServer(services.service, "server-access", undefined, services.recordings);
  cleanup.push(async () => {
    await services.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = randomBytes(32).toString("hex");
  const headers = { authorization: "Bearer server-access", "x-sottoduo-capture-owner": owner };
  const request: components["schemas"]["StartCaptureRequest"] = {
    requestID: randomUUID(),
    device: { id: "mac", name: "Mac" },
    mode: "dictation",
    source: { hostID: "host-stable", id: "usb-dji-stable" },
  };
  return {
    app,
    service: services.service,
    recordings: services.recordings,
    directory,
    provider: provider!,
    request,
    owner,
    headers,
    start: () => app.inject({ method: "POST", url: "/v2/captures", headers, payload: request }),
    control: (
      id: string,
      action: string,
      payload: unknown = {},
      extra: Record<string, string> = {},
    ) =>
      app.inject({
        method: "POST",
        url: `/v2/recordings/${id}/${action}`,
        headers: { ...headers, ...extra },
        payload: payload as Record<string, unknown>,
      }),
  };
}
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw Error("Condition timed out");
    await Bun.sleep(5);
  }
}
const discarded = (snapshot: RecordingSnapshot) => snapshot.captureState === "discarded";

test("remote capture pins destination and source, processes as a session, and keeps owners private", async () => {
  const f = await fixture();
  const response = await f.start();
  expect(response.statusCode).toBe(201);
  const record = response.json<RecordingSnapshot>();
  expect(record.device).toEqual(f.request.device);
  expect(record.capture).toEqual({ source: f.request.source, state: "recording" });
  expect((await f.start()).json().id).toBe(record.id);
  expect(f.provider.calls).toBe(1);
  const stopped = await f.control(record.id, "capture/stop");
  expect(stopped.statusCode).toBe(202);
  expect(stopped.json().capture.state).toBe("sealed");
  expect(f.provider.options?.signal.aborted).toBe(true);
  const events = await f.app.inject({
    url: `/v2/recordings/${record.id}/events`,
    headers: f.headers,
  });
  const final = JSON.parse(events.body.trim().split("\n").at(-1)!) as RecordingSnapshot;
  expect(final.processingState).toBe("completed");
  const detail = (await f.recordings.detail(record.id)).result!;
  expect(detail.inferenceAudio?.frameCount).toBe(16_000);
  expect(detail.originalAudio?.frameCount).toBe(48_000);
  expect(detail.device.id).toBe("mac");
  const manifest = await readFile(
    join(f.directory, "sessions", record.id, "manifest.json"),
    "utf8",
  );
  expect(manifest).not.toContain(f.owner);
  expect(JSON.parse(manifest).snapshot.capture.source).toEqual(f.request.source);
  expect((await f.control(record.id, "capture/stop")).statusCode).toBe(202);
  expect(
    (await f.control(record.id, "capture/stop", { continuationID: randomUUID() })).statusCode,
  ).toBe(409);
  const receipt = { status: "inserted", reportedAt: "2026-09-20T00:00:00Z" };
  expect(
    (
      await f.control(record.id, "delivery", receipt, {
        "x-sottoduo-capture-owner": "e".repeat(64),
      })
    ).statusCode,
  ).toBe(403);
  expect((await f.control(record.id, "delivery", receipt)).statusCode).toBe(200);
  // A settled take is shared history: deleting it needs no owner, as for client uploads.
  const removed = await f.app.inject({
    method: "POST",
    url: `/v2/recordings/${record.id}/discard`,
    headers: { authorization: "Bearer server-access" },
  });
  expect(removed.statusCode).toBe(200);
  expect(discarded(await f.recordings.get(record.id))).toBe(true);
});

test("one admission wins racing clients; device labels and request IDs do not grant ownership", async () => {
  const f = await fixture();
  const results = await Promise.all([
    f.start(),
    f.app.inject({
      method: "POST",
      url: "/v2/captures",
      headers: { ...f.headers, "x-sottoduo-capture-owner": "a".repeat(64) },
      payload: {
        ...f.request,
        requestID: randomUUID(),
        device: { id: "desktop", name: "Desktop" },
      },
    }),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  expect(results.find((r) => r.statusCode === 409)!.json().code).toBe("capture_busy");
  expect(f.provider.calls).toBe(1);
  const record = results.find((r) => r.statusCode === 201)!.json<RecordingSnapshot>();
  for (const action of ["discard", "capture/heartbeat", "capture/stop", "delivery", "context"]) {
    const result = await f.app.inject({
      method: "POST",
      url: `/v2/recordings/${record.id}/${action}`,
      headers: { authorization: "Bearer server-access" },
      payload: {},
    });
    expect(result.statusCode).toBe(403);
  }
  const forged = await f.app.inject({
    method: "POST",
    url: "/v2/captures",
    headers: { ...f.headers, "x-sottoduo-capture-owner": "b".repeat(64) },
    payload: f.request,
  });
  expect(forged.statusCode).toBe(403);
  expect((await f.recordings.get(record.id)).capture?.state).toBe("recording");
});

test("remote sessions reject client audio", async () => {
  const f = await fixture();
  const record = (await f.start()).json<RecordingSnapshot>();
  const pcm = Buffer.alloc(16);
  await expect(
    f.recordings.appendAudio(
      record.id,
      {
        type: "audio",
        epoch: record.epoch,
        runID: randomUUID(),
        kind: "inference",
        sequence: 0,
        firstFrame: 0,
        frameCount: 4,
        format: { sampleRate: 16000, channels: 1 },
        sha256: sha256(pcm),
      },
      pcm,
    ),
  ).rejects.toMatchObject({ code: "remote_capture" });
  // The upload socket would otherwise grant controls without the owner secret.
  const socket = await f.app.inject({
    url: `/v2/recordings/${record.id}/stream`,
    headers: { ...f.headers, "sec-websocket-protocol": RECORDING_WS_PROTOCOL },
  });
  expect(socket.statusCode).toBe(409);
  expect(socket.json().code).toBe("remote_capture");
});

test("discovery never starts capture; stale or disconnected sources cannot win admission", async () => {
  const f = await fixture();
  f.provider.age = 4_000;
  const discovery = await f.app.inject({ url: "/v1/audio-sources", headers: f.headers });
  expect(validateBody("AudioSourceList", discovery.json()).sources[0]?.link).toBe("unknown");
  expect((await f.start()).statusCode).toBe(503);
  f.provider.age = 0;
  f.provider.available = false;
  expect((await f.start()).statusCode).toBe(503);
  expect(f.provider.calls).toBe(0);
  expect((await f.recordings.history(50)).items).toHaveLength(0);
});

test("capture startup can be discarded without waiting for a stuck provider", async () => {
  const f = await fixture();
  f.provider.gate = new Promise(() => {});
  const starting = f.start();
  await until(() => f.provider.calls === 1);
  const id = f.provider.options!.generation.id;
  expect((await f.recordings.get(id)).capture?.state).toBe("preparing");
  expect((await f.control(id, "discard")).statusCode).toBe(200);
  expect((await starting).statusCode).toBe(409);
  expect(f.provider.options!.signal.aborted).toBe(true);
  expect(discarded(await f.recordings.get(id))).toBe(true);
});

test("an admission whose requester gave up during startup is discarded, not archived", async () => {
  const f = await fixture();
  f.provider.writeAtStart = true;
  let ready!: () => void;
  f.provider.gate = new Promise((resolve) => (ready = resolve));
  const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
  const abandon = new AbortController();
  const starting = fetch(`${address}/v2/captures`, {
    method: "POST",
    headers: { ...f.headers, "content-type": "application/json" },
    body: JSON.stringify(f.request),
    signal: abandon.signal,
  }).catch(() => undefined);
  await until(() => f.provider.calls === 1);
  abandon.abort();
  await starting;
  await Bun.sleep(50);
  ready();
  const id = f.provider.options!.generation.id;
  await until(async () => discarded(await f.recordings.get(id)));
  expect(f.provider.options!.signal.aborted).toBe(true);
});

test("startup timeout aborts hardware and releases admission", async () => {
  const f = await fixture();
  f.provider.gate = new Promise(() => {});
  const result = await f.start();
  expect(result.statusCode).toBe(503);
  expect(result.json().code).toBe("capture_timeout");
  expect(f.provider.options!.signal.aborted).toBe(true);
  expect(discarded(await f.recordings.get(f.provider.options!.generation.id))).toBe(true);
}, 7_000);

test("provider loss before readiness remains eligible for client fallback", async () => {
  const f = await fixture();
  f.provider.failBeforeReady = true;
  const result = await f.start();
  expect(result.statusCode).toBe(503);
  expect(result.json().code).toBe("capture_failed");
  expect(f.provider.options!.signal.aborted).toBe(true);
  expect(discarded(await f.recordings.get(f.provider.options!.generation.id))).toBe(true);
});

test("owner lease expiry stops recording even while source status remains fresh", async () => {
  const f = await fixture();
  const id = (await f.start()).json().id;
  await Bun.sleep(3_000);
  expect((await f.control(id, "capture/heartbeat")).statusCode).toBe(204);
  await Bun.sleep(3_000);
  expect(f.provider.options!.signal.aborted).toBe(false);
  await until(() => f.provider.options!.signal.aborted, 7_000);
  await until(async () => discarded(await f.recordings.get(id)));
  expect((await f.control(id, "capture/heartbeat")).statusCode).toBe(409);
}, 15_000);

test("an interrupted take with audio is sealed and finishes archive-only", async () => {
  const provider = new FakeCapture();
  provider.writeAtStart = true;
  const f = await fixture(provider);
  const preferences = await f.service.getPreferences();
  preferences.preferences.keepOriginalAudio = false;
  await f.service.updatePreferences(preferences);
  const id = (await f.start()).json().id;
  f.provider.available = false;
  await until(async () => (await f.recordings.get(id)).capture?.state === "stopped");
  const settled = await until(
    async () => (await f.recordings.get(id)).processingState === "completed",
    3_000,
  ).then(() => f.recordings.get(id));
  expect(settled.stopRuns?.[0]?.inferenceFrames).toBe(16_000);
  expect((await f.recordings.detail(id)).result?.finalText).toBeTruthy();
});

test("a seal that fails transiently after an interruption is retried", async () => {
  const provider = new FakeCapture();
  provider.writeAtStart = true;
  const f = await fixture(provider);
  const stopCapture = f.recordings.stopCapture.bind(f.recordings);
  let attempts = 0;
  f.recordings.stopCapture = async (...args) => {
    if (++attempts === 1) throw new Error("Disk briefly unavailable");
    return stopCapture(...args);
  };
  const id = (await f.start()).json().id;
  f.provider.available = false;
  await until(async () => (await f.recordings.get(id)).capture?.state === "stopped", 2_000);
  expect(attempts).toBe(2);
  expect((await f.recordings.get(id)).stopRuns?.[0]?.inferenceFrames).toBe(16_000);
});

test("source loss waits for an in-flight append before sealing its counts", async () => {
  const f = await fixture();
  const preferences = await f.service.getPreferences();
  preferences.preferences.keepOriginalAudio = false;
  await f.service.updatePreferences(preferences);
  const id = (await f.start()).json().id;
  const append = f.recordings.appendCaptureAudio.bind(f.recordings);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const spy = spyOn(f.recordings, "appendCaptureAudio").mockImplementation(async (...args) => {
    await gate;
    return append(...args);
  });
  const write = f.provider.options!.write(
    "inference",
    0,
    { sampleRate: 16_000, channels: 1 },
    Buffer.alloc(64_000),
  );
  f.provider.options!.lost();
  await Bun.sleep(50);
  release();
  await write;
  spy.mockRestore();
  await until(async () => (await f.recordings.get(id)).processingState === "completed", 3_000);
  expect((await f.recordings.get(id)).stopRuns?.[0]?.inferenceFrames).toBe(16_000);
});

test("duplicate starts cannot open another source when readiness is lost", async () => {
  const f = await fixture();
  let ready!: () => void;
  f.provider.gate = new Promise((resolve) => {
    ready = resolve;
  });
  const first = f.start();
  const second = f.start();
  await until(() => f.provider.calls === 1);
  f.provider.available = false;
  ready();
  expect((await first).statusCode).toBe(503);
  // A retry admitted after the failure sees the discarded session instead of pending readiness.
  expect([503, 409, 201]).toContain((await second).statusCode);
  expect(f.provider.calls).toBe(1);
  expect(discarded(await f.recordings.get(f.provider.options!.generation.id))).toBe(true);
});

test("a pending retry cannot change the selected source or mode", async () => {
  const f = await fixture();
  let ready!: () => void;
  f.provider.gate = new Promise((resolve) => {
    ready = resolve;
  });
  const first = f.start();
  await until(() => f.provider.calls === 1);
  for (const change of [
    { source: { hostID: "host-stable", id: "another-mic" } },
    { mode: "test" as const },
  ]) {
    const retry = await f.app.inject({
      method: "POST",
      url: "/v2/captures",
      headers: f.headers,
      payload: { ...f.request, ...change },
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().code).toBe("conflicting_request");
  }
  ready();
  expect((await first).statusCode).toBe(201);
  expect(f.provider.calls).toBe(1);
});

test("original retention is frozen at admission and disabled originals are not required", async () => {
  const f = await fixture();
  const preferences = await f.service.getPreferences();
  preferences.preferences.keepOriginalAudio = false;
  await f.service.updatePreferences(preferences);
  const id = (await f.start()).json().id;
  const newer = await f.service.getPreferences();
  newer.preferences.keepOriginalAudio = true;
  await f.service.updatePreferences(newer);
  const result = await f.control(id, "capture/stop");
  expect(result.statusCode).toBe(202);
  const stopped = result.json<RecordingSnapshot>();
  expect(stopped.stopRuns?.[0]?.originalFrames).toBeUndefined();
  expect(stopped.settings.preferences.keepOriginalAudio).toBe(false);
});

test("source loss stops without splicing another mic; stale ownership cannot control a new take", async () => {
  const f = await fixture();
  const id = (await f.start()).json().id;
  f.provider.available = false;
  await until(async () => discarded(await f.recordings.get(id)));
  f.provider.available = true;
  const nextOwner = "c".repeat(64);
  const next = await f.app.inject({
    method: "POST",
    url: "/v2/captures",
    headers: { ...f.headers, "x-sottoduo-capture-owner": nextOwner },
    payload: { ...f.request, requestID: randomUUID() },
  });
  expect(next.statusCode).toBe(201);
  expect((await f.control(next.json().id, "discard")).statusCode).toBe(403);
  expect((await f.recordings.get(next.json().id)).capture?.state).toBe("recording");
});

test("mismatched original and inference intervals are rejected without discarding audio", async () => {
  const f = await fixture();
  f.provider.originalFrames = 24_000;
  const id = (await f.start()).json().id;
  expect((await f.control(id, "capture/stop")).statusCode).toBe(400);
  const failed = await f.recordings.get(id);
  expect(discarded(failed)).toBe(false);
  expect(failed.capture?.state).toBe("stopped");
  expect(failed.streams.find((stream) => stream.kind === "inference")?.frameCount).toBe(16_000);
});

test("shutdown aborts capture and restart never resumes it; ownership persists privately", async () => {
  const f = await fixture();
  const id = (await f.start()).json().id;
  await f.service.shutdown();
  await f.recordings.shutdown();
  expect(f.provider.options!.signal.aborted).toBe(true);
  const restarted = await openCaptureServices(f.directory, undefined);
  try {
    expect(discarded(await restarted.recordings.get(id))).toBe(true);
    expect(restarted.service.captures.sources()).toEqual({ sources: [] });
    await expect(restarted.recordings.authorizeCapture(id, "d".repeat(64))).rejects.toMatchObject({
      status: 403,
    });
    await restarted.recordings.authorizeCapture(id, f.owner);
  } finally {
    await restarted.close();
  }
});

test("missing owner credentials on disk fail closed without exposing private paths", async () => {
  const f = await fixture();
  const id = (await f.start()).json().id;
  await rm(join(f.directory, "sessions", id, "capture-owner.sha256"));
  const result = await f.control(id, "discard");
  expect(result.statusCode).toBe(403);
  expect(result.body).not.toContain(f.directory);
  expect(f.provider.options!.signal.aborted).toBe(false);
});

test("provider loss during drain aborts the pending stop without sealing partial audio", async () => {
  const f = await fixture();
  const id = (await f.start()).json().id;
  f.provider.stopGate = new Promise(() => {});
  const stopping = f.control(id, "capture/stop");
  await until(() => f.provider.stopCalls === 1);
  f.provider.options!.lost();
  expect((await stopping).statusCode).toBe(409);
  expect(discarded(await f.recordings.get(id))).toBe(true);
  expect(f.provider.options!.signal.aborted).toBe(true);
});

test("DJI destination owner gates capture, pins its source, and disarming aborts hardware", async () => {
  const f = await fixture();
  const id = randomUUID().toUpperCase();
  const destinationOwner = randomBytes(32).toString("hex");
  const headers = { ...f.headers, "x-sottoduo-destination-owner": destinationOwner };
  f.service.buttons.input(f.request.source, "input-epoch");
  const call = (suffix: string, payload: Record<string, unknown> = {}) =>
    f.app.inject({ method: "POST", url: `/v1/button-destinations${suffix}`, headers, payload });
  expect((await call("", { id, device: f.request.device })).statusCode).toBe(200);
  expect((await call(`/${id}/select`)).statusCode).toBe(200);
  f.service.buttons.press("wrong-epoch", 1);
  expect(f.service.buttons.state(id).command).toBeUndefined();
  f.service.buttons.press("input-epoch", 1);
  const command = validateBody(
    "ButtonDestinationState",
    (await call(`/${id}/heartbeat`)).json(),
  ).command!;
  expect(command.action).toBe("start");
  expect(f.provider.calls).toBe(0);
  expect(f.service.buttons.state().command).toBeUndefined();
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: `/v1/button-destinations/${id}/heartbeat`,
        payload: {},
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(403);
  f.request.buttonTicket = command.takeID;
  const wrong = await f.app.inject({
    method: "POST",
    url: "/v2/captures",
    headers,
    payload: { ...f.request, source: { ...f.request.source, id: "different" } },
  });
  expect(wrong.statusCode).toBe(409);
  expect(f.provider.calls).toBe(0);
  expect((await f.start()).statusCode).toBe(201);
  expect((await f.start()).statusCode).toBe(201);
  expect(f.provider.calls).toBe(1);
  expect(
    (await f.app.inject({ method: "DELETE", url: `/v1/button-destinations/${id}`, headers }))
      .statusCode,
  ).toBe(200);
  await until(() => f.provider.options?.signal.aborted === true);
  expect((await f.start()).statusCode).toBe(409);
});

test("disarming while button capture prepares stops it before readiness", async () => {
  const f = await fixture();
  let release!: () => void;
  f.provider.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const id = randomUUID();
  f.service.buttons.input(f.request.source, "epoch");
  f.service.buttons.register({ id, device: f.request.device }, f.owner);
  await f.service.buttons.select(id, {}, f.owner);
  f.service.buttons.press("epoch", 1);
  f.request.buttonTicket = f.service.buttons.state(id).command!.takeID;
  const pending = f.start();
  await until(() => f.provider.calls === 1);
  f.service.buttons.unregister(id, f.owner);
  release();
  expect((await pending).statusCode).not.toBe(201);
  expect(f.provider.options?.signal.aborted).toBe(true);
});

test("the lease never cancels a take while its stop drains", async () => {
  const f = await fixture();
  const id = (await f.start()).json().id;
  let releaseStop: (() => void) | undefined;
  f.provider.stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const stopping = f.control(id, "capture/stop");
  await until(() => f.provider.stopCalls === 1);
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
  try {
    await Bun.sleep(350);
    expect(f.provider.options!.signal.aborted).toBe(false);
  } finally {
    clock.mockRestore();
    releaseStop?.();
  }
  expect((await stopping).statusCode).toBe(202);
  expect((await f.recordings.get(id)).capture?.state).toBe("sealed");
});

test("a server restart seals a remote take's recorded audio archive-only", async () => {
  const provider = new FakeCapture();
  provider.writeAtStart = true;
  const f = await fixture(provider);
  const preferences = await f.service.getPreferences();
  preferences.preferences.keepOriginalAudio = false;
  await f.service.updatePreferences(preferences);
  const id = (await f.start()).json().id;
  // Simulate a crash: the provider never reports and storage closes abruptly.
  await f.recordings.shutdown();
  const restarted = await openCaptureServices(f.directory, undefined);
  try {
    const snapshot = await restarted.recordings.get(id);
    expect(snapshot.capture?.state).toBe("stopped");
    expect(snapshot.stopRuns?.[0]?.inferenceFrames).toBe(16_000);
    await until(
      async () => (await restarted.recordings.get(id)).processingState === "completed",
      5_000,
    );
  } finally {
    await restarted.close();
  }
});

test("a sealed remote take queues for processing while the next remote take records", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  class HeldInference extends FakeInference {
    override async transcribe(...args: Parameters<FakeInference["transcribe"]>) {
      await held;
      return super.transcribe(...args);
    }
  }
  const f = await fixture(new FakeCapture(), new HeldInference());
  const first = (await f.start()).json();
  expect((await f.control(first.id, "capture/stop")).statusCode).toBe(202);
  const second = await f.app.inject({
    method: "POST",
    url: "/v2/captures",
    headers: f.headers,
    payload: { ...f.request, requestID: randomUUID() },
  });
  expect(second.statusCode).toBe(201);
  expect((await f.recordings.get(first.id)).processingState).not.toBe("completed");
  release();
  await until(
    async () => (await f.recordings.get(first.id)).processingState === "completed",
    5_000,
  );
  expect((await f.recordings.get(second.json().id)).capture?.state).toBe("recording");
});

test("the destination's continuation is fixed before processing, or the hold expires", async () => {
  const f = await fixture();
  const first = (await f.start()).json<RecordingSnapshot>();
  expect((await f.control(first.id, "context", {})).statusCode).toBe(200);
  expect((await f.control(first.id, "context", { continuationID: randomUUID() })).statusCode).toBe(
    409,
  );
  await f.control(first.id, "capture/stop");
  await until(
    async () => (await f.recordings.get(first.id)).processingState === "completed",
    5_000,
  );
});

test("other computers only see and record shared microphones; sharing changes only locally", async () => {
  const f = await fixture();
  const sharing = { "x-sottoduo-microphone-sharing": "sharing-v1" };
  const list = (remoteAddress?: string, headers: Record<string, string> = sharing) =>
    f.app
      .inject({
        method: "GET",
        url: "/v1/audio-sources",
        headers: { ...f.headers, ...headers },
        ...(remoteAddress ? { remoteAddress } : {}),
      })
      .then((response) => response.json());
  // Sources present when sharing first runs stay shared, as before the setting existed.
  const first = await list();
  expect(first.sharingHost.local).toBe(true);
  expect(first.sources.map((source: { shared: boolean }) => source.shared)).toEqual([true]);
  f.provider.later = [
    {
      identity: { hostID: "host-stable", id: "desk-mic" },
      name: "Desk",
      transport: "usb",
      present: true,
      link: "notApplicable",
      capture: "available",
      audioHealth: "unknown",
      observedAt: new Date().toISOString(),
    },
  ];
  const local = await list();
  expect(
    local.sources.map((source: { identity: { id: string }; shared: boolean }) => [
      source.identity.id,
      source.shared,
    ]),
  ).toEqual([
    ["desk-mic", false],
    ["usb-dji-stable", true],
  ]);
  const remote = await list("100.64.0.9");
  expect(remote.sharingHost.local).toBe(false);
  expect(remote.sources.map((source: { identity: { id: string } }) => source.identity.id)).toEqual([
    "usb-dji-stable",
  ]);
  // Older clients get no new fields, and still only shared sources.
  const legacy = await list("100.64.0.9", {});
  expect(legacy.sharingHost).toBeUndefined();
  expect(legacy.sources).toHaveLength(1);
  expect(legacy.sources[0].shared).toBeUndefined();

  const start = (remoteAddress?: string) =>
    f.app.inject({
      method: "POST",
      url: "/v2/captures",
      headers: { ...f.headers, "x-sottoduo-capture-owner": randomBytes(32).toString("hex") },
      payload: {
        ...f.request,
        requestID: randomUUID(),
        source: { hostID: "host-stable", id: "desk-mic" },
      },
      ...(remoteAddress ? { remoteAddress } : {}),
    });
  const refused = await start("100.64.0.9");
  expect(refused.statusCode).toBe(503);
  expect(refused.json().code).toBe("source_unavailable");

  const share = (remoteAddress?: string) =>
    f.app.inject({
      method: "PUT",
      url: "/v1/audio-sources/sharing",
      headers: { ...f.headers, ...sharing },
      payload: { source: { hostID: "host-stable", id: "desk-mic" }, shared: true },
      ...(remoteAddress ? { remoteAddress } : {}),
    });
  expect((await share("100.64.0.9")).statusCode).toBe(403);
  expect((await share()).statusCode).toBe(200);
  const recording = await start("100.64.0.9");
  expect(recording.statusCode).toBe(201);
  // One take holds every source, and every computer sees which device it is for.
  const busy = await list("100.64.0.9");
  for (const source of busy.sources) expect(source.recordingFor).toEqual(f.request.device);

  // The choice is saved for the next server start.
  const saved = JSON.parse(await readFile(join(f.directory, "microphone-sharing.json"), "utf8"));
  expect(saved.shared.map((source: { id: string }) => source.id).sort()).toEqual([
    "desk-mic",
    "usb-dji-stable",
  ]);
});
