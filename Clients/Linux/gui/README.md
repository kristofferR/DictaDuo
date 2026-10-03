# DictaDuo for Linux

Direction A of the [design gallery](https://plans.kristofferr.com/d/fo12u4el8h2x), implemented in Qt Quick. The familiar five-page sidebar, shared preferences and compact dictation capsule stay consistent across themes.

## Build and run

Requires CMake 3.24+, a C++20 compiler, Qt 6.8+ (Quick, QuickControls2, Widgets, Network, Svg, DBus; Test for the default test build), LayerShellQt 6.6+, and the existing Bun Linux client toolchain. The default test build also needs dbus-run-session. On Arch these dependencies are provided by qt6-base, qt6-declarative, qt6-svg and layer-shell-qt.

From the repository root:

```sh
bash scripts/build-linux-client.sh
bash scripts/build-linux-gui.sh
build/linux-gui/dictaduo-gui --preview
```

Preview mode uses bundled sample data. It never connects to the client, opens a microphone, saves settings, or changes the desktop theme. It can copy sample text when explicitly requested.

For real use, start `build/linux-gui/dictaduo-gui` in your graphical session. **This computer → Background dictation** can install and start the matching `dictaduo` client as a systemd user service; it never overwrites a service configured outside DictaDuo. Open **This computer → Connection** to enter the server address, access token and device name. The daemon accepts setup requests even when its configuration or token is missing. Stored credentials are never sent to QML; a typed token is masked and cleared after submission or hiding the window.

Closing settings keeps the live capsule available, including on desktops without a system tray. Open DictaDuo from the application launcher or tray to return to the same window. A session-bus service permits only one live GUI per user session; sample-data previews remain independent. A missing or unresponsive session bus produces a launch error rather than starting a duplicate.

**This computer → Launch at login** writes DictaDuo’s own XDG autostart entry and starts the GUI with `--background`, without opening settings. Run the installed copy when enabling it, so startup uses a durable executable path. Disabling writes a hidden entry; it does not stop the current GUI or the separate dictation service. Existing entries managed outside DictaDuo are preserved, and save failures appear beside the switch. Preview mode cannot change startup.

**This computer → Quit DictaDuo feedback** (also in the optional tray menu) exits the GUI and removes the live capsule. On Plasma, its portal shortcut stops until DictaDuo is reopened; pairing-button dictation remains with the separate client. On Omarchy, shortcut dictation also remains available. The window still asks you to finish or cancel an active microphone test before closing or quitting.

Build the Linux client first, then install the GUI, matching client, destination helper and launcher with CMake's normal install command into an explicitly chosen prefix. The GUI sets up its own user service on request. It does not install receiver permissions or override an existing service. Login startup starts the GUI; the service starts independently after setup.

## Appearance

Choose a theme in **This computer → Appearance**:

- Follow system: selects DictaDuo warm light or Glacier dark using Qt's color scheme hint.
- DictaDuo warm light / Glacier dark: the approved Mac-like palette.
- Omarchy: reads the active `colors.toml` from `$XDG_STATE_HOME/omarchy/current/theme` (default `~/.local/state`), with compatibility for `~/.config/omarchy/current/theme`. Only literal six-digit hex color assignments are consumed. Missing or unsupported palettes fall back to Glacier with a visible explanation. Background, foreground and accent drive semantic colors, with contrast correction for unreadable foregrounds/accents. A palette change is picked up within three seconds.

The theme selection is local to the GUI. Reading Omarchy colors does not write theme files, install hooks or require Omarchy on other distributions. It uses the same layout and controls as the DictaDuo themes.

## Implemented behavior

- **This computer → Connection** tests authenticated server health and discovers capture hosts without recording. Save accepts the exact tested proposal for two minutes, retains the device ID, and applies without restarting the service. Blank tokens reuse the saved credential only at the same server origin. New credentials are written to a fresh private client token file and config is replaced atomically; existing/shared token files are never overwritten. Previous private token files are retained. Active dictation, shortcut checks, locked sessions and external configuration changes block saving. A connection switch drains old pairing-button registrations before replacing immutable API clients, clears the last result, rejects stale server replies, and starts unselected. Changing server or capture host resets microphone preferences to automatic. With no discovered sources, setup requires the server’s explicit capture host ID.

- Structured, versioned private Unix-socket snapshots of activity, source, trigger, last text, delivery and destination selection. The CLI command protocol remains compatible.
- Microphone tests use the existing capture controller and source fallback but **never capture a text destination, insert text or automatically select a pairing-button destination**. Test results remain available in DictaDuo and shared server history.
- Current transcript recovery distinguishes inserted, ready to copy and uncertain insertion. No automatic clipboard action or insertion retry.
- **History** filters by DictaDuo/Wispr Flow on the server and by device among loaded entries. The list/detail divider can be dragged. Load older preserves selection and deduplicates entries; refresh retains a still-visible selection. Details show final and original recognition text, duration, delivery, errors, cleanup/rejection explanations, omitted vocabulary and model/backend information. Copy gives visible feedback. Viewing history never inserts or replays a result.
- **Open audio / Open original** downloads the retained WAV privately and opens the default desktop audio player, matching the Mac. Imported Wispr Flow WAVs can also be opened. Authentication stays in the background client; the player only receives a local file URL. Temporary copies have mode 0600 in a private runtime directory, expire after 15 minutes while the client is running, and are pruned on later downloads after a restart. The cache retains at most four recordings, each limited to 128 MB; failed downloads are removed. Availability depends on what the server retained. No playback starts merely by selecting an entry.
- **Source files** opens files already archived with a Mac-imported Wispr Flow entry. Linux checks the server record and filename allowlist, downloads on an explicit click into the same private cache, validates WAV/PNG/JSON formats, and opens the desktop's default app. It never reads or imports a local Wispr Flow database.
- **Delete dictation** confirms that archived text/files disappear from shared history on every device. It targets the confirmed entry and server even if selection changes; the server rejects active recordings. Successful deletion removes this client's cached copies, refreshes pagination, and retains another selected entry when possible. Opened players may already hold their own copy. Connection changes clear the previous server's history, and late responses cannot open its audio or populate the new server's list.
- **Server preferences** edits recognition, language, vocabulary, audio retention and cleanup instructions, with a reset to DictaDuo's built-in cleanup prompt. The dictionary shows compact, independently collapsible lists and supports list names, preferred spellings, replacement phrases (one per line, preserving commas), priority words, and adding/removing lists and words. All edits remain drafts until Save changes. The shared server validation enforces dictionary and prompt limits before saving. Revision checks prevent overwriting another device's changes; conflicts and connection failures preserve the draft, and Discard and reload requires confirmation. Separate speech and cleanup model rows show the server's backend and readiness. Polling cannot overwrite unsaved edits or a newer save.
- **Microphone → Input priority** creates, renames, selects and deletes named lists (up to 16, with 32 inputs each). Drag a row handle to reorder, or use its keyboard-accessible menu to move up, down, to the top, or remove; disconnected inputs keep their place. Existing priorities appear as Default without rewriting configuration on startup. Lists retain host-scoped identities and saved names when inputs disconnect. Automatic uses the selected list; system-default and fixed-input modes remain separate, with the existing host fallback. The input picker includes connected microphones directly, and Test microphone is available on this page as on the Mac. Each change saves immediately; edits made during an in-flight write are queued and the latest state is saved next. A conflicting external revision requires an explicit reload, while temporary failures retry without dropping the displayed choice. Saving checks the page revision, desktop lock, active dictation and external config changes before updating the controller for the next take. Server/capture-host changes reset the lists. Older source-setting requests update the selected list while preserving other profiles.
- **Next dictation** explains the resolved input, unavailable earlier priorities, fixed-input fallback, or absence of an eligible source. Saved rows retain disconnected microphones and show capture-host and readiness details. Selection is checked again at start; an active take never changes microphones.
- **This computer → Shortcuts** shows the verified active key and offers Menu, F8, F9, F10 and F12 where available. It edits only DictaDuo's recognized Lua binding section, preserves surrounding configuration, keeps a backup, reloads Hyprland and validates the result. Conflicting keys, custom binding formats, active dictation and stale configuration are rejected; failed activation restores the prior file. Cancel follows Super + key and copy follows Super + Shift + key. The dictation keycap uses the verified key instead of a generic icon.
- **Check shortcut** consumes DictaDuo press/release/cancel/copy events for 30 seconds without recording or clipboard actions. A bounded, timestamped diagnostic log shows those events in an expandable section. A shared capture gate also blocks GUI microphone tests and pairing-button starts during the check. Finish, leaving settings, or hiding the window ends the check; a key still held when it ends must be released before recording is allowed. Only DictaDuo's namespaced commands are observed, never arbitrary typed keys.
- **This computer → DJI receiver on server** enables or disables pairing-button reception immediately and saves it for next login. Disabling retires this client's registration; enabling never selects it automatically. Destination controls reject changes during dictation and only release this computer's selection.
- **Check receiver** reads the server's current receiver/link and pairing-button status without recording or selecting a destination, even with reception disabled. Setup help distinguishes receiver USB access from pairing-button interface access. A connected link does not establish RF audio quality or mute state. Keyboard dictation retains fallback; pairing-button dictation pins the server receiver.
- The passive capsule reports preparing, recording, transcription/refinement, delivery and completion/failure. Real peak samples from the server's existing generation stream drive its nine-bar meter; missing/stale samples show an inactive meter, and silence remains distinguishable from missing data. The clock starts when capture is admitted and freezes at stop. Recordings have no time limit.
- The main dictation page displays provisional recognition text when the server provides it. Only the controller's completed result can be delivered or copied as a finished take. The feedback stream cannot select a microphone, fall back, insert text, or resume a recording. Stream failure removes levels and provisional text while the existing lease, lock checks, stop/cancel and final-result path retain control. No streaming support is assumed from a batch-only recognizer.
- On Wayland with layer-shell support, the capsule is a bottom-centred overlay on the active monitor, 80 logical pixels above the bottom edge. It reserves no workspace space, stays outside the tiling layout/task switcher, and accepts neither keyboard focus nor pointer input. Only the capsule uses layer-shell; settings remain an ordinary window. It shows only when the main window is not active; successful/failed completion lingers briefly. There are no decorative animations: recording IPC polls at 100 ms, other phases at 500 ms, and QML receives snapshots only when data changes. Cancellation remains in the settings window or existing desktop shortcut.

## Current boundaries

The presentation is distro-neutral. Omarchy/Hyprland remains the verified desktop. On Plasma Wayland, DictaDuo uses the GlobalShortcuts portal for a hold key, an AT-SPI focused text destination, and Plasma/logind lock checks. Keep the GUI running in the background for its portal shortcut. Plasma requires a real-device validation before it is considered verified; an unavailable portal or ambiguous text destination fails closed. The overlay requires a Wayland compositor implementing wlr-layer-shell (verified on Hyprland). Desktops without that protocol need a separate overlay adapter; exact placement is not guaranteed there. X11 uses passive tool-window flags and screen-relative positioning.

Shortcut editing supports DictaDuo's standard Omarchy Lua bindings; Plasma uses its desktop shortcut dialog instead. Draft persistence across application restarts is not implemented. **Wispr Flow history import is permanently a Mac-only action on this project; do not add a Linux importer.** Linux can read imported history and open its archived files from the shared server. History audio requires a default WAV player on the desktop. The GUI is deployed on the Omarchy desktop; overlay verification uses synthetic state without opening a microphone.

## Automated checks

```sh
bun run --cwd Clients/Linux test
bun run check
ctest --test-dir build/linux-gui --output-on-failure
QT_QPA_PLATFORM=offscreen QT_QUICK_BACKEND=software \
  build/linux-gui/dictaduo-gui --preview --theme dark --capture .local/gui/dark
```

`--capture` is limited to preview mode. It renders all five pages into PNGs, then each `states` entry in `preview.json` on the Dictation page (`dictation-<name>.png`), and exits. Qt tests check socket snapshots/disconnection, palette changes/fallback, page rendering without QML warnings, and non-activating overlay flags. Desktop tests use an isolated D-Bus session to verify background startup, duplicate-launch forwarding, missing-bus errors, autostart persistence, preview isolation and write failures. GUI tests retain the microphone-test close guard. Controller tests check that GUI tests cannot insert or select a destination. The opt-in Wayland test below shows the actual capsule twice with synthetic state, without connecting to the client or using a microphone. During the test, inspect `hyprctl -j layers` for `dictaduo-dictation` on layer 3, absence from `hyprctl -j clients`, unchanged tile geometry and unchanged keyboard focus. This does not test RF range.

```sh
DICTADUO_GUI_TEST_WAYLAND=1 QT_QPA_PLATFORM=wayland \
  build/linux-gui/dictaduo-gui-tests waylandOverlayLifecycle
```
