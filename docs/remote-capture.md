# Remote capture sessions

Ref [#5](https://github.com/kristofferR/sottoduo/issues/5). This implements the session boundary for a microphone attached to the server's host. A trusted local `CaptureProvider` supplies audio; the optional [Linux PipeWire/DJI provider](pipewire-capture.md) implements that boundary for #6. With no provider, discovery returns an empty list and the existing local-upload API works unchanged.

## Source and destination

A remote take is a durable [recording session](recording-protocol.md) whose audio the server's own provider supplies. `RecordingSnapshot.device` remains the initiating/destination computer, including history and continuation checks. Optional `capture.source` identifies the selected remote transport using a stable `{hostID, id}` pair. The provider persists its host identity and maps reconnecting devices to stable source IDs; display names, USB enumeration numbers and PipeWire node IDs are not identities. Bluetooth and receiver paths are different sources. The client resolves its own preferences; the server never redirects to another microphone or computer.

`GET /v1/audio-sources` returns at most 32 cached observations. Discovery must not open microphones or connect Bluetooth. Presence, transmitter link, capture availability and audio health are separate fields. Observation age exceeding 3.5 seconds, or a future timestamp, makes status unknown and ineligible. Wireless link must be known connected; wired inputs can report `notApplicable`. Capture must be available and audio health must not be known degraded. Unknown audio health is allowed: the actual DJI remains linked during confirmed range dropouts, so a connected flag cannot guarantee intelligibility. Silence alone must not change readiness.

Inference readiness remains `/v1/health` and recording admission. Shared preferences are frozen by that admission, including original-audio retention. Capture-provider audio is written into one capture run of the session through the same durable chunk receipts, checksums and limits as client uploads: a 16 kHz mono inference stream and an optional matching-interval original stream. Speech is recognized and committed while the take records, exactly as for client uploads. Audio never travels through the destination client just to return to the server.

## Control protocol

All routes retain server bearer authentication and Host/Origin policy. The initiating client also generates a random 32-byte secret, encoded as 64 lowercase hexadecimal characters. Send it as `X-SottoDuo-Capture-Owner`, never in a URL. Use a new secret for every new request ID and retain it for retries and delivery. Device IDs and names are attribution, not authorization.

| Operation | Behavior |
| --- | --- |
| `POST /v2/captures` | `{requestID, device, mode, source}` admits a recording session, prepares capture and returns 201 `RecordingSnapshot` only after provider readiness. Mode is dictation or test. |
| `POST /v2/recordings/:id/capture/heartbeat` | Renew the owner lease every second; 204 on renewal. |
| `POST /v2/recordings/:id/context` | `{continuationID?}` fixes the take's continuation, or none, as soon as the destination is known. Processing holds for at most 3 seconds after admission waiting for it; afterwards the take starts fresh and a late context is a conflict. |
| `POST /v2/recordings/:id/capture/stop` | `{continuationID?}` stops and drains provider audio, validates exact final counts and seals the run; 202 with the snapshot. The continuation applies only if context was not fixed yet. |
| `GET /v2/recordings/:id/events` | NDJSON `RecordingSnapshot` lines with capture state, peak level and preview text, repeated every two seconds, until the session completes, fails or is discarded. |
| `POST /v2/recordings/:id/discard` | Requires the owner secret for remote sessions; aborts preparation/capture and discards the audio. |
| `POST /v2/recordings/:id/delivery` | Requires the owner secret for remote sessions. Shared history and audio reads retain existing server authorization. |

Owner hashes are stored privately beside session metadata, outside the artifact allowlist. Secrets and hashes are absent from API records, history and downloadable metadata. Restart retains ownership checks but never resumes capture. Ownership applies to remote sessions only; client-uploaded sessions keep their existing authorization semantics.

Remote sessions reject client-uploaded audio, even with an owner secret. Only the trusted local provider supplies their audio and final counts. Same-device/request-ID retries share the admitted session and pending startup, but require the same secret, source and mode. A different request while the provider is recording is busy (`capture_busy`); sealed takes keep processing like client uploads; stale secrets cannot control a newer session. Repeating stop uses the original result; changing its continuation ID is a conflict. Discard never restarts a take.

## Lifecycle and bounds

`RecordingSnapshot.capture` carries the provider state alongside the session's capture and processing states:

`preparing → recording → stopping → sealed`

A remote take has no duration limit. Source loss, lease expiry, a failed drain or shutdown seal the audio already written at its exact counts, set capture to `stopped` with the interruption as the session error, and finish it archive-only: the text lands in history and nothing is delivered. A take with no audio is discarded instead, as is an explicit discard. Startup failure returns an error and requires a fresh request for another take. Clients must not show “listening” before acknowledged `recording` readiness.

- Preparation has a 5-second deadline inside the client's 6-second activation budget, leaving time for the start response and first heartbeat. If discovery becomes obsolete during preparation, cancel the admission. A client may re-resolve **once** to its next eligible input within its original activation budget, using a fresh request ID/secret, only before acknowledged recording; otherwise report failure. No unbounded connection/retry loop or implicit Bluetooth pairing.
- The owner lease lasts 6 seconds. It begins at admission; send the first heartbeat immediately after acknowledged readiness, then continue through recording and draining. A 250 ms watchdog stops takes with expired leases or observed source unavailability. An already-expired lease cannot be renewed, even before the watchdog runs.
- Stop/drain has a 5-second deadline, still subject to the owner lease. A failed drain or lost ownership keeps the audio acknowledged so far, sealed archive-only. Provider stop must drain all acknowledged writes before returning counts.
- The provider must honor abort independently of pending start/stop promises, stop its hardware promptly, bound queues and surface process/audio loss through `lost()`. #6 must verify process cleanup/watchdog behavior, including coordinator crashes. The session coordinator cannot kill hardware owned by an adapter that ignores its abort signal.
- Once audio is sealed, processing may finish without heartbeats or a connected client. Reconnecting/history viewing never authorizes insertion. Only the original client with its live target checks may deliver and report a receipt; the server cannot inspect a remote screen lock or caret.
- Server restart seals an unfinished remote take at its acknowledged audio, archive-only, or discards it when empty.
- Destination lock/sleep cancels through the client; abrupt network/process loss is bounded by lease expiry. **Capture-host screen lock alone does not cancel another computer's owned take.** Host sleep, provider/device loss and server shutdown do. The desktop's local client must cancel only its own take. Client integration and OS lifecycle validation belong to #7/#8.

Recording events carry capture transitions and bounded peak-level updates (at most 10 Hz) with live preview text. Peak updates are ephemeral. NDJSON subscription/disconnection does not renew or terminate an owner lease. A finished take's result is the session's materialized `GenerationRecord`, read from `GET /v2/recordings/:id`.

## Validation and remaining integration

Fake-provider tests exercise admission races, idempotent starts, ownership and upload bypass prevention, cancelled/stalled startup, lease expiry, source loss, archive-only sealing, retention/interval validation and shutdown/restart. Real audio/device shutdown, source freshness, GUI selection, lock/sleep hooks and safe text insertion require the hardware/client work in #6–#9. This change does not implement automatic Bluetooth handoff or solve the confirmed living-room coverage limit.
