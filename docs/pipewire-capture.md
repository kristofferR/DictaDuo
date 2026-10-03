# Linux microphone capture

Ref #6, using the [owned session contract](remote-capture.md). Capture is optional and runs in the same **user session** as PipeWire. The TypeScript provider lives in the existing server; a small `dictaduo-capture` subprocess owns each audio stream, and separate read-only helpers observe DJI status. No additional network endpoint, audio relay through the Mac, virtual driver, Bluetooth connection manager, or privileged server is needed. Client-uploaded audio remains usable with no provider or an unavailable PipeWire session. Container/system inference installations need a future authenticated user-agent bridge; this implementation does not expose the desktop socket to a container.

## Build and enable

The optional Linux helper dynamically links PipeWire, libusb and libsamplerate. On Arch, build dependencies are `base-devel`, `pkgconf`, `pipewire`, `libusb`, and `libsamplerate`. On Ubuntu 24.04 they are `build-essential`, `pkg-config`, `libpipewire-0.3-dev`, `libusb-1.0-0-dev`, and `libsamplerate0-dev`. Runtime needs PipeWire with WirePlumber and `pw-dump`, plus these shared libraries. The ordinary inference package does not acquire these dependencies unless capture packaging is enabled.

```sh
bash scripts/build-capture.sh                 # build/capture/dictaduo-capture
bash scripts/test-capture.sh                  # DSP checks + isolated PipeWire integration
DICTADUO_BUILD_CAPTURE=1 ./scripts/build-server.sh # include helper + service/rule templates
```

Add `--capture-helper /absolute/path/to/dictaduo-capture --capture-host-id omarchy-desktop` to the existing server arguments, or set `DICTADUO_CAPTURE_HELPER` and `DICTADUO_CAPTURE_HOST_ID`. Choose a unique, stable host ID and preserve it across upgrades. This is an explicit opt-in; it is not enabled by building or installing a package. Start only one server against a given data directory.

The example [user service](../Server/packaging/dictaduo-server.service) reads `%h/.config/dictaduo/server.env`. Supply the `DICTADUO_SERVER_*`, model/helper paths, optional Soniox key-file path, and the two capture variables there, using absolute paths. Environment files do not expand `$HOME`. Keep token/key values in private credential files. Review/adapt the template before installing it as `~/.config/systemd/user/dictaduo-server.service`; do not overwrite an existing unit blindly.

```sh
systemctl --user daemon-reload
systemctl --user enable --now dictaduo-server.service
systemctl --user status dictaduo-server.service
journalctl --user -u dictaduo-server.service
systemctl --user restart dictaduo-server.service
systemctl --user stop dictaduo-server.service
```

The service's control group and the helper's Linux parent-death signal release capture even if the coordinator crashes. On a normal shutdown the server cancels the take and waits for helper cleanup. A missing/restarted PipeWire session is retried automatically; ordinary graph discovery runs about once per second, without opening microphones. There is no need to restart the server after a receiver replug. New takes use its new PipeWire serial; a take already recording is cancelled.

## DJI permissions and status

The Mic Mini receiver `2ca3:4011` exposes unsolicited status on USB interface 6, endpoint `0x86`. A user must have permission to open that USB device. The optional [udev rule](../Server/packaging/70-dictaduo-dji.rules) grants local-seat access to this receiver only. Installing it under `/etc/udev/rules.d/` requires administrator authorization; reload udev rules and replug the receiver afterward. Never run the server as root, add blanket input-device permissions, detach audio drivers, or reset/pair the receiver to obtain status. `uaccess` is intended for a logged-in local user, not an unattended system account. Another program claiming interface 6 makes the source unavailable.

For a one-off test, an administrator can instead add a temporary per-user ACL on the verified `/dev/bus/usb/BBB/DDD` receiver node and remove that exact ACL afterward. Device numbers change on replug; verify the VID/PID before touching a node. Building the code does not install either permission change.

Only CRC-checked V2 full-status frames validated on the Mini 2S are accepted. Startup queued frames are discarded, followed by a fresh, naturally spaced observation. Status older than 2.5 seconds becomes unknown; identity/audio-level packets cannot refresh link freshness. The provider maps the ALSA card through sysfs to that exact USB bus/address, not the first matching product. Unsupported firmware or inaccessible/busy USB status remains unknown and cannot admit a DJI take. Raw status, serial numbers and audio are never logged.

**Connected is not healthy audio.** Our living-room test dropped audio while all 85 status reports remained connected. The provider therefore leaves `audioHealth` unknown, accepts digital silence, and never uses silence to switch microphones. It checks PipeWire mute/zero-volume state, but the tested DJI decoder does not expose a verified transmitter-mute flag. A linked transmitter can still be muted or out of usable RF range; connected status does not promise audibility. Bluetooth is a separate source, with automatic DJI radio handoff and Bluetooth button behavior unproven. The previously skipped receiver-placement experiment remains optional.

## Bluetooth microphones

Already-connected Bluetooth microphones can occupy a client's fallback priority list. Capture eligibility requires an associated PipeWire BlueZ device reporting `api.bluez5.connection=connected`, an exposed mono/stereo input, and a usable capture format. Missing connection state, mute, node errors and unsupported formats remain unavailable. Internal BlueZ sources are omitted to avoid duplicating WirePlumber's user-facing microphone.

WirePlumber's headset auto-switch loopback can advertise channels without a fixed rate. DictaDuo requests 48 kHz PCM from that source; WirePlumber negotiates the headset profile when capture starts. This is the delivered loopback format, not the Bluetooth codec's native rate. Direct BlueZ sources use their reported rate. Discovery does not pair, connect, open a stream or change profile policy. Audio readiness still requires the native helper's first valid buffer within the existing startup deadline.

AirPods Pro 3 were observed switching from A2DP to mSBC headset mode with a 16 kHz mono radio source, delivering 48 kHz mono through the loopback and stopping cleanly. This capture probe does not establish end-to-end fallback, reconnect reliability or range. Track those physical tests in #11. No mid-take handoff is implemented.

## Audio and lifecycle guarantees

- Stable source identity hashes the PipeWire node name and physical bus path under the configured host ID. It does not publish receiver serials or persist numeric node IDs. Identical ambiguous identities are omitted. Changing USB ports can produce a new identity, requiring preference selection again.
- This version captures ALSA and connected Bluetooth mono/stereo sources with a usable format. A take pins the current PipeWire object serial, capture rate/channels, retention setting and DJI transmitter mask. Registry removal, unexpected relinking, mute, connection loss, status expiry or transmitter-mask changes cancel it. WirePlumber fallback, moving and reconnecting are disabled for DictaDuo's capture stream. No global routing, playback volume or device gains are changed.
- Readiness follows the first valid buffer from the selected stream. Audio is interleaved float32 at the selected capture rate/channels. Inference is an equal-weight mono mix resampled to 16 kHz with libsamplerate's stateful anti-alias filter. Original retention uses those same input samples/interval and is omitted when the admitted preference is off. For a Bluetooth loopback this retains the delivered PCM, not raw radio-codec samples. The helper closes hardware before flushing its final filter tail; the coordinator drains acknowledged writes before sealing.
- Streams feed the existing archives and Soniox/Whisper pipeline directly. Native output is nonblocking: saturation fails the take. The coordinator batches approximately 100 ms of audio, caps queued writes at 2 MiB and validates frame sizes/finite samples. Meter updates use inference peaks; the session layer limits publication to 10 Hz. There is no unbounded queue or silent sample loss on backpressure.
- Abort kills the helper immediately, escalating to SIGKILL after 500 ms. Unexpected exit, corrupt/truncated output or write failure cannot seal a take. The helper detects target removal, known buffer discontinuity and a one-second audio-delivery stall. Its boot-time watchdog rejects host-suspend/long scheduling gaps and bounds capture to 181 seconds independently of the coordinator. These are known path failures, not RF silence heuristics.
- Capture-host screen lock alone does not cancel a Mac-owned take. Host sleep or source/provider loss does. Destination lock/sleep cancellation and the five-second ownership lease are specified in the session contract. The helper never pastes text or chooses another destination.

## Verification and remaining device checks

`bun test Server/tests/pipewire-capture.test.ts` exercises CRC/framing/freshness, stable discovery, original retention, silent audio, helper failure, cancellation and bounded writes through real child processes and existing generation storage. `scripts/test-capture.sh` verifies native conversion at 8/16/44.1/48/192 kHz with varied block boundaries, channel cancellation, exact interval counts and anti-alias attenuation. It also starts a private PipeWire daemon with a synthetic tone source to exercise real native capture, meters, retention, cancellation, lease expiry, rejected relinking, parent death, shutdown/restart and target removal. These integration checks require `pipewire`, `pw-cli`, `pw-link`, `pw-dump` and the SPA audiotestsrc plugin (`pipewire-bin` and `libspa-0.2-modules` on Ubuntu); they never connect to the desktop audio graph. Session ownership/lease tests remain in `capture-sessions.test.ts`.

Device acceptance also requires a short authorized capture with the actual receiver: start/heartbeat/stop from the Mac API, retained and inference-only WAV metadata, live meters/recognition previews, cancellation/lease loss, helper/coordinator crash cleanup, receiver replug and next-take recovery, and idle CPU/no idle recording. Physical sleep/replug and full Mac UI integration are distinct from automated tests. Track the evidence and any unrun cases in #6 and #11; do not call synthetic tests proof of RF reliability.

Implementation references: [PipeWire stream API](https://docs.pipewire.org/group__pw__stream.html), [WirePlumber linking policy](https://pipewire.pages.freedesktop.org/wireplumber/policies/linking.html), [libsamplerate stateful API](https://libsndfile.github.io/libsamplerate/api_full.html), and the [community DJI decoder at the inspected revision](https://github.com/ShadowBitBasher/DJI-Mic-Control/blob/9ba76880807a71d4eaba74c785dbee186a98f43b/crates/protocol/src/models/mic_mini.rs). Hardware findings and the corrected CRC8 seed come from #4.
