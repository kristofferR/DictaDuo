#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$project_dir"
version=$(bash scripts/release-version.sh)
platform="${1:?Usage: package-server.sh darwin-arm64|linux-x64-cpu|linux-arm64-cpu [--signed]}"
case "$platform" in darwin-arm64|linux-x64-cpu|linux-arm64-cpu) ;; *) exit 2 ;; esac
if [[ $# -gt 2 || ( $# == 2 && "$2" != --signed ) ]]; then exit 2; fi
test -x build/server/dictaduo-server
test -x build/server/helpers/dictaduo-engine
test -x build/server/helpers/dictaduo-text-engine
test -s build/server/resources/silero-vad.bin
test "$(cat build/server/VERSION)" = "$version"
if [[ "$platform" == linux-* ]]; then
    test -x build/server/helpers/dictaduo-capture
    test -x build/server/helpers/dictaduo-dji-button
    for executable in build/server/dictaduo-server build/server/helpers/*; do
        dependencies=$(ldd "$executable" 2>&1 || true)
        if [[ "$dependencies" == *'not found'* ]]; then
            printf 'Unresolved libraries for %s:\n%s\n' "$executable" "$dependencies" >&2
            exit 1
        fi
    done
fi
if [[ "${2:-}" == --signed ]]; then
    [[ "$platform" == darwin-arm64 ]]
    : "${APPLE_SIGNING_IDENTITY:?Configure release signing}"
    : "${APPLE_ID:?Configure notarization credentials}"
    : "${APPLE_PASSWORD:?Configure notarization credentials}"
    : "${APPLE_TEAM_ID:?Configure notarization credentials}"
    [[ "$APPLE_SIGNING_IDENTITY" == 'Developer ID Application:'* ]]
    for helper in build/server/helpers/dictaduo-engine build/server/helpers/dictaduo-text-engine; do
        codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp --options runtime "$helper"
        codesign --verify --strict "$helper"
    done
    codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp --options runtime \
        --entitlements Server/entitlements.plist build/server/dictaduo-server
    codesign --verify --strict build/server/dictaduo-server
    ditto -c -k --keepParent build/server build/server-notarization.zip
    bash scripts/notarize.sh build/server-notarization.zip
fi
./build/server/dictaduo-server --help
bun Server/scripts/smoke.ts --executable ./build/server/dictaduo-server
mkdir -p build/release
tar -czf "build/release/dictaduo-server_${version}_${platform}.tar.gz" -C build server
