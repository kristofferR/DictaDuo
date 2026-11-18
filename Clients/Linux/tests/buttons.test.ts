import { afterEach, expect, test } from "bun:test";
import { ButtonDestinationClient } from "../src/buttons.ts";
import { Controller } from "../src/controller.ts";
import type { API } from "../src/api.ts";
import type { components } from "../../../Server/src/generated/api.ts";
type State = components["schemas"]["ButtonDestinationState"];
function fixture() {
  let unlocked = true,
    compositorLocked = false,
    checks = 0,
    offline = false,
    blocked: string | undefined;
  const requests: string[] = [];
  const starts: string[] = [];
  let state: State = { available: true, destinations: [] };
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api: Pick<API, "buttonRequest" | "buttonStatus"> = {
    buttonStatus: async () => {
      if (offline) throw Error("offline");
      return structuredClone(state);
    },
    buttonRequest: async (path, _owner, _body, method) => {
      requests.push(`${method ?? "POST"} ${path}`);
      if (blocked !== undefined && (blocked === "" ? path === "" : path.endsWith(blocked)))
        await gate;
      return structuredClone(state);
    },
  };
  const desktop = {
    unlocked: async () => {
      checks++;
      return unlocked;
    },
    locked: async () => compositorLocked,
    capture: async () => {
      throw Error("not used");
    },
    defaultInput: async () => undefined,
    notify() {},
  };
  const unused = async (): Promise<never> => {
    throw Error("not used");
  };
  const controller = new Controller(
    {
      sources: unused,
      start: unused,
      stop: unused,
      cancel: unused,
      recording: unused,
      context: unused,
      delivery: unused,
      heartbeat: unused,
    },
    desktop,
    { id: "client", name: "Linux" },
    { hostID: "desktop", mode: "automatic", priority: [] },
  );
  controller.startButton = (ticket) => {
    starts.push(ticket);
    return true;
  };
  const buttons = new ButtonDestinationClient(api, desktop, controller, {
    id: "client",
    name: "Linux",
  });
  return {
    buttons,
    controller,
    requests,
    starts,
    /** How often the full lock check ran. */
    checks: () => checks,
    offline: (down = true) => {
      offline = down;
    },
    /** A lock the compositor has not taken yet is seen by the full check alone. */
    lock: (compositor = true) => {
      unlocked = false;
      compositorLocked = compositor;
    },
    unlock: () => {
      unlocked = true;
      compositorLocked = false;
    },
    block: (path = "") => {
      blocked = path;
    },
    release: () => release!(),
    set: (next: State) => {
      state = next;
    },
  };
}
const pending: ButtonDestinationClient[] = [];
afterEach(async () => {
  for (const buttons of pending.splice(0)) await buttons.close();
});
test("disabling retires a late registration; enabling again does not select a destination", async () => {
  const f = fixture();
  pending.push(f.buttons);
  f.block();
  const tick = f.buttons.tick();
  await Bun.sleep(0);
  await f.buttons.setEnabled(false);
  f.release();
  await tick;
  expect(f.buttons.state).toBeUndefined();
  expect(f.requests.at(-1)?.startsWith("DELETE")).toBe(true);
  const count = f.requests.length;
  await f.buttons.tick();
  expect(f.requests).toHaveLength(count);
  await expect(f.buttons.select()).rejects.toThrow("not connected");
  await f.buttons.setEnabled(true);
  await f.buttons.tick();
  expect(f.requests.filter((r) => r === "POST ")).toHaveLength(2);
  expect(f.requests.some((r) => r.endsWith("/select"))).toBe(false);
});
test("disabling ignores an in-flight start command and busy dictation rejects settings changes", async () => {
  const f = fixture();
  pending.push(f.buttons);
  await f.buttons.tick();
  f.block("/heartbeat");
  f.set({
    available: true,
    destinations: [],
    command: {
      id: crypto.randomUUID(),
      takeID: crypto.randomUUID(),
      action: "start",
      source: { hostID: "desktop", id: "dji" },
      expiresAt: new Date(Date.now() + 5000).toISOString(),
    },
  });
  const tick = f.buttons.tick();
  await Bun.sleep(0);
  await f.buttons.setEnabled(false);
  f.release();
  await tick;
  expect(f.starts).toHaveLength(0);
  expect(f.buttons.state).toBeUndefined();
  Object.defineProperty(f.controller, "busy", { get: () => true });
  await expect(f.buttons.setEnabled(true)).rejects.toThrow("Finish dictation");
  expect(f.buttons.enabled).toBe(false);
});
test("lock discards registration; reconnect registers without selecting and duplicate commands run once", async () => {
  const f = fixture();
  pending.push(f.buttons);
  await f.buttons.tick();
  expect(f.requests.some((r) => r.endsWith("/select"))).toBe(false);
  f.set({
    available: true,
    destinations: [],
    command: {
      id: crypto.randomUUID(),
      takeID: crypto.randomUUID(),
      action: "start",
      source: { hostID: "desktop", id: "dji" },
      expiresAt: new Date(Date.now() + 5000).toISOString(),
    },
  });
  await f.buttons.tick();
  await f.buttons.tick();
  expect(f.starts).toHaveLength(1);
  f.lock();
  const checks = f.checks();
  await f.buttons.tick();
  await f.buttons.tick();
  expect(f.requests.at(-1)?.startsWith("DELETE")).toBe(true);
  // The compositor's lock is answer enough: a locked computer spawns nothing either.
  expect(f.checks()).toBe(checks);
  f.set({ available: true, destinations: [] });
  f.unlock();
  await f.buttons.tick();
  expect(f.requests.filter((r) => r === "POST ")).toHaveLength(2);
  expect(f.requests.some((r) => r.endsWith("/select"))).toBe(false);
});
test("the full lock check runs to register and to start a take, never on an idle tick", async () => {
  const f = fixture();
  pending.push(f.buttons);
  // An unreachable server is not worth a lock check: an outage must stay cheap too.
  f.offline();
  await expect(f.buttons.tick()).rejects.toThrow("offline");
  expect(f.checks()).toBe(0);
  f.offline(false);
  await f.buttons.tick();
  await f.buttons.tick();
  await f.buttons.tick();
  expect(f.requests.filter((r) => r.endsWith("/heartbeat"))).toHaveLength(3);
  expect(f.checks()).toBe(1);
  f.lock(false);
  f.set({
    available: true,
    destinations: [],
    command: {
      id: crypto.randomUUID(),
      takeID: crypto.randomUUID(),
      action: "start",
      source: { hostID: "desktop", id: "dji" },
      expiresAt: new Date(Date.now() + 5000).toISOString(),
    },
  });
  await f.buttons.tick();
  expect(f.checks()).toBe(2);
  expect(f.starts).toHaveLength(0);
  expect(f.requests.at(-1)?.startsWith("DELETE")).toBe(true);
  // Unregistered, every tick asks again and nothing is offered until it passes.
  await f.buttons.tick();
  expect(f.checks()).toBe(3);
  expect(f.requests.filter((r) => r === "POST ")).toHaveLength(1);
});
test("disarm wins a race with registration and retires the late server lease", async () => {
  const f = fixture();
  pending.push(f.buttons);
  f.block();
  const tick = f.buttons.tick();
  await Bun.sleep(0);
  await f.buttons.disarm();
  f.release();
  await tick;
  expect(f.buttons.state).toBeUndefined();
  expect(f.requests.at(-1)?.startsWith("DELETE")).toBe(true);
  expect(f.starts).toHaveLength(0);
});
