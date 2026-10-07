<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/dictaduo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/images/dictaduo-light.svg">
    <img src="docs/images/dictaduo-light.svg" width="420" alt="DictaDuo — the Inkflow pulse and wordmark, in graphite and gold">
  </picture>
</p>

<p align="center">
  <strong>One dictation server for your Mac and your Linux desktop.</strong><br>
  Shared models, dictionary, history, and microphone.
</p>

<p align="center">
  <a href="https://github.com/kristofferR/DictaDuo/actions/workflows/server.yml"><img src="https://github.com/kristofferR/DictaDuo/actions/workflows/server.yml/badge.svg" alt="Build and test status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/kristofferR/DictaDuo?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#why-dictaduo">Why DictaDuo</a> ·
  <a href="#build-from-source">Build from source</a> ·
  <a href="#documentation">Documentation</a>
</p>

---

Most dictation apps live on one computer. DictaDuo runs one dictation server
for your Mac and your Linux desktop: the models, dictionary, cleanup rules,
and history live on the server, and lightweight native apps record and type
the text on each computer. Hold a key, speak, release, and the text appears
where your cursor is, on whichever computer you are using.

## Why DictaDuo

**One setup for two computers.** Teach the dictionary a name once and both
computers spell it right. Both apps read the same history, with the original
audio, raw recognition, and every cleanup decision. A laptop can use the
desktop's GPU instead of keeping its own models loaded.

**One microphone for both.** Plug a DJI Mic receiver into the server. Either
computer can record from it, and the transmitter's button starts dictation on
whichever computer you choose. You never move the receiver or keep a second
microphone setup.

**Fast cloud recognition with a local backup.** With a Soniox key, you see the
words while you speak. If the cloud fails, the server transcribes the full
recording with local Whisper instead. You can also stay fully local with
Whisper or Parakeet v3. There is no account, subscription, or word quota.

**Cleanup that cannot rewrite you.** Qwen proofreads on your own server, then
DictaDuo checks the result. Changed numbers, dropped negations, broken lists,
or invented names are rejected, and the text from before proofreading is kept.
History shows what changed and why.

**A take is never lost.** Audio is saved to disk while you speak, so a
network drop, app crash, or server restart does not lose a recording. There
is no time limit. Cancelled takes are still transcribed: undo within four
seconds to insert them, or find them in history. Any recording can be
transcribed again.

**Keep talking.** Start the next take while the last one is still
processing; text is inserted in the order you spoke. Hold to talk or double
tap to toggle. DictaDuo can mute your speakers while you record.

**Bring your Wispr Flow history.** The Mac app imports past Wispr Flow
dictations, text and audio, into the shared history.

## What you need

DictaDuo has three parts. They can all run on one Mac, or the server can run
on another machine you reach over Tailscale or HTTPS.

| Part | Runs on |
| --- | --- |
| **Server** | Apple Silicon Mac, or Linux x86_64/ARM64 with CPU or NVIDIA CUDA. Containers are available. |
| **Mac app** | macOS 14+ on Apple Silicon. Swift and AppKit. |
| **Linux app** | Omarchy/Hyprland, and experimental KDE Plasma on Wayland. Qt Quick, with light, dark, and Omarchy themes. |

The apps always need a reachable server, even in local-only mode. On Linux,
the server records the microphone through PipeWire, so a Linux desktop needs
the server's PipeWire capture enabled, even when both run on the same
computer. Text insertion on Linux depends on each application's accessibility
support. Automatic and Type text offer verified native/keyboard delivery on
supported Wayland desktops; terminals use explicit copy and paste. See the
[text input review](docs/text-input-research.md) for compatibility boundaries.

History, including original microphone audio, stays on the server until you
delete it. Back up the server's data directory to keep it; see
[storage](docs/architecture.md#storage).

### Recognition modes

| Mode | How speech is recognized |
| --- | --- |
| **Automatic** | Soniox when a key is configured, otherwise local. A cloud failure falls back to local recognition of the complete recording. |
| **Cloud only** | Soniox. Works without local speech models; failures are reported instead of falling back. |
| **Local only** | Whisper or Parakeet v3 on your server. No audio leaves it. |

Parakeet is faster and detects 25 European languages, but not Norwegian, and
it ignores recognition vocabulary. Cloud recognition sends speech audio and
vocabulary hints to Soniox; proofreading always stays on your server. See
[Soniox setup](docs/soniox-streaming.md) and [server models](Server/README.md#models).

## Build from source

| Component | Requirements |
| --- | --- |
| **Mac app and local server** | Apple Silicon, macOS 14+, Xcode 26+ with the Metal compiler, Swift 6.2+, Bun 1.4.2, CMake, and Git. |
| **Linux desktop** | Omarchy/Hyprland or experimental KDE Plasma Wayland, the Linux client dependencies, Qt 6.8+, and LayerShellQt 6.6+. Requires a server with PipeWire capture enabled. |
| **Separate server** | Apple Silicon macOS, or Linux x86_64/ARM64 with CPU or optional NVIDIA CUDA inference. Linux container builds are also available. |

### On one Mac

```sh
git clone --recurse-submodules https://github.com/kristofferR/DictaDuo.git
cd DictaDuo
```

[Download the Whisper and Qwen models](Server/README.md#models) into `.local/models`,
then build and start:

```sh
export DICTADUO_SPEECH_MODEL="$PWD/.local/models/ggml-large-v3-turbo.bin"
export DICTADUO_TEXT_MODEL="$PWD/.local/models/Qwen3-4B-Instruct-2507-MLX-4bit"
./scripts/run-dev.sh
```

This starts the server at **http://localhost:8391** and opens **DictaDuo Dev**,
which has separate settings from the regular app.

Grant **Microphone** and **Accessibility** permissions. The default hold-to-dictate
key is <kbd>Right Option</kbd>, configurable under **This Mac**. Inputs are under
**Microphone**; dictionaries and cleanup are under **Server preferences**.
For Fn/Globe shortcuts, set macOS
**Keyboard → Press Globe key to → Do Nothing** if its action conflicts.

For the regular app, run `./scripts/build-app.sh` and move `build/DictaDuo.app`
to Applications. It still needs the independently running server.

### On Linux

Start with the [Linux desktop guide](Clients/Linux/gui/README.md) for dependencies
and installation, and enable [PipeWire capture](docs/pipewire-capture.md) on the
server. From a cloned repository with those dependencies installed:

```sh
bun install --frozen-lockfile
bash scripts/build-linux-client.sh
bash scripts/build-linux-gui.sh
build/linux-gui/dictaduo-gui
```

Under **This computer**, set up **Background dictation**, enter your server
details under **Connection**, and configure **Shortcuts**. Choose your inputs
under **Microphone**. The server's capture provider handles Linux recording,
including when the client and server run on the same computer.

### With a separate server

Follow the [server guide](Server/README.md) to build, install models, and run on
macOS, Linux, or in a container. On a client Mac, build only the app with
`./scripts/build-app.sh`; it needs no inference models locally.

Enter the server URL and token under **This Mac** or Linux's
**This computer → Connection**. Use HTTPS for remote hosts, or HTTP with the
server's literal Tailscale IP on your connected tailnet. Ordinary LAN addresses
require HTTPS.

## DJI microphone button

Supported USB receivers include DJI Mic Mini, Mini 2, and Mini 2S using the
`2CA3:4011` consumer-control interface. Connect the receiver over USB, then tap
the transmitter's linking button once to record and again to finish.
Bluetooth-only connections do not provide these button events.

- **Receiver on your Mac:** Enable **This Mac → DJI mic button → Use DJI mic
  button**, allow Input Monitoring, and select the receiver under **Microphone**.
- **Receiver on the Linux server:** Configure the capture and button helpers,
  enable reception on each client, and select the destination computer. A
  successful keyboard dictation can also select that computer for the next
  button take.

The destination stays fixed throughout a recording. Server-button selection
clears when the selected client locks, sleeps, or disconnects. Microphone
priorities apply to new recordings; DictaDuo does not switch inputs mid-sentence
or automatically hand off between USB and Bluetooth.

See [DJI button routing and setup](docs/dji-button-routing.md) and
[remote microphone selection on Mac](docs/mac-remote-capture.md).
USB button support builds on the findings in
[dji-mic-wispr-flow](https://github.com/caezium/dji-mic-wispr-flow).

## Development

```sh
./scripts/run-dev.sh start --skip-build   # Start existing Mac development builds
./scripts/run-dev.sh status
./scripts/run-dev.sh stop
./scripts/run-dev.sh restart             # Rebuild and restart
bun run check
bun run test
swift test                              # Swift client and shared code
```

Keep the model-path exports set for the Mac dev runner. It stores server data
in `.local/server`, client preferences in `.local/client`, and logs in
`.local/server.log`. Quitting the app leaves the server running. After rebuilding
an open client, quit and reopen it to load the new executable.

For HTTP/audio smoke tests, native helper checks, and Linux GUI tests, see the
[server](Server/README.md#verify) and
[Linux desktop](Clients/Linux/gui/README.md#automated-checks) guides.

## Repository layout

```text
Clients/
  macOS/       Swift app, core library, tests, and app resources
  Linux/       Bun client, Qt Quick GUI, tests, and desktop integration
Shared/        Swift API bindings, domain libraries, and their tests
Server/        Production TypeScript server, API contract, and native capture
  Swift/       Reference Swift server and parity tests
Engine/        Whisper inference helper
TextEngine/    Qwen inference helpers
Resources/     Shared brand sources, generated artwork, and third-party licenses
scripts/       Build, development, and validation entry points
docs/          Architecture and setup guides
```

Run build and test commands from the repository root. `Package.swift` connects
the Swift targets across these directories; `package.json` defines the Bun
workspaces. Build outputs stay in `build/` and `.build/`.

## Documentation

- [Server setup, models, containers, and remote access](Server/README.md)
- [Linux desktop setup and features](Clients/Linux/gui/README.md)
- [Soniox streaming and local fallback](docs/soniox-streaming.md)
- [PipeWire microphone capture](docs/pipewire-capture.md)
- [DJI button routing](docs/dji-button-routing.md)
- [Dictionary and cleanup instructions](docs/text-correction.md)
- [Architecture and storage](docs/architecture.md)
- [HTTP API](docs/client-server-contract.md)
- [Whisper helper](Engine/README.md) and [Qwen helpers](TextEngine/README.md)
- [Inkflow / Graphite identity, editable sources, and platform exports](Resources/Brand/README.md)

## Support and contributing

[Open an issue](https://github.com/kristofferR/DictaDuo/issues) for bugs or ideas.
For a dictation problem, include your desktop environment, server platform,
recognition mode, and microphone setup.

Contributions are welcome; see [repository instructions](AGENTS.md) for the
contributor PR requirements.

## License and credits

[MIT](LICENSE). Originally based on [Sotto](https://github.com/davis7dotsh/sotto)
by davis7dotsh. See [third-party notices](THIRD_PARTY_NOTICES.md) for bundled
dependencies and model licenses.
