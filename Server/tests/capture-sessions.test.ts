import { afterEach, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GenerationService } from "../src/generation-service.ts";
import { createHTTPServer } from "../src/http-server.ts";
import type { CaptureProvider } from "../src/capture-sessions.ts";
import type { components } from "../src/generated/api.ts";
import { FakeInference } from "./support.ts";
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
  sources(): components["schemas"]["AudioSource"][] {
    return [
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
    return {
      stop: async () => {
        this.stopCalls++;
        await this.stopGate;
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
  const service = await GenerationService.open(
    { dataDirectory: directory, development: true, captureProvider: provider },
    inference,
  );
  const app = createHTTPServer(service, "server-access");
  cleanup.push(async () => {
    await service.shutdown();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = randomBytes(32).toString("hex");
  const headers = {
    authorization: "Bearer server-access",
    "x-sottoduo-capture-owner": owner,
    "x-sottoduo-capture": "capture-v1",
  };
  const request: components["schemas"]["StartCaptureRequest"] = {
    requestID: randomUUID(),
    device: { id: "mac", name: "Mac" },
    mode: "dictation",
    source: { hostID: "host-stable", id: "usb-dji-stable" },
  };
  return {
    app,
    service,
    directory,
    provider: provider!,
    request,
    owner,
    headers,
    start: () => app.inject({ method: "POST", url: "/v1/captures", headers, payload: request }),
  };
}
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw Error("Condition timed out");
    await Bun.sleep(5);
  }
}

test("remote capture pins destination/source, shares generation processing and preserves old response shapes", async () => {
  const f = await fixture();
  const response = await f.app.inject({
    method: "POST",
    url: "/v1/captures?trace=1",
    payload: f.request,
    headers: { authorization: "Bearer server-access", "x-sottoduo-capture-owner": f.owner },
  });
  expect(response.statusCode).toBe(201);
  const record = validateBody("GenerationRecord", response.json());
  expect(record.device).toEqual(f.request.device);
  expect(record.capture).toEqual({ source: f.request.source, state: "recording" });
  expect((await f.start()).json().id).toBe(record.id);
  expect(f.provider.calls).toBe(1);
  const stopped = await f.app.inject({
    method: "POST",
    url: `/v1/generations/${record.id}/capture/stop`,
    headers: f.headers,
    payload: {},
  });
  expect(stopped.statusCode).toBe(202);
  expect(stopped.json().capture.state).toBe("sealed");
  expect(f.provider.options?.signal.aborted).toBe(true);
  const events = await f.app.inject({
    url: `/v1/generations/${record.id}/events`,
    headers: f.headers,
  });
  const final = JSON.parse(events.body.trim().split("\n").at(-1)!);
  expect(final.status).toBe("completed");
  expect(final.inferenceAudio.frameCount).toBe(16_000);
  expect(final.originalAudio.frameCount).toBe(48_000);
  expect(final.device.id).toBe("mac");
  const legacy = await f.app.inject({
    url: `/v1/generations/${record.id}`,
    headers: { authorization: "Bearer server-access", "x-sottoduo-recognition": "streaming-v1" },
  });
  expect(legacy.json().capture).toBeUndefined();
  expect(legacy.body).not.toContain(f.owner);
  const metadata = await readFile(
    join(f.directory, "generations", record.id, "metadata.json"),
    "utf8",
  );
  expect(metadata).not.toContain(f.owner);
  expect(JSON.parse(metadata).capture.source).toEqual(f.request.source);
  expect(
    (
      await f.app.inject({
        url: `/v1/generations/${record.id}/artifacts/capture-owner.sha256`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(404);
  const again = await f.app.inject({
    method: "POST",
    url: `/v1/generations/${record.id}/capture/stop`,
    headers: f.headers,
    payload: {},
  });
  expect(again.statusCode).toBe(202);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: `/v1/generations/${record.id}/capture/stop`,
        headers: f.headers,
        payload: { continuationID: randomUUID() },
      })
    ).statusCode,
  ).toBe(409);
  const receipt = { status: "inserted", reportedAt: "2026-09-20T00:00:00Z" };
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: `/v1/generations/${record.id}/delivery`,
        headers: { ...f.headers, "x-sottoduo-capture-owner": "e".repeat(64) },
        payload: receipt,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: `/v1/generations/${record.id}/delivery`,
        headers: f.headers,
        payload: receipt,
      })
    ).statusCode,
  ).toBe(200);
});

test("one admission wins racing clients; device labels and request IDs do not grant ownership", async () => {
  const f = await fixture();
  const results = await Promise.all([
    f.start(),
    f.app.inject({
      method: "POST",
      url: "/v1/captures",
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
  const record = results.find((r) => r.statusCode === 201)!.json();
  for (const action of ["cancel", "capture/heartbeat", "capture/stop", "delivery"]) {
    const result = await f.app.inject({
      method: "POST",
      url: `/v1/generations/${record.id}/${action}`,
      headers: { authorization: "Bearer server-access" },
      payload: action === "capture/stop" ? {} : undefined,
    });
    expect(result.statusCode).toBe(403);
  }
  const forged = await f.app.inject({
    method: "POST",
    url: "/v1/captures",
    headers: { ...f.headers, "x-sottoduo-capture-owner": "b".repeat(64) },
    payload: f.request,
  });
  expect(forged.statusCode).toBe(403);
  expect((await f.service.get(record.id)).status).toBe("receiving");
});

test("remote generations reject public PCM, WebSocket and finish bypasses", async () => {
  const f = await fixture();
  const id = (await f.start()).json().id;
  const upload = await f.app.inject({
    method: "POST",
    url: `/v1/generations/${id}/audio/inference?sequence=0&sampleRate=16000&channels=1`,
    headers: { ...f.headers, "content-type": "application/octet-stream" },
    payload: Buffer.alloc(16),
  });
  expect(upload.statusCode).toBe(409);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: `/v1/generations/${id}/finish`,
        headers: f.headers,
        payload: { inferenceFrames: 16_000 },
      })
    ).statusCode,
  ).toBe(409);
  // The WebSocket route's preValidation uses this same service guard.
  await expect(f.service.requireClientUpload(id)).rejects.toMatchObject({ code: "remote_capture" });
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
  expect((await f.service.history()).items).toHaveLength(0);
});

test("capture startup can be cancelled without waiting for a stuck provider", async () => {
  const f = await fixture();
  f.provider.gate = new Promise(() => {});
  const starting = f.start();
  await until(() => f.provider.calls === 1);
  const id = f.provider.options!.generation.id;
  expect((await f.service.get(id)).capture?.state).toBe("preparing");
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: `/v1/generations/${id}/cancel`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(200);
  expect((await starting).statusCode).toBe(409);
  expect(f.provider.options!.signal.aborted).toBe(true);
  expect((await f.service.get(id)).status).toBe("cancelled");
});

test("startup timeout aborts hardware and releases admission", async () => {
  const f = await fixture();
  f.provider.gate = new Promise(() => {});
  const result = await f.start();
  expect(result.statusCode).toBe(503);
  expect(result.json().code).toBe("capture_timeout");
  expect(f.provider.options!.signal.aborted).toBe(true);
  const records = await f.service.history();
  expect(records.items[0]?.status).toBe("cancelled");
}, 7_000);

test("provider loss before readiness remains eligible for client fallback", async () => {
  const f = await fixture();
  f.provider.failBeforeReady = true;
  const result = await f.start();
  expect(result.statusCode).toBe(503);
  expect(result.json().code).toBe("capture_failed");
  expect(f.provider.options!.signal.aborted).toBe(true);
  expect((await f.service.get(f.provider.options!.generation.id)).status).toBe("cancelled");
});

test("owner lease expiry cancels recording even while source status remains fresh", async () => {
  const f = await fixture();
  const id = (await f.start()).json().id;
  await Bun.sleep(3_000);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: `/v1/generations/${id}/capture/heartbeat`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(204);
  await Bun.sleep(3_000);
  expect(f.provider.options!.signal.aborted).toBe(false);
  await until(() => f.provider.options!.signal.aborted, 7_000);
  expect(f.provider.options!.signal.aborted).toBe(true);
  await until(async () => (await f.service.get(id)).status === "cancelled");
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: `/v1/generations/${id}/capture/heartbeat`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(409);
}, 15_000);

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
  // A retry admitted after cancellation sees the cancelled generation instead of pending readiness.
  expect([503, 409]).toContain((await second).statusCode);
  expect(f.provider.calls).toBe(1);
  expect((await f.service.get(f.provider.options!.generation.id)).status).toBe("cancelled");
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
      url: "/v1/captures",
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
  const result = await f.app.inject({
    method: "POST",
    url: `/v1/generations/${id}/capture/stop`,
    headers: f.headers,
    payload: {},
  });
  expect(result.statusCode).toBe(202);
  expect(result.json().originalAudio).toBeUndefined();
  expect(result.json().settings.preferences.keepOriginalAudio).toBe(false);
});

test("source loss stops without splicing another mic; stale ownership cannot control a new take", async () => {
  const f = await fixture();
  const id = (await f.start()).json().id;
  f.provider.available = false;
  await Bun.sleep(350);
  expect((await f.service.get(id)).status).toBe("cancelled");
  f.provider.available = true;
  const nextOwner = "c".repeat(64);
  const next = await f.app.inject({
    method: "POST",
    url: "/v1/captures",
    headers: { ...f.headers, "x-sottoduo-capture-owner": nextOwner },
    payload: { ...f.request, requestID: randomUUID() },
  });
  expect(next.statusCode).toBe(201);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: `/v1/generations/${next.json().id}/cancel`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(403);
  expect((await f.service.get(next.json().id)).capture?.state).toBe("recording");
});

test("remote capture retains original-audio settings and interval validation", async () => {
  const f = await fixture();
  f.provider.originalFrames = 24_000;
  const id = (await f.start()).json().id;
  const stopped = await f.app.inject({
    method: "POST",
    url: `/v1/generations/${id}/capture/stop`,
    headers: f.headers,
    payload: {},
  });
  expect(stopped.statusCode).toBe(400);
  expect(stopped.json().code).toBe("audio_mismatch");
  expect((await f.service.get(id)).status).toBe("cancelled");
});

test("shutdown aborts capture and restart never resumes it; ownership persists privately", async () => {
  const f = await fixture();
  const id = (await f.start()).json().id;
  await f.service.shutdown();
  expect(f.provider.options!.signal.aborted).toBe(true);
  const restarted = await GenerationService.open(
    { dataDirectory: f.directory, development: true },
    new FakeInference(),
  );
  try {
    expect((await restarted.get(id)).status).toBe("cancelled");
    expect(restarted.captures.sources()).toEqual({ sources: [] });
    await expect(restarted.authorizeCapture(id, "d".repeat(64))).rejects.toMatchObject({
      status: 403,
    });
    await restarted.authorizeCapture(id, f.owner);
  } finally {
    await restarted.shutdown();
  }
});

test("missing owner credentials on disk fail closed without exposing private paths", async () => {
  const f = await fixture();
  const id = (await f.start()).json().id;
  await rm(join(f.directory, "generations", id, "capture-owner.sha256"));
  const result = await f.app.inject({
    method: "POST",
    url: `/v1/generations/${id}/cancel`,
    headers: f.headers,
  });
  expect(result.statusCode).toBe(403);
  expect(result.body).not.toContain(f.directory);
  expect(f.provider.options!.signal.aborted).toBe(false);
});

test("provider loss during drain aborts the pending stop without sealing partial audio", async () => {
  const f = await fixture();
  const id = (await f.start()).json().id;
  f.provider.stopGate = new Promise(() => {});
  const stopping = f.app.inject({
    method: "POST",
    url: `/v1/generations/${id}/capture/stop`,
    headers: f.headers,
    payload: {},
  });
  await until(() => f.provider.stopCalls === 1);
  f.provider.options!.lost();
  expect((await stopping).statusCode).toBe(409);
  const record = await f.service.get(id);
  expect(record.status).toBe("cancelled");
  expect(record.capture?.state).toBe("stopped");
  expect(record.inferenceAudio).toBeUndefined();
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
    url: "/v1/captures",
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

test("capture deadline and lease no longer cancel a take while its stop drains", async () => {
  const f = await fixture();
  const id = (await f.start()).json().id;
  let releaseStop: (() => void) | undefined;
  f.provider.stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const stopping = f.app.inject({
    method: "POST",
    url: `/v1/generations/${id}/capture/stop`,
    headers: f.headers,
    payload: {},
  });
  await until(() => f.provider.stopCalls === 1);
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now + 181_000);
  try {
    await Bun.sleep(350);
    expect(f.provider.options!.signal.aborted).toBe(false);
  } finally {
    clock.mockRestore();
    releaseStop?.();
  }
  expect((await stopping).statusCode).toBe(202);
  expect((await f.service.get(id)).capture?.state).toBe("sealed");
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
  const next = () =>
    f.app.inject({
      method: "POST",
      url: "/v1/captures",
      headers: f.headers,
      payload: { ...f.request, requestID: randomUUID() },
    });
  const first = (await f.start()).json();
  const stopped = await f.app.inject({
    method: "POST",
    url: `/v1/generations/${first.id}/capture/stop`,
    headers: f.headers,
    payload: {},
  });
  expect(stopped.statusCode).toBe(202);
  const second = await next();
  expect(second.statusCode).toBe(201);
  expect(["queued", "transcribing"]).toContain((await f.service.get(first.id)).status);
  release();
  await until(async () => (await f.service.get(first.id)).status === "completed");
  expect((await f.service.get(second.json().id)).status).toBe("receiving");
  await f.service.cancel(second.json().id);
});
