#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/build/linux-client"
DESTINATION_FLAGS="$(pkg-config --cflags --libs atspi-2 json-glib-1.0)"
# Parse pkg-config's argument list once, then preserve the resulting arguments.
read -r -a DESTINATION_ARGS <<< "$DESTINATION_FLAGS"
cc -O2 -Wall -Wextra -Werror "$ROOT/Clients/Linux/native/destination.c" \
  "${DESTINATION_ARGS[@]}" -o "$ROOT/build/linux-client/dictaduo-destination"
wayland-scanner client-header "$ROOT/Clients/Linux/native/virtual-keyboard-unstable-v1.xml" "$ROOT/build/linux-client/virtual-keyboard.h"
wayland-scanner private-code "$ROOT/Clients/Linux/native/virtual-keyboard-unstable-v1.xml" "$ROOT/build/linux-client/virtual-keyboard.c"
read -r -a TYPING_ARGS <<< "$(pkg-config --cflags --libs glib-2.0 wayland-client xkbcommon)"
cc -O2 -Wall -Wextra -Werror -I "$ROOT/build/linux-client" \
  "$ROOT/Clients/Linux/native/type.c" "$ROOT/build/linux-client/virtual-keyboard.c" \
  "${TYPING_ARGS[@]}" -o "$ROOT/build/linux-client/dictaduo-type"
cd "$ROOT"
bun run --cwd Clients/Linux build
