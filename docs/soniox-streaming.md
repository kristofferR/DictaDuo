# Soniox streaming and local fallback

The TypeScript server supports three shared recognition modes:

| Mode | Recognition |
| --- | --- |
| Automatic (default) | Soniox when configured; otherwise Whisper. A cloud failure reprocesses the complete recording with Whisper. |
| Cloud only | Soniox; failures retain sealed audio and report an error without invoking Whisper. |
| Local only | Existing Whisper pipeline. No Soniox session is opened. |

Configure `SONIOX_API_KEY` in the server environment, or pass `--soniox-key-file /path/to/private-key`. `SOTTODUO_SONIOX_KEY_FILE` is the equivalent environment setting. A key file takes precedence over the environment key. Keep it outside the repository and restrict its permissions to the server account. Credentials never enter shared preferences, generation metadata, or client responses.

The model is `stt-rt-v5`, using `wss://stt-rt.soniox.com/transcribe-websocket`. Only normalized 16 kHz mono float32 audio is sent to Soniox. Original microphone audio stays in the existing server archive. Recognition vocabulary and dictionary terms are sent as bounded context; deterministic dictionary replacement still runs afterward. Selecting Local only affects subsequent takes; each take retains its admission-time preferences.

Whisper, VAD, Qwen, their model configuration, and their build/install scripts remain intact. Native helpers retain their existing warm-up policy, keeping offline fallback ready when models are installed. Soniox does not replace Qwen proofreading. Missing proof assets preserve deterministic text as before. Automatic mode waits for local Whisper to be available and loaded before accepting a recording. Cloud only can accept recordings without local models. A working local model installation is needed for offline recognition; cloud-only operation does not make unavailable local models usable.

## Recording and storage

The Mac sends 50 ms inference frames over an authenticated WebSocket. Original audio uploads on an independent queue. Durable cumulative acknowledgements bound the unacknowledged speech window to about one second. The server forwards each newly archived inference frame once. Exact upload retries do not send duplicate audio to Soniox.

The server accumulates final tokens and replaces provisional text. The Dictation page shows a live preview; provisional tokens are never inserted or treated as completed text. Release drains microphone samples and ends the inference stream. Soniox finalization overlaps the remaining original-audio upload. Existing `/finish` validation still checks both intervals and seals the WAV artifacts before the result can complete.

`inference.wav`, optional `original.wav`, `transcript.txt`, and `metadata.json` retain their existing names and meanings. Soniox's confirmed output becomes `rawText`; the existing cleanup, dictionary, list, optional proofreading, and composition pipeline produces `finalText`. `speech` identifies the provider/model that actually produced the result. Optional `recognition` metadata records the selected provider and fallback reason; its transient `partialText` is removed on completion/failure/cancellation. Historical records need no rewrite.

If Soniox fails during capture, Automatic keeps archiving audio and uses the entire sealed WAV for local recognition after release. Cloud and local fragments are never joined. Cloud-only failures also allow uploads to finish so the complete audio can be retained. Neither mode silently retries a cloud stream with ambiguous offsets. Client-to-server disconnection retains the existing incomplete-upload expiry behavior; offline fallback means Whisper on the server, not an independent model in the Mac client.

## Additive wire protocol

`GET /v1/generations/:id/stream` upgrades to WebSocket using the same Host, Origin, and bearer-token policy as the HTTP API. It requires a receiving generation. No credentials appear in the URL.

- Binary client messages: unsigned 32-bit little-endian sequence followed by mono 16 kHz little-endian float32 PCM. Sequence begins at zero. Maximum PCM per frame is 64,000 bytes.
- Server receipt: `{"type":"ack","nextSequence":1,"frameCount":800}`. Acknowledged bytes have been written and synced through the existing archive path.
- Server preview: `{"type":"recognition","recognition":{"provider":"soniox","partialText":"Hello"}}`. Whisper fallback includes `fallbackReason` and clears provisional text.
- Client end: `{"type":"end","frameCount":16000}`. The server validates the exact uploaded count, disallows further new inference frames, and starts provider finalization.
- Server end receipt: `{"type":"ended","frameCount":16000}`. This acknowledges upload completion, not transcription completion. The client can close the upload socket after this.
- Server error: `{"type":"error","message":"..."}`, followed by closure.

Original audio uses the existing sequenced HTTP route. After all audio is acknowledged the client calls the existing `/finish`, then reads the existing NDJSON events until terminal. Clients opt into recognition fields by sending `X-SottoDuo-Recognition: streaming-v1`. Without this header, both servers omit `recognitionMode` and `recognition` from JSON and NDJSON responses so older strict v1 decoders remain compatible. Stored metadata retains the full fields. Existing HTTP-only clients still work; their inference uploads are also streamed to Soniox as they arrive. The Mac chooses the new transport when the admitted record includes `recognition`; otherwise it uses the original HTTP upload implementation. Before consuming microphone audio, the Mac also waits for the streaming handshake; if a proxy blocks or stalls the upgrade, it uses the HTTP upload path for the same recording without losing or replaying audio. Live capture previews require the WebSocket path. The retained Swift reference server implements local recognition only and rejects Cloud only settings and admissions.

## Keeping upstream merges small

Provider protocol and selection live in `Server/src/inference/soniox.ts` and `recognition.ts`. `audio-stream.ts` registers the legacy v1 transport for older clients. Current clients upload durable recording sessions instead, and the server streams their acknowledged audio to Soniox itself (`recording-recognition.ts`). The existing native inference implementation, microphone capture, storage format, HTTP upload route, text pipeline, and delivery rules are reused.

The coordinator changes are confined to session admission, forwarding accepted chunks, ending/cancelling sessions, and substituting the recognition result before the existing text pipeline. OpenAPI additions are optional, with Automatic as the historical preference default. Legacy preference updates which omit recognition mode preserve the current server selection. Regenerate both language bindings after schema changes; do not hand-edit generated files.

## Validation

`bun run check`, `bun run test`, and `bun run build:server` validate the server. Soniox tests use a local WebSocket peer and exercise incremental revisions, final tokens, protocol errors, disconnects, and cancellation without sending recordings to a cloud service.

`recording-live.test.ts` covers recording-session recognition with a fake provider: frame-exact commits, local fallback from the committed cursor, cloud-only retries, near real-time pacing, restart resumption and local retry of a failed session.

A live Soniox account test is still needed to measure recognition quality and latency on actual dictation. Relevant measurements are first-preview latency and release-to-insertion latency, with proofreading and original retention measured separately.

Protocol references: [Soniox WebSocket API](https://soniox.com/docs/api-reference/stt/websocket-api), [streaming tokens and formats](https://soniox.com/docs/stt/rt/real-time-transcription).
