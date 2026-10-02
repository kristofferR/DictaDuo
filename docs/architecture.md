# Architecture

SottoDuo's native Swift macOS client handles microphone capture, shortcuts, and cursor insertion. An independent TypeScript/Fastify server, compiled with Bun, owns inference, shared settings, and history. Both processes use the same OpenAPI v2 contract whether they run on one machine or across the network.

## Code map

| Component | Responsibility |
| --- | --- |
| `Clients/macOS/Sources/SottoDuo` | SwiftUI/AppKit app, device settings, HTTP client, capture, and guarded delivery. |
| `Clients/macOS/Sources/SottoDuoCore` | Mac configuration, audio metering, microphone selection, and model manifests. |
| `Clients/Linux` | Bun dictation client, Qt Quick GUI, desktop integration, and tests. |
| `Shared/Sources/SottoDuoAPI` | Shared wire types and limits. |
| `Shared/Sources/SottoDuoAPIWire` | Generated Swift transport types used through the API facade. |
| `Server/api/openapi.yaml` | Language-neutral HTTP and wire-model contract. |
| `Server/src` | Packaged TypeScript HTTP server, durable coordinator, text pipeline, and helper management. |
| `Shared/Sources/SottoDuoDomain` | Dictionary, list formatting, rewrite validation, and composition. |
| `Server/Swift/Sources/SottoDuoServerKit` | Reference Swift server retained for migration parity tests. |
| `Server/Swift/Sources/SottoDuoServer` | Reference Swift server command-line entry point. |
| `Engine` | Persistent whisper.cpp speech helper; Metal on Mac, CPU/CUDA on Linux. |
| `TextEngine` | Persistent Qwen helper; Swift MLX on Mac, llama.cpp on Linux. |

Each client's tests live alongside its sources. Shared Swift tests live in
`Shared/Tests`, and reference server tests in `Server/Swift/Tests`. The root
Swift package keeps the existing product names and commands while assigning
each target an explicit path. Root scripts coordinate platform builds;
`Resources` holds license files shared by the app and server packages, while
Mac bundle metadata and entitlements live in `Clients/macOS/Resources`.

The server talks to helpers over bounded JSON-lines pipes. Models warm at startup and stay loaded. The client contains no model helpers; it never starts or stops the server. The application has no Python runtime dependency.

Bun manages all JavaScript dependencies and compiles the coordinator plus its correction worker into standalone platform executables. Heavy correction alignment runs outside the HTTP event loop. Native inference helpers still require platform builds; the Mac proofreader remains Swift MLX. Linux server packages require neither Swift nor an installed JavaScript runtime.

The TypeScript server also supports [Soniox streaming with automatic Whisper fallback](soniox-streaming.md). Inference runs during capture when cloud recognition is configured. The local pipeline described below remains the offline path.

## A recording

An additive [remote capture coordinator](remote-capture.md) separates server-hosted audio from the destination client. It reuses generation admission and processing through a trusted local capture-provider interface. No hardware provider is configured by default; the following local-upload flow continues unchanged.

1. The client asks the server to create a generation with its device identity. The server freezes shared settings. Several recordings can upload at once; offline or unavailable speech recognition prevents capture.
2. The client pins its microphone and uploads acknowledged, sequenced PCM chunks while recording. Inference audio is mono 16 kHz float32; optional original audio keeps the microphone rate/channels as float32.
3. Release stops capture, drains uploads, and sends final frame counts. The server checks the complete intervals, seals WAV files, and queues the recording. Sealed recordings are processed one at a time in the order they finished; cancelling one leaves the rest of the queue running. Recordings must be 0.25–180 seconds.
4. The server runs Whisper, mechanical cleanup, dictionary rules, and list formatting. Optional Qwen output passes through dictionary rules and deterministic rewrite checks. Rejection or proofreading failure retains the pre-proofreading text.
5. NDJSON events carry progress and the saved final result. The client verifies focus/caret safety, makes one delivery attempt, and reports the outcome separately from inference completion.

Interrupted partial uploads expire; a complete upload can finish after the client disconnects. Reconnecting or opening history never pastes an old result. Restarting the server marks unfinished generations failed and retains completed history. There is no offline queue or automatic retry.

## Text delivery

Only the new `insertionText` can be inserted; `previewText` may include earlier list items. Continuation requires a previous generation from the same device and a confirmed client-side cursor anchor. The server checks age and delivery state before reusing context. Invalid context falls back to a standalone take.

The Mac rechecks destination, selection, protected fields, modifiers, and clipboard state before delivery. Unsafe destinations use clipboard or preview fallback. Only confirmed insertion advances cursor-based continuation. Editor text and Accessibility handles stay on the Mac.

Microphone capture uses input-only Core Audio without changing system routing or playback volume. Route changes apply to the next take. Release, cancellation, sleep/lock, or device loss ends capture.

With **Mute system audio while recording** enabled under **This Mac** (or **This computer** on Linux, through PipeWire's `wpctl`), the default output device is muted when a take starts and restored when capture ends. Only mute controls SottoDuo changed are restored, so output that was already muted stays muted. A client crash during a take can leave output muted.

## Settings

| Scope | Where to edit | What it owns |
| --- | --- | --- |
| This Mac | **This Mac** and **Microphone** | Endpoint/token, device name, shortcut, launch at login, output muting while recording, microphone priority/selection. |
| Shared server | **Server preferences** | Language, cleanup prompt, vocabulary, dictionary, proofreading toggle, original-audio retention. |
| Server process | Command arguments or environment | Bind address, port, data directory, token file, helper/model paths. See [server setup](../Server/README.md). |

Shared saves use revisions to reject stale concurrent edits. Settings are snapshotted when the server accepts a take; changes affect future recordings. Update shared settings through the UI/API rather than editing files while the server runs.

The regular app uses `~/Library/Application Support/SottoDuo`; Dev uses `~/Library/Application Support/SottoDuo Dev`. `SOTTODUO_CLIENT_DATA_DIR` overrides either, and the dev runner selects `.local/client`. `config.json` stores shortcut/microphone settings; `client.json` stores endpoint/device identity. Tokens live in separate release/Dev Keychain services, scoped to the endpoint and client directory. `SOTTODUO_SERVER_URL` overrides the saved endpoint for a run. Valid manual `config.json` edits are reloaded; invalid files leave the last good configuration active.

## Storage

The server's `--data-dir` (normally `.local/server` in development) contains:

```text
preferences.json
generations/<UUID>/
  metadata.json
  transcript.txt
  inference.wav
  original.wav
```

Metadata includes device identity, settings snapshot, raw/final text, insertion/preview text, model and processing details, and any delivery receipt. `transcript.txt` contains the current take's final text. Inference audio is always retained for completed takes; original audio is optional and defaults on. The retention toggle does not remove existing files, and there is no automatic history expiry.

All clients read shared, paginated history. Deleting an inactive generation deletes its server artifacts. Failed takes can retain metadata and sealed audio; partial upload files are internal and cannot be downloaded. Client audio copies are temporary.

Only one server may own a data directory. Back up preferences and generation directories together. SottoDuo does not add filesystem encryption; protect this directory as you would the recordings it contains. Authentication and remote transport are described in the [server guide](../Server/README.md#remote-access).

See the [HTTP contract](client-server-contract.md) for request details and [text correction](text-correction.md) for behavior and limitations.
