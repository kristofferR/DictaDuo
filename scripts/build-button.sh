#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
output="${1:-$project_dir/build/capture/dictaduo-dji-button}"
mkdir -p "$(dirname "$output")"
cc -std=gnu11 -O2 -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE -pie -Wl,-z,relro,-z,now -Wall -Wextra -Werror "$project_dir/Server/capture/button.c" -o "$output"
