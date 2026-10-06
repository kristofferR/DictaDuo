# Text input research and client parity

The source review is a collection of designs, not a claim that every app's code
was copied or every technique is compatible with DictaDuo. Implementations were
written for this project. The [MIT licensed Wayland protocol definition](https://github.com/atx/wtype/blob/d71be3a7b3f93b534a2823fd68cabd7ac2a02359/protocol/virtual-keyboard-unstable-v1.xml)
is retained with its copyright and distributed license.

## Adopted ideas

| Idea and source | macOS | Linux |
| --- | --- | --- |
| Prepare accessibility early. [TypeWhisper](https://github.com/TypeWhisper/typewhisper-mac/blob/fe2f92d838dad9ab5200606b38a6e0c1c5ef5faf/TypeWhisper/Services/TextInsertionService.swift), [Chromium ATK implementation](https://github.com/chromium/chromium/blob/main/ui/accessibility/platform/ax_platform_node_auralinux.cc). | Warm Electron at startup and app activation, with a cooldown. | Start/enable AT-SPI at startup, prepare extended attributes/relations, warm Hyprland app activations, and bound capture readiness. IsEnabled enables toolkit accessibility; ScreenReaderEnabled is never changed. |
| Recognize evidenced editable web fields. [Hyperwhisper](https://github.com/ray-amjad/hyperwhisper-app/blob/06c10930464854b5a9b18916e5dea8a8a42b7cc9/app/macos/hyperwhisper/Utilities/AccessibilityHelper%2BFocus.swift). | Search-field and editable web roles; explicit editable ancestor. | Focused editable document/container roles with Text readback; EditableText is required only for native writes. |
| Verify insertion rather than trust dispatch. [FluidVoice](https://github.com/altic-dev/FluidVoice/blob/fb3b238abcb029a39ff45b0c357e08055d0b3759/Sources/Fluid/Services/TypingService.swift), [TypeWhisper](https://github.com/TypeWhisper/typewhisper-mac/blob/fe2f92d838dad9ab5200606b38a6e0c1c5ef5faf/TypeWhisper/Services/TextInsertionService.swift). | Advance the retained caret only on confirmation. | Verify full expected field text and caret after native insertion and every keyboard packet, with a bounded provider settling wait. |
| Offer direct typing. [Handy](https://github.com/cjpais/Handy/blob/a94b403e0610049fafa54b0a4077db2945084dd8/src-tauri/src/clipboard.rs), [wtype](https://github.com/atx/wtype/blob/d71be3a7b3f93b534a2823fd68cabd7ac2a02359/main.c). | Automatic / Type text; Unicode payload only on key-down. | Matching local modes. A bundled Wayland helper uses printable physical keycodes, avoiding Chromium's action-key interpretation of wtype's sequential keycodes. No external typing daemon or keyboard-layout guess. |
| Preserve Unicode boundaries and stop after partial writes. [Parrot](https://github.com/humanitas-labs/parrot), [Fonos](https://github.com/ethannortharc/fonos). | At most 16 UTF-16 units; keep graphemes where possible; scalar-safe splitting of oversized clusters. No full-payload retry after a partial write. | Same packet bounds. Guard original text, field and selection, verify each packet, and terminate the keyboard helper on lost destination. No fallback after a possible write. |
| Own a verified selection/range. [TypeWhisper](https://github.com/TypeWhisper/typewhisper-mac/blob/fe2f92d838dad9ab5200606b38a6e0c1c5ef5faf/TypeWhisper/Services/TextInsertionService.swift). | Retain selection, replace it, then verify the resulting caret. | Retain a single selection; one keyboard transaction replaces it. Avoid separate AT-SPI delete/insert operations. Unexpected edits, selection, focus or caret events invalidate queued takes. |
| Preserve the clipboard and serialize delivery. [FreeFlow](https://github.com/zachlatta/freeflow/blob/ad5c827b5a324c503d58f948d500fa5d9f90e7d8/Sources/AppState.swift), [OpenWhisp](https://github.com/initcore0/openwhisp/blob/eec578712c25b37da26c7bd5cce36b3c813c19c1/OpenWhisp/Services/TextInserter.swift). | Snapshot all representations and restore only the owned revision in Automatic; Type text does not touch it. | Native and keyboard delivery never change the clipboard. Existing recording-order serialization is retained. Copy is an explicit user action. |

## Linux-specific source review

- [Handy](https://github.com/cjpais/Handy/blob/a94b403e0610049fafa54b0a4077db2945084dd8/src-tauri/src/clipboard.rs) selects among compositor-specific typing tools. We adopted capability probing and direct text delivery, with stronger readback and no ambiguous retry.
- [OpenWhispr](https://github.com/OpenWhispr/openwhispr/blob/f770e9211719a6e28d0578b480d8a23dea79d7ff/resources/linux-fast-paste.c) separates portal, uinput and X11 shortcuts and waits for modifiers. Those transports are useful references, but their successful dispatch does not establish text insertion.
- [hyprwhspr](https://github.com/goodroot/hyprwhspr/blob/6a97f2dc3d70023b6be191d7a446d8150673895d/lib/src/text_injector.py) uses clipboard generations, cancellation and compiled-layout checks for ydotool. We avoid layout-dependent typing and automatic clipboard replacement.
- [Hex](https://github.com/anomalyco/hex/blob/255f12fac993ca99f18f4a68139b603beea308b5/src/linux_paste.rs) waits for modifier release and distinguishes bounded clipboard settling from an acknowledgment.
- [Voquill](https://github.com/voquill/voquill/blob/a5dfbe0e3a35807271293a0ef02c91902abc0104/apps/desktop/src-tauri/src/platform/linux/wl/accessibility.rs) obtains selected text through temporary copy. DictaDuo reads the accessible range directly, avoiding another clipboard transaction. Its full transport remains only partially traced.
- [Cotto](https://github.com/JessePomeroy/cotto/blob/7b7dd80daf6e76cbc21b41cd3ddd623841409c0c/Linux/src/DesktopPaste.cpp) uses a RemoteDesktop portal. A portal transport needs a separately authorized session and still needs field readback.

## Concrete remaining differences

- Wayland keyboard input turns line breaks/tabs into action keys. Type text
  refuses the whole payload before typing. Automatic can insert literal
  paragraphs in native AT-SPI fields. A verified literal UTF-8 transport for
  web-editor paragraphs remains necessary.
- Chromium 153 on Wayland did not reliably accept supplementary Unicode
  symbols through keyboard input. Chromium payloads containing them are refused
  before mutation; native GTK fields passed emoji and combining-mark tests.
- KWin does not offer this virtual-keyboard protocol. Plasma retains native
  AT-SPI insertion and the same safety checks; a portal or KWin typing adapter
  needs real-device validation. Unsupported Type text reports its constraint.
- Wayland does not provide a general physical-input monitor to this client.
  Linux observes accessible text/caret/selection/focus changes and compositor
  focus changes; macOS additionally has a listen-only input event tap.
- Linux has no borrowed-clipboard paste transport. Adding one must preserve all
  MIME representations, respect newer clipboard owners and prove delivery.
  Plain-text backups and unconditional restore timers are not sufficient.
- Live streaming is tracked in [#63](https://github.com/kristofferR/DictaDuo/issues/63)
  for both clients. Stable recognition chunks, region ownership, correction
  reconciliation and the Linux transport gaps above remain feature work.

## Validation

Linux: complete Bun suite, TypeScript checks, warning-clean native builds, Qt
GUI/desktop tests, and `scripts/test-linux-insertion.sh` in dedicated GTK fields.
The desktop test uses a private accessibility bus, preserving the shared socket
and restoring focus. Cases cover Unicode, selections, paragraphs, queued takes,
changed destinations, control-key refusal, partial interruption, and a backend
that exits successfully without inserting text.

A dedicated Chromium 153 Wayland window passed Norwegian letters, combining
marks, Chinese text and punctuation including the sequential-keycode failure
case. No Enter event occurred. Supplementary-symbol refusal left the field
unchanged. macOS's corresponding delivery tests/probes passed in the preceding
changes; this Linux follow-up does not modify that client.
