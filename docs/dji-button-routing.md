# DJI button destination routing

Ref #9. This is the USB receiver path verified on Kris's Mic Mini 2S (2ca3:4011), with audio and input monitoring hosted on Omarchy. The Mac and Linux clients can be destinations. The Linux controls are testing scaffolding; the planned GUI should follow the Mac settings and live dictation UI (Ref #8, #10).

## Everyday behavior

Enable **Let the DJI button type here** on each participating client (Microphone page). **Button types into** chooses the target and is stored on the server for every computer (`PUT /v1/button-destinations/target`):

- **Last computer I dictated on** (default): a successful computer-shortcut dictation selects that computer, provided DJI is available. `dictaduo arm` on Linux still selects explicitly in this mode.
- **Always <computer>**: that computer is selected whenever it is connected, including after lock, restart or reconnect. Dictating elsewhere does not move it.
- **Nowhere**: taps are ignored without turning the receiver off.

In the default mode, microphone tests, local DJI-button takes, ordinary typing, and pointer movement never select a destination. A later explicit selection takes precedence over an older in-flight shortcut take.

One transmitter linking-button tap requests recording on the selected computer. That client establishes its text target before admitting capture. Tap again to stop. A button take uses the configured USB DJI source only, even when the computer's normal microphone profile would choose something else. Keyboard takes retain their existing pre-ready fallback. No mid-recording source switch is supported.

Source and destination are pinned for the whole take. Menu/hotkey release only stops a keyboard take. Explicit cancel cancels the current local take. A button start received while that client is busy is declined; it cannot stop a keyboard take. A second deliberate tap during preparation cancels and disarms instead of leaving a delayed recording queued. Taps during stopping/processing do not start another take.

Registration is per process with a fresh 256-bit owner secret and five-second lease. Clients renew once per polling cycle, using 1.5-second request timeouts and a one-second pause. Commands also expire within five seconds. No button command is persisted, and only the target choice survives a restart. In the default mode, lock, sleep, client/network loss, receiver monitor loss, unavailable source, or server restart clears selection; unlock/reconnect registers the client again without selecting it, so use a fresh shortcut take or explicit selection to re-arm. A pinned computer is selected again as soon as it reconnects. A failed capture remains in history as appropriate and never resumes for delivery after restart.

Mac settings show the chosen computer and receiver availability. Linux exposes `dictaduo button-status` and desktop capture notifications. This implementation does not control transmitter LEDs, beeps, or haptics. The microphone cannot confirm destination selection itself; check the client before dictating.

## Verified events and limits

The verified mobile receiver emits a synthetic **KEY_VOLUMEUP (115)** press/release pair about 1 ms apart for each single linking-button tap. Only key-down value 1 is accepted. Release/repeat events are ignored, sequences deduplicate replay, and a 500 ms debounce suppresses rapid repeats. No double-tap action or physical hold duration is inferred. Long linking presses retain their native pairing purpose. Direct Bluetooth events and related-model equivalence are unverified; this implementation does not listen for Bluetooth buttons or switch to Bluetooth on range loss.

The native helper matches all of USB bus, vendor/product, the exact `DJI Technology Co., Ltd. Wireless Mic Rx Consumer Control` name, and the same physical sysfs USB parent as the configured PipeWire audio source. It opens no general keyboard or other DJI input interface. It discards startup-queued and more-than-250-ms-old events, exits on lost evdev synchronization, and obtains EVIOCGRAB to suppress this interface's native volume behavior while the helper is running. Other keyboards/media keys remain outside its scope. Live suppression still needs verification with the real receiver.

The helper runs only when explicitly configured, but its grab remains active even when no destination is selected. Stopping the helper/server releases the grab. Permission denial, competing grab, discovery ambiguity, or failed helper startup leaves button routing unavailable. No audio is opened by monitoring or destination selection.

## Opt-in setup for a test deployment

1. Build the native capture helper and button helper: `bash scripts/build-capture.sh` and `bash scripts/build-button.sh`. Build the server and Linux client using their existing scripts.
2. Configure the capture provider with `--capture-helper PATH --capture-host-id HOST`. Obtain the exact stable DJI source ID from `/v1/audio-sources`.
3. Add `--button-helper /absolute/path/to/dictaduo-dji-button --button-source-id EXACT_64_HEX_SOURCE_ID`. Equivalent environment variables are `DICTADUO_BUTTON_HELPER` and `DICTADUO_BUTTON_SOURCE_ID`. No button feature is enabled by default.
4. Review the narrowly scoped udev template `Server/packaging/70-dictaduo-dji-button.rules` before an authorized system installation. It grants active-seat access only to the observed DJI Consumer Control interface; it does not add the user to the broad `input` group. The receiver status interface has its own separate access requirements from the capture-provider setup. Neither permission is installed by this change.
5. On Linux set `"buttonEnabled": true` in its private client config and restart the client. Run `dictaduo button-status`, then `dictaduo arm`. On Mac enable **Receive the server's DJI button** and choose **Use this Mac**. Keep the existing local USB-button mapping disabled when testing the server path.

The daily server, Menu binding, udev configuration, and installed Mac app have not been changed by this implementation. Deployment remains a separate step.

## Validation and outstanding device trials

Automated coverage includes authenticated destination leases, owner isolation, two-client routing, fixed source/device admission, duplicate/stale input, expiry, preparation cancellation, no button fallback, late keyboard release, safe receipt status, and registration/disarm races. The native helper is compiled with warnings as errors. Mac API/client tests cover registration, command deduplication, expiry, and lock eligibility. Existing capture, microphone fallback, and delivery tests remain in use.

Before marking hardware acceptance complete, run this matrix with temporary scoped device access and test text fields:

- Select Mac, tap/start/tap/stop, verify exactly one result only at its original cursor. Repeat with Linux, then select each using a successful shortcut take.
- Test no selection, locked/asleep/disconnected selected client, busy keyboard take, late keyboard release, rapid taps, taps during startup/drain, source loss, receiver/server/client restart. Confirm no recording or delayed insertion into another field.
- Observe system volume during a tap while monitoring is enabled and after disabling it. Verify another keyboard's media keys work normally throughout. Confirm permissions and grab are removed after the temporary trial.
- Confirm receiver unplug/replug and pairing do not replay old taps or restore destination selection.
- Test from the living room while speaking continuously and timestamping position. Listen to retained audio against the timeline: the earlier recording had gaps around 21–30 seconds although the receiver reported connected. Link status alone is not audio-health evidence, and this routing work does not solve that range limit.
- Separately test direct Bluetooth audio, reconnect timing, and button exposure (Ref #4/#11). Do not advertise automatic USB-to-Bluetooth range fallback or USB-reset reconnection based on the inconsistent earlier trials.
