import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { PipeWireCaptureProvider } from "../src/capture/pipewire-provider.ts";
import { openCaptureServices } from "./support.ts";

// Explicit opt-in: a private PipeWire daemon with a tone generator, never desktop audio.
const helper = process.env.DICTADUO_TEST_CAPTURE_HELPER;
const nativeTest = test.skipIf(!helper || process.platform !== "linux");
const exec = promisify(execFile);
let directory: string,
  daemon: ReturnType<typeof spawn>,
  provider: PipeWireCaptureProvider,
  services: Awaited<ReturnType<typeof openCaptureServices>>;
let previous: { runtime?: string; remote?: string };
interface GraphObject {
  id: number;
  type: string;
  info?: { props?: Record<string, unknown> };
}
const command = async (file: string, args: string[]) =>
  (await exec(file, args, { timeout: 1500 })).stdout;
const graph = async () => JSON.parse(await command("pw-dump", [])) as GraphObject[];
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 2500;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  }
  throw new Error("PipeWire condition timed out.");
}
const configure = (id: number, direction: "Input" | "Output") =>
  command("pw-cli", [
    "set-param",
    String(id),
    "PortConfig",
    `{ direction = ${direction} mode = dsp format = { mediaType = audio mediaSubtype = raw format = F32P rate = 48000 channels = 2 position = [ FL FR ] } }`,
  ]);
async function connect() {
  const node = await until(async () =>
    (await graph()).find((x) => x.info?.props?.["media.name"] === "DictaDuo capture"),
  );
  await configure(node.id, "Input");
  for (const channel of ["FL", "FR"])
    await command("pw-link", [
      `dictaduo-test-source:capture_${channel}`,
      `dictaduo-capture:input_${channel}`,
    ]);
}
async function noCapture() {
  await until(async () =>
    (await graph()).some((x) => x.info?.props?.["media.name"] === "DictaDuo capture")
      ? undefined
      : true,
  );
}
beforeEach(async () => {
  if (!helper || process.platform !== "linux") return;
  directory = await mkdtemp(join(tmpdir(), "dictaduo-pw-"));
  previous = { runtime: process.env.PIPEWIRE_RUNTIME_DIR, remote: process.env.PIPEWIRE_REMOTE };
  process.env.PIPEWIRE_RUNTIME_DIR = directory;
  process.env.PIPEWIRE_REMOTE = "dictaduo-test";
  daemon = spawn("pipewire", ["-c", resolve(import.meta.dir, "fixtures/pipewire.conf")], {
    stdio: "ignore",
  });
  const source = await until(async () => {
    try {
      return (await graph()).find((x) => x.info?.props?.["node.name"] === "dictaduo-test-source");
    } catch {
      return undefined;
    }
  });
  await configure(source.id, "Output");
  provider = await PipeWireCaptureProvider.open({ helper, hostID: "isolated-test" });
  services = await openCaptureServices(join(directory, "data"), provider);
}, 20_000);
afterEach(async () => {
  if (!helper || process.platform !== "linux") return;
  try {
    await services?.close();
    await provider?.close();
  } finally {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const closed = new Promise((resolve) => daemon.once("close", resolve));
      daemon.kill();
      await closed;
    }
    if (previous.runtime === undefined) delete process.env.PIPEWIRE_RUNTIME_DIR;
    else process.env.PIPEWIRE_RUNTIME_DIR = previous.runtime;
    if (previous.remote === undefined) delete process.env.PIPEWIRE_REMOTE;
    else process.env.PIPEWIRE_REMOTE = previous.remote;
    await rm(directory, { recursive: true, force: true });
  }
});
async function begin() {
  await until(async () => ((await services.service.health()).ready ? true : undefined));
  const source = provider.sources()[0]!;
  const owner = "a".repeat(64);
  const starting = services.service.captures.start(
    {
      requestID: randomUUID(),
      device: { id: "mac", name: "Mac" },
      mode: "test",
      source: source.identity,
    },
    owner,
  );
  void starting.catch(() => {});
  await connect();
  return { record: await starting, owner };
}
nativeTest(
  "native PipeWire buffers reach existing generations with meters and matching retention intervals",
  async () => {
    for (const retained of [true, false]) {
      const preferences = await services.service.getPreferences();
      preferences.preferences.keepOriginalAudio = retained;
      await services.service.updatePreferences(preferences);
      const { record, owner } = await begin();
      // Level peaks are published to watchers, never persisted.
      let peak = 0;
      const unsubscribe = services.recordings.subscribe(record.id, (snapshot) => {
        peak = Math.max(peak, snapshot.capture?.peak ?? 0);
      });
      await Bun.sleep(500);
      expect(peak).toBeGreaterThan(0.1);
      unsubscribe();
      const stopped = await services.service.captures.stop(record.id, {}, owner);
      expect(stopped.capture?.state).toBe("sealed");
      const inference = stopped.streams.find((stream) => stream.kind === "inference")!;
      const original = stopped.streams.find((stream) => stream.kind === "original");
      expect(inference.format).toEqual({ sampleRate: 16000, channels: 1 });
      expect(inference.frameCount).toBeGreaterThan(4000);
      if (retained) {
        expect(original?.format).toEqual({ sampleRate: 48000, channels: 2 });
        expect(Math.abs(original!.frameCount / 48000 - inference.frameCount / 16000)).toBeLessThan(
          1 / 16000,
        );
      } else expect(original).toBeUndefined();
      await noCapture();
    }
  },
  20_000,
);
nativeTest(
  "cancellation releases native input and allows a new take",
  async () => {
    const { record } = await begin();
    await services.recordings.discard(record.id);
    await noCapture();
    const next = await begin();
    await services.recordings.discard(next.record.id);
    await noCapture();
  },
  20_000,
);
nativeTest(
  "owner lease expiry kills native capture without sealing",
  async () => {
    const { record } = await begin();
    await Bun.sleep(5300);
    await noCapture();
    expect((await services.recordings.get(record.id)).capture?.state).toBe("stopped");
  },
  10_000,
);
nativeTest("wrong target cannot silently attach to another source", async () => {
  const child = spawn(helper!, ["capture", "99999999", "48000", "2", "0"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  let bytes = 0;
  child.stdout.on("data", (b) => {
    bytes += b.length;
  });
  const completion = new Promise((resolve) => child.once("close", resolve));
  const node = await until(async () =>
    (await graph()).find((x) => x.info?.props?.["media.name"] === "DictaDuo capture"),
  );
  await configure(node.id, "Input");
  // Force an incorrect link, as a misbehaving session manager might. The helper must reject it.
  await command("pw-link", ["dictaduo-test-source:capture_FL", "dictaduo-capture:input_FL"]);
  const code = await completion;
  expect(code).not.toBe(0);
  expect(bytes).toBe(0);
  await noCapture();
});
nativeTest("parent crash kills its native helper", async () => {
  const source = (await graph()).find(
    (x) => x.info?.props?.["node.name"] === "dictaduo-test-source",
  );
  const serial = source?.info?.props?.["object.serial"];
  if (typeof serial !== "number" || !Number.isSafeInteger(serial) || serial <= 0)
    throw new Error("The test source has no PipeWire serial.");
  const parent = spawn(
    process.execPath,
    [
      "-e",
      `const p=Bun.spawn([process.argv[1],"capture","${serial}","48000","2","0"],{stdin:"pipe",stdout:"ignore",stderr:"ignore",env:{...process.env,DICTADUO_CAPTURE_PARENT_PID:String(process.pid)}}); console.log(p.pid); setInterval(()=>{},1000);`,
      helper!,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const exited = new Promise((resolve) => parent.once("close", resolve));
  try {
    const pid = await new Promise<number>((resolve) =>
      parent.stdout.once("data", (bytes) => resolve(Number(bytes.toString().trim()))),
    );
    await connect();
    parent.kill("SIGKILL");
    await exited;
    await until(async () => {
      try {
        const stat = await Bun.file(`/proc/${pid}/stat`).text();
        return stat.split(") ")[1]?.startsWith("Z") ? true : undefined;
      } catch {
        return true;
      }
    });
    await noCapture();
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    await exited;
  }
});
nativeTest("service shutdown releases capture and restart permits a fresh take", async () => {
  const { record } = await begin();
  await services.close();
  await provider.close();
  await noCapture();
  provider = await PipeWireCaptureProvider.open({ helper: helper!, hostID: "isolated-test" });
  services = await openCaptureServices(join(directory, "data"), provider);
  expect((await services.recordings.get(record.id)).capture?.state).toBe("stopped");
  const next = await begin();
  await services.recordings.discard(next.record.id);
  await noCapture();
});
nativeTest("target removal cancels an active take without substituting audio", async () => {
  const { record } = await begin();
  const source = (await graph()).find(
    (x) => x.info?.props?.["node.name"] === "dictaduo-test-source",
  )!;
  await command("pw-cli", ["destroy", String(source.id)]);
  await noCapture();
  // Loss ends the take asynchronously: audio already written is sealed as
  // stopped, and a take that lost its source before any audio is discarded.
  await until(async () => {
    const snapshot = await services.recordings.get(record.id);
    return snapshot.captureState === "discarded" || snapshot.capture?.state === "stopped"
      ? true
      : undefined;
  });
});
