# Remote capture sessions

Ref [#5](https://github.com/kristofferR/sottoduo/issues/5). This implements the session boundary for a microphone attached to the server's host. A trusted local `CaptureProvider` supplies audio; the optional [Linux PipeWire/DJI provider](pipewire-capture.md) implements that boundary for #6. With no provider, discovery returns an empty list and the existing local-upload API works unchanged.

## Source and destination

`GenerationRecord.device` remains the initiating/destination computer, including history and continuation checks. Optional `capture.source` identifies the selected remote transport using a stable `{hostID, id}` pair. The provider persists its host identity and maps reconnecting devices to stable source IDs; display names, USB enumeration numbers and PipeWire node IDs are not identities. Bluetooth and receiver paths are different sources. The client resolves its own preferences; the server never redirects to another microphone or computer.

`GET /v1/audio-sources` returns at most 32 cached observations. Discovery must not open microphones or connect Bluetooth. Presence, transmitter link, capture availability and audio health are separate fields. Observation age exceeding 3.5 seconds, or a future timestamp, makes status unknown and ineligible. Wireless link must be known connected; wired inputs can report `notApplicable`. Capture must be available and audio health must not be known degraded. Unknown audio health is allowed: the actual DJI remains linked during confirmed range dropouts, so a connected flag cannot guarantee intelligibility. Silence alone must not change readiness.

Inference readiness remains `/v1/health` and existing generation admission. Shared preferences are frozen by that admission, including original-audio retention. Capture-provider audio uses the existing sequenced writes, durable acknowledgements, byte/frame limits, 16 kHz mono inference stream and optional matching-interval original stream. It never travels through the destination client just to return to the server.

## Control protocol

All routes retain server bearer authentication and Host/Origin policy. The initiating client also generates a random 32-byte secret, encoded as 64 lowercase hexadecimal characters. Send it as `X-SottoDuo-Capture-Owner`, never in a URL. Use a new secret for every new request ID and retain it for retries and delivery. Device IDs and names are attribution, not authorization.

| Operation | Behavior |
| --- | --- |
| `POST /v1/captures` | `{requestID, device, mode, source}` reserves the existing active-generation slot, prepares capture and returns 201 only after provider readiness. Mode is dictation or test. |
| `POST /v1/generations/:id/capture/heartbeat` | Renew the owner lease every second; 204 on renewal. |
| `POST /v1/generations/:id/capture/stop` | `{continuationID?}` stops and drains provider audio, validates exact final counts, seals and queues existing inference; 202 with the record. |
| Existing `POST .../:id/cancel` | Requires the owner secret for remote generations; aborts preparation/capture/processing and is terminal-idempotent. |
| Existing `POST .../:id/delivery` | Requires the owner secret for remote generations. Shared history/artifact reads and explicit deletion of terminal history retain existing server authorization; active generations cannot be deleted. |

Owner hashes are stored privately beside generation metadata, outside the artifact allowlist. Secrets and hashes are absent from API records, history and downloadable metadata. Restart retains ownership checks but never resumes capture. Ownership applies to remote generations only; old local-upload clients keep their existing authorization semantics.

Remote generations reject HTTP PCM uploads, the upload WebSocket and the old client-supplied finish route, even with an owner secret. Only the trusted local provider supplies their audio and final counts. Same-device/request-ID retries share the admitted generation and pending startup, but require the same secret, source and mode. A different request while the provider is recording is busy (`capture_busy`); sealed takes queue for processing like local uploads; stale secrets cannot control a newer generation. Repeating stop uses the original result; changing its continuation ID is a conflict. Cancel never restarts a take.

## Lifecycle and bounds

Capture state accompanies the existing generation status:

`preparing → recording → stopping → sealed`

Cancellation, source loss, timeout or shutdown moves an unsealed capture to `stopped` and its generation to `cancelled`. Startup failure returns an error and requires a fresh request for another take. Clients must not show “listening” before acknowledged `recording` readiness.

- Preparation has a 5-second deadline inside the client's 6-second activation budget, leaving time for the start response and first heartbeat. If discovery becomes obsolete during preparation, cancel the admission. A client may re-resolve **once** to its next eligible input within its original activation budget, using a fresh request ID/secret, only before acknowledged recording; otherwise report failure. No unbounded connection/retry loop or implicit Bluetooth pairing.
- The owner lease lasts 6 seconds. It begins at admission; send the first heartbeat immediately after acknowledged readiness, then continue through recording and draining. A 250 ms watchdog aborts expired leases, observed source unavailability and recordings reaching 180 seconds. An already-expired lease cannot be renewed, even before the watchdog runs.
- Stop/drain has a 5-second deadline, still subject to the owner lease. Until sealing commits, losing ownership cancels the take rather than processing incomplete audio. Provider stop must drain all acknowledged writes before returning counts.
- The provider must honor abort independently of pending start/stop promises, stop its hardware promptly, bound queues and surface process/audio loss through `lost()`. #6 must verify process cleanup/watchdog behavior, including coordinator crashes. The session coordinator cannot kill hardware owned by an adapter that ignores its abort signal.
- Once audio is sealed, processing may finish without heartbeats or a connected client. Reconnecting/history viewing never authorizes insertion. Only the original client with its live target checks may deliver and report a receipt; the server cannot inspect a remote screen lock or caret.
- Destination lock/sleep cancels through the client; abrupt network/process loss is bounded by lease expiry. **Capture-host screen lock alone does not cancel another computer's owned take.** Host sleep, provider/device loss and server shutdown do. The desktop's local client must cancel only its own take. Client integration and OS lifecycle validation belong to #7/#8.

NDJSON generation events carry capture transitions and bounded peak-level updates (at most 10 Hz), with existing recognition previews and terminal results. Use `X-SottoDuo-Capture: capture-v1` to receive `capture` in existing generation/history/event routes. Without it, the new object is omitted for strict legacy clients, independently of `X-SottoDuo-Recognition: streaming-v1`. New capture-control routes include it automatically. Peak updates are ephemeral and do not refresh durable upload expiry. NDJSON subscription/disconnection does not renew or terminate an owner lease.

## Validation and remaining integration

Fake-provider tests exercise admission races, idempotent starts, ownership and upload bypass prevention, cancelled/stalled startup, lease expiry, source loss, retention/interval validation, shutdown/restart and old JSON shapes. Existing local-upload tests continue to exercise the original path without a provider. Real audio/device shutdown, source freshness, GUI selection, lock/sleep hooks and safe text insertion require the hardware/client work in #6–#9. This change does not implement automatic Bluetooth handoff or solve the confirmed living-room coverage limit.
