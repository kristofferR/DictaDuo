import { expect, test, spyOn } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShortcutCheck, ShortcutSettings, shortcutBlock } from "../src/shortcuts.ts";

test("shortcut checking consumes commands without recording and waits for release after Finish", () => {
  const check = new ShortcutCheck();
  expect(check.consume("start")).toBe(false);
  check.begin();
  expect(check.consume("start")).toBe(true);
  expect(check.consume("start")).toBe(true);
  expect(check.consume("copy")).toBe(true);
  expect(check.consume("toggle")).toBe(true);
  expect(check.snapshot().presses).toBe(1);
  expect(check.snapshot().events.map((event) => event.replace(/^.*?s  /, ""))).toEqual([
    "Check started",
    "Press detected",
    "Repeated press",
    "Copy detected",
    "Toggle detected",
  ]);
  check.end();
  expect(check.blocked).toBe(true);
  expect(check.consume("start")).toBe(true);
  expect(check.consume("stop")).toBe(true);
  expect(check.snapshot()).toMatchObject({
    active: false,
    blocked: false,
    presses: 1,
    releases: 1,
  });
  expect(check.consume("start")).toBe(false);
  expect(check.snapshot().events.at(-1)).toContain("Release detected");
});

test("an expired check cannot turn a held or repeated press into dictation", () => {
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  try {
    const check = new ShortcutCheck();
    check.begin();
    check.consume("start");
    clock.mockReturnValue(32000);
    expect(check.snapshot()).toMatchObject({ active: false, blocked: true, held: true });
    expect(check.consume("start")).toBe(true);
    expect(check.consume("stop")).toBe(true);
    expect(check.blocked).toBe(false);
    expect(check.consume("start")).toBe(false);
  } finally {
    clock.mockRestore();
  }
});
function bindings(key: string, brand = "DictaDuo") {
  return ["start dictation", "stop dictation", "cancel dictation", "copy last result"].map(
    (action, index) => ({
      key,
      keycode: 0,
      modmask: [0, 0, 64, 65][index],
      release: index === 1,
      submap: "",
      dispatcher: "__lua",
      description: `${brand}: ${action}`,
    }),
  );
}
test("shortcut settings preserve other bindings, reject conflicts and stale edits, and roll back failed reloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dictaduo-shortcuts-"));
  const file = join(dir, "bindings.lua");
  const untouched = '-- My desktop\no.bind("SUPER + B", "Browser", "browser")\n';
  const original =
    untouched +
    "-- DictaDuo dictation: hold Menu; release to transcribe.\n" +
    shortcutBlock("Menu");
  let active = bindings("Menu"),
    fail = false,
    busy = false;
  const run = async (args: string[]) => {
    if (args.includes("binds"))
      return JSON.stringify([...active, { key: "F9", keycode: 0, description: "Voxtype" }]);
    if (args.includes("configerrors")) return "";
    if (args.includes("reload")) {
      const text = await readFile(file, "utf8");
      if (fail && text.includes('o.rebind("F10"')) throw new Error("Reload failed");
      active = bindings(text.includes('o.rebind("F8"') ? "F8" : "Menu");
      return "ok";
    }
    throw new Error("Unexpected command");
  };
  const settings = new ShortcutSettings(run, () => busy, file);
  try {
    await writeFile(file, original);
    const state = await settings.refresh();
    expect(state).toMatchObject({ supported: true, key: "Menu" });
    expect(state.choices.find((c) => c.key === "F9")?.available).toBe(false);
    await expect(settings.save("F9", state.revision)).rejects.toThrow("already used");
    expect(await readFile(file, "utf8")).toBe(original);
    busy = true;
    await expect(settings.save("F8", state.revision)).rejects.toThrow("Finish dictation");
    busy = false;
    settings.startCheck();
    await expect(settings.save("F8", state.revision)).rejects.toThrow("Finish dictation");
    settings.check.end();
    const saved = await settings.save("F8", state.revision);
    expect(saved.key).toBe("F8");
    const good = await readFile(file, "utf8");
    expect(good.startsWith(untouched)).toBe(true);
    expect(good).toContain("-- BEGIN DictaDuo shortcuts");
    expect((await readdir(dir)).some((name) => name.includes("dictaduo-backup"))).toBe(true);
    await expect(settings.save("F10", state.revision)).rejects.toThrow("changed elsewhere");
    fail = true;
    await expect(settings.save("F10", saved.revision)).rejects.toThrow("restored");
    expect(await readFile(file, "utf8")).toBe(good);
    expect(settings.blocked).toBe(false);
    await writeFile(file, good.replace("dictaduo:start", "custom:start"));
    expect((await settings.refresh()).supported).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shortcut settings recognize and migrate the documented Menu bindings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dictaduo-shortcuts-documented-"));
  const file = join(dir, "bindings.lua");
  const documented = await readFile(join(import.meta.dir, "../integration/bindings.lua"), "utf8");
  let active = bindings("Menu");
  const run = async (args: string[]) => {
    if (args.includes("binds")) return JSON.stringify(active);
    if (args.includes("configerrors")) return "";
    if (args.includes("reload")) {
      active = bindings("F8");
      return "ok";
    }
    throw new Error("Unexpected command");
  };
  const settings = new ShortcutSettings(run, () => false, file);
  try {
    await writeFile(file, documented);
    const state = await settings.refresh();
    expect(state).toMatchObject({ supported: true, key: "Menu" });
    await settings.save("F8", state.revision);
    const saved = await readFile(file, "utf8");
    expect(saved).toContain("-- BEGIN DictaDuo shortcuts");
    expect(saved).toContain('o.rebind("F8"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
