#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/build/linux-client"
DESTINATION_FLAGS="$(pkg-config --cflags --libs atspi-2 json-glib-1.0)"
# Parse pkg-config's argument list once, then preserve the resulting arguments.
read -r -a DESTINATION_ARGS <<< "$DESTINATION_FLAGS"
cc -O2 -Wall -Wextra -Werror "$ROOT/Clients/Linux/native/destination.c" \
  "${DESTINATION_ARGS[@]}" -o "$ROOT/build/linux-client/dictaduo-destination"
cd "$ROOT"
bun run --cwd Clients/Linux build
