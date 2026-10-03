import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DJIStatus, djiCRC } from "../src/capture/dji-status.ts";
import { pipeWireInputs } from "../src/capture/pipewire-discovery.ts";
import { recordPipeWire } from "../src/capture/pipewire-recording.ts";
import { PipeWireCaptureProvider } from "../src/capture/pipewire-provider.ts";
import { GenerationService } from "../src/generation-service.ts";
import { FakeInference } from "./support.ts";
import { validateBody } from "../src/validation.ts";

function statusFrame(mask: number, length = 86) {
  const frame = Buffer.alloc(length);
  frame[0] = 0x55;
  frame[1] = length;
  frame[2] = 4;
  frame[3] = djiCRC(frame.subarray(0, 3), 0x77, 0x8c);
  frame.set([0, 0x5b, 3, 3], 8);
  frame[12] = length - 16;
  frame[44] = mask;
  frame.writeUInt16LE(djiCRC(frame.subarray(0, -2), 0x3692, 0x8408), length - 2);
  return frame;
}
test("DJI status rejects queued, corrupt, unsupported and stale reports without inferring audio health", () => {
  const decoder = new DJIStatus(0);
  const connected = statusFrame(1);
  decoder.push(Buffer.concat([Buffer.from([1, 2, 3]), connected, connected]), 2);
  expect(decoder.snapshot(2)).toBeUndefined();
  decoder.push(connected.subarray(0, 40), 1100);
  decoder.push(connected.subarray(40), 1101);
  expect(decoder.snapshot(1101)).toBeUndefined();
  decoder.push(connected, 2200);
  expect(decoder.snapshot(2200)?.mask).toBe(1);
  const corrupted = statusFrame(0);
  corrupted[44] = 1;
  decoder.push(corrupted, 2300);
  expect(decoder.snapshot(2300)?.mask).toBe(1);
  expect(decoder.snapshot(4800)).toBeUndefined();
  decoder.push(statusFrame(0, 54), 5500);
  expect(decoder.snapshot(5500)).toBeUndefined();
  decoder.push(statusFrame(0, 54), 6600);
  expect(decoder.snapshot(6600)?.mask).toBe(0);
  decoder.push(statusFrame(2, 54), 7700); // Mask precedes the TX slot on reconnect.
  expect(decoder.snapshot(7700)?.mask).toBe(2);
  decoder.push(statusFrame(8), 8800);
  expect(decoder.snapshot(8800)?.mask).toBe(2);
});

test("DJI extra full reports preserve fresh status without keeping stale status alive", () => {
  const decoder = new DJIStatus(0);
  decoder.push(statusFrame(1), 100);
  decoder.push(statusFrame(1), 1200);
  decoder.push(statusFrame(1), 1423); // Extra report observed during the physical button trial.
  expect(decoder.snapshot(1423)).toEqual({ mask: 1, at: 1200 });
  decoder.push(statusFrame(1), 2200);
  expect(decoder.snapshot(2200)).toEqual({ mask: 1, at: 2200 });
  for (let now = 2300; now <= 4800; now += 100) decoder.push(statusFrame(1), now);
  expect(decoder.snapshot(4800)).toBeUndefined();
  decoder.push(statusFrame(1), 5800);
  expect(decoder.snapshot(5800)).toEqual({ mask: 1, at: 5800 });
});

test("DJI rapid changed masks invalidate immediately and cannot restore connection in a burst", () => {
  for (const mask of [0, 2, 3]) {
    const decoder = new DJIStatus(0);
    decoder.push(statusFrame(1), 100);
    decoder.push(statusFrame(1), 1200);
    decoder.push(statusFrame(mask), 1423);
    expect(decoder.snapshot(1423)).toBeUndefined();
    decoder.push(statusFrame(1), 1500);
    expect(decoder.snapshot(1500)).toBeUndefined();
    decoder.push(statusFrame(1), 2500);
    expect(decoder.snapshot(2500)?.mask).toBe(1);
  }
});

const node = (serial = 100) => ({
  id: serial,
  type: "PipeWire:Interface:Node",
  info: {
    state: "suspended",
    props: {
      "node.name": "alsa_input.usb-test",
      "node.description": "DJI receiver",
      "object.serial": serial,
      "media.class": "Audio/Source",
      "device.api": "alsa",
      "device.bus": "usb",
      "alsa.components": "USB2ca3:4011",
      "api.alsa.pcm.card": 2,
    },
    params: {
      EnumFormat: [{ mediaType: "audio", mediaSubtype: "raw", rate: 48000, channels: 2 }],
      Props: [{ mute: false }],
    },
  },
});
test("PipeWire discovery uses stable identities across node churn and leaves DJI readiness unknown", () => {
  const a = pipeWireInputs([node()], "desktop")[0]!;
  const b = pipeWireInputs([node(200)], "desktop")[0]!;
  expect(a.source.identity).toEqual(b.source.identity);
  expect(a.serial).not.toBe(b.serial);
  expect(a.source).toMatchObject({
    present: true,
    capture: "unknown",
    link: "unknown",
    audioHealth: "unknown",
  });
  expect(a.format).toEqual({ sampleRate: 48000, channels: 2 });
  expect(pipeWireInputs([node(), node(200)], "desktop")).toEqual([]);
  const muted = node();
  muted.info.params.Props[0]!.mute = true;
  expect(pipeWireInputs([muted], "desktop")[0]!.source.capture).toBe("unavailable");
  const malformed = node();
  malformed.info.params.EnumFormat[0]!.rate = 0;
  expect(pipeWireInputs([malformed], "desktop")[0]!.source.capture).toBe("unavailable");
  expect(() => pipeWireInputs({}, "desktop")).toThrow();
  const longName = node();
  longName.info.props["node.description"] = "x".repeat(200);
  expect(() =>
    validateBody("AudioSourceList", {
      sources: pipeWireInputs([longName], "desktop").map((x) => x.source),
    }),
  ).not.toThrow();
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function recording(serial: string, retain = true, block = false) {
  const directory = await mkdtemp(join(tmpdir(), "dictaduo-pipewire-"));
  const service = await GenerationService.open(
    { dataDirectory: directory, development: true },
    new FakeInference(),
  );
  cleanup.push(async () => {
    await service.shutdown();
    await rm(directory, { force: true, recursive: true });
  });
  const preferences = await service.getPreferences();
  preferences.preferences.keepOriginalAudio = retain;
  await service.updatePreferences(preferences);
  const generation = await service.create({
    requestID: randomUUID(),
    device: { id: "mac", name: "Mac" },
    mode: "test",
  });
  const input = pipeWireInputs([node()], "desktop")[0]!;
  input.serial = serial;
  const controller = new AbortController();
  const gate = Promise.withResolvers<void>();
  let lost = 0,
    levels = 0;
  const capture = recordPipeWire(resolve(import.meta.dir, "fixtures/capture-helper.ts"), input, {
    generation,
    signal: controller.signal,
    write: async (kind, sequence, format, bytes) => {
      if (block) await gate.promise;
      await service.appendAudio(generation.id, kind, sequence, format, bytes);
    },
    lost: () => {
      lost++;
    },
    level: () => {
      levels++;
    },
  });
  cleanup.push(async () => {
    controller.abort();
    await capture.cancel();
    gate.resolve();
    capture.cleanup();
  });
  return { capture, controller, service, generation, lost: () => lost, levels: () => levels };
}
test("PipeWire framing drains matching original/inference intervals into existing generations, including silence", async () => {
  for (const retained of [true, false]) {
    const f = await recording("1", retained);
    const handle = await f.capture.ready;
    const counts = await handle.stop();
    expect(counts).toEqual(
      retained ? { inferenceFrames: 16000, originalFrames: 48000 } : { inferenceFrames: 16000 },
    );
    const record = await f.service.finish(f.generation.id, counts);
    expect(record.inferenceAudio?.frameCount).toBe(16000);
    expect(record.originalAudio?.channels).toBe(retained ? 2 : undefined);
    expect(f.levels()).toBe(10);
    expect(f.lost()).toBe(0);
  }
});
test("abort releases a helper stuck before readiness", async () => {
  const f = await recording("2");
  f.controller.abort();
  await expect(f.capture.ready).rejects.toThrow("aborted");
  await f.capture.done;
});
test("helper crash and truncated stop output cannot seal a generation", async () => {
  const crashed = await recording("3");
  await crashed.capture.done;
  expect(crashed.lost()).toBe(1);
  const truncated = await recording("4");
  const handle = await truncated.capture.ready;
  await expect(handle.stop()).rejects.toThrow();
  expect((await truncated.service.get(truncated.generation.id)).status).toBe("receiving");
});
test("backpressure failure terminates the helper even when an archive write is stuck", async () => {
  const f = await recording("5", false, true);
  await f.capture.done;
  expect(f.lost()).toBe(1);
});
test.skipIf(process.platform !== "linux")(
  "missing optional native helper keeps discovery empty and shutdown usable",
  async () => {
    const provider = await PipeWireCaptureProvider.open({
      helper: "/missing/dictaduo-capture",
      hostID: "desktop",
    });
    try {
      expect(provider.sources()).toEqual([]);
    } finally {
      await provider.close();
    }
  },
);
