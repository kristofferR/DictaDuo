import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Controller, type Desktop } from "../src/controller.ts";
import { API } from "../src/api.ts";
import { createGUIHandler } from "../src/gui.ts";
import { parseConfig } from "../src/config.ts";
import { ButtonDestinationClient } from "../src/buttons.ts";

test("GUI shortcut release waits for the preceding press check", async () => {
  const config = parseConfig({
    server: "http://localhost:8394",
    tokenFile: "/private/token",
    destinationHelper: "/private/helper",
    device: { id: "desktop", name: "Desktop" },
    sources: {
      server: "http://localhost:8394",
      hostID: "desktop",
      mode: "automatic",
      priority: [],
    },
  });
  let allowPress: (() => void) | undefined;
  const pressCheck = new Promise<void>((resolve) => {
    allowPress = resolve;
  });
  let checks = 0;
  const actions: string[] = [];
  const desktop: Desktop = {
    unlocked: async () => {
      if (++checks === 1) {
        await pressCheck;
        return true;
      }
      return false;
    },
    capture: async () => {
      throw new Error("not used");
    },
    defaultInput: async () => undefined,
    notify() {},
  };
  const controller = new Controller(
    new API(config.server, "test-token"),
    desktop,
    config.device,
    config.sources,
  );
  controller.start = () => {
    actions.push("start");
    return true;
  };
  controller.stop = () => {
    actions.push("stop");
  };
  const gui = createGUIHandler(new API(config.server, "test-token"), controller, desktop, config);
  const press = gui({ version: 1, action: "start" });
  const release = gui({ version: 1, action: "stop" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(checks).toBe(1);
  expect(actions).toEqual([]);
  allowPress?.();
  await Promise.all([press, release]);
  expect(checks).toBe(1);
  expect(actions).toEqual(["start", "stop"]);
});

test("GUI start, undo and copy-last requests reach the controller", async () => {
  const config = parseConfig({
    server: "http://localhost:8394",
    tokenFile: "/private/token",
    destinationHelper: "/private/helper",
    device: { id: "desktop", name: "Desktop" },
    sources: {
      server: "http://localhost:8394",
      hostID: "desktop",
      mode: "automatic",
      priority: [],
    },
  });
  const desktop: Desktop = {
    unlocked: async () => true,
    capture: async () => {
      throw new Error("not used");
    },
    defaultInput: async () => undefined,
    notify() {},
  };
  const controller = new Controller(
    new API(config.server, "t"),
    desktop,
    config.device,
    config.sources,
  );
  let undone = 0;
  const actions: string[] = [];
  controller.undo = () => void undone++;
  controller.closeUndo = () => void actions.push("keep");
  controller.start = () => {
    actions.push("start");
    return true;
  };
  const gui = createGUIHandler(new API(config.server, "t"), controller, desktop, config);
  await gui({ version: 1, action: "undo" });
  expect(undone).toBe(1);
  // Start dictation keeps a cancelled take in history; the shortcut may still paste it.
  await gui({ version: 1, action: "start" });
  await gui({ version: 1, action: "start", shortcut: true });
  expect(actions).toEqual(["keep", "start", "start"]);
  await expect(gui({ version: 1, action: "copyLast" })).rejects.toThrow("no dictation to copy");
});
test("GUI requests are versioned and scoped; source preferences persist without losing private configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sottoduo-gui-"));
  const previous = process.env.SOTTODUO_CLIENT_CONFIG;
  process.env.SOTTODUO_CLIENT_CONFIG = join(dir, "client.json");
  const config = parseConfig({
    server: "http://localhost:8394",
    tokenFile: "/private/token",
    destinationHelper: "/private/helper",
    device: { id: "desktop", name: "Desktop" },
    sources: {
      server: "http://localhost:8394",
      hostID: "desktop",
      mode: "automatic",
      priority: [],
    },
  });
  let unlocked = true;
  const desktop: Desktop = {
    unlocked: async () => unlocked,
    capture: async () => {
      throw new Error("not used");
    },
    defaultInput: async () => undefined,
    notify() {},
  };
  const api = new API(config.server, "never-publish-this-token");
  const controller = new Controller(api, desktop, config.device, config.sources);
  const requests: string[] = [];
  api.sources = async () => {
    requests.push("sources");
    return { sources: [] };
  };
  api.buttonStatus = async () => {
    requests.push("status");
    return { available: false, destinations: [] };
  };
  api.buttonRequest = async (path, _owner, _body, method) => {
    requests.push(`${method ?? "POST"} ${path}`);
    return { available: false, destinations: [] };
  };
  api.setButtonTarget = async (target) => {
    requests.push(`target ${target.mode}`);
    return { available: false, destinations: [], buttonTarget: target };
  };
  api.setSharing = async (source, shared) => {
    requests.push(`share ${source.id} ${shared}`);
    return { sources: [] };
  };
  const buttons = new ButtonDestinationClient(
    api,
    desktop,
    controller,
    config.device,
    config.buttonEnabled,
  );
  const gui = createGUIHandler(api, controller, desktop, config, buttons);
  try {
    await writeFile(process.env.SOTTODUO_CLIENT_CONFIG, JSON.stringify(config), { mode: 0o600 });
    await expect(gui({ version: 2, action: "snapshot" })).rejects.toThrow();
    await expect(gui({ version: 1, action: "request", path: "/anything" })).rejects.toThrow();
    const snapshot = JSON.stringify(await gui({ version: 1, action: "snapshot" }));
    expect(snapshot).not.toContain("/private");
    expect(snapshot).not.toContain("never-publish");
    controller.captureAllowed = () => false;
    await expect(gui({ version: 1, action: "test" })).rejects.toThrow("shortcut check");
    expect(controller.busy).toBe(false);
    controller.captureAllowed = () => true;
    expect(await gui({ version: 1, action: "receiver" })).toMatchObject({
      available: false,
      source: null,
    });
    expect(requests).toEqual(["sources", "status"]);
    await expect(gui({ version: 1, action: "saveButton", enabled: "true" })).rejects.toThrow(
      "Invalid",
    );
    await gui({ version: 1, action: "saveButton", enabled: true });
    expect(buttons.enabled).toBe(true);
    expect(JSON.parse(await readFile(process.env.SOTTODUO_CLIENT_CONFIG, "utf8"))).toEqual({
      ...config,
      buttonEnabled: true,
    });
    await buttons.tick();
    // The DJI button's target is server state; the GUI only forwards valid targets.
    await expect(
      gui({ version: 1, action: "setButtonTarget", target: { mode: "everywhere" } }),
    ).rejects.toThrow();
    await gui({ version: 1, action: "setButtonTarget", target: { mode: "off" } });
    await expect(
      gui({ version: 1, action: "setSharing", source: { hostID: "desktop" }, shared: true }),
    ).rejects.toThrow();
    await gui({
      version: 1,
      action: "setSharing",
      source: { hostID: "desktop", id: "dji" },
      shared: true,
    });
    expect(requests.slice(-2)).toEqual(["target off", "share dji true"]);
    expect(requests.some((r) => r.startsWith("DELETE"))).toBe(false);
    await gui({ version: 1, action: "saveButton", enabled: false });
    expect(buttons.enabled).toBe(false);
    expect(requests.at(-1)?.startsWith("DELETE")).toBe(true);
    expect(JSON.parse(await readFile(process.env.SOTTODUO_CLIENT_CONFIG, "utf8"))).toEqual(config);
    Object.defineProperty(controller, "busy", { configurable: true, get: () => true });
    await expect(gui({ version: 1, action: "saveButton", enabled: true })).rejects.toThrow(
      "Finish dictation",
    );
    expect(buttons.enabled).toBe(false);
    Object.defineProperty(controller, "busy", { configurable: true, get: () => false });
    const sources = { ...config.sources, priority: [{ hostID: "desktop", id: "dji" }] };
    await gui({ version: 1, action: "saveSources", value: sources });
    expect(JSON.parse(await readFile(process.env.SOTTODUO_CLIENT_CONFIG, "utf8"))).toEqual({
      ...config,
      sources,
    });
    unlocked = false;
    await expect(gui({ version: 1, action: "saveButton", enabled: true })).rejects.toThrow(
      "Unlock",
    );
    await expect(gui({ version: 1, action: "saveSources", value: config.sources })).rejects.toThrow(
      "Unlock",
    );
    unlocked = true;
    await writeFile(
      process.env.SOTTODUO_CLIENT_CONFIG,
      JSON.stringify({ ...config, device: { ...config.device, name: "External change" } }),
    );
    await expect(gui({ version: 1, action: "saveSources", value: config.sources })).rejects.toThrow(
      "externally",
    );
    await expect(gui({ version: 1, action: "saveButton", enabled: true })).rejects.toThrow(
      "externally",
    );
    expect(buttons.enabled).toBe(false);
  } finally {
    await buttons.close();
    if (previous === undefined) delete process.env.SOTTODUO_CLIENT_CONFIG;
    else process.env.SOTTODUO_CLIENT_CONFIG = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("shared GUI settings preserve untouched preferences and reject a stale revision", async () => {
  const { GenerationService } = await import("../../../Server/src/generation-service.ts");
  const { createHTTPServer } = await import("../../../Server/src/http-server.ts");
  const { FakeInference } = await import("../../../Server/tests/support.ts");
  const dir = await mkdtemp(join(tmpdir(), "sottoduo-gui-prefs-"));
  const inference = Object.assign(new FakeInference(), {
    engines: ["whisper", "parakeet"] as const,
  });
  const service = await GenerationService.open(
    { dataDirectory: dir, development: true },
    inference,
  );
  const server = createHTTPServer(service, "test-token");
  try {
    const endpoint = await server.listen({ host: "127.0.0.1", port: 0 });
    const api = new API(endpoint, "test-token");
    expect((await api.health()).recognitionEngines).toEqual(["whisper", "parakeet"]);
    const old = await api.preferences();
    expect(old.preferences.recognitionEngine).toBe("whisper");
    const current = await api.savePreferences({
      ...old,
      preferences: {
        ...old.preferences,
        proofreadingPrompt: "Preserve this prompt",
        recognitionMode: "local",
        recognitionEngine: "parakeet",
        vocabulary: "First computer",
      },
    });
    expect(current.preferences.recognitionMode).toBe("local");
    expect(current.preferences.recognitionEngine).toBe("parakeet");
    await expect(
      api.savePreferences({
        ...old,
        preferences: { ...old.preferences, vocabulary: "Stale computer" },
      }),
    ).rejects.toThrow("409");
    const saved = await api.savePreferences({
      ...current,
      preferences: { ...current.preferences, vocabulary: "Current computer" },
    });
    expect(saved.preferences.proofreadingPrompt).toBe("Preserve this prompt");
    expect(saved.preferences.recognitionMode).toBe("local");
    expect(saved.preferences.vocabulary).toBe("Current computer");
    expect((await api.preferences()).preferences.recognitionMode).toBe("local");
    expect(saved.preferences.recognitionEngine).toBe("parakeet");
  } finally {
    await service.shutdown();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
