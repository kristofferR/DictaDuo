import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHTTPServer } from "../../../Server/src/http-server.ts";
import { FakeInference, openCaptureServices } from "../../../Server/tests/support.ts";
import { API } from "../src/api.ts";
import { ConnectionSettings } from "../src/connection.ts";
import { parseConfig } from "../src/config.ts";
import { ClientRuntime } from "../src/runtime.ts";
import { monotonicMS } from "../src/double-tap.ts";
import type { Desktop } from "../src/controller.ts";
import type { Source } from "../src/sources.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "sottoduo-connection-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  let starts = 0;
  let reportedHost = "desktop";
  const services = await openCaptureServices(
    join(dir, "server"),
    {
      sources: (): Source[] => [
        {
          identity: { hostID: reportedHost, id: "mic" },
          name: "Mic",
          transport: "usb",
          present: true,
          link: "connected",
          capture: "available",
          audioHealth: "unknown",
          observedAt: new Date().toISOString(),
        },
      ],
      start: async () => {
        starts++;
        return { stop: async () => ({ inferenceFrames: 0 }) };
      },
    },
    new FakeInference(),
  );
  const service = services.service;
  const http = createHTTPServer(service, "fixture-secret", undefined, services.recordings);
  const server = await http.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    await services.close();
    await http.close();
  });
  const file = join(dir, "client", "config.json");
  let unlocked = true;
  const desktop: Desktop = {
    unlocked: async () => unlocked,
    capture: async () => ({ close() {}, deliver: async () => "preview" }),
    defaultInput: async () => undefined,
    notify() {},
  };
  return {
    dir,
    file,
    server,
    desktop,
    lock: () => {
      unlocked = false;
    },
    unlock: () => {
      unlocked = true;
    },
    starts: () => starts,
    reportHost: (host: string) => {
      reportedHost = host;
    },
  };
}
async function until(predicate: () => Promise<boolean>) {
  for (let n = 0; n < 200; n++) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out");
}

test("first setup tests without recording, saves private credentials and starts a usable runtime", async () => {
  const f = await fixture();
  const settings = await ConnectionSettings.open("/sottoduo-destination", f.file);
  const runtime = new ClientRuntime(settings, f.desktop);
  cleanup.push(() => runtime.close());
  runtime.start();
  expect(await runtime.gui({ version: 1, action: "snapshot" })).toMatchObject({
    setupRequired: true,
  });
  expect(await runtime.command("start")).toContain("Set up");
  const proposal = { server: f.server, name: "Linux desktop", accessToken: "fixture-secret" };
  const checked = await settings.test(proposal);
  expect(checked.hosts).toEqual(["desktop"]);
  expect(f.starts()).toBe(0);
  expect(await Bun.file(f.file).exists()).toBe(false);
  expect(JSON.stringify(checked)).not.toContain("fixture-secret");
  await runtime.gui({
    version: 1,
    action: "saveConnection",
    ticket: checked.ticket,
    hostID: checked.hostID,
  });
  const config = parseConfig(await Bun.file(f.file).json());
  expect(config.device.name).toBe("Linux desktop");
  expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  expect((await stat(config.tokenFile)).mode & 0o777).toBe(0o600);
  expect(await readFile(config.tokenFile, "utf8")).toBe("fixture-secret\n");
  const snapshot = await runtime.gui({ version: 1, action: "snapshot" });
  expect(snapshot).toMatchObject({
    setupRequired: false,
    connectionRevision: 1,
    buttonEnabled: false,
  });
  expect(JSON.stringify(snapshot)).not.toContain("fixture-secret");
  expect(JSON.stringify(snapshot)).not.toContain("tokenFile");
  expect(f.starts()).toBe(0);
  const sourcePreferences = { ...config.sources, priority: [{ hostID: "desktop", id: "mic" }] };
  await runtime.gui({ version: 1, action: "saveSources", value: sourcePreferences });
  expect(settings.config?.sources).toEqual(sourcePreferences);
  const second = await settings.test({ ...proposal, accessToken: "" });
  await runtime.gui({ version: 1, action: "test" });
  await until(async () => f.starts() === 1);
  await expect(
    runtime.gui({ version: 1, action: "saveConnection", ticket: second.ticket, hostID: "desktop" }),
  ).rejects.toThrow("Finish dictation");
  await runtime.gui({ version: 1, action: "cancel" });
  await until(
    async () =>
      !((await runtime.gui({ version: 1, action: "snapshot" })) as { busy: boolean }).busy,
  );
  f.lock();
  await expect(
    runtime.gui({ version: 1, action: "saveConnection", ticket: second.ticket, hostID: "desktop" }),
  ).rejects.toThrow("Unlock");
  f.unlock();
  await runtime.gui({
    version: 1,
    action: "saveConnection",
    ticket: second.ticket,
    hostID: "desktop",
  });
  expect(settings.config?.device.id).toBe(config.device.id);
  expect(settings.config?.sources).toEqual(sourcePreferences);
});

test("runtime serializes a delayed press, key release, and GUI shutdown release while locked", async () => {
  const f = await fixture();
  const settings = await ConnectionSettings.open("/sottoduo-destination", f.file);
  const checked = await settings.test({
    server: f.server,
    name: "Desktop",
    accessToken: "fixture-secret",
  });
  settings.commit(checked.ticket, checked.hostID);
  let allowPress: (() => void) | undefined;
  const pressCheck = new Promise<void>((resolve) => {
    allowPress = resolve;
  });
  let checks = 0;
  f.desktop.unlocked = async () => {
    if (++checks === 1) {
      await pressCheck;
      return true;
    }
    return checks === 2;
  };
  const runtime = new ClientRuntime(settings, f.desktop);
  cleanup.push(() => runtime.close());
  runtime.start();
  const actions: string[] = [];
  const controller = runtime["current"]!.controller;
  controller.start = () => {
    actions.push("start");
    return true;
  };
  controller.stop = () => {
    actions.push("stop");
  };
  const press = runtime.gui({ version: 1, action: "start" });
  const release = runtime.gui({ version: 1, action: "stop" });
  const shutdownRelease = runtime.gui({ version: 1, action: "releasePortalShortcut" });
  await Bun.sleep(0);
  expect(checks).toBe(1);
  expect(actions).toEqual([]);
  allowPress?.();
  await Promise.all([press, release, shutdownRelease]);
  expect(checks).toBe(2);
  expect(actions).toEqual(["start", "stop", "stop"]);
});

test("double-tap mode toggles on a double tap from either shortcut source, never on the test's Stop", async () => {
  const f = await fixture();
  const settings = await ConnectionSettings.open("/sottoduo-destination", f.file);
  const checked = await settings.test({
    server: f.server,
    name: "Desktop",
    accessToken: "fixture-secret",
  });
  settings.commit(checked.ticket, checked.hostID);
  const runtime = new ClientRuntime(settings, f.desktop);
  cleanup.push(() => runtime.close());
  runtime.start();
  const actions: string[] = [];
  const controller = runtime["current"]!.controller;
  controller.start = () => (actions.push("start"), true);
  controller.stop = () => void actions.push("stop");
  controller.toggle = () => void actions.push("toggle");
  await runtime.gui({ version: 1, action: "saveActivationMode", mode: "doubleTap" });
  expect(parseConfig(await Bun.file(f.file).json()).activationMode).toBe("doubleTap");
  // Hyprland binds, then Plasma portal edges.
  for (const edge of ["start", "stop", "start", "stop"] as const) await runtime.command(edge);
  for (const action of ["start", "stop", "start", "stop"])
    await runtime.gui({ version: 1, action, shortcut: true });
  expect(actions).toEqual(["toggle", "toggle"]);
  // A tap during a take does not pair with one after it ends.
  let busy = true;
  Object.defineProperty(controller, "busy", { get: () => busy });
  controller.activity = { phase: "processing", startedAt: 1 };
  await runtime.command("start");
  await runtime.command("stop");
  busy = false;
  await runtime.command("start");
  await runtime.command("stop");
  expect(actions).toEqual(["toggle", "toggle"]);
  // A slow lock check delays processing, but each portal edge keeps the time it fired.
  const unlocked = f.desktop.unlocked;
  f.desktop.unlocked = async (...args) => (await Bun.sleep(600), unlocked(...args));
  const base = monotonicMS();
  for (const [action, offset] of [
    ["start", 0],
    ["stop", 80],
    ["start", 200],
    ["stop", 280],
  ] as const)
    await runtime.gui({ version: 1, action, shortcut: true, at: base + offset });
  f.desktop.unlocked = unlocked;
  expect(actions).toEqual(["toggle", "toggle", "toggle"]);
  actions.pop();
  // The microphone test's Stop button still stops.
  await runtime.gui({ version: 1, action: "stop" });
  expect(actions).toEqual(["toggle", "toggle", "stop"]);
  await runtime.gui({ version: 1, action: "saveActivationMode", mode: "hold" });
  await runtime.command("start");
  await runtime.command("stop");
  expect(actions.slice(3)).toEqual(["start", "stop"]);
});

test("failed authentication and edited or expired proposals preserve config; new origins require a new token", async () => {
  const f = await fixture();
  const settings = await ConnectionSettings.open("/sottoduo-destination", f.file);
  const proposed = { server: f.server, name: "Desktop", accessToken: "fixture-secret" };
  const tested = await settings.test(proposed);
  settings.commit(tested.ticket, "desktop");
  const before = await readFile(f.file, "utf8");
  const files = await readdir(join(f.dir, "client"));
  await expect(
    settings.test({ ...proposed, accessToken: "invalid-sensitive-token" }),
  ).rejects.toThrow("rejected this access token");
  expect(() => settings.commit(tested.ticket, "desktop")).toThrow("Test this connection");
  await expect(
    settings.test({ ...proposed, server: "http://127.0.0.1:1", accessToken: "" }),
  ).rejects.toThrow("never sent");
  await expect(settings.test({ ...proposed, server: "http://127.0.0.1:1" })).rejects.toThrow(
    "Could not verify",
  );
  await expect(
    settings.test({ ...proposed, server: "http://user:secret@example.com" }),
  ).rejects.toThrow("without a path or login");
  const checked = await settings.test({ ...proposed, accessToken: "" });
  expect(() => settings.commit(checked.ticket, "unknown")).toThrow("Choose the computer");
  const now = Date.now;
  Date.now = () => now() + 121_000;
  try {
    expect(() => settings.commit(checked.ticket, "desktop")).toThrow("Test this connection");
  } finally {
    Date.now = now;
  }
  expect(await readFile(f.file, "utf8")).toBe(before);
  expect(await readdir(join(f.dir, "client"))).toEqual(files);
  const fresh = await settings.test({ ...proposed, accessToken: "" });
  await writeFile(f.file, before + "\n");
  expect(() => settings.commit(fresh.ticket, "desktop")).toThrow("outside SottoDuo");
});

test("switching servers resets scoped inputs and never replaces a shared token", async () => {
  const f = await fixture();
  const second = await fixture();
  const sharedToken = join(f.dir, "server-token");
  await writeFile(sharedToken, "fixture-secret\n", { mode: 0o600 });
  const config = parseConfig({
    server: f.server,
    tokenFile: sharedToken,
    destinationHelper: "/sottoduo-destination",
    device: { id: "stable", name: "Old name" },
    sources: {
      server: f.server,
      hostID: "desktop",
      mode: "fixed",
      priority: [{ hostID: "desktop", id: "dji" }],
      fixed: { hostID: "desktop", id: "dji" },
      profiles: [{ id: "desk", name: "Desk", priority: [{ hostID: "desktop", id: "dji" }] }],
      activeProfileID: "desk",
      knownInputs: [{ identity: { hostID: "desktop", id: "dji" }, name: "DJI Mic Mini" }],
    },
  });
  const file = join(f.dir, "config.json");
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const settings = await ConnectionSettings.open("/sottoduo-destination", file);
  f.reportHost("temporary");
  const same = await settings.test({ server: f.server, name: "Renamed", accessToken: "" });
  expect(same.hosts).toEqual(["desktop", "temporary"]);
  expect(same.hostID).toBe("desktop");
  settings.commit(same.ticket, "desktop");
  expect(settings.config?.sources).toEqual(config.sources);
  const next = await settings.test({
    server: second.server,
    name: "Renamed",
    accessToken: "fixture-secret",
  });
  settings.commit(next.ticket, "desktop");
  expect(settings.config?.sources).toEqual({
    server: second.server,
    hostID: "desktop",
    mode: "automatic",
    priority: [],
    fixed: undefined,
  });
  expect(settings.config?.device.id).toBe("stable");
  expect(await readFile(sharedToken, "utf8")).toBe("fixture-secret\n");
});

test("connection switch drains old button registration and rejects stale server replies", async () => {
  const f = await fixture();
  const nextServer = await fixture();
  const settings = await ConnectionSettings.open("/sottoduo-destination", f.file);
  const initial = await settings.test({
    server: f.server,
    name: "Desktop",
    accessToken: "fixture-secret",
  });
  settings.commit(initial.ticket, "desktop");
  settings.config!.buttonEnabled = true;
  await writeFile(f.file, JSON.stringify(settings.config));
  settings.accepted(settings.config!);
  const calls: string[] = [];
  const registration = Promise.withResolvers<void>();
  const oldSources = Promise.withResolvers<{ sources: Source[] }>();
  cleanup.push(async () => {
    registration.resolve();
    oldSources.resolve({ sources: [] });
  });
  settings.api!.buttonRequest = async (path, _owner, _body, method) => {
    calls.push(`${method ?? "POST"} ${path}`);
    if (path === "") await registration.promise;
    return { available: false, destinations: [] };
  };
  const runtime = new ClientRuntime(settings, f.desktop);
  cleanup.push(async () => {
    registration.resolve();
    oldSources.resolve({ sources: [] });
    await runtime.close();
  });
  runtime.start();
  await until(async () => calls.length > 0);
  settings.api!.sources = () => oldSources.promise;
  const pendingSources = runtime.gui({ version: 1, action: "sources" }).then(
    () => "unexpected success",
    (error) => (error as Error).message,
  );
  const checked = await settings.test({
    server: nextServer.server,
    name: "Desktop",
    accessToken: "fixture-secret",
  });
  const saving = runtime.gui({
    version: 1,
    action: "saveConnection",
    ticket: checked.ticket,
    hostID: "desktop",
  });
  await until(
    async () =>
      ((await runtime.gui({ version: 1, action: "snapshot" })) as { connectionChanging: boolean })
        .connectionChanging,
  );
  expect(await runtime.command("start")).toContain("connection is changing");
  registration.resolve();
  await saving;
  oldSources.resolve({ sources: [] });
  expect(await pendingSources).toContain("connection changed");
  expect(calls[0]).toBe("POST ");
  expect(calls[1]).toStartWith("DELETE /");
  expect(calls).toHaveLength(2);
  expect(await runtime.gui({ version: 1, action: "snapshot" })).toMatchObject({
    server: nextServer.server,
    result: null,
    busy: false,
  });
  expect(f.starts() + nextServer.starts()).toBe(0);
});

test("an incompatible server and missing credentials remain repairable without leaking secrets", async () => {
  const f = await fixture();
  const health = await new API(f.server, "fixture-secret").health();
  const incompatible = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ...health, apiVersion: 999 }),
  });
  cleanup.push(async () => {
    await incompatible.stop(true);
  });
  const settings = await ConnectionSettings.open("/sottoduo-destination", f.file);
  await expect(
    settings.test({
      server: incompatible.url.origin,
      name: "Desktop",
      accessToken: "fixture-secret",
    }),
  ).rejects.toThrow("The server is newer than this app");
  expect(await Bun.file(f.file).exists()).toBe(false);
  const checked = await settings.test({
    server: f.server,
    name: "Desktop",
    accessToken: "fixture-secret",
  });
  settings.commit(checked.ticket, "desktop");
  await rm(settings.config!.tokenFile);
  const repaired = await ConnectionSettings.open("/sottoduo-destination", f.file);
  expect(repaired.api).toBeUndefined();
  expect(repaired.config?.server).toBe(f.server);
  await expect(
    repaired.test({ server: f.server, name: "Desktop", accessToken: "" }),
  ).rejects.toThrow("saved token is unavailable");
  const valid = await repaired.test({
    server: f.server,
    name: "Desktop",
    accessToken: "fixture-secret",
  });
  repaired.commit(valid.ticket, "desktop");
  expect(repaired.api).toBeDefined();
});

test("repair retains an invalid configuration in a private backup", async () => {
  const f = await fixture();
  const file = join(f.dir, "invalid.json");
  const original = '{"server":"unfinished';
  await writeFile(file, original, { mode: 0o600 });
  const settings = await ConnectionSettings.open("/sottoduo-destination", file);
  expect(settings.setupMessage).toContain("private backup");
  const checked = await settings.test({
    server: f.server,
    name: "Desktop",
    accessToken: "fixture-secret",
  });
  settings.commit(checked.ticket, "desktop");
  const backup = (await readdir(f.dir)).find((name) => name.startsWith("invalid.json.backup-"));
  expect(backup).toBeDefined();
  expect(await readFile(join(f.dir, backup!), "utf8")).toBe(original);
  expect((await stat(join(f.dir, backup!))).mode & 0o777).toBe(0o600);
  expect(settings.setupMessage).toBe("");
});
