# Essential Omarchy client

Ref #8, #11. `Clients/Linux` adds a small Bun executable and an AT-SPI destination helper. It uses the capture API from #5/#6 and can run independently of the later Linux GUI (#10). It is stacked on PR #12. Installation and the daily app/microphone trial are still pending; the existing SottoDuo server and Voxtype bindings have not been changed.

## Everyday workflow

Start the daemon in your graphical session. Hold the configured key, wait for the **recording** notification, speak, then release. A short tap released before admission does not start a recording. `sottoduo toggle` supports a second shortcut if preferred; `sottoduo cancel` cancels the take the overlay shows. Once the server seals a take, the next one can start while the earlier one processes; insertions happen in recording order and wait until the newer take is released. To dictate hands-free, set **Trigger** under **This computer** to **Double tap to toggle**: two taps of the dictation key within 0.45 seconds start recording, and another double tap stops it. A single tap or a longer press does nothing. The compositor only reports the dictation key, so unlike on the Mac, typing between the two taps does not break the pair. The DJI button is not claimed by this client.

A completed take inserts once into the original accessible field only when the destination checks succeed. Otherwise a notification says the text is ready: `sottoduo result` prints it; `sottoduo copy` explicitly replaces the clipboard so you can paste it yourself. An uncertain insertion is identified separately; check the field before copying. Notifications never display dictated text. The last result lives only in this process and is cleared when starting a new take. Older results remain in shared server history.

No key injection, automatic clipboard replacement, clipboard restoration, or automatic Enter is involved. Keyboard modifiers therefore cannot turn delivery into a different paste shortcut. Explicit copying intentionally replaces the clipboard; SottoDuo never restores old clipboard data over newer user content. Terminals use the manual-copy path, so their paste conventions and shell command execution remain under the user's control.

## Build and setup

Requires Linux, Bun for development, a C compiler, pkg-config, `at-spi2-core`, and `json-glib`. Runtime dependencies are `hyprctl`, `omarchy-shell`, `loginctl`, `dbus-monitor`, `pw-dump`, `notify-send`, `wl-copy`, and the native helper's shared libraries. The current destination/lock adapter targets Omarchy 4 / Hyprland 0.56; it fails closed when required state is unavailable. It is not a generic Wayland client yet.

```sh
bun install --frozen-lockfile
bash scripts/build-linux-client.sh
./build/linux-client/sottoduo --help

# HOST must match the server's --capture-host-id on this desktop.
# The token file is an existing private bearer-token file, not its literal contents.
./build/linux-client/sottoduo init http://127.0.0.1:8391 HOST "/absolute/path/server-token" "/absolute/path/build/linux-client/sottoduo-destination"
./build/linux-client/sottoduo sources
./build/linux-client/sottoduo daemon
```

`init` creates `~/.config/sottoduo/linux-client.json` once, with a persistent device UUID; it never overwrites an existing configuration. `SOTTODUO_CLIENT_CONFIG` selects an isolated configuration for a test. The token file must be a regular file owned by the user with no group/other permissions. Tokens never appear in command arguments, notifications, history, or IPC responses.

The server must already be deployed with the optional PipeWire capture provider enabled. This client does not install the provider, grant USB access, pair Bluetooth devices, or change the daily server. A server with no registered sources cannot record from this client. Desktop inputs are captured by the same provider, with no second local capture path.

For autostart, first place the executable and helper in `~/.local/opt/sottoduo-linux/current/` and put `sottoduo` on PATH. Configure the helper's installed absolute path, then adapt/install [the user service](../Clients/Linux/integration/sottoduo-client.service). Enable it only after the desktop trial. It requires the graphical session's `WAYLAND_DISPLAY`, `HYPRLAND_INSTANCE_SIGNATURE`, `XDG_RUNTIME_DIR`, and session D-Bus environment. The installed Omarchy session already exports these to systemd. Restart begins idle; it never reloads old takes for insertion. If desktop monitoring fails, stop/restart the client before trying again.

[The Lua binding example](../Clients/Linux/integration/bindings.lua) uses Menu for press/release, Super+Menu to cancel, and Super+Shift+Menu to copy the last result. Kris chose to replace the existing Menu → Voxtype toggle; the example explicitly unbinds it before adding SottoDuo. F9 remains assigned to Voxtype. Recheck bindings before installation. Release ignores modifiers, so pressing another modifier while speaking still stops the take. Recording is not enabled on the lock screen. Validate changes with `hyprctl reload` followed by `hyprctl configerrors`.

The example follows the installed Omarchy `o.bind` helper and the [Hyprland bind flags](https://wiki.hypr.land/configuring/core/binds/flags/). No user desktop configuration is installed by the build.

## Desktop microphone preferences

Edit this desktop's configuration and restart the daemon. `sources` contains:

```json
{
  "server": "http://127.0.0.1:8391",
  "hostID": "omarchy",
  "mode": "automatic",
  "priority": [{ "hostID": "omarchy", "id": "STABLE_SOURCE_ID_FROM_SOTTODUO_SOURCES" }]
}
```

- `automatic`: saved priorities, then the eligible desktop system default. If there is no eligible default, use the same-host input with the smallest stable identity.
- `fixed`: the `fixed: {hostID, id}` source, then the desktop fallback.
- `systemDefault`: only the desktop default/fallback, ignoring favorites.

Preferences are independent of the Mac's. Unknown remote hosts are not implicitly selected. Source preferences are bound to the server origin: changing `server` requires deliberately reselecting sources and updating their scope. The desktop maps PipeWire's default node through the existing provider's stable identity function; node numbers are never saved. A registered DJI is one source even though client and server run on the same host.

Readiness matches the Mac: fresh observations (0–3.5 seconds), present, capture available, connected/notApplicable link, and no known degraded audio. A definitive pre-ready 503 permits one fallback with a fresh owner and request ID inside the original three-second activation budget. Ambiguous admission/network timeouts never start a second microphone. After readiness, loss cancels rather than splicing sources.

Bluetooth remains a distinct source and is not paired or connected by discovery. The server supports already-connected Bluetooth mono/stereo microphones, including WirePlumber's headset auto-switch source; missing connection state and unsupported inputs remain unavailable. Add that source after DJI in the automatic priority list to use it for new takes when DJI is unavailable. Direct DJI Bluetooth testing remains #4. A connected DJI status still cannot detect the confirmed living-room radio gaps. This client makes no new range or seamless radio handoff claim.

## Destination safety and limits

The native helper retains one AT-SPI accessible object, restricted to the initiating Hyprland application's PID. Overlapping takes aimed at the same unchanged field share that helper. It requires an editable, enabled, showing, focused entry/text role, no selection, a valid caret, and no password or terminal ancestor. The current field is hashed in memory, never logged or saved. AT-SPI focus/text/caret/selection changes invalidate the target, even if focus later returns. The helper exempts only its own exact insertion and resulting caret event, advancing the queued takes' snapshot only when the resulting text hash and caret match the expected insertion. Final checks repeat the role, state, text hash, and caret comparison.

Delivery calls [AT-SPI InsertText](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/method.EditableText.insert_text.html) on that retained object, rather than sending paste keystrokes to whatever happens to be focused. Hyprland window changes and application disappearance also invalidate delivery. There is one mutation attempt per take. A timeout/false/error response is **uncertain**, not permission to retry, and closes the shared helper. The helper closes when its last queued take finishes or cancels. There is no automatic selected-text replacement or continuation anchor after the queue finishes.

AT-SPI is application-provided metadata. Password roles are rejected, but arbitrary applications can omit or misreport accessibility information. Web form semantics, rich editors, embedded terminals, and application-specific protected inputs are not claimed to have macOS Accessibility parity. Missing/unsupported metadata uses preview/manual copy. There is no atomic compositor+accessibility transaction; insertion is pinned to the original object to avoid redirecting text into a newly focused application.

Lock safety checks logind activity, Omarchy shell `lock status`, and Hyprland monitor lock blockers. Unknown state, pending locks, and orphaned compositor locks block delivery. The lock event timestamp catches a lock/unlock cycle between checks. Logind sleep/session events cancel promptly; a wall-clock gap over 2.5 seconds cancels on resume. Only this desktop's owned session is cancelled. The Mac's server-side take is unaffected by a desktop lock.

## Validation and app matrix (2026-09-21)

| Destination | Evidence / behavior |
| --- | --- |
| Real GTK 3 test entry on this Hyprland session | Norwegian characters and emoji inserted; changed text, caret, selection, focus, password transition, and initial password input rejected. |
| Hyprland adapter plus real GTK entry | One insertion, repeated attempt rejected, application disappearance safely falls back. |
| Terminal | Deliberately manual copy. No shell input injection or automatic Enter. Actual daily terminal trial pending. |
| Chromium / Firefox | Detected on this desktop; actual editable fields and password behavior need the daily app trial. Unsupported accessibility uses manual copy. |
| T3 Code / editor | Detected on this desktop; editable-field versus embedded terminal behavior still needs the daily app trial. |

Automated tests use the real HTTP coordinator and synthetic audio, covering owner attribution/history/receipts, one pre-ready fallback, uncertain admission, cancellation during admission, early release, heartbeat loss, lock cancellation, heartbeats through drain, and no repeated insertion after receipt failure. IPC tests verify private socket permissions, exclusive daemon ownership, and restart without a take. Lock-policy fixtures exercise pending, orphan, rapid lock/unlock, inactive-session and unknown-monitor states.

```sh
bun run check
bun run test
bun run fmt:check

# Supervised native test: briefly opens and closes disposable GTK windows.
mkdir -p .local
cc -Wall -Wextra -Werror Clients/Linux/tests/entry-fixture.c $(pkg-config --cflags --libs gtk+-3.0) -o .local/entry-fixture
SOTTODUO_TEST_DESKTOP=1 bun test Clients/Linux/tests/native-destination.test.ts
```

Remaining #8/#11 trials: chosen shortcut press/release including modifiers; daily terminal/browser/editor matrix; explicit clipboard copy while clipboard ownership changes; real lock/unlock and suspend/resume; server/provider stop and unplug; source fallback with actual desktop microphones; two-computer ownership; and a complete spoken DJI take. Those checks need the capture-enabled server deployment and user interaction. The earlier DJI range/dropout findings and the user's decision to skip receiver-placement testing remain unchanged.

## Mac UI continuity

Kris selected the Mac app as the visual reference, particularly its settings arrangement and live dictation UI. The final Linux experience should preserve the Dictation/History/Microphone/Server preferences/This computer navigation, familiar settings sections, source/fallback controls, and compact floating recording capsule. Match `SottoDuoWindowView.swift`, `PreferencesPage.swift`, `MicrophonePage.swift`, `MenuHUDViews.swift`, `RecordingFeedback.swift`, and the existing warm-light/Glacier-dark theme. No unrelated redesign is intended. The overlay must not steal keyboard focus; current CLI and notification feedback are testing scaffolding. Full implementation and visual acceptance remain #10.

The binding integration uses `hl.dsp.event` through Hyprland's ordered event socket rather than starting a CLI process for each edge. This prevents fast press/release commands being reordered by process startup. The installed Hyprland 0.56.2 parser accepted the Menu bindings in an isolated `--verify-config` check; the daily configuration has not been edited.

DJI transmitter-button destination routing is documented in [dji-button-routing.md](dji-button-routing.md).
