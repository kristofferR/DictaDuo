import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ButtonDestinations } from "../src/button-destinations.ts";
import type { GenerationService } from "../src/generation-service.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const brokers: ButtonDestinations[] = [];
afterEach(() => brokers.splice(0).forEach((b) => b.shutdown()));
function fixture(targetFile?: string) {
  let now = Date.now();
  let connected = true;
  const source = { hostID: "desktop", id: "dji" };
  const service: Pick<GenerationService, "captures" | "resolveResult"> = {
    captures: {
      sources: () => ({
        sources: [
          {
            identity: source,
            name: "DJI",
            transport: "usb",
            present: true,
            capture: "available",
            link: connected ? "connected" : "disconnected",
            audioHealth: "unknown",
            observedAt: new Date(now).toISOString(),
          },
        ],
      }),
    } as GenerationService["captures"],
    resolveResult: async () => {
      throw new Error("No completed generation");
    },
  };
  const broker = new ButtonDestinations(service, () => now, targetFile);
  brokers.push(broker);
  const a = randomUUID().toUpperCase(),
    b = randomUUID().toUpperCase(),
    owner = "a".repeat(64);
  broker.input(source, "epoch");
  broker.register({ id: a, device: { id: "mac", name: "Mac" } }, owner);
  broker.register({ id: b, device: { id: "linux", name: "Linux" } }, owner);
  return {
    broker,
    a,
    b,
    owner,
    source,
    advance: (ms: number) => {
      now += ms;
    },
    disconnect: () => {
      connected = false;
    },
  };
}
test("only explicit selection routes taps; duplicates and rapid double-taps do not change the take", async () => {
  const f = fixture();
  f.broker.press("epoch", 1);
  expect(f.broker.state(f.a).command).toBeUndefined();
  await f.broker.select(f.b, {}, f.owner);
  f.advance(501);
  f.broker.press("epoch", 2);
  const command = f.broker.state(f.b).command!;
  expect(command.action).toBe("start");
  expect(f.broker.state(f.a).command).toBeUndefined();
  const claim = f.broker.claim(
    {
      requestID: randomUUID(),
      device: { id: "linux", name: "Linux" },
      mode: "dictation",
      source: f.source,
      buttonTicket: command.takeID,
    },
    f.owner,
  );
  claim.ready();
  f.broker.press("epoch", 2);
  f.broker.press("epoch", 3);
  expect(f.broker.state(f.b).command?.id).toBe(command.id);
  await expect(f.broker.select(f.a, {}, f.owner)).rejects.toThrow();
  f.advance(501);
  f.broker.press("epoch", 4);
  expect(f.broker.state(f.b).command?.action).toBe("stop");
  f.broker.complete(f.b, command.takeID, f.owner);
  expect(claim.signal.aborted).toBe(true);
  expect(f.broker.state().selected?.id).toBe(f.b);
});
test("another owner cannot replace a live destination with the same device ID", async () => {
  const f = fixture();
  await f.broker.select(f.a, {}, f.owner);
  f.broker.press("epoch", 1);
  const ticket = f.broker.state(f.a).command!.takeID;
  const claim = f.broker.claim(
    {
      requestID: randomUUID(),
      device: { id: "mac", name: "Mac" },
      mode: "dictation",
      source: f.source,
      buttonTicket: ticket,
    },
    f.owner,
  );
  claim.ready();
  expect(() =>
    f.broker.register({ id: randomUUID(), device: { id: "mac", name: "Mac" } }, "b".repeat(64)),
  ).toThrow();
  expect(claim.signal.aborted).toBe(false);
  expect(f.broker.state().selected?.id).toBe(f.a);
});
test("lease expiry and input restarts discard selection and revoke pending tickets", async () => {
  const f = fixture();
  await f.broker.select(f.a, {}, f.owner);
  f.broker.press("epoch", 1);
  const command = f.broker.state(f.a).command!;
  f.advance(5001);
  expect(f.broker.state().selected).toBeUndefined();
  expect(() => f.broker.heartbeat(f.a, {}, f.owner)).toThrow();
  expect(() =>
    f.broker.claim(
      {
        requestID: randomUUID(),
        device: { id: "mac", name: "Mac" },
        mode: "dictation",
        source: f.source,
        buttonTicket: command.takeID,
      },
      f.owner,
    ),
  ).toThrow();
  f.broker.register({ id: f.a, device: { id: "mac", name: "Mac" } }, f.owner);
  await f.broker.select(f.a, {}, f.owner);
  f.broker.input(f.source, "new-epoch");
  expect(f.broker.state().selected).toBeUndefined();
  await f.broker.select(f.a, {}, f.owner);
  f.disconnect();
  expect(f.broker.state().selected).toBeUndefined();
  expect(f.broker.state().available).toBe(false);
});
test("a second tap during preparation cancels instead of opening a delayed recording", async () => {
  const f = fixture();
  await f.broker.select(f.a, {}, f.owner);
  f.broker.press("epoch", 1);
  const command = f.broker.state(f.a).command!;
  const claim = f.broker.claim(
    {
      requestID: randomUUID(),
      device: { id: "mac", name: "Mac" },
      mode: "dictation",
      source: f.source,
      buttonTicket: command.takeID,
    },
    f.owner,
  );
  f.advance(501);
  f.broker.press("epoch", 2);
  expect(claim.signal.aborted).toBe(true);
  expect(f.broker.state(f.a).command?.action).toBe("cancel");
  expect(f.broker.state().selected).toBeUndefined();
});

test("a pinned computer stays selected, dictating elsewhere does not move it, and it survives restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dictaduo-button-target-"));
  try {
    const file = join(directory, "button-target.json");
    const f = fixture(file);
    expect(f.broker.state().buttonTarget).toEqual({ mode: "lastDictated" });
    await f.broker.setTarget({ mode: "device", device: { id: "linux", name: "Linux" } });
    expect(f.broker.state().selected?.id).toBe(f.b);
    // A shortcut take on the Mac would select it in lastDictated mode.
    await f.broker.select(f.a, {}, f.owner);
    expect(f.broker.state().selected?.id).toBe(f.b);
    f.broker.press("epoch", 1);
    expect(f.broker.state(f.b).command?.action).toBe("start");

    // The same target applies after a restart, once the pinned computer registers again.
    const restarted = fixture(file);
    expect(restarted.broker.state().buttonTarget).toEqual({
      mode: "device",
      device: { id: "linux", name: "Linux" },
    });
    expect(restarted.broker.state().selected?.id).toBe(restarted.b);

    await restarted.broker.setTarget({ mode: "off" });
    expect(restarted.broker.state().selected).toBeUndefined();
    await restarted.broker.select(restarted.a, {}, restarted.owner);
    restarted.advance(501);
    restarted.broker.press("epoch", 1);
    expect(restarted.broker.state(restarted.a).command).toBeUndefined();
    expect(restarted.broker.state(restarted.b).command).toBeUndefined();
    await expect(restarted.broker.setTarget({ mode: "device" })).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a target change lets the current button take finish and never inherits a pinned selection", async () => {
  const f = fixture();
  await f.broker.setTarget({ mode: "device", device: { id: "linux", name: "Linux" } });
  f.broker.press("epoch", 1);
  const command = f.broker.state(f.b).command!;
  expect(command.action).toBe("start");
  await f.broker.setTarget({ mode: "off" });
  // The take started on Linux keeps recording there.
  expect(f.broker.state(f.b).command?.id).toBe(command.id);
  f.broker.complete(f.b, command.takeID, f.owner);
  expect(f.broker.state().selected).toBeUndefined();
  await f.broker.setTarget({ mode: "device", device: { id: "linux", name: "Linux" } });
  expect(f.broker.state().selected?.id).toBe(f.b);
  // Back to "last computer I dictated on": nothing is selected until a shortcut take.
  await f.broker.setTarget({ mode: "lastDictated" });
  expect(f.broker.state().selected).toBeUndefined();
  // Also when the switch happens during a take: the take finishes, then nothing is selected.
  await f.broker.setTarget({ mode: "device", device: { id: "linux", name: "Linux" } });
  f.advance(501);
  f.broker.press("epoch", 2);
  const take = f.broker.state(f.b).command!;
  await f.broker.setTarget({ mode: "lastDictated" });
  expect(f.broker.state().selected?.id).toBe(f.b);
  f.broker.complete(f.b, take.takeID, f.owner);
  expect(f.broker.state().selected).toBeUndefined();
});
test("a target that cannot be saved is reported and not applied", async () => {
  const f = fixture("/nonexistent-dictaduo-directory/button-target.json");
  await expect(f.broker.setTarget({ mode: "off" })).rejects.toThrow();
  expect(f.broker.state().buttonTarget).toEqual({ mode: "lastDictated" });
});
