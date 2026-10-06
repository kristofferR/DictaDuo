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
| Verify insertion rather than trust dispatch. [FluidVoice](https://github.com/altic-dev/FluidVoice/blob/fb3b238abcb029a39ff45b0c357e08055d0b3759/Sources/Fluid/Services/TypingService.swift), [TypeWhisper](https://github.com/TypeWhisper/typewhisper-mac/blob/fe2f92d838dad9ab5200606b38a6e0c1c5ef5faf/TypeWhisper/Services/TextInsertionService.swift). | Type text checks exact field contents and caret after every packet and at final confirmation. Synthetic typing/paste events target the retained PID. | Verify full expected field text and caret after native insertion and every keyboard packet, with a bounded provider settling wait. |
| Offer direct typing. [Handy](https://github.com/cjpais/Handy/blob/a94b403e0610049fafa54b0a4077db2945084dd8/src-tauri/src/clipboard.rs), [wtype](https://github.com/atx/wtype/blob/d71be3a7b3f93b534a2823fd68cabd7ac2a02359/main.c). | Automatic / Type text; Unicode payload only on key-down. | Matching local modes. A bundled Wayland helper uses printable physical keycodes, avoiding Chromium's action-key interpretation of wtype's sequential keycodes. No external typing daemon or keyboard-layout guess. |
| Preserve Unicode boundaries and stop after partial writes. [Parrot](https://github.com/humanitas-labs/parrot), [Fonos](https://github.com/ethannortharc/fonos). | At most 16 UTF-16 units; keep graphemes where possible; scalar-safe splitting of oversized clusters. No full-payload retry after a partial write. | Same packet bounds. Guard original text, field and selection, verify each packet, and terminate the keyboard helper on lost destination. No fallback after a possible write. |
| Own a verified selection/range. [TypeWhisper](https://github.com/TypeWhisper/typewhisper-mac/blob/fe2f92d838dad9ab5200606b38a6e0c1c5ef5faf/TypeWhisper/Services/TextInsertionService.swift). | Retain selection, replace it, then verify the resulting caret. | Retain a single selection; one keyboard transaction replaces it. Avoid separate AT-SPI delete/insert operations. Unexpected edits, selection, focus or caret events invalidate queued takes. |
| Preserve the clipboard and serialize delivery. [FreeFlow](https://github.com/zachlatta/freeflow/blob/ad5c827b5a324c503d58f948d500fa5d9f90e7d8/Sources/AppState.swift), [OpenWhisp](https://github.com/initcore0/openwhisp/blob/eec578712c25b37da26c7bd5cce36b3c813c19c1/OpenWhisp/Services/TextInserter.swift). | Snapshot all representations and restore only the owned revision in Automatic; Type text does not touch it. | Automatic snapshots every MIME representation before temporary paste, then restores only its lease. A separate user scope keeps restored data alive across client restart. Type text never touches the clipboard. Recording-order serialization is retained. |
| Carry literal controls without action keys. [Input-method v2](../Clients/Linux/native/PROTOCOLS.md). | Leading/control-only packets use selected-text replacement with exact text and caret readback. A potentially applied write is never retried. | Native insertion or UTF-8 input-method commits handle literal newline/tab and emoji. Automatic can use verified paste when those routes are unavailable. |

## Linux-specific source review

- [Handy](https://github.com/cjpais/Handy/blob/a94b403e0610049fafa54b0a4077db2945084dd8/src-tauri/src/clipboard.rs) selects among compositor-specific typing tools. We adopted capability probing and direct text delivery, with stronger readback and no ambiguous retry.
- [OpenWhispr](https://github.com/OpenWhispr/openwhispr/blob/f770e9211719a6e28d0578b480d8a23dea79d7ff/resources/linux-fast-paste.c) separates portal, uinput and X11 shortcuts and waits for modifiers. Those transports are useful references, but their successful dispatch does not establish text insertion.
- [hyprwhspr](https://github.com/goodroot/hyprwhspr/blob/6a97f2dc3d70023b6be191d7a446d8150673895d/lib/src/text_injector.py) uses clipboard generations, cancellation and compiled-layout checks for ydotool. We avoid layout-dependent typing and automatic clipboard replacement.
- [Hex](https://github.com/anomalyco/hex/blob/255f12fac993ca99f18f4a68139b603beea308b5/src/linux_paste.rs) waits for modifier release and distinguishes bounded clipboard settling from an acknowledgment.
- [Voquill](https://github.com/voquill/voquill/blob/a5dfbe0e3a35807271293a0ef02c91902abc0104/apps/desktop/src-tauri/src/platform/linux/wl/input.rs) was traced through its command, desktop adapter and Wayland transport. It uses ydotool/wtype, text-only clipboard backup and a delayed restore; failure can leave the transcript on the clipboard. DictaDuo uses all-format ownership checks and field readback. Its selected-text copy workaround is unnecessary because we read the accessible range directly.
- [Cotto](https://github.com/JessePomeroy/cotto/blob/7b7dd80daf6e76cbc21b41cd3ddd623841409c0c/Linux/src/DesktopPaste.cpp) uses a RemoteDesktop portal. A portal transport needs a separately authorized session and still needs field readback.
- [Epicenter/Whispering](https://github.com/EpicenterHQ/epicenter/blob/f9441c8f6d32276bb8ab640091b35776174d2490/apps/epicenter/src-tauri/src/delivery.rs) was traced from its frontend command through native delivery. Its Mac concealed pasteboard and permission-watch ideas informed our guards. Linux saves only text and restores after a fixed delay; we use MIME snapshots and verified receipt instead.

## Delivery and platform constraints

- Literal controls are never synthesized as Return/Tab actions. Linux attempts
  native insertion, then an input-method commit when the focused application
  supports it and no other input method owns the seat. Automatic has a verified
  paste fallback for web paragraphs and Chromium supplementary Unicode. Type
  text reports a constraint when no clipboard-free route exists.
  This workstation runs Fcitx5, which already owns the input-method seat; that
  route is deliberately declined without interrupting the existing IME.
  A temporary input-method seat is released after the current literal transaction,
  even when another queued take retains the destination.
- macOS selected-text replacement must prove the exact expected value and caret.
  Chromium's successful AX reply without a real write fails this check. Automatic
  retains its paste route; Type text stops safely after any possible write.
  Type text requires a readable value of at most 65,536 UTF-16 units and a verified
  selection. Changed or transformed text stops delivery even when the caret matches.
  Application activation interrupts delivery, and keyboard events address the
  retained PID. Linux's Wayland keyboard protocols expose only a seat, so they
  retain field/focus checks and exact readback without an atomic PID-targeted post.
- Plasma uses a keyboard-only RemoteDesktop grant, enabled explicitly in This
  computer before dictation. Restore tokens are private, rotated and never logged.
  Session revocation closes the transport. Printable key packets and complete
  paste chords use the same retained-field readback as Hyprland. KWin uses ext
  data control for clipboard leases; both protocol variants are bundled.
- Linux now watches AT-SPI keyboard events and readable physical evdev devices
  without grabs or permission changes. Physical keys/buttons/wheel, dropped input
  events and held modifiers interrupt delivery where the backend exposes them.
  Full hardware coverage depends on compositor support/device access; accessible
  text/caret/selection/focus checks always remain active. This workstation does
  not grant access to its ordinary keyboard/mouse evdev nodes. macOS has a
  listen-only event tap.
- Clipboard snapshots are bounded to 128 formats, 32 MiB and 1.5 seconds.
  An incomplete/changed snapshot is rejected before publishing a transcript.
  Restoration never overwrites a newer owner. A systemd user scope is required
  so restored selection ownership survives background-client shutdown.
- Live streaming is tracked in [#63](https://github.com/kristofferR/DictaDuo/issues/63)
  for both clients and was explicitly excluded from this change.

## Validation

Linux: complete Bun suite, TypeScript checks, warning-clean native builds, Qt
GUI/desktop tests, and `scripts/test-linux-insertion.sh` in dedicated GTK fields.
The desktop test uses a private accessibility bus, preserving the shared socket
and restoring focus. Cases cover Unicode, selections, paragraphs, queued takes,
changed destinations, literal controls, partial interruption, and a backend
that exits successfully without inserting text.

A dedicated Chromium 153 Wayland window passed leading newline/tab, Norwegian
letters, emoji, skin tones and joined emoji through Automatic, with exact text
readback and zero Enter events. Type text left that field unchanged when its
input-method route was unavailable. GTK passed clipboard-free literal controls.

`scripts/test-linux-transports.sh` uses private Wayland and D-Bus fixtures. It
checks both wlr/ext clipboard formats, empty/binary data, newer-owner preservation,
EOF restoration, keyboard-only portal grants, immediate responses, private restore
tokens, key-up ordering and revocation. The private input-method test verifies
literal controls/emoji and the commit serial, and rejects occupied, protected and
inactive seats. An input-event fixture checks held
modifiers and physical/synthetic discrimination without device permissions.
Plasma protocol validation passes; a real KWin desktop trial remains unverified
because this machine runs Hyprland and has no KWin/RemoteDesktop backend.

macOS targeted Swift tests and its release build pass. Native NSTextView accepted
leading newline/tab and emoji exactly in a signed temporary probe. Chromium
reported AX success without inserting the payload, confirming why readback and
no ambiguous retry are required. The temporary WKWebView did not expose a focused
AX field, so that literal route is not claimed as verified there.
