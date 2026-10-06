import { defaultProofreadingPrompt, saveSharedPreferences } from "./processing.ts";
import { HistoryTools } from "./history.ts";
import { legacySourceEdit, microphoneSnapshot } from "./microphones.ts";
import { ClientNotice } from "./errors.ts";
import { command } from "./desktop.ts";
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { validateBody } from "../../../Server/src/validation.ts";
import { API, APIError } from "./api.ts";
import { configPath, parseConfig, type Config } from "./config.ts";
import type { Controller, Desktop } from "./controller.ts";
import type { ButtonDestinationClient } from "./buttons.ts";
import { eligible, sourceKey, selectionExplanation, unavailableReason } from "./sources.ts";
import type { ShortcutSettings } from "./shortcuts.ts";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Deliberately small API: no arbitrary server paths, credentials or capture ownership tokens. */
export function createGUIHandler(
  api: API,
  controller: Controller,
  desktop: Desktop,
  initial: Config,
  buttons?: ButtonDestinationClient,
  shortcuts?: ShortcutSettings,
  onConfigSaved?: (config: Config) => void,
  file = configPath(),
) {
  let config = initial;
  let shortcutQueue: Promise<unknown> = Promise.resolve();
  const history = new HistoryTools(api);
  const saveConfig = (next: Config) => {
    // Synchronous compare-and-replace keeps new takes and settings writes ordered.
    const disk = parseConfig(JSON.parse(readFileSync(file, "utf8")));
    if (JSON.stringify(disk) !== JSON.stringify(config))
      throw new ClientNotice("Configuration changed externally. Restart the client.");
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    try {
      renameSync(temp, file);
    } finally {
      try {
        unlinkSync(temp);
      } catch {}
    }
    config = next;
    onConfigSaved?.(next);
  };
  const handle = async (request: unknown): Promise<unknown> => {
    if (!object(request) || request.version !== 1 || typeof request.action !== "string")
      throw new ClientNotice("Unsupported GUI request.");
    if (request.action === "snapshot")
      return {
        version: 1,
        activity: controller.activity,
        feedback: controller.feedback.snapshot(),
        busy: controller.busy,
        canStartTake: controller.canStartTake,
        message: controller.state,
        result: controller.result ?? null,
        hasLastDictation: controller.lastDictation !== undefined,
        device: config.device,
        server: config.server,
        sources: config.sources,
        microphones: microphoneSnapshot(config.sources),
        buttonEnabled: config.buttonEnabled,
        activationMode: config.activationMode,
        muteOutputWhileRecording: config.muteOutputWhileRecording,
        textInsertionMethod: config.textInsertionMethod,
        shortcut: shortcuts?.snapshot() ?? null,
        buttonSettingsSupported: buttons !== undefined,
        button: buttons?.state
          ? {
              selected: buttons.state.selected,
              available: buttons.state.available,
              destinations: buttons.state.destinations,
              buttonTarget: buttons.state.buttonTarget ?? null,
              selectedHere: buttons.selectedHere,
            }
          : null,
        desktop: desktop.kind ?? "hyprland",
        configPath: file,
      };
    if (request.action === "stop") {
      controller.stop();
      return {};
    }
    if (!(await desktop.unlocked())) throw new ClientNotice("Unlock this computer first.");
    switch (request.action) {
      case "start":
        // The window and tray start a new take; only the shortcut pastes a cancelled one.
        // Settle the undo window only once a new take can actually start.
        if (request.shortcut !== true && controller.canStartTake) controller.closeUndo();
        if (!controller.start())
          throw new ClientNotice("Finish dictation or the shortcut check first.");
        return {};
      case "shortcuts":
        if (!shortcuts)
          throw new ClientNotice("Update the background client for shortcut settings.");
        return shortcuts.refresh();
      case "saveShortcut":
        if (!shortcuts)
          throw new ClientNotice("Update the background client for shortcut settings.");
        return shortcuts.save(request.key, request.revision);
      case "checkShortcut":
        if (!shortcuts)
          throw new ClientNotice("Update the background client for shortcut checking.");
        return shortcuts.startCheck();
      case "endShortcutCheck":
        shortcuts?.check.end();
        return {};
      case "test":
        if (!controller.start(undefined, true))
          throw new ClientNotice("Finish dictation or the shortcut check before testing.");
        return {};
      case "cancel":
        await controller.cancel();
        return {};
      case "undo":
        controller.undo();
        return {};
      case "copyLast": {
        const result = controller.lastDictation;
        if (!result) throw new ClientNotice("There is no dictation to copy yet.");
        await command(["wl-copy", "--type", "text/plain;charset=utf-8"], 1500, result.text);
        return {};
      }
      case "saveActivationMode":
        if (request.mode !== "hold" && request.mode !== "doubleTap")
          throw new ClientNotice("Choose hold or double tap.");
        if (controller.busy)
          throw new ClientNotice("Finish dictation before changing how it starts.");
        saveConfig(parseConfig({ ...config, activationMode: request.mode }));
        return { mode: request.mode };
      case "saveMuteOutput":
        if (typeof request.enabled !== "boolean")
          throw new ClientNotice("Invalid output muting setting.");
        // Only affects the next take, so it can change while one is running.
        saveConfig(parseConfig({ ...config, muteOutputWhileRecording: request.enabled }));
        controller.muteOutput = request.enabled;
        return { enabled: request.enabled };
      case "saveTextInsertionMethod":
        if (request.method !== "automatic" && request.method !== "unicodeTyping")
          throw new ClientNotice("Choose Automatic or Type text.");
        if (controller.busy)
          throw new ClientNotice("Finish dictation before changing text insertion.");
        saveConfig(parseConfig({ ...config, textInsertionMethod: request.method }));
        controller.textInsertionMethod = request.method;
        return { method: request.method };
      case "saveButton": {
        if (!buttons)
          throw new ClientNotice("Update the background client to change DJI button settings.");
        if (typeof request.enabled !== "boolean")
          throw new ClientNotice("Invalid DJI button setting.");
        if (controller.busy)
          throw new ClientNotice("Finish dictation before changing DJI button settings.");
        saveConfig(parseConfig({ ...config, buttonEnabled: request.enabled }));
        await buttons.setEnabled(request.enabled);
        return { enabled: buttons.enabled };
      }
      case "receiver": {
        // Discovery refreshes receiver status; checking never registers or selects a destination.
        const { sources, sharingHost } = await api.sources();
        const state = await api.buttonStatus();
        const identity = state.source;
        const source = identity
          ? sources.find((source) => sourceKey(source.identity) === sourceKey(identity))
          : undefined;
        return {
          available: state.available,
          selected: state.selected ?? null,
          destinations: state.destinations,
          buttonTarget: state.buttonTarget ?? null,
          source: source ?? null,
          // Other computers only see the receiver's source details when it is shared.
          reported: identity !== undefined,
          sharingHost: sharingHost ?? null,
          checkedAt: new Date().toISOString(),
        };
      }
      case "setButtonTarget":
        return api.setButtonTarget(validateBody("ButtonTarget", request.target));
      case "setSharing":
        if (typeof request.shared !== "boolean")
          throw new ClientNotice("Invalid microphone sharing setting.");
        try {
          return await api.setSharing(
            validateBody("AudioSourceIdentity", request.source),
            request.shared,
          );
        } catch (error) {
          if (error instanceof APIError && error.code === "source_not_found")
            throw new ClientNotice("This microphone is no longer connected.");
          if (error instanceof APIError && error.code === "sharing_local_only")
            throw new ClientNotice(
              "Sharing is set on the computer the microphone is plugged into.",
            );
          throw error;
        }
      case "connection":
        return api.health();
      case "sources": {
        const [{ sources, sharingHost }, defaultID] = await Promise.all([
          api.sources(),
          desktop.defaultInput(config.sources.hostID),
        ]);
        const device = config.device.id;
        return {
          items: sources.map((source) => ({
            ...source,
            eligible: eligible(source, device),
            unavailableReason: unavailableReason(source, device),
          })),
          sharingHost: sharingHost ?? null,
          ...selectionExplanation(sources, config.sources, defaultID, device),
        };
      }
      case "history":
        return history.list(request.before, request.source, request.queryID);
      case "historyEntry":
        return history.entry(request);
      case "retryHistory":
        return history.retry(request);
      case "historyAudio":
      case "historyArtifact":
      case "deleteHistory":
        return history.action(request.action, request);
      case "processingDefaults":
        return { proofreadingPrompt: defaultProofreadingPrompt };
      case "preferences":
        return api.preferences();
      case "savePreferences":
        if (request.server !== undefined && request.server !== config.server)
          throw new ClientNotice(
            "The connected server changed. Discard and reload before editing its shared settings.",
          );
        return saveSharedPreferences(api, request.value);
      case "saveMicrophones": {
        if (controller.busy)
          throw new ClientNotice("Finish dictation before changing microphone lists.");
        if (request.revision !== microphoneSnapshot(config.sources).revision)
          throw new ClientNotice(
            "Microphone settings changed. Reload the latest settings, then edit again.",
          );
        if (
          !object(request.value) ||
          request.value.server !== config.server ||
          request.value.hostID !== config.sources.hostID
        )
          throw new ClientNotice(
            "Microphone lists belong to this server and microphone computer. Reload saved settings.",
          );
        const next = parseConfig({ ...config, sources: request.value });
        saveConfig(next);
        controller.updatePreferences(config.sources);
        return microphoneSnapshot(config.sources);
      }
      case "saveSources": {
        if (controller.busy) throw new ClientNotice("Finish dictation first.");
        const next = parseConfig({
          ...config,
          sources: legacySourceEdit(config.sources, request.value),
        });
        saveConfig(next);
        controller.updatePreferences(config.sources);
        return config.sources;
      }
      default:
        throw new ClientNotice("Unknown GUI action.");
    }
  };
  return (request: unknown): Promise<unknown> => {
    if (object(request) && (request.action === "start" || request.action === "stop")) {
      const next = shortcutQueue.then(() => handle(request));
      shortcutQueue = next.catch(() => {});
      return next;
    }
    return handle(request);
  };
}
