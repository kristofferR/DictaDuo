#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/build/linux-client"
DESTINATION_FLAGS="$(pkg-config --cflags --libs atspi-2 json-glib-1.0 xkbcommon)"
# Parse pkg-config's argument list once, then preserve the resulting arguments.
read -r -a DESTINATION_ARGS <<< "$DESTINATION_FLAGS"
cc -O2 -Wall -Wextra -Werror "$ROOT/Clients/Linux/native/destination.c" \
  "${DESTINATION_ARGS[@]}" -o "$ROOT/build/linux-client/dictaduo-destination"
wayland-scanner client-header "$ROOT/Clients/Linux/native/wlr-data-control-unstable-v1.xml" "$ROOT/build/linux-client/data-control.h"
wayland-scanner private-code "$ROOT/Clients/Linux/native/wlr-data-control-unstable-v1.xml" "$ROOT/build/linux-client/data-control.c"
read -r -a CLIPBOARD_ARGS <<< "$(pkg-config --cflags --libs gio-unix-2.0 json-glib-1.0 wayland-client)"
cc -O2 -Wall -Wextra -Werror -I "$ROOT/build/linux-client" \
  "$ROOT/Clients/Linux/native/clipboard.c" "$ROOT/build/linux-client/data-control.c" \
  "${CLIPBOARD_ARGS[@]}" -o "$ROOT/build/linux-client/dictaduo-clipboard"
wayland-scanner client-header "$ROOT/Clients/Linux/native/ext-data-control-v1.xml" "$ROOT/build/linux-client/ext-data-control.h"
wayland-scanner private-code "$ROOT/Clients/Linux/native/ext-data-control-v1.xml" "$ROOT/build/linux-client/ext-data-control.c"
cc -O2 -Wall -Wextra -Werror -DDICTADUO_EXT_DATA_CONTROL -I "$ROOT/build/linux-client" \
  "$ROOT/Clients/Linux/native/clipboard.c" "$ROOT/build/linux-client/ext-data-control.c" \
  "${CLIPBOARD_ARGS[@]}" -o "$ROOT/build/linux-client/dictaduo-clipboard-ext"
wayland-scanner client-header "$ROOT/Clients/Linux/native/input-method-unstable-v2.xml" "$ROOT/build/linux-client/input-method.h"
wayland-scanner private-code "$ROOT/Clients/Linux/native/input-method-unstable-v2.xml" "$ROOT/build/linux-client/input-method.c"
cc -O2 -Wall -Wextra -Werror -I "$ROOT/build/linux-client" \
  "$ROOT/Clients/Linux/native/literal.c" "$ROOT/build/linux-client/input-method.c" \
  "${CLIPBOARD_ARGS[@]}" -o "$ROOT/build/linux-client/dictaduo-literal"
read -r -a PORTAL_ARGS <<< "$(pkg-config --cflags --libs gio-unix-2.0 json-glib-1.0 xkbcommon)"
cc -O2 -Wall -Wextra -Werror "$ROOT/Clients/Linux/native/portal-keyboard.c" \
  "${PORTAL_ARGS[@]}" -o "$ROOT/build/linux-client/dictaduo-portal-keyboard"
wayland-scanner client-header "$ROOT/Clients/Linux/native/virtual-keyboard-unstable-v1.xml" "$ROOT/build/linux-client/virtual-keyboard.h"
wayland-scanner private-code "$ROOT/Clients/Linux/native/virtual-keyboard-unstable-v1.xml" "$ROOT/build/linux-client/virtual-keyboard.c"
read -r -a TYPING_ARGS <<< "$(pkg-config --cflags --libs glib-2.0 wayland-client xkbcommon)"
cc -O2 -Wall -Wextra -Werror -I "$ROOT/build/linux-client" \
  "$ROOT/Clients/Linux/native/type.c" "$ROOT/build/linux-client/virtual-keyboard.c" \
  "${TYPING_ARGS[@]}" -o "$ROOT/build/linux-client/dictaduo-type"
cd "$ROOT"
bun run --cwd Clients/Linux build
