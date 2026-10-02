import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GenerationService } from "../../../Server/src/generation-service.ts";
import { createHTTPServer } from "../../../Server/src/http-server.ts";
import type { CaptureProvider } from "../../../Server/src/capture-sessions.ts";
import { FakeInference } from "../../../Server/tests/support.ts";
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
  const provider: CaptureProvider = {
    sources,
    async start(options) {
      starts.push(options.generation.capture!.source.id);
      level = options.level;
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
  const service = await GenerationService.open(
    { dataDirectory: directory, development: true, captureProvider: provider },
    inference,
  );
  let recognitionHeader: string | undefined;
  let feedbackHeader: string | undefined;
  const app = createHTTPServer(service, "fixture-token", (server) => {
    server.addHook("onRequest", async (request) => {
      if (request.url.endsWith("/events")) {
        const value = request.headers["x-sottoduo-recognition"];
        recognitionHeader = typeof value === "string" ? value : undefined;
        const feedback = request.headers["x-sottoduo-feedback"];
        feedbackHeader = typeof feedback === "string" ? feedback : undefined;
      }
    });
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    await service.shutdown();
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
    recognitionHeader: () => recognitionHeader,
    feedbackHeader: () => feedbackHeader,
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
  f.level(0.65);
  await until(() => f.controller.feedback.snapshot().levels.includes(0.65));
  expect(f.recognitionHeader()).toBe("streaming-v1");
  expect(f.feedbackHeader()).toBe("compact-v1");
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
    const record = await f.api.get(id);
    const publish = () =>
      update({ ...record, recognition: { provider: "soniox", partialText: "Not final" } });
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
  const record = await f.api.get(f.controller.result!.id);
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
    get = f.api.get.bind(f.api),
    cancel = f.api.cancel.bind(f.api);
  let sealedID: string | undefined,
    cancellations = 0;
  f.api.stop = async (...args) => {
    const record = await stop(...args);
    sealedID = record.id;
    return { ...record, status: "transcribing" };
  };
  f.api.get = async () => {
    throw new Error("Polling connection lost");
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

test("an ambiguous stop response cannot cancel a sealed take", async () => {
  const f = await fixture();
  const stop = f.api.stop.bind(f.api);
  const get = f.api.get.bind(f.api);
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
  expect((await f.api.get(f.controller.result!.id)).delivery?.status).toBe("none");
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
  expect((await f.api.get(f.controller.result!.id)).mode).toBe("test");
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
  await until(async () => (await f.api.get(ids.started[0]!)).status === "completed");
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
    await until(async () => (await f.api.get(ids.started[1]!)).capture?.state === "sealed");
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
    get = f.api.get.bind(f.api);
  f.api.stop = async (...args) => ({ ...(await stop(...args)), status: "queued" });
  let polls = 0;
  f.controller.processingTimeoutMS = 200;
  f.api.get = async (...args) => {
    const result = await get(...args);
    // Stay queued for longer than the processing deadline.
    if (++polls <= 3) return { ...result, status: "queued" };
    return result;
  };
  await record(f);
  f.controller.stop();
  await f.controller.settled();
  expect(polls).toBe(4);
  expect(f.deliveries()).toBe(1);
  expect(f.controller.result?.delivery).toBe("inserted");
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
      await until(async () => (await f.api.get(ids.started[0]!)).status === "completed");
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
  expect((await f.api.get(ids.started[1]!)).status).toBe("cancelled");
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
  expect(ids.delivered).toEqual([ids.started[0]!]);
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
    await until(async () => (await f.api.get(ids.started[1]!)).capture?.state === "sealed");
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
  await until(async () => (await f.api.get(ids.started[1]!)).capture?.state === "sealed");
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
