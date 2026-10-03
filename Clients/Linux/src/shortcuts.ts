import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClientNotice } from "./errors.ts";

export class ShortcutCheck {
  private until = 0;
  private held = false;
  private presses = 0;
  private releases = 0;
  private last = "Not checked";
  private startedAt = 0;
  private events: string[] = [];
  private note(message: string) {
    const seconds = Math.max(0, (Date.now() - this.startedAt) / 1000).toFixed(1);
    this.events.push(`${seconds}s  ${message}`);
    if (this.events.length > 24) this.events.shift();
  }
  get blocked() {
    return this.until > Date.now() || this.held;
  }
  begin() {
    if (this.blocked)
      throw new ClientNotice("Finish the current shortcut check and release the key first.");
    this.until = Date.now() + 30000;
    this.startedAt = Date.now();
    this.presses = this.releases = 0;
    this.last = "Hold and release your dictation key";
    this.events = [];
    this.note("Check started");
  }
  end() {
    if (this.until > 0) this.note("Check finished");
    this.until = 0;
  }
  consume(action: string) {
    if (!["start", "stop", "cancel", "copy", "toggle"].includes(action) || !this.blocked)
      return false;
    if (action === "start") {
      if (!this.held) ++this.presses;
      this.note(this.held ? "Repeated press" : "Press detected");
      this.held = true;
      this.last = "Press detected";
    } else if (action === "stop") {
      if (this.held) ++this.releases;
      this.note(this.held ? "Release detected" : "Release without press");
      this.held = false;
      this.last = "Release detected";
    } else {
      this.last = `${action === "copy" ? "Copy" : action === "cancel" ? "Cancel" : "Toggle"} detected`;
      this.note(this.last);
    }
    return true;
  }
  snapshot() {
    return {
      active: this.until > Date.now(),
      blocked: this.blocked,
      held: this.held,
      presses: this.presses,
      releases: this.releases,
      events: this.events.slice(),
      remainingSeconds: Math.max(0, Math.ceil((this.until - Date.now()) / 1000)),
      message:
        this.until <= Date.now() && this.held ? "Release the key to resume dictation" : this.last,
    };
  }
}

const keys = ["Menu", "F8", "F9", "F10", "F12"] as const;
type Key = (typeof keys)[number];
const codes: Record<Key, number[]> = { Menu: [135, 147], F8: [74], F9: [75], F10: [76], F12: [96] };
const actions = ["start dictation", "stop dictation", "cancel dictation", "copy last result"];
const begin = "-- BEGIN DictaDuo shortcuts\n",
  end = "-- END DictaDuo shortcuts\n";
const documentedMenuBlock = `-- Kris selected Menu for DictaDuo, replacing its Voxtype toggle binding.
-- Remove the existing Menu binding once, then add both press and release actions.
hl.unbind("Menu")
-- Compositor events preserve press/release ordering without racing CLI processes.
o.bind("Menu", "DictaDuo: start dictation", hl.dsp.event("dictaduo:start"))
o.bind("Menu", "DictaDuo: stop dictation", hl.dsp.event("dictaduo:stop"), { release = true, ignore_mods = true })
o.bind("SUPER + Menu", "DictaDuo: cancel dictation", hl.dsp.event("dictaduo:cancel"))
o.bind("SUPER + SHIFT + Menu", "DictaDuo: copy last result", hl.dsp.event("dictaduo:copy"))
`;
const revision = (text: string) => createHash("sha256").update(text).digest("hex");
export function shortcutBlock(key: Key) {
  return `o.rebind("${key}", "DictaDuo: start dictation", hl.dsp.event("dictaduo:start"))\no.bind("${key}", "DictaDuo: stop dictation", hl.dsp.event("dictaduo:stop"), { release = true, ignore_mods = true })\no.bind("SUPER + ${key}", "DictaDuo: cancel dictation", hl.dsp.event("dictaduo:cancel"))\no.bind("SUPER + SHIFT + ${key}", "DictaDuo: copy last result", hl.dsp.event("dictaduo:copy"))\n`;
}
function section(text: string) {
  for (const key of keys) {
    for (const block of [
      begin + shortcutBlock(key) + end,
      `-- DictaDuo dictation: hold ${key}; release to transcribe.\n` + shortcutBlock(key),
      ...(key === "Menu" ? [documentedMenuBlock] : []),
    ]) {
      const at = text.indexOf(block);
      if (
        at >= 0 &&
        !text.replace(block, "").includes("dictaduo:") &&
        !text.replace(block, "").includes("BEGIN DictaDuo shortcuts")
      )
        return { key, block, at };
    }
  }
  throw new ClientNotice(
    "Shortcut editing supports DictaDuo’s standard Omarchy Lua bindings. Custom bindings must be edited in desktop settings.",
  );
}
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((v) => !v || typeof v !== "object" || Array.isArray(v)))
    throw new ClientNotice("Could not read the desktop shortcuts.");
  return value;
}
function own(binding: Record<string, unknown>, key: Key) {
  const index = actions.map((action) => `DictaDuo: ${action}`).indexOf(String(binding.description));
  return (
    index >= 0 &&
    binding.key === key &&
    binding.keycode === 0 &&
    binding.modmask === [0, 0, 64, 65][index] &&
    binding.release === (index === 1) &&
    binding.submap === "" &&
    binding.dispatcher === "__lua"
  );
}
function verify(bindings: Record<string, unknown>[], key: Key) {
  return actions.every(
    (action) =>
      bindings.filter((b) => own(b, key) && b.description === `DictaDuo: ${action}`).length === 1,
  );
}
function conflict(bindings: Record<string, unknown>[], key: Key, current: Key) {
  return bindings.find(
    (b) =>
      (String(b.key).toLowerCase() === key.toLowerCase() ||
        codes[key].includes(Number(b.keycode))) &&
      !own(b, current),
  );
}
type Run = (args: string[]) => Promise<string>;
type Status = {
  supported: boolean;
  key?: Key;
  revision?: string;
  message: string;
  choices: { key: Key; available: boolean; reason: string }[];
};
export class ShortcutSettings {
  readonly check = new ShortcutCheck();
  private changing = false;
  private state: Status = { supported: false, message: "Checking desktop shortcuts…", choices: [] };
  constructor(
    private run: Run,
    private busy: () => boolean,
    private file = join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "hypr",
      "bindings.lua",
    ),
  ) {}
  get blocked() {
    return this.changing || this.check.blocked;
  }
  snapshot() {
    return { ...this.state, changing: this.changing, check: this.check.snapshot() };
  }
  private read() {
    const info = lstatSync(this.file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.size > 256 * 1024
    )
      throw new ClientNotice(
        "Shortcut editing requires a regular bindings file owned by your Linux user.",
      );
    return readFileSync(this.file, "utf8");
  }
  async refresh() {
    if (this.changing) return this.snapshot();
    try {
      const text = this.read(),
        current = section(text);
      const bindings = records(JSON.parse(await this.run(["hyprctl", "-j", "binds"])));
      const supported =
        verify(bindings, current.key) && !conflict(bindings, current.key, current.key);
      this.state = {
        supported,
        key: supported ? current.key : undefined,
        revision: revision(text),
        message: supported
          ? "Hold to dictate; release to transcribe."
          : "The active shortcuts differ from DictaDuo’s saved bindings. Reload or repair the desktop configuration first.",
        choices: keys.map((key) => {
          const other = conflict(bindings, key, current.key);
          return {
            key,
            available: !other,
            reason: other
              ? `Already used: ${String(other.description || "another desktop action")}`
              : "Available",
          };
        }),
      };
    } catch (error) {
      this.state = {
        supported: false,
        message:
          error instanceof ClientNotice
            ? error.message
            : "Shortcut configuration is available on the supported Omarchy Lua desktop setup.",
        choices: [],
      };
    }
    return this.snapshot();
  }
  startCheck() {
    if (this.busy() || this.changing)
      throw new ClientNotice("Finish dictation or saving shortcuts first.");
    if (!this.state.supported) throw new ClientNotice("Check the desktop shortcut setup first.");
    this.check.begin();
    return this.snapshot();
  }
  async save(key: unknown, expected: unknown) {
    if (!keys.some((k) => k === key) || typeof expected !== "string")
      throw new ClientNotice("Choose one of the supported dictation keys.");
    if (this.busy() || this.blocked)
      throw new ClientNotice("Finish dictation or the shortcut check and release the key first.");
    this.changing = true;
    const selected = key as Key;
    let original: string | undefined,
      next: string | undefined,
      written = false;
    const atomic = (text: string) => {
      const temp = `${this.file}.dictaduo-${randomUUID()}.tmp`;
      writeFileSync(temp, text, { flag: "wx", mode: lstatSync(this.file).mode & 0o777 });
      renameSync(temp, this.file);
    };
    try {
      original = this.read();
      if (revision(original) !== expected)
        throw new ClientNotice(
          "Desktop shortcuts changed elsewhere. Reload this page before saving.",
        );
      const current = section(original);
      if ((await this.run(["hyprctl", "configerrors"])).trim())
        throw new ClientNotice(
          "Repair the existing desktop configuration errors before changing shortcuts.",
        );
      const bindings = records(JSON.parse(await this.run(["hyprctl", "-j", "binds"])));
      if (!verify(bindings, current.key))
        throw new ClientNotice(
          "The active DictaDuo shortcuts no longer match. Reload this page first.",
        );
      if (conflict(bindings, selected, current.key))
        throw new ClientNotice(
          "That key is already used by another desktop action. Choose an available key.",
        );
      if (this.read() !== original)
        throw new ClientNotice(
          "Desktop shortcuts changed elsewhere. Reload this page before saving.",
        );
      next = original.replace(current.block, begin + shortcutBlock(selected) + end);
      writeFileSync(`${this.file}.dictaduo-backup-${randomUUID()}`, original, {
        flag: "wx",
        mode: 0o600,
      });
      atomic(next);
      written = true;
      await this.run(["hyprctl", "reload"]);
      if ((await this.run(["hyprctl", "configerrors"])).trim())
        throw new Error("Invalid configuration");
      const active = records(JSON.parse(await this.run(["hyprctl", "-j", "binds"])));
      if (!verify(active, selected) || conflict(active, selected, selected))
        throw new Error("Shortcut not activated");
    } catch (error) {
      if (written && next !== undefined && original !== undefined) {
        if (this.read() !== next)
          throw new ClientNotice(
            "The desktop configuration changed during saving, so your previous bindings were not restored. A DictaDuo backup is beside bindings.lua.",
          );
        atomic(original);
        await this.run(["hyprctl", "reload"]);
        if ((await this.run(["hyprctl", "configerrors"])).trim())
          throw new ClientNotice(
            "Previous shortcuts were restored, but the desktop still reports configuration errors.",
          );
        throw new ClientNotice(
          "The desktop could not activate that shortcut. Your previous bindings were restored.",
        );
      }
      throw error instanceof ClientNotice
        ? error
        : new ClientNotice("Could not save desktop shortcuts. Check access to your bindings file.");
    } finally {
      this.changing = false;
    }
    return this.refresh();
  }
}
