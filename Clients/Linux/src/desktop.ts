import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { pipeWireInputs } from "../../../Server/src/capture/pipewire-discovery.ts";
import { type Desktop, type Destination } from "./controller.ts";
import type { SourceID } from "./sources.ts";
import { NativeDestinations } from "./native-destination.ts";
import type { TextInsertionMethod } from "./text-insertion.ts";

export async function command(args: string[], timeout = 1500, input?: string): Promise<string> {
  const child = Bun.spawn(args, {
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  try {
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) throw new Error(`${args[0]} is unavailable.`);
    return output;
  } finally {
    clearTimeout(timer);
  }
}
/**
 * Posts DictaDuo's notifications through notify-send, each replacing the
 * previous one instead of stacking. Sends are serialized so every one knows the ID.
 */
export class Notifier {
  private id?: string;
  private queue: Promise<void> = Promise.resolve();
  constructor(private run: (args: string[]) => Promise<string> = command) {}
  notify(title: string, body?: string): void {
    this.queue = this.queue.then(async () => {
      try {
        const output = await this.run([
          "notify-send",
          "--app-name=DictaDuo",
          "--expire-time=6000",
          "--print-id",
          ...(this.id ? [`--replace-id=${this.id}`] : []),
          title,
          ...(body ? [body] : []),
        ]);
        const id = output.trim();
        if (/^\d+$/.test(id)) this.id = id;
      } catch {}
    });
  }
  /** Resolves once queued notifications were handed to notify-send. */
  settled(): Promise<void> {
    return this.queue;
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
interface Window {
  address: string;
  pid: number;
}
async function activeWindow(): Promise<Window | undefined> {
  const value: unknown = JSON.parse(await command(["hyprctl", "-j", "activewindow"]));
  if (
    !object(value) ||
    typeof value.address !== "string" ||
    !/^0x[0-9a-f]+$/i.test(value.address) ||
    typeof value.pid !== "number" ||
    value.pid <= 0
  )
    return undefined;
  return { address: value.address, pid: value.pid };
}
const preview = (): Destination => ({ deliver: async () => "preview", close() {} });
export class HyprlandDesktop implements Desktop {
  readonly kind = "hyprland";
  get keyboardAccess() {
    return this.destinations.keyboardAccess;
  }
  enableKeyboardAccess(): void {
    this.destinations.enableKeyboardAccess();
  }
  private socket?: Socket;
  private monitor?: ReturnType<typeof Bun.spawn>;
  private connected = false;
  private destinations = new NativeDestinations();
  private focusRevision = 0;
  private unsafe = () => {};
  constructor(private helper: string) {
    this.destinations.warm(helper);
  }
  async monitorSession(
    unsafe: () => void,
    shortcut: (action: "start" | "stop" | "cancel" | "copy") => void = () => {},
  ): Promise<void> {
    this.unsafe = unsafe;
    const runtime = process.env.XDG_RUNTIME_DIR;
    const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
    if (!runtime || !signature || signature.includes("/"))
      throw new Error("Start DictaDuo inside the Hyprland session.");
    let buffer = "";
    this.socket = connect(join(runtime, "hypr", signature, ".socket2.sock"));
    await new Promise<void>((resolve, reject) => {
      this.socket!.once("connect", resolve);
      this.socket!.once("error", reject);
    });
    this.connected = true;
    this.socket.on("error", () => {
      this.connected = false;
      this.unsafe();
    });
    this.socket.on("close", () => {
      this.connected = false;
      this.unsafe();
    });
    this.socket.on("data", (data: Buffer) => {
      buffer += data.toString();
      if (buffer.length > 65536) {
        this.socket?.destroy();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("activewindowv2>>") || line.startsWith("closewindow>>")) {
          this.focusRevision++;
          this.destinations.invalidate();
          if (line.startsWith("activewindowv2>>"))
            void activeWindow()
              .then((window) => {
                if (window) this.destinations.warm(this.helper, String(window.pid));
              })
              .catch(() => {});
        }
        const action = shortcutEvent(line);
        if (action) shortcut(action);
      }
    });
    // Any session lock or impending system sleep invalidates this desktop's take.
    // The server-side capture owned by the Mac is deliberately unaffected.
    this.monitor = Bun.spawn(
      [
        "dbus-monitor",
        "--system",
        "type='signal',interface='org.freedesktop.login1.Manager',member='PrepareForSleep'",
        "type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path_namespace='/org/freedesktop/login1/session'",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const monitor = this.monitor;
    if (!(monitor.stdout instanceof ReadableStream))
      throw new Error("Session monitor unavailable.");
    const output = monitor.stdout;
    void (async () => {
      const reader = output.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          pending = (pending + decoder.decode(next.value, { stream: true })).slice(-8192);
          if (/member=PrepareForSleep|"LockedHint"|"Active"/.test(pending)) {
            // Conservatively cancel on either transition, including rapid lock/unlock.
            this.unsafe();
            pending = "";
          }
        }
      } finally {
        this.connected = false;
        this.unsafe();
      }
    })().catch(() => {
      this.connected = false;
      this.unsafe();
    });
  }
  async unlocked(since = Date.now()): Promise<boolean> {
    if (!this.connected) return false;
    try {
      const [state, lockJSON, monitorsJSON] = await Promise.all([
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
        command(["omarchy-shell", "lock", "status"]),
        command(["hyprctl", "-j", "monitors"]),
      ]);
      return desktopUnlocked(state, JSON.parse(lockJSON), JSON.parse(monitorsJSON), since);
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
  private notifier = new Notifier();
  notify(title: string, body?: string): void {
    this.notifier.notify(title, body);
  }
  async capture(method: TextInsertionMethod = "automatic"): Promise<Destination> {
    const startedAt = Date.now();
    const revision = this.focusRevision;
    const window = await activeWindow().catch(() => undefined);
    if (!window || revision !== this.focusRevision) return preview();
    const destination = await this.destinations.capture(this.helper, String(window.pid), method);
    if (revision !== this.focusRevision) {
      destination.close();
      return preview();
    }
    return {
      get reason() {
        return destination.reason;
      },
      close: () => destination.close(),
      deliver: async (text, held) => {
        if (!(await this.unlocked(startedAt))) {
          destination.close();
          return "preview";
        }
        const current = await activeWindow().catch(() => undefined);
        if (current?.address !== window.address || current.pid !== window.pid) {
          destination.close();
          return "preview";
        }
        return destination.deliver(text, held);
      },
    };
  }
  close(): void {
    this.destinations.close();
    this.connected = false;
    this.socket?.destroy();
    this.monitor?.kill();
  }
}

export function shortcutEvent(line: string): "start" | "stop" | "cancel" | "copy" | undefined {
  const prefix = "custom>>dictaduo:";
  if (!line.startsWith(prefix)) return undefined;
  const action = line.slice(prefix.length);
  return action === "start" || action === "stop" || action === "cancel" || action === "copy"
    ? action
    : undefined;
}

/** Omarchy's locker does not necessarily update logind's LockedHint. Check both,
 * including the compositor's orphan-lock signal and a rapid lock/unlock cycle. */
export function desktopUnlocked(
  state: string,
  lock: unknown,
  monitors: unknown,
  since: number,
): boolean {
  if (
    !["LockedHint=no", "Active=yes", "Type=wayland", "State=active"].every((line) =>
      state.split("\n").includes(line),
    )
  )
    return false;
  if (
    !object(lock) ||
    lock.locked !== false ||
    lock.requested !== false ||
    lock.pending !== false ||
    lock.sessionLocked !== false ||
    lock.secure !== false ||
    typeof lock.lastEventAt !== "string"
  )
    return false;
  if (lock.lastEventAt !== "" && !(Date.parse(lock.lastEventAt) <= since)) return false;
  if (!Array.isArray(monitors) || monitors.length === 0) return false;
  const blockers = monitors.map((m) => (object(m) ? m.solitaryBlockedBy : undefined));
  if (blockers.some((b) => !Array.isArray(b) || b.includes("LOCK"))) return false;
  return blockers.some((b) => Array.isArray(b) && !b.includes("WORKSPACE"));
}
