import { pipeWireInputs } from "../../../Server/src/capture/pipewire-discovery.ts";
import type { Desktop, Destination } from "./controller.ts";
import { command } from "./desktop.ts";
import type { SourceID } from "./sources.ts";
import { NativeDestinations } from "./native-destination.ts";

const preview = (): Destination => ({ deliver: async () => "preview", close() {} });
export function isPlasmaDesktop(names: (string | undefined)[]) {
  return names.some((value) =>
    value?.split(":").some((name) => ["kde", "plasma"].includes(name.toLowerCase())),
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function plasmaUnlocked(state: string, screen: string, lockedSince: number, since: number) {
  const lines = state.split("\n");
  return (
    ["LockedHint=no", "Active=yes", "Type=wayland", "State=active"].every((line) =>
      lines.includes(line),
    ) &&
    /^\(false,?\)\s*$/.test(screen.trim()) &&
    lockedSince < since
  );
}

export function plasmaLockEvent(text: string) {
  return /AboutToLock|ActiveChanged\s*\(\s*true\s*,?\s*\)/.test(text);
}

export function loginSessionPath(reply: string) {
  const path = /^o "(\/org\/freedesktop\/login1\/session\/[A-Za-z0-9_]+)"\s*$/.exec(reply.trim());
  if (!path) throw new Error("Could not identify the current login session.");
  return path[1];
}

/** Plasma owns global shortcut registration through its portal in the GUI.
 * This adapter pins insertion to a focused AT-SPI object and fails closed on
 * unknown screen-lock/session state. */
export class PlasmaDesktop implements Desktop {
  readonly kind = "plasma";
  private screen?: ReturnType<typeof Bun.spawn>;
  private session?: ReturnType<typeof Bun.spawn>;
  private connected = false;
  private lockedSince = 0;
  private destinations = new NativeDestinations();
  constructor(private helper: string) {}

  async monitorSession(unsafe: () => void): Promise<void> {
    if (process.env.XDG_SESSION_TYPE !== "wayland")
      throw new Error("Start SottoDuo inside a Plasma Wayland session.");
    const sessionID = (
      await command(["loginctl", "show-session", "auto", "-p", "Id", "--value"])
    ).trim();
    if (!sessionID) throw new Error("Could not identify the current login session.");
    const sessionPath = loginSessionPath(
      await command([
        "busctl",
        "--system",
        "call",
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
        "GetSession",
        "s",
        sessionID,
      ]),
    );
    this.screen = Bun.spawn(
      ["gdbus", "monitor", "--session", "--dest", "org.freedesktop.ScreenSaver"],
      { stdout: "pipe", stderr: "ignore" },
    );
    if (!(this.screen.stdout instanceof ReadableStream))
      throw new Error("Plasma screen-lock monitor unavailable.");
    const reader = this.screen.stdout.getReader();
    const timer = setTimeout(() => this.screen?.kill("SIGKILL"), 1500);
    try {
      const first = await reader.read();
      if (first.done || !new TextDecoder().decode(first.value).includes("Monitoring signals"))
        throw new Error("Plasma screen-lock monitor unavailable.");
    } finally {
      clearTimeout(timer);
    }
    this.session = Bun.spawn(
      [
        "dbus-monitor",
        "--system",
        "type='signal',interface='org.freedesktop.login1.Manager',member='PrepareForSleep'",
        `type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path='${sessionPath}'`,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    if (!(this.session.stdout instanceof ReadableStream))
      throw new Error("Desktop session monitor unavailable.");
    this.connected = true;
    void this.readMonitor(reader, plasmaLockEvent, unsafe);
    void this.readMonitor(
      this.session.stdout.getReader(),
      (text) => /member=PrepareForSleep|"LockedHint"|"Active"/.test(text),
      unsafe,
    );
  }

  private async readMonitor(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    detectsLock: (text: string) => boolean,
    unsafe: () => void,
  ) {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        pending = (pending + decoder.decode(next.value, { stream: true })).slice(-8192);
        if (detectsLock(pending)) {
          this.lockedSince = Date.now();
          unsafe();
          pending = "";
        }
      }
    } catch {
      // An unavailable monitor must make text insertion fail closed.
    } finally {
      this.connected = false;
      unsafe();
    }
  }

  async unlocked(since = Date.now()): Promise<boolean> {
    if (!this.connected) return false;
    try {
      const [state, screen] = await Promise.all([
        command([
          "loginctl",
          "show-session",
          "auto",
          "-p",
          "LockedHint",
          "-p",
          "Active",
          "-p",
          "Type",
          "-p",
          "State",
        ]),
        command([
          "gdbus",
          "call",
          "--session",
          "--dest",
          "org.freedesktop.ScreenSaver",
          "--object-path",
          "/ScreenSaver",
          "--method",
          "org.freedesktop.ScreenSaver.GetActive",
        ]),
      ]);
      return plasmaUnlocked(state, screen, this.lockedSince, since);
    } catch {
      return false;
    }
  }

  async defaultInput(hostID: string): Promise<SourceID | undefined> {
    try {
      const graph: unknown = JSON.parse(await command(["pw-dump"]));
      if (!Array.isArray(graph)) return undefined;
      const nodes = graph.filter(object);
      let name: string | undefined;
      for (const item of nodes) {
        if (item.type !== "PipeWire:Interface:Metadata" || !Array.isArray(item.metadata)) continue;
        for (const entry of item.metadata.filter(object)) {
          if (entry.key !== "default.audio.source") continue;
          const value: unknown =
            typeof entry.value === "string" ? JSON.parse(entry.value) : entry.value;
          if (object(value) && typeof value.name === "string") name = value.name;
        }
      }
      const node = nodes.find(
        (item) =>
          object(item.info) && object(item.info.props) && item.info.props["node.name"] === name,
      );
      const serial =
        object(node?.info) && object(node.info.props)
          ? node.info.props["object.serial"]
          : undefined;
      return pipeWireInputs(graph, hostID).find((input) => input.serial === String(serial))?.source
        .identity;
    } catch {
      return undefined;
    }
  }

  notify(message: string): void {
    void command([
      "notify-send",
      "--app-name=SottoDuo",
      "--expire-time=3500",
      "SottoDuo",
      message,
    ]).catch(() => {});
  }

  async capture(): Promise<Destination> {
    const startedAt = Date.now();
    if (!(await this.unlocked(startedAt))) return preview();
    const destination = await this.destinations.capture(this.helper, "focused");
    return {
      close: () => destination.close(),
      deliver: async (text, held) => {
        if (!(await this.unlocked(startedAt))) {
          destination.close();
          return "preview";
        }
        return destination.deliver(text, held);
      },
    };
  }

  close(): void {
    this.destinations.invalidate();
    this.connected = false;
    this.screen?.kill();
    this.session?.kill();
  }
}
