import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHTTPServer } from "../../../Server/src/http-server.ts";
import type { CaptureProvider } from "../../../Server/src/capture-sessions.ts";
import { FakeInference, openCaptureServices } from "../../../Server/tests/support.ts";
import { API, APIError } from "../src/api.ts";
import { Controller, type Desktop } from "../src/controller.ts";
import type { Source } from "../src/sources.ts";
import { ShortcutCheck } from "../src/shortcuts.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await Bun.sleep(5);
  }
}
async function fixture(inference = new FakeInference()) {
  const sources = (): Source[] =>
    ["dji", "built-in"].map((id) => ({
      identity: { hostID: "desktop", id },
      name: id,
      transport: "usb",
      present: true,
      link: "connected",
      capture: "available",
      audioHealth: "unknown",
      observedAt: new Date().toISOString(),
    }));
  const starts: string[] = [];
  let level: (peak: number) => void = () => {};
  let lose = () => {};
  const provider: CaptureProvider = {
    sources,
    async start(options) {
      starts.push(options.generation.capture!.source.id);
      level = options.level;
      lose = options.lost;
      await options.write("inference", 0, { sampleRate: 16000, channels: 1 }, Buffer.alloc(64000));
      if (options.generation.settings.preferences.keepOriginalAudio)
        await options.write(
          "original",
          0,
          { sampleRate: 48000, channels: 1 },
          Buffer.alloc(192000),
        );
      return {
        stop: async () => ({
          inferenceFrames: 16000,
          ...(options.generation.settings.preferences.keepOriginalAudio
            ? { originalFrames: 48000 }
            : {}),
        }),
      };
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "sottoduo-linux-test-"));
  const services = await openCaptureServices(directory, provider, inference);
  const service = services.service;
  const app = createHTTPServer(service, "fixture-token", undefined, services.recordings);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    await services.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const api = new API(address, "fixture-token");
  let unlocked = true;
  let deliveries = 0;
  let mode: "inserted" | "preview" | "uncertain" = "inserted";
  let deliveryGate: Promise<void> | undefined;
  const notices: string[] = [];
  const desktop: Desktop = {
    unlocked: async () => unlocked,
    capture: async () => ({
      close() {},
      deliver: async () => {
        deliveries++;
        await deliveryGate;
        return mode;
      },
    }),
    defaultInput: async () => ({ hostID: "desktop", id: "built-in" }),
    notify: (value) => {
      notices.push(value);
    },
  };
  const controller = new Controller(
    api,
    desktop,
    { id: "desktop-client", name: "Omarchy" },
    { hostID: "desktop", mode: "automatic", priority: [{ hostID: "desktop", id: "dji" }] },
  );
  cleanup.push(async () => {
    await controller.cancelAll();
    await controller.settled();
  });
  return {
    controller,
    api,
    service,
    starts,
    notices,
    desktop,
    deliveries: () => deliveries,
    /** The fields these tests check, read from the recording session. */
    record: async (id: string) => {
      const { snapshot, result } = await api.recording(id);
      return {
        status:
          snapshot.captureState === "discarded"
            ? "cancelled"
            : snapshot.processingState === "completed"
              ? "completed"
              : snapshot.processingState === "failed"
                ? "failed"
                : "receiving",
        delivery: result?.delivery,
        device: snapshot.device,
        capture: snapshot.capture,
        mode: snapshot.mode,
      };
    },
    lock: () => {
      unlocked = false;
    },
    delivery: (value: typeof mode) => {
      mode = value;
    },
    waitForDelivery: (gate: Promise<void>) => {
      deliveryGate = gate;
    },
    level: (peak: number) => level(peak),
    lose: () => lose(),
  };
}
test("shortcut diagnostics block shortcut, GUI test and pairing captures until a held key is released", async () => {
  const f = await fixture();
  const check = new ShortcutCheck();
  f.controller.captureAllowed = () => !check.blocked;
  check.begin();
  check.consume("start");
  f.controller.start();
  f.controller.start(undefined, true);
  expect(f.controller.startButton("ticket", { hostID: "desktop", id: "dji" })).toBe(false);
  expect(f.controller.busy).toBe(false);
  expect(f.starts).toEqual([]);
  check.end();
  f.controller.start();
  expect(f.controller.busy).toBe(false);
  check.consume("stop");
  f.controller.start(undefined, true);
  await until(() => f.controller.activity.phase === "recording");
  f.controller.stop();
  await f.controller.settled();
  expect(f.starts).toEqual(["dji"]);
  expect(f.deliveries()).toBe(0);
});
test("live server feedback supplies real peaks but cannot deliver text; stopped and cancelled takes clear levels", async () => {
  const f = await fixture();
  f.controller.start();
  await until(() => f.controller.activity.phase === "recording");
  // Peaks are a live stream, not stored state: keep sending them until the
  // client's event subscription, which connects after admission, sees one.
  await until(() => {
    f.level(0.65);
    return f.controller.feedback.snapshot().levels.includes(0.65);
  });
  expect(f.deliveries()).toBe(0);
  f.controller.stop();
  await f.controller.settled();
  expect(f.controller.feedback.snapshot().levels).toEqual([]);
  expect(f.deliveries()).toBe(1);
  f.controller.start();
  await until(() => f.controller.activity.phase === "recording");
  expect(f.controller.feedback.snapshot().partialText).toBe("");
  await f.controller.cancel();
  f.level(0.9);
  await f.controller.settled();
  expect(f.controller.feedback.snapshot().levels).toEqual([]);
  expect(f.deliveries()).toBe(1);
});
test("failed live feedback remains advisory and cannot prevent the owned take from completing", async () => {
  const f = await fixture();
  f.api.events = async () => {
    throw new Error("feedback connection failed");
  };
  f.controller.start();
  await until(() => f.controller.activity.phase === "recording");
  expect(f.controller.feedback.snapshot()).toMatchObject({ streamAvailable: false, levels: [] });
  f.controller.stop();
  await f.controller.settled();
  expect(f.deliveries()).toBe(1);
});
test("provisional text never inserts and a cancelled stream cannot update the next take", async () => {
  const f = await fixture();
  let late: (() => void) | undefined;
  f.api.events = async (id, signal, update) => {
    const { snapshot } = await f.api.recording(id);
    const publish = () => update({ ...snapshot, previewText: "Not final" });
    late ??= publish;
    publish();
    if (!signal.aborted)
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
  };
  f.controller.start();
  await until(() => f.controller.feedback.snapshot().partialText === "Not final");
  expect(f.deliveries()).toBe(0);
  await f.controller.cancel();
  await f.controller.settled();
  f.api.events = async () => {};
  f.controller.start();
  await until(() => f.controller.activity.phase === "recording");
  late!();
  expect(f.controller.feedback.snapshot().partialText).toBe("");
  expect(f.deliveries()).toBe(0);
  await f.controller.cancel();
});
test("owned HTTP capture reuses history and delivers once, including duplicate release commands", async () => {
  const f = await fixture();
  f.controller.start();
  f.controller.start();
  await until(() => f.controller.state.startsWith("recording"));
  f.controller.stop();
  f.controller.stop();
  await f.controller.settled();
  expect(f.starts).toEqual(["dji"]);
  expect(f.deliveries()).toBe(1);
  expect(f.controller.result?.text).toBe("Hello world. ");
  const record = await f.record(f.controller.result!.id);
  expect(record.device.id).toBe("desktop-client");
  expect(record.capture?.source.id).toBe("dji");
  expect(record.delivery?.status).toBe("inserted");
});
test("output stays muted from activation until the microphone is sealed, only when enabled", async () => {
  const f = await fixture();
  const events: string[] = [];
  f.controller.output = {
    mute: async () => {
      events.push(`mute:${f.controller.activity.phase}`);
      await Bun.sleep(50);
      events.push("muted");
    },
    restore: async () => void events.push(`restore:${f.controller.activity.phase}`),
  };
  const start = f.api.start.bind(f.api);
  f.api.start = async (...args) => {
    events.push("start");
    return start(...args);
  };
  f.controller.start();
  await until(() => f.controller.state.startsWith("recording"));
  f.controller.stop();
  await f.controller.settled();
  expect(events).toEqual(["start"]);
  events.length = 0;

  f.controller.muteOutput = true;
  f.controller.start();
  await until(() => f.controller.state.startsWith("recording"));
  // Turning the setting off mid-take still restores this take's output.
  f.controller.muteOutput = false;
  f.controller.stop();
  await f.controller.settled();
  expect(events.slice(0, 4)).toEqual(["mute:preparing", "muted", "start", "restore:processing"]);
  expect(events.every((event) => event !== "mute:processing")).toBe(true);
});

test("definitive startup rejection permits one fallback with fresh owner and request ID", async () => {
  const f = await fixture();
  const start = f.api.start.bind(f.api);
  const requests: { id: string; owner: string }[] = [];
  f.api.start = async (...args) => {
    requests.push({ id: args[0], owner: args[4] });
    if (requests.length === 1) throw new APIError(503, "source_unavailable");
    return start(...args);
  };
  f.controller.start();
  await until(() => f.controller.state.startsWith("recording"));
  f.controller.stop();
  await f.controller.settled();
  expect(requests.length).toBe(2);
  expect(requests[0]!.owner).not.toBe(requests[1]!.owner);
  expect(requests[0]!.id).not.toBe(requests[1]!.id);
  expect(f.starts).toEqual(["built-in"]);
  expect(f.deliveries()).toBe(1);
});
test("uncertain admission never opens a fallback microphone", async () => {
  const f = await fixture();
  let calls = 0;
  f.api.start = async () => {
    calls++;
    throw new Error("Network timeout after possible admission");
  };
  f.controller.start();
  await f.controller.settled();
  expect(calls).toBe(1);
  expect(f.deliveries()).toBe(0);
  expect(f.controller.result).toBeUndefined();
});
test("cancel during admission cancels its late response and cannot deliver", async () => {
  const f = await fixture();
  const start = f.api.start.bind(f.api);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let admitted = false;
  f.api.start = async (...args) => {
    const record = await start(...args);
    admitted = true;
    await gate;
    return record;
  };
  f.controller.start();
  await until(() => admitted);
  await f.controller.cancel();
  finish();
  await f.controller.settled();
  expect(f.deliveries()).toBe(0);
  expect(f.controller.result).toBeUndefined();
});
test("release during admission stops after readiness instead of leaving an open microphone", async () => {
  const f = await fixture();
  const start = f.api.start.bind(f.api);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let admitted = false;
  f.api.start = async (...args) => {
    const record = await start(...args);
    admitted = true;
    await gate;
    return record;
  };
  f.controller.start();
  await until(() => admitted);
  f.controller.stop();
  finish();
  await f.controller.settled();
  expect(f.deliveries()).toBe(1);
  expect(f.controller.result?.text).toBe("Hello world. ");
});
test("lock and heartbeat failure cancel capture without delivery", async () => {
  for (const cause of ["lock", "network"]) {
    const f = await fixture();
    f.controller.start();
    await until(() => f.controller.state.startsWith("recording"));
    if (cause === "lock") f.lock();
    else
      f.api.heartbeat = async () => {
        throw new Error("Offline");
      };
    await f.controller.settled();
    expect(f.deliveries()).toBe(0);
    expect(f.controller.result).toBeUndefined();
  }
});
test("a capture the server stops mid-take is kept in history, not discarded", async () => {
  const f = await fixture();
  const start = f.api.start.bind(f.api);
  let id = "";
  f.api.start = async (...args) => {
    const record = await start(...args);
    id = record.id;
    return record;
  };
  f.controller.start();
  await until(() => f.controller.state.startsWith("recording"));
  f.lose();
  await f.controller.settled();
  expect(f.controller.state).toContain("saved in history");
  expect(f.deliveries()).toBe(0);
  await until(async () => (await f.record(id)).status === "completed");
});
test("an interrupted capture restores muted output", async () => {
  const f = await fixture();
  let restored = 0;
  f.controller.output = { mute: async () => {}, restore: async () => void restored++ };
  f.controller.muteOutput = true;
  f.controller.start();
  await until(() => f.controller.state.startsWith("recording"));
  f.lose();
  await f.controller.settled();
  expect(f.controller.state).toContain("saved in history");
  expect(restored).toBe(1);
});
test("a cancel during a brief outage keeps retrying the discard", async () => {
  const f = await fixture();
  const cancel = f.api.cancel.bind(f.api);
  let attempts = 0,
    id = "";
  f.api.cancel = async (...args) => {
    id = args[0];
    if (++attempts < 3) throw new Error("Offline");
    return cancel(...args);
  };
  f.controller.discardRetryDelaysMS = [10, 10, 10];
  f.controller.start();
  await until(() => f.controller.state.startsWith("recording"));
  await f.controller.cancel();
  // Quitting waits for the retries instead of abandoning them.
  await f.controller.discardsSettled();
  expect(attempts).toBe(3);
  expect((await f.record(id)).status).toBe("cancelled");
});
test("recognition failing mid-take seals the capture instead of recording on", async () => {
  const f = await fixture();
  let stopped = "";
  const stop = f.api.stop.bind(f.api);
  f.api.stop = async (id, owner) => {
    stopped = id;
    return stop(id, owner);
  };
  f.api.events = async (id, _signal, update) => {
    const { snapshot } = await f.api.recording(id);
    update({ ...snapshot, processingState: "failed", error: "Recognition failed." });
  };
  f.controller.start();
  await f.controller.settled();
  expect(f.controller.state).toBe("Recognition failed.");
  expect(f.deliveries()).toBe(0);
  expect((await f.record(stopped)).capture?.state).toBe("sealed");
});
test("a lock after one-shot delivery begins preserves its insertion result", async () => {
  const f = await fixture();
  const owner = "a".repeat(64);
  const registration = crypto.randomUUID();
  const source = { hostID: "desktop", id: "dji" };
  f.service.buttons.input(source, "test-monitor");
  await f.api.buttonRequest("", owner, {
    id: registration,
    device: { id: "desktop-client", name: "Omarchy" },
  });
  await f.api.buttonRequest(`/${registration}/select`, owner, {});
  f.service.buttons.press("test-monitor", 1);
  const ticket = f.service.buttons.state(registration).command!.takeID;
  let release!: () => void;
  f.waitForDelivery(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  try {
    expect(f.controller.startButton(ticket, source)).toBe(true);
    await until(() => f.controller.activity.phase === "recording");
    f.controller.stopButton(ticket);
    await until(() => f.controller.activity.phase === "delivering");
    f.lock();
    await f.controller.cancelButton(ticket);
    await Bun.sleep(1100);
  } finally {
    release();
  }
  await f.controller.settled();
  expect(f.deliveries()).toBe(1);
  expect(f.controller.result?.delivery).toBe("inserted");
  expect(f.controller.activity.phase).toBe("completed");
});
test("a lock during the delivery receipt preserves completed insertion", async () => {
  const f = await fixture();
  const saveDelivery = f.api.delivery.bind(f.api);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.api.delivery = async (...args) => {
    await gate;
    return saveDelivery(...args);
  };
  try {
    f.controller.start();
    await until(() => f.controller.activity.phase === "recording");
    f.controller.stop();
    await until(() => f.controller.activity.phase === "completed");
    f.lock();
    await Bun.sleep(1100);
    expect(f.controller.result?.delivery).toBe("inserted");
    expect(f.controller.activity.phase).toBe("completed");
  } finally {
    release();
  }
  await f.controller.settled();
  expect(f.deliveries()).toBe(1);
});
test("clipboard fallback and ambiguous insertion never retry delivery, even if receipt fails", async () => {
  for (const mode of ["preview", "uncertain"] as const) {
    const f = await fixture();
    f.delivery(mode);
    f.api.delivery = async () => {
      throw new Error("Receipt offline");
    };
    f.controller.start();
    await until(() => f.controller.state.startsWith("recording"));
    f.controller.stop();
    await f.controller.settled();
    expect(f.controller.result?.delivery).toBe(mode);
    expect(f.deliveries()).toBe(1);
    f.controller.stop();
    await f.controller.settled();
    expect(f.deliveries()).toBe(1);
  }
});
test("owner heartbeats continue through a slow drain and stop after sealing", async () => {
  const f = await fixture();
  const stop = f.api.stop.bind(f.api),
    heartbeat = f.api.heartbeat.bind(f.api);
  let heartbeats = 0;
  f.api.heartbeat = async (...args) => {
    heartbeats++;
    await heartbeat(...args);
  };
  f.api.stop = async (...args) => {
    await Bun.sleep(1300);
    return stop(...args);
  };
  f.controller.start();
  await until(() => f.controller.state.startsWith("recording"));
  await Bun.sleep(1150);
  f.controller.stop();
  await f.controller.settled();
  expect(heartbeats).toBeGreaterThanOrEqual(2);
  expect(f.deliveries()).toBe(1);
});

test("a polling failure after sealing preserves the completed take in history", async () => {
  const f = await fixture();
  const stop = f.api.stop.bind(f.api),
    read = f.api.recording.bind(f.api),
    cancel = f.api.cancel.bind(f.api);
  let sealedID: string | undefined,
    cancellations = 0;
  f.api.stop = async (...args) => {
    const record = await stop(...args);
    sealedID = record.id;
    return { ...record, processingState: "processing" };
  };
  f.api.recording = async () => {
    throw new Error("Polling connection lost");
  };
  f.api.cancel = async (...args) => {
    cancellations++;
    return cancel(...args);
  };
  f.controller.processingTimeoutMS = 200;
  f.controller.start();
  await until(() => f.controller.state.startsWith("recording"));
  f.controller.stop();
  await f.controller.settled();
  expect(cancellations).toBe(0);
  expect(sealedID).toBeDefined();
  await until(async () => (await read(sealedID!)).snapshot.processingState === "completed");
});

test("a brief polling outage after sealing still delivers the take", async () => {
  const f = await fixture();
  const read = f.api.recording.bind(f.api);
  let failures = 0;
  f.api.recording = async (...args) => {
    if (failures++ < 2) throw new Error("Polling connection lost");
    return read(...args);
  };
  f.controller.start();
  await until(() => f.controller.state.startsWith("recording"));
  f.controller.stop();
  await f.controller.settled();
  expect(failures).toBeGreaterThan(2);
  expect(f.deliveries()).toBe(1);
});

test("an ambiguous stop response cannot cancel a sealed take", async () => {
  const f = await fixture();
  const stop = f.api.stop.bind(f.api);
  const get = f.record;
  const cancel = f.api.cancel.bind(f.api);
  let sealedID: string | undefined;
  let cancellations = 0;
  f.api.stop = async (...args) => {
    sealedID = (await stop(...args)).id;
    throw new Error("Stop response lost");
  };
  f.api.cancel = async (...args) => {
    cancellations++;
    return cancel(...args);
  };
  f.controller.start();
  await until(() => f.controller.state.startsWith("recording"));
  f.controller.stop();
  await f.controller.settled();
  expect(cancellations).toBe(0);
  expect(sealedID).toBeDefined();
  await until(async () => (await get(sealedID!)).status === "completed");
});

test("button take pins DJI, ignores keyboard release, and reports a supported preview receipt", async () => {
  const f = await fixture();
  const owner = "a".repeat(64),
    registration = crypto.randomUUID();
  const source = { hostID: "desktop", id: "dji" };
  f.service.buttons.input(source, "test-monitor");
  await f.api.buttonRequest("", owner, {
    id: registration,
    device: { id: "desktop-client", name: "Omarchy" },
  });
  await f.api.buttonRequest(`/${registration}/select`, owner, {});
  f.service.buttons.press("test-monitor", 1);
  const ticket = f.service.buttons.state(registration).command!.takeID;
  f.delivery("preview");
  expect(f.controller.startButton(ticket, source)).toBe(true);
  await until(() => f.controller.state.startsWith("recording"));
  f.controller.stop();
  await Bun.sleep(80);
  expect(f.controller.state.startsWith("recording")).toBe(true);
  f.controller.stopButton(ticket);
  await f.controller.settled();
  expect(f.starts).toEqual(["dji"]);
  expect(f.deliveries()).toBe(1);
  expect(f.notices.some((n) => n.includes("receipt could not"))).toBe(false);
  expect((await f.record(f.controller.result!.id)).delivery?.status).toBe("none");
});

test("button admission failure never tries the fallback microphone", async () => {
  const f = await fixture();
  let calls = 0;
  f.api.start = async () => {
    calls++;
    throw new APIError(503, "source_unavailable");
  };
  f.controller.startButton(crypto.randomUUID(), { hostID: "desktop", id: "dji" });
  await f.controller.settled();
  expect(calls).toBe(1);
  expect(f.starts).toEqual([]);
  expect(f.deliveries()).toBe(0);
});

test("successful shortcut take selects this connected destination, without a button selecting it first", async () => {
  const { ButtonDestinationClient } = await import("../src/buttons.ts");
  const f = await fixture();
  f.service.buttons.input({ hostID: "desktop", id: "dji" }, "input");
  const buttons = new ButtonDestinationClient(f.api, f.desktop, f.controller, {
    id: "desktop-client",
    name: "Omarchy",
  });
  cleanup.push(() => buttons.close());
  buttons.start();
  await until(() => (buttons.state?.destinations.length ?? 0) === 1);
  expect(buttons.state?.selected).toBeUndefined();
  f.controller.start();
  await until(() => f.controller.state.startsWith("recording"));
  f.controller.stop();
  await f.controller.settled();
  await until(() => f.service.buttons.state().selected?.device.id === "desktop-client");
  expect(f.service.buttons.state().selected?.device.id).toBe("desktop-client");
});

test("a shortcut take begun before disarm cannot reselect a replacement registration", async () => {
  const { ButtonDestinationClient } = await import("../src/buttons.ts");
  const f = await fixture();
  f.service.buttons.input({ hostID: "desktop", id: "dji" }, "input");
  const buttons = new ButtonDestinationClient(f.api, f.desktop, f.controller, {
    id: "desktop-client",
    name: "Omarchy",
  });
  cleanup.push(() => buttons.close());
  buttons.start();
  await until(() => (buttons.state?.destinations.length ?? 0) === 1);
  f.controller.start();
  await until(() => f.controller.state.startsWith("recording"));
  await buttons.disarm();
  await until(() => (buttons.state?.destinations.length ?? 0) === 1);
  f.controller.stop();
  await f.controller.settled();
  await Bun.sleep(40);
  expect(f.service.buttons.state().selected).toBeUndefined();
});

test("GUI microphone tests retain a preview without attempting desktop insertion or selecting a button destination", async () => {
  const f = await fixture();
  let selected = false;
  f.controller.onComplete = (_id, _ticket, succeeded) => {
    selected = succeeded;
  };
  f.controller.start(undefined, true);
  await until(() => f.controller.activity.phase === "recording");
  expect(f.controller.activity.trigger).toBe("test");
  expect(f.controller.activity.source).toBe("dji");
  f.controller.stop();
  await f.controller.settled();
  expect(f.controller.activity.phase).toBe("completed");
  expect(f.controller.result?.delivery).toBe("preview");
  expect((await f.record(f.controller.result!.id)).mode).toBe("test");
  expect(f.deliveries()).toBe(0);
  expect(selected).toBe(false);
});

function heldInference(call = 0) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  class HeldInference extends FakeInference {
    override async transcribe(...args: Parameters<FakeInference["transcribe"]>) {
      if (calls++ === call) await held;
      return super.transcribe(...args);
    }
  }
  return { inference: new HeldInference(), release: () => release() };
}
function track(f: Awaited<ReturnType<typeof fixture>>) {
  const started: string[] = [],
    delivered: string[] = [];
  const start = f.api.start.bind(f.api),
    delivery = f.api.delivery.bind(f.api);
  f.api.start = async (...args) => {
    const record = await start(...args);
    started.push(record.id);
    return record;
  };
  f.api.delivery = async (...args) => {
    delivered.push(args[0]);
    return delivery(...args);
  };
  return { started, delivered };
}
test("a slow automatic Whisper retry still delivers within the processing deadline", async () => {
  const held = Promise.withResolvers<void>();
  let attempts = 0;
  class RetryInference extends FakeInference {
    override async transcribe(...args: Parameters<FakeInference["transcribe"]>) {
      if (attempts++ === 0) {
        await held.promise;
        throw new Error("Speech inference timed out.");
      }
      return super.transcribe(...args);
    }
  }
  const f = await fixture(new RetryInference());
  const stop = f.api.stop.bind(f.api);
  const clock = spyOn(Date, "now");
  cleanup.push(async () => clock.mockRestore());
  f.api.stop = async (...args) => {
    const record = await stop(...args);
    // Start the controller's budget ten minutes ago, without simulating sleep
    // for the separate lock/suspend watchdog.
    clock.mockReturnValueOnce(Date.now() - 600_000);
    return record;
  };
  await record(f);
  f.controller.stop();
  await until(() => f.controller.activity.phase === "processing");
  held.resolve();
  await f.controller.settled();
  expect(attempts).toBe(2);
  expect(f.deliveries()).toBe(1);
  expect(f.controller.result?.delivery).toBe("inserted");
});

async function record(f: Awaited<ReturnType<typeof fixture>>) {
  await until(() => f.controller.start());
  await until(() => f.controller.state.startsWith("recording"));
}

test("a sealed take processes while the next take records, and deliveries keep recording order", async () => {
  const held = heldInference();
  const f = await fixture(held.inference);
  const ids = track(f);
  await record(f);
  f.controller.stop();
  await record(f);
  expect(f.controller.busy).toBe(true);
  f.controller.stop();
  await until(() => ids.started.length === 2);
  await Bun.sleep(400);
  expect(f.deliveries()).toBe(0);
  held.release();
  await f.controller.settled();
  expect(ids.delivered).toEqual(ids.started);
  expect(f.controller.result?.id).toBe(ids.started[1]);
  expect(f.controller.busy).toBe(false);
});

test("a pairing-button start is declined while an earlier take processes", async () => {
  const held = heldInference();
  const f = await fixture(held.inference);
  let sealed = false;
  const stop = f.api.stop.bind(f.api);
  f.api.stop = async (...args) => {
    const record = await stop(...args);
    sealed = true;
    return record;
  };
  await record(f);
  f.controller.stop();
  await until(() => sealed);
  await Bun.sleep(20);
  expect(f.controller.startButton(crypto.randomUUID(), { hostID: "desktop", id: "dji" })).toBe(
    false,
  );
  held.release();
  await f.controller.settled();
  expect(f.starts).toEqual(["dji"]);
});

test("a completed take waits for a newer held take before delivering", async () => {
  const f = await fixture();
  const ids = track(f);
  await record(f);
  f.controller.stop();
  await record(f);
  await until(async () => (await f.record(ids.started[0]!)).status === "completed");
  await Bun.sleep(400);
  expect(f.deliveries()).toBe(0);
  expect(f.controller.state.startsWith("recording")).toBe(true);
  f.controller.stop();
  await f.controller.settled();
  expect(ids.delivered).toEqual(ids.started);
});

test("an insertion deferred for a newer held take is retried after its release", async () => {
  const f = await fixture();
  const ids = track(f);
  const statuses: string[] = [];
  const delivery = f.api.delivery.bind(f.api);
  f.api.delivery = async (...args) => {
    statuses.push(args[2]);
    return delivery(...args);
  };
  let raced = false;
  // The next take starts while the destination's own delivery checks are pending.
  f.desktop.capture = async () => ({
    close() {},
    deliver: async (_text, held = () => false) => {
      if (!raced) {
        raced = true;
        await record(f);
      }
      return held() ? "held" : "inserted";
    },
  });
  await record(f);
  f.controller.stop();
  await until(() => raced && f.controller.state.startsWith("recording"));
  await Bun.sleep(200);
  expect(ids.delivered).toEqual([]);
  f.controller.stop();
  await f.controller.settled();
  expect(ids.delivered).toEqual(ids.started);
  expect(statuses).toEqual(["inserted", "inserted"]);
});

test("later insertions do not wait for an earlier delivery receipt", async () => {
  const held = heldInference();
  const f = await fixture(held.inference);
  const ids = track(f);
  const saveDelivery = f.api.delivery.bind(f.api);
  let release!: () => void;
  const receipt = new Promise<void>((resolve) => (release = resolve));
  let waiting = false;
  f.api.delivery = async (...args) => {
    if (args[0] === ids.started[0]) {
      waiting = true;
      await receipt;
    }
    return saveDelivery(...args);
  };
  try {
    await record(f);
    f.controller.stop();
    await record(f);
    f.controller.stop();
    await until(
      async () => (await f.api.recording(ids.started[1]!)).snapshot.capture?.state === "sealed",
    );
    held.release();
    await until(() => waiting && f.deliveries() === 2);
    expect(f.controller.result?.id).toBe(ids.started[1]);
  } finally {
    held.release();
    release();
  }
  await f.controller.settled();
  expect(ids.delivered).toEqual([ids.started[1]!, ids.started[0]!]);
});

test("server queue wait does not consume a take's processing deadline", async () => {
  const f = await fixture();
  const stop = f.api.stop.bind(f.api),
    recording = f.api.recording.bind(f.api);
  f.api.stop = async (...args) => ({ ...(await stop(...args)), processingState: "queued" });
  let polls = 0;
  // Shorter than both the queue wait below and the one-second take.
  f.controller.processingTimeoutMS = 200;
  f.api.recording = async (...args) => {
    const detail = await recording(...args);
    // Stay queued for longer than the processing deadline.
    if (++polls <= 5) return { snapshot: { ...detail.snapshot, processingState: "queued" } };
    return detail;
  };
  await record(f);
  f.controller.stop();
  await f.controller.settled();
  expect(polls).toBe(6);
  expect(f.deliveries()).toBe(1);
  expect(f.controller.result?.delivery).toBe("inserted");
});

test("server progress renews a take's processing deadline", async () => {
  const f = await fixture();
  const recording = f.api.recording.bind(f.api);
  let polls = 0;
  f.controller.processingTimeoutMS = 200;
  f.api.recording = async (...args) => {
    const detail = await recording(...args);
    // Each checkpoint lands within the deadline, but together they outlast it.
    if (++polls <= 8)
      return {
        snapshot: { ...detail.snapshot, processingState: "processing", revision: 1_000 + polls },
      };
    return detail;
  };
  await record(f);
  f.controller.stop();
  await f.controller.settled();
  expect(polls).toBe(9);
  expect(f.deliveries()).toBe(1);
});

test("cancelAll revokes every queued destination before slow server cancellation", async () => {
  for (const includeDelivery of [true, false]) {
    const held = heldInference();
    const f = await fixture(held.inference);
    const ids = track(f);
    const capture = f.desktop.capture,
      cancel = f.api.cancel.bind(f.api);
    let closed = 0;
    f.desktop.capture = async () => {
      const destination = await capture();
      let revoked = false;
      return {
        deliver: destination.deliver,
        close() {
          if (!revoked) closed++;
          revoked = true;
          destination.close();
        },
      };
    };
    let release!: () => void;
    const cleanupGate = new Promise<void>((resolve) => (release = resolve));
    f.api.cancel = async (...args) => {
      await cleanupGate;
      return cancel(...args);
    };
    let cancelling: Promise<void> | undefined;
    try {
      await record(f);
      f.controller.stop();
      await record(f);
      cancelling = f.controller.cancelAll(includeDelivery);
      expect(closed).toBe(2);
      held.release();
      await until(
        async () =>
          (await f.api.recording(ids.started[0]!)).snapshot.processingState === "completed",
      );
      await Bun.sleep(350);
      expect(f.deliveries()).toBe(0);
    } finally {
      held.release();
      release();
      await cancelling;
    }
    await f.controller.settled();
    expect(f.deliveries()).toBe(0);
  }
});

test("a take started during the delivery unlock check holds earlier insertion until release", async () => {
  const f = await fixture();
  const ids = track(f);
  await record(f);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let checking = false;
  let checked = false;
  const unlocked = f.desktop.unlocked;
  f.desktop.unlocked = async (since) => {
    if (!checking && f.controller.activity.phase === "processing") {
      checking = true;
      await gate;
      checked = true;
    }
    return unlocked(since);
  };
  try {
    f.controller.stop();
    await until(() => checking);
    await record(f);
    release();
    await until(() => checked);
    await Bun.sleep(100);
    expect(f.deliveries()).toBe(0);
    expect(f.controller.activity.phase).toBe("recording");
    f.controller.stop();
    await f.controller.settled();
    expect(ids.delivered).toEqual(ids.started);
  } finally {
    release();
  }
});

test("cancelling the newest take keeps an earlier processing take", async () => {
  const held = heldInference();
  const f = await fixture(held.inference);
  const ids = track(f);
  await record(f);
  f.controller.stop();
  await record(f);
  await f.controller.cancel();
  expect(f.controller.state).toBe("Cancelled · earlier dictation is still processing");
  expect(f.controller.activity.phase).toBe("processing");
  held.release();
  await f.controller.settled();
  expect(ids.delivered).toEqual([ids.started[0]!]);
  expect((await f.record(ids.started[1]!)).status).toBe("cancelled");
});

test("a cancel targets an earlier take that took over the overlay during slow cleanup", async () => {
  const held = heldInference();
  const f = await fixture(held.inference);
  const cancel = f.api.cancel.bind(f.api);
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>((resolve) => (releaseCleanup = resolve));
  f.api.cancel = async (...args) => {
    await cleanupGate;
    return cancel(...args);
  };
  let releaseDelivery!: () => void;
  f.waitForDelivery(new Promise<void>((resolve) => (releaseDelivery = resolve)));
  let first: Promise<void> | undefined;
  try {
    await record(f);
    f.controller.stop();
    await record(f);
    first = f.controller.cancel();
    held.release();
    // The earlier take now shows "Delivering text" while the newer take cleans up.
    await until(() => f.controller.activity.phase === "delivering");
    void f.controller.cancel();
    await until(() => f.controller.activity.phase === "cancelled");
  } finally {
    held.release();
    releaseDelivery();
    releaseCleanup();
    await first;
  }
  await f.controller.settled();
});

test("a cancelled recording is kept in history and inserted only after undo", async () => {
  const f = await fixture();
  const ids = track(f);
  const receipts: string[] = [];
  const delivery = f.api.delivery.bind(f.api);
  f.api.delivery = async (...args) => {
    receipts.push(args[2]);
    return delivery(...args);
  };
  await record(f);
  await Bun.sleep(300);
  await f.controller.cancel();
  expect(f.controller.activity.undoUntil).toBeGreaterThan(Date.now());
  // The same cancel arriving twice must not close the window it just opened.
  await f.controller.cancel();
  expect(f.controller.activity.undoUntil).toBeDefined();
  expect(f.controller.start()).toBe(true);
  expect(f.controller.activity.undoUntil).toBeUndefined();
  await f.controller.settled();
  expect(f.deliveries()).toBe(1);
  expect(receipts).toEqual(["inserted"]);
  expect((await f.record(ids.started[0]!)).status).toBe("completed");

  await record(f);
  await Bun.sleep(300);
  await f.controller.cancel();
  await Bun.sleep(350);
  await f.controller.cancel();
  await f.controller.settled();
  expect(f.deliveries()).toBe(1);
  expect(receipts).toEqual(["inserted", "cancelled"]);
  expect(f.controller.activity.kept).toBe(true);
  expect((await f.record(ids.started[1]!)).delivery?.status).toBe("cancelled");
});

test("toggle inserts a cancelled take that is still sealing", async () => {
  const f = await fixture();
  const stop = f.api.stop.bind(f.api);
  let release = () => {};
  const sealing = new Promise<void>((resolve) => (release = resolve));
  f.api.stop = async (...args) => {
    await sealing;
    return stop(...args);
  };
  try {
    await record(f);
    await Bun.sleep(300);
    await f.controller.cancel();
    f.controller.toggle();
    expect(f.controller.activity.undoUntil).toBeUndefined();
    release();
    await f.controller.settled();
    expect(f.deliveries()).toBe(1);
  } finally {
    release();
  }
});

test("a stopped take cancelled while sealing is kept in history", async () => {
  const f = await fixture();
  const ids = track(f);
  const stop = f.api.stop.bind(f.api);
  let release = () => {};
  const sealing = new Promise<void>((resolve) => (release = resolve));
  f.api.stop = async (...args) => {
    await sealing;
    return stop(...args);
  };
  try {
    await record(f);
    await Bun.sleep(300);
    f.controller.stop();
    await Bun.sleep(100);
    await f.controller.cancel();
    expect(f.controller.activity.undoUntil).toBeGreaterThan(Date.now());
    await Bun.sleep(350);
    await f.controller.cancel();
    release();
    await f.controller.settled();
    expect(f.deliveries()).toBe(0);
    expect((await f.api.recording(ids.started[0]!)).result?.delivery?.status).toBe("cancelled");
  } finally {
    release();
  }
});

test("a short cancelled recording is discarded without an undo window", async () => {
  const f = await fixture();
  const ids = track(f);
  await record(f);
  await f.controller.cancel();
  expect(f.controller.activity.undoUntil).toBeUndefined();
  await f.controller.settled();
  expect(f.deliveries()).toBe(0);
  expect((await f.record(ids.started[0]!)).status).toBe("cancelled");
});

test("a repeated cancel during slow cleanup keeps the earlier processing take", async () => {
  const held = heldInference();
  const f = await fixture(held.inference);
  const ids = track(f);
  const cancel = f.api.cancel.bind(f.api);
  let release!: () => void;
  const cleanupGate = new Promise<void>((resolve) => (release = resolve));
  f.api.cancel = async (...args) => {
    await cleanupGate;
    return cancel(...args);
  };
  try {
    await record(f);
    f.controller.stop();
    await record(f);
    const first = f.controller.cancel();
    const repeated = f.controller.cancel();
    release();
    await Promise.all([first, repeated]);
    expect(f.controller.activity.phase).toBe("processing");
    held.release();
    await f.controller.settled();
    expect(ids.delivered).toEqual([ids.started[0]!]);
  } finally {
    held.release();
    release();
  }
});

test("cancelling the newest take keeps an earlier take's result", async () => {
  const held = heldInference(1);
  const f = await fixture(held.inference);
  const ids = track(f);
  f.delivery("preview");
  try {
    await record(f);
    f.controller.stop();
    await record(f);
    f.controller.stop();
    await until(() => f.controller.result !== undefined);
    await f.controller.cancel();
    expect(f.controller.result?.id).toBe(ids.started[0]);
  } finally {
    held.release();
  }
  await f.controller.settled();
  // The cancelled take is kept in history with a cancelled receipt, never inserted.
  expect(f.deliveries()).toBe(1);
  expect(ids.delivered).toEqual([ids.started[0]!, ids.started[1]!]);
  expect((await f.api.recording(ids.started[1]!)).result?.delivery?.status).toBe("cancelled");
});

test("a cancel after a newer take starts targets that take, not an earlier cleanup", async () => {
  const held = heldInference();
  const f = await fixture(held.inference);
  const ids = track(f);
  const cancel = f.api.cancel.bind(f.api);
  let release!: () => void;
  const cleanupGate = new Promise<void>((resolve) => (release = resolve));
  f.api.cancel = async (...args) => {
    await cancel(...args);
    await cleanupGate;
  };
  try {
    await record(f);
    const first = f.controller.cancel();
    await record(f);
    f.controller.stop();
    await until(
      async () => (await f.api.recording(ids.started[1]!)).snapshot.capture?.state === "sealed",
    );
    await f.controller.cancel();
    held.release();
    release();
    await first;
    await f.controller.settled();
    expect(f.deliveries()).toBe(0);
  } finally {
    held.release();
    release();
  }
});

test("a foreground capture or admission failure restores the earlier take's activity and feedback", async () => {
  for (const failure of ["capture", "admission"]) {
    const held = heldInference();
    const f = await fixture(held.inference);
    await record(f);
    const feedback = f.controller.feedback;
    const activity = f.controller.activity;
    f.controller.stop();
    await until(() => f.controller.activity.phase === "processing");
    // A second activation is admitted once the first take has been sealed.
    if (failure === "capture")
      f.desktop.capture = async () => {
        throw new Error("Destination unavailable");
      };
    else
      f.api.start = async () => {
        throw new Error("Admission unavailable");
      };
    try {
      await until(() => f.controller.start());
      await until(() => f.notices.some((notice) => notice.startsWith("Capture failed")));
      await until(() => f.controller.state === "processing");
      expect(f.controller.busy).toBe(true);
      expect(f.controller.activity).toEqual({ ...activity, phase: "processing" });
      expect(f.controller.feedback).toBe(feedback);
    } finally {
      held.release();
    }
    await f.controller.settled();
    expect(f.deliveries()).toBe(1);
  }
});

test("an earlier preview notifies about recovery while the newer take owns the overlay", async () => {
  const held = heldInference();
  const f = await fixture(held.inference);
  const ids = track(f);
  f.delivery("preview");
  await record(f);
  f.controller.stop();
  await record(f);
  f.controller.stop();
  await until(
    async () => (await f.api.recording(ids.started[1]!)).snapshot.capture?.state === "sealed",
  );
  held.release();
  await f.controller.settled();
  expect(f.notices).toContain(
    "Earlier dictation: Text ready. Use sottoduo result or sottoduo copy.",
  );
  expect(ids.delivered).toEqual(ids.started);
});

test("a completed take awaiting its receipt does not retake the overlay", async () => {
  const f = await fixture();
  const modes = ["preview", "inserted"] as const;
  let captures = 0;
  f.desktop.capture = async () => {
    const mode = modes[captures++]!;
    return { close() {}, deliver: async () => mode };
  };
  let release!: () => void;
  const receipt = new Promise<void>((resolve) => (release = resolve));
  const delivery = f.api.delivery.bind(f.api);
  let receipts = 0;
  f.api.delivery = async (...args) => {
    if (receipts++ === 0) await receipt;
    return delivery(...args);
  };
  let completed = 0;
  f.controller.onComplete = () => completed++;
  await record(f);
  f.controller.stop();
  await until(() => receipts === 1);
  await record(f);
  f.controller.stop();
  await until(() => completed === 1);
  expect(f.controller.state).toBe("Text inserted");
  expect(f.controller.result?.delivery).toBe("inserted");
  release();
  await f.controller.settled();
  expect(f.controller.state).toBe("Text inserted");
});
