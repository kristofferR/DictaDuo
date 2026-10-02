import { API } from "./api.ts";
import { ButtonDestinationClient } from "./buttons.ts";
import type { Config } from "./config.ts";
import { ConnectionSettings } from "./connection.ts";
import { Controller, type Desktop } from "./controller.ts";
import { command } from "./desktop.ts";
import { ClientNotice } from "./errors.ts";
import { createGUIHandler } from "./gui.ts";
import { DoubleTap, edgeTime } from "./double-tap.ts";
import { OutputMuter } from "./output.ts";
import type { Command } from "./ipc.ts";
import type { ShortcutSettings } from "./shortcuts.ts";

/** Each connection owns immutable API clients, takes and button registrations. */
export class ClientRuntime {
  private current?: ReturnType<ClientRuntime["create"]>;
  private changing = false;
  private mutations = 0;
  private generation = 0;
  private shortcutQueue: Promise<unknown> = Promise.resolve();
  private readonly doubleTap = new DoubleTap();
  /** The take a pending tap was made during, so a pair cannot span one ending. */
  private tapTake?: number;
  private readonly output = new OutputMuter();
  shortcuts?: ShortcutSettings;
  constructor(
    readonly settings: ConnectionSettings,
    private desktop: Desktop,
  ) {}
  get busy() {
    return this.changing || !!this.current?.controller.busy;
  }
  start() {
    if (!this.current && this.settings.config && this.settings.api)
      this.current = this.create(this.settings.config, this.settings.api);
  }
  private create(
    config: Config,
    api: API,
    controller = new Controller(api, this.desktop, config.device, config.sources),
  ) {
    controller.captureAllowed = () => !this.changing && !this.shortcuts?.blocked;
    controller.output = this.output;
    controller.muteOutput = config.muteOutputWhileRecording;
    const buttons = new ButtonDestinationClient(
      api,
      this.desktop,
      controller,
      config.device,
      config.buttonEnabled,
    );
    const gui = createGUIHandler(
      api,
      controller,
      this.desktop,
      config,
      buttons,
      this.shortcuts,
      (next) => this.settings.accepted(next),
      this.settings.file,
    );
    buttons.start();
    return { api, controller, buttons, gui };
  }
  async close() {
    this.changing = true;
    const current = this.current;
    await Promise.allSettled([current?.buttons.close(), current?.controller.cancelAll()]);
    await Promise.all([current?.controller.discardsSettled(), this.output.finish()]);
  }
  unsafe() {
    this.shortcuts?.check.end();
    void this.current?.buttons.disarm().catch(() => {});
    // A take already delivering keeps its single insertion attempt.
    void this.current?.controller.cancelAll(false).catch(() => {});
  }
  gui(request: unknown): Promise<unknown> {
    if (
      request &&
      typeof request === "object" &&
      "action" in request &&
      (request.action === "start" ||
        request.action === "stop" ||
        request.action === "releasePortalShortcut")
    ) {
      const next = this.shortcutQueue.then(() => this.handleGUI(request));
      this.shortcutQueue = next.catch(() => {});
      return next;
    }
    return this.handleGUI(request);
  }
  private async handleGUI(request: unknown): Promise<unknown> {
    if (
      !request ||
      typeof request !== "object" ||
      !("version" in request) ||
      request.version !== 1 ||
      !("action" in request) ||
      typeof request.action !== "string"
    )
      throw new ClientNotice("Unsupported GUI request.");
    const input = request as Record<string, unknown>;
    const action = request.action;
    if (action === "snapshot") {
      const current = this.current;
      const snapshot = current
        ? await current.gui(request)
        : {
            version: 1,
            activity: { phase: "idle" },
            busy: false,
            result: null,
            message: "Set up your server connection in This computer.",
            server: this.settings.config?.server ?? "",
            device: this.settings.config?.device ?? { name: "This computer" },
            shortcut: this.shortcuts?.snapshot() ?? null,
          };
      if (current !== this.current) return this.gui(request);
      return {
        ...(snapshot as object),
        setupRequired: !this.current,
        setupMessage: this.settings.setupMessage,
        connectionChanging: this.changing,
        connectionRevision: this.generation,
      };
    }
    if (action === "releasePortalShortcut") {
      this.current?.controller.stop();
      return {};
    }
    // Plasma portal edges; the microphone test's Stop button sends an untagged stop.
    if (
      (action === "start" || action === "stop") &&
      input.shortcut === true &&
      this.doubleTapping
    ) {
      // Time the edge when the portal fired it, not after the lock check below.
      const at = edgeTime(input.at);
      if (action === "start" && !(await this.desktop.unlocked()))
        throw new ClientNotice("Unlock this computer first.");
      this.edge(action, at);
      return {};
    }
    if (action !== "stop" && !(await this.desktop.unlocked()))
      throw new ClientNotice("Unlock this computer first.");
    if (this.changing) throw new ClientNotice("The connection is changing. Try again in a moment.");
    if (action === "testConnection") return this.settings.test(input);
    if (action === "saveConnection") {
      if (this.busy || this.mutations || this.shortcuts?.blocked)
        throw new ClientNotice(
          "Finish dictation or the shortcut check before changing the connection.",
        );
      this.settings.validateSave(input.ticket, input.hostID);
      this.changing = true;
      const old = this.current;
      try {
        // Drain late registration requests using the old URL and credentials.
        await old?.buttons.close();
        if (!(await this.desktop.unlocked()))
          throw new ClientNotice("Unlock this computer before saving the connection.");
        const next = this.settings.commit(input.ticket, input.hostID);
        this.current = this.create(next.config, next.api);
        this.generation++;
        return { saved: true };
      } catch (error) {
        if (old && this.settings.config)
          this.current = this.create(this.settings.config, old.api, old.controller);
        throw error;
      } finally {
        this.changing = false;
      }
    }
    if (!this.current)
      throw new ClientNotice("Set up your server connection in This computer first.");
    const current = this.current;
    const generation = this.generation;
    const mutating = ![
      "connection",
      "sources",
      "history",
      "historyEntry",
      "preferences",
      "receiver",
      "shortcuts",
    ].includes(action);
    if (mutating) this.mutations++;
    try {
      const result = await current.gui(request);
      if (generation !== this.generation || this.changing)
        throw new ClientNotice("The connection changed. Reload this page.");
      return result;
    } finally {
      if (mutating) this.mutations--;
    }
  }
  private get doubleTapping() {
    return this.settings.config?.activationMode === "doubleTap";
  }
  /** A shortcut press or release. In double-tap mode only a double tap toggles recording. */
  private edge(edge: "start" | "stop", at?: number) {
    const controller = this.current?.controller;
    if (!controller) return;
    if (!this.doubleTapping) {
      if (edge === "start") controller.start();
      else controller.stop();
      return;
    }
    const take = controller.busy ? controller.activity.startedAt : undefined;
    if (take !== this.tapTake) this.doubleTap.reset();
    this.tapTake = take;
    if (edge === "start") this.doubleTap.press(at);
    else if (this.doubleTap.release(at)) controller.toggle();
  }
  async command(action: Command): Promise<string> {
    if (this.shortcuts?.check.consume(action))
      return "Shortcut detected. No recording or clipboard action was performed.";
    if (this.changing) return "The connection is changing. Try again in a moment.";
    const current = this.current;
    if (!current) return "Set up your server connection in SottoDuo → This computer first.";
    const { controller, buttons } = current;
    this.mutations++;
    try {
      switch (action) {
        case "arm":
          if (!buttons.enabled)
            return "Let the DJI button type here in SottoDuo → Microphone first.";
          await buttons.select();
          return "The DJI button now types into this computer.";
        case "disarm":
          if (!buttons.enabled) return "The DJI button is not allowed to type here.";
          await buttons.disarm();
          return "The DJI button no longer types into this computer.";
        case "button-status":
          return JSON.stringify({ ...buttons.state, enabled: buttons.enabled });
        case "start":
        case "stop":
          this.edge(action);
          break;
        case "toggle":
          controller.toggle();
          break;
        case "cancel":
          await controller.cancel();
          break;
        case "undo":
          controller.undo();
          break;
        case "status":
          return controller.state;
        case "result":
          return (
            controller.result?.text ??
            "No result in this session. Check shared history for older takes."
          );
        case "copy": {
          const result = controller.result;
          if (!result || !(await this.desktop.unlocked()) || controller.result !== result)
            return "No current result to copy, or the desktop is locked.";
          await command(["wl-copy", "--type", "text/plain;charset=utf-8"], 1500, result.text);
          return "Copied. Paste into your chosen field.";
        }
      }
      return controller.state;
    } finally {
      this.mutations--;
    }
  }
}
