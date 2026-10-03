#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
capture_test_mode=${1:-all}
if (( $# > 1 )); then
    printf 'Usage: %s [all|core|pipewire]\n' "$0" >&2
    exit 2
fi
case "$capture_test_mode" in
    all|core|pipewire) ;;
    *) printf 'Usage: %s [all|core|pipewire]\n' "$0" >&2; exit 2 ;;
esac
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
if ! dependency_flags=$(pkg-config --cflags --libs samplerate); then
    printf 'Install pkg-config and the libsamplerate development package. See docs/pipewire-capture.md.\n' >&2
    exit 1
fi
read -r -a flags <<< "$dependency_flags"
if [[ "$capture_test_mode" != "pipewire" ]]; then
    cc -std=gnu11 -O2 -Wall -Wextra -Werror "$project_dir/Server/capture/audio-test.c" \
        -o "$temporary/audio-test" "${flags[@]}" -lm
    "$temporary/audio-test"
fi
bash "$project_dir/scripts/build-capture.sh" "$temporary/dictaduo-capture"
if [[ "$capture_test_mode" != "core" ]]; then
    DICTADUO_TEST_CAPTURE_HELPER="$temporary/dictaduo-capture" bun test "$project_dir/Server/tests/pipewire-native.test.ts"
fi
