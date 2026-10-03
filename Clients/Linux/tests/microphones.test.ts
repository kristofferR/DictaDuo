import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { API } from "../src/api.ts";
import { parseConfig } from "../src/config.ts";
import { Controller, type Desktop } from "../src/controller.ts";
import { createGUIHandler } from "../src/gui.ts";
import { microphoneSettings, microphoneSnapshot } from "../src/microphones.ts";
import { candidates, selectionExplanation, sourceKey, type Source } from "../src/sources.ts";

const dji = { hostID: "desktop", id: "dji" };
const airpods = { hostID: "desktop", id: "airpods" };
const base = () =>
  parseConfig({
    server: "http://localhost:8391",
    tokenFile: "/private/token",
    destinationHelper: "/private/helper",
    device: { id: "linux", name: "Linux" },
    sources: {
      server: "http://localhost:8391",
      hostID: "desktop",
      mode: "automatic",
      priority: [dji, airpods],
    },
  });
const source = (identity = dji): Source => ({
  identity,
  name: identity.id,
  transport: "usb",
  present: true,
  link: "connected",
  capture: "available",
  audioHealth: "unknown",
  observedAt: new Date().toISOString(),
});

test("legacy priorities migrate without changing selection and profile metadata stays server scoped", () => {
  const config = base();
  const value = microphoneSettings(config.sources);
  expect(value.profiles).toEqual([{ id: "default", name: "Default", priority: [dji, airpods] }]);
  expect(candidates([source(), source(airpods)], value).map((s) => s.identity)).toEqual([
    dji,
    airpods,
  ]);
  const saved = parseConfig({
    ...config,
    sources: { ...value, knownInputs: [{ identity: dji, name: "DJI Mic Mini" }] },
  });
  expect(saved.sources.knownInputs?.[0]?.name).toBe("DJI Mic Mini");
  expect(() => parseConfig({ ...saved, server: "http://other:8391" })).toThrow("another server");
  const reset = parseConfig({
    ...saved,
    server: "http://other:8391",
    sources: { server: "http://other:8391", hostID: "desktop", mode: "automatic", priority: [] },
  });
  expect(microphoneSettings(reset.sources).profiles).toEqual([
    { id: "default", name: "Default", priority: [] },
  ]);
  for (const patch of [
    { profiles: [] },
    { activeProfileID: "missing" },
    { profiles: [...value.profiles, { id: "second", name: "DEFAULT", priority: [] }] },
    { profiles: [{ id: "default", name: "Default", priority: [dji, dji] }], priority: [dji, dji] },
    { priority: [] },
  ])
    expect(() => parseConfig({ ...config, sources: { ...value, ...patch } })).toThrow();
});

test("named lists persist atomically, reject stale/active/locked edits and retain unavailable names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dictaduo-profiles-"));
  const file = join(dir, "client.json");
  let unlocked = true;
  const desktop: Desktop = {
    unlocked: async () => unlocked,
    defaultInput: async () => airpods,
    capture: async () => {
      throw Error("No recording in settings tests");
    },
    notify() {},
  };
  const config = base();
  const api = new API(config.server, "private-token");
  api.sources = async () => ({ sources: [source(airpods)] });
  const controller = new Controller(api, desktop, config.device, config.sources);
  const gui = createGUIHandler(
    api,
    controller,
    desktop,
    config,
    undefined,
    undefined,
    undefined,
    file,
  );
  const snapshot = async () =>
    (
      (await gui({ version: 1, action: "snapshot" })) as {
        microphones: ReturnType<typeof microphoneSnapshot>;
      }
    ).microphones;
  const save = async (value: ReturnType<typeof microphoneSettings>, revision: string) =>
    gui({ version: 1, action: "saveMicrophones", value, revision });
  try {
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    const initial = await snapshot();
    const value = {
      ...initial.value,
      profiles: [
        ...initial.value.profiles,
        { id: "living-room", name: "Living room", priority: [airpods] },
      ],
      knownInputs: [
        { identity: dji, name: "DJI Mic Mini" },
        { identity: airpods, name: "AirPods Pro" },
      ],
    };
    await save(value, initial.revision);
    let current = await snapshot();
    expect(current.value.profiles).toHaveLength(2);
    expect(current.value.knownInputs[0]?.name).toBe("DJI Mic Mini");
    expect(await gui({ version: 1, action: "sources" })).toMatchObject({
      next: { identity: airpods },
      reason: "Using priority 2; earlier microphones in the list are unavailable.",
    });
    const disk = await readFile(file, "utf8");
    await expect(save(value, initial.revision)).rejects.toThrow("changed");
    expect(await readFile(file, "utf8")).toBe(disk);
    for (const mode of ["systemDefault", "fixed", "automatic"] as const) {
      const next = {
        ...current.value,
        mode,
        fixed: dji,
        activeProfileID: "living-room",
        priority: [airpods],
      };
      await save(next, current.revision);
      current = await snapshot();
      expect(current.value.mode).toBe(mode);
      expect(current.value.profiles[0]?.priority).toEqual([dji, airpods]);
    }
    const renamed = {
      ...current.value,
      profiles: current.value.profiles.map((p) =>
        p.id === "living-room" ? { ...p, name: "Away from desk" } : p,
      ),
    };
    await save(renamed, current.revision);
    current = await snapshot();
    const removed = {
      ...current.value,
      profiles: current.value.profiles.filter((p) => p.id !== "default"),
    };
    await save(removed, current.revision);
    current = await snapshot();
    expect(current.value.profiles.map((p) => p.name)).toEqual(["Away from desk"]);
    expect(parseConfig(JSON.parse(await readFile(file, "utf8"))).sources).toEqual(current.value);
    Object.defineProperty(controller, "busy", { configurable: true, get: () => true });
    await expect(save(current.value, current.revision)).rejects.toThrow("Finish dictation");
    Object.defineProperty(controller, "busy", { configurable: true, get: () => false });
    unlocked = false;
    await expect(save(current.value, current.revision)).rejects.toThrow("Unlock");
    unlocked = true;
    await expect(save({ ...current.value, hostID: "other" }, current.revision)).rejects.toThrow(
      "belong to this server",
    );
    // Legacy source edits still update the selected list without deleting the library.
    await gui({ version: 1, action: "saveSources", value: { ...current.value, priority: [dji] } });
    current = await snapshot();
    expect(current.value.profiles[0]?.priority).toEqual([dji]);
    await writeFile(file, (await readFile(file, "utf8")) + " ");
    // Semantically unchanged whitespace is allowed by the existing config writer.
    const external = parseConfig(JSON.parse(await readFile(file, "utf8")));
    await writeFile(
      file,
      JSON.stringify({ ...external, device: { ...external.device, name: "External edit" } }),
    );
    await expect(save(current.value, current.revision)).rejects.toThrow("externally");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fallback explanations agree with resolution for disconnected, stale and fixed inputs", () => {
  const config = base();
  const disconnected = { ...source(), link: "disconnected" as const };
  const next = source(airpods);
  expect(selectionExplanation([disconnected, next], config.sources, airpods)).toMatchObject({
    next,
    reason: "Using priority 2; earlier microphones in the list are unavailable.",
  });
  const fixed = { ...config.sources, mode: "fixed" as const, fixed: dji };
  expect(selectionExplanation([disconnected, next], fixed, airpods).reason).toContain(
    "Fixed input unavailable: Transmitter link is not ready",
  );
  expect(
    selectionExplanation([disconnected, next], { ...config.sources, priority: [] }, airpods).reason,
  ).toContain("priority list is empty");
  expect(selectionExplanation([disconnected], config.sources).next).toBeNull();
  const stale = { ...source(), observedAt: new Date(Date.now() - 5000).toISOString() };
  expect(selectionExplanation([stale, next], fixed).reason).toContain("Status is out of date");
  const other = source({ hostID: "other", id: "airpods" });
  expect(sourceKey(other.identity)).not.toBe(sourceKey(airpods));
  expect(selectionExplanation([other], config.sources).next).toBeNull();
});
