#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
output="${1:-$project_dir/build/capture/dictaduo-capture}"
mkdir -p "$(dirname "$output")"
if ! dependency_flags=$(pkg-config --cflags --libs libpipewire-0.3 libusb-1.0 samplerate); then
    printf 'Install pkg-config and the PipeWire, libusb and libsamplerate development packages. See docs/pipewire-capture.md.\n' >&2
    exit 1
fi
read -r -a flags <<< "$dependency_flags"
cc -std=gnu11 -O2 -Wall -Wextra -Werror "$project_dir/Server/capture/main.c" \
    -o "$output" "${flags[@]}" -lm
