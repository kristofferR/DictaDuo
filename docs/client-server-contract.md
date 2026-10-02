# HTTP API

API version 3, default port **8391**. [`Server/api/openapi.yaml`](../Server/api/openapi.yaml) defines the HTTP contract and generates TypeScript and Swift types. [`Sources/SottoDuoAPI/API.swift`](../Shared/Sources/SottoDuoAPI/API.swift) preserves the legacy client facade; `RecordingAPI.swift` defines the v2 recording messages. V1 dates use whole-second ISO-8601 UTC; v2 accepts fractional seconds and preserves capture timestamps. macOS and Linux expose the same packaged API. See [server setup](../Server/README.md#remote-access) for authentication and endpoint configuration.

The current native client negotiates `/v2/recordings/capabilities` and uses durable recording admission, resumable WebSocket audio, during-capture processing, and one final delivery. The complete [recording protocol](recording-protocol.md) defines pause/stop, checksums, durable ACKs, connection fencing, recovery, paginated history, and per-run audio exports. Legacy v1 routes and semantics below remain available for old clients/imports. The reference Swift server implements v1 only and does not advertise long-recording capability.

## Routes

| Route | Request / response |
| --- | --- |
| `GET /v1/health` | `ServerHealth`; server reachability differs from ready inference. Lightweight health contains no user data. |
| `GET /v1/audio-sources` | `AudioSourceList`; up to 32 cached source observations, without starting capture. |
| `POST /v2/captures` | `StartCaptureRequest` → 201 `RecordingSnapshot` after remote capture readiness; requires a capture owner secret. |
| `POST /v2/recordings/:id/capture/heartbeat` | Owner-authenticated lease renewal → 204; send every second, expires after six seconds. |
| `POST /v2/recordings/:id/context` | `StopCaptureRequest` → `RecordingSnapshot`; fixes a remote take's continuation before processing starts. Requires the owner secret. |
| `POST /v2/recordings/:id/capture/stop` | `StopCaptureRequest` → 202 `RecordingSnapshot` after provider audio drains and seals; requires the owner secret. |
| `GET /v2/recordings/:id/events` | `application/x-ndjson` `RecordingSnapshot` lines, repeated every two seconds, until the session completes, fails or is discarded. |
| `GET /v1/preferences` | `PreferencesSnapshot` |
| `PUT /v1/preferences` | `PreferencesSnapshot` with expected revision; validates and returns incremented snapshot, 409 if stale. |
| `POST /v1/generations` | `CreateGenerationRequest` → `GenerationRecord` with server UUID and frozen settings. Idempotent requestID scoped to device. Admission occurs before microphone capture. |
| `POST /v1/generations/:id/audio/:kind?sequence=0&sampleRate=16000&channels=1` | Binary little-endian interleaved float32 PCM, ≤1 MiB per request. `kind` is `inference` or `original`. Every request has sequence/format; format fixed per stream. Exact repeated chunk idempotent; gaps/conflicting repeats reject. → `AudioChunkReceipt`. |
| `GET /v1/generations/:id/stream` | Authenticated WebSocket for sequenced inference PCM, durable acknowledgements, live recognition updates, and end-of-audio. See [binary streaming protocol](soniox-streaming.md#additive-wire-protocol). |
| `POST /v1/generations/:id/finish` | `FinishGenerationRequest` with exact frame counts. All chunks must be acknowledged first. Optional previous continuation generation ID. Seals WAV artifacts atomically and submits processing. → `GenerationRecord`. |
| `GET /v1/generations/:id/events` | `application/x-ndjson`, each line a full `GenerationRecord`; emit current state, updates, and two-second heartbeats until terminal. Disconnecting after complete upload does not cancel inference. |
| `GET /v1/generations/:id` | `GenerationRecord` |
| `GET /v1/generations?limit=50&before=CURSOR` | `GenerationPage`, descending creation order, bounded limit/cursor. |
| `POST /v1/generations/:id/cancel` | Explicit cancellation, terminal idempotency, → `GenerationRecord`. |
| `POST /v1/generations/:id/delivery` | `DeliveryReceipt`; store actual client outcome separately from inference completion. → `GenerationRecord`. |
| `GET /v1/generations/:id/artifacts/:filename` | Allowlisted original.wav, inference.wav, transcript.txt, metadata.json, source.json, source.wav, opus.json, screenshot.png, and built-in-audio.bin. Imported artifacts exist only when supplied by the source. |
| `DELETE /v1/generations/:id` | Explicit history removal; active generation cannot be deleted. 204. |
| `POST /v1/imports/wispr-flow/known` | Source IDs → known imported source IDs. |
| `POST /v1/imports/wispr-flow` | Source metadata and checksummed artifact manifests → staging session. 201. |
| `PUT /v1/imports/wispr-flow/:id/artifacts/:filename` | JSON/WAV/PNG or binary bytes, ≤8 MiB; validates manifest before publishing. |
| `POST /v1/imports/wispr-flow/:id/complete` | Atomically publishes or reconciles the imported record. |
| `DELETE /v1/imports/wispr-flow/:id` | Removes unpublished staging session. 204. |
| `PUT /v1/imports/wispr-flow/dictionary` | Preserves source JSON and immutable digest versions, ≤8 MiB; does not change active dictionary. |

Errors are `APIErrorResponse`; relevant codes 400 invalid input, 401 auth, 404 missing, 409 stale/conflict/busy, 413 limits, 503 unavailable. Bearer authorization on data routes if token configured; nonloopback server binds require a token. Remote connections use HTTPS; localhost and explicit Tailscale endpoints can use HTTP. No credentials in URLs or diagnostics.

## Generation semantics

Server-attached microphones record durable recording sessions through the [remote capture session contract](remote-capture.md): source discovery, owned start/heartbeat/context/stop controls, capture readiness and bounded cleanup. Remote recording control, discard and delivery additionally require their session-specific `X-SottoDuo-Capture-Owner` secret; the upload WebSocket rejects remote sessions. Legacy generations created before this change keep their `capture` object, returned when a client sends `X-SottoDuo-Capture: capture-v1`.

- Server owns settings/dictionary, inference, formatting, proofreading, rewrite guards, composition, artifacts and history. Client owns only ephemeral capture/AX anchors and device preferences.
- Inference audio is mono 16k float32. Original is input microphone format normalized to interleaved float32, retained/uploaded only if the accepted settings snapshot says keepOriginalAudio. Both audio intervals must match. Min take 0.25 s, max 180 s. Soniox recognition runs during upload; only sealed complete uploads can complete a generation or run Whisper fallback.
- Sequence counts are independent for each audio kind. Server handles incomplete upload expiry, bounded disk and request buffers, validates byte/frame counts and formats, and never accepts caller filesystem paths.
- Native helpers remain separate persistent processes (independent ggml versions). Soniox streaming is preferred when configured in Automatic mode; Whisper remains the local/offline path. macOS Qwen MLX; Linux Qwen llama.cpp/GGUF. Server applies current deterministic domain logic; client inserts returned insertionText once with existing destination/caret checks.
- ContinuationID references a completed prior generation from the same device and is sent only if the client has an exact confirmed caret anchor. Server checks age and valid delivery or test/control-only state before reusing its stored continuation. Deleted, stale, or invalid context falls back to standalone composition without discarding the new recording. No editor text/AX handles go over the wire.
- A lost connection during capture/upload stops capture, clears client temporary buffers, and leaves the server to cancel/expire the partial generation. No offline queue or retry UI. Once upload is complete, server may finish independently. A sealed take's client retries a lost finish acknowledgement with identical frame counts and recovers a dropped event stream by reading the saved generation; later viewing history does not paste.
- API result bytes and metadata are server-owned. All clients read the same history, tagged with the original device ID/name.
- Shared original-audio setting defaults on; inference audio always retained for completed generations. Changes affect future takes. Local server storage is a configurable persistent data directory; hosted deployments mount durable storage.

## Shared preferences

Send `X-SottoDuo-Recognition: streaming-v1` to receive the optional recognition fields in JSON and NDJSON. Without this header, responses retain the legacy v1 shape for strict older clients.

GET/PUT use `{ "revision": N, "preferences": { ... } }`. A save must include the current revision; successful validation returns the incremented snapshot. Active generations keep their admission-time snapshot.

| Field | Default / limit |
| --- | --- |
| `recognitionMode` | `automatic`; also `cloud` or `local`. Missing values in legacy preference updates preserve the existing selection. |
| `language` | `en`; `auto` and the languages declared in `ServerPreferences`. |
| `proofreadingPrompt` | Editable default; nonempty, at most 4,096 UTF-8 bytes. |
| `vocabulary` | Recognition hints; at most 16 KiB. |
| `dictionary` | Up to 32 named lists, 500 terms, eight aliases per term. Conflicting mappings reject. |
| `textCorrectionEnabled` | `true`; toggles Qwen, preserving dictionary/list processing when off. |
| `keepOriginalAudio` | `true`; affects future uploads and retention, not existing artifacts. |

For on-disk layout and client-owned settings, see [architecture](architecture.md).
