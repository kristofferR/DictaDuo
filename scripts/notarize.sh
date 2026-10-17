#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then printf 'Usage: %s ARTIFACT\n' "$0" >&2; exit 2; fi
: "${APPLE_ID:?Configure notarization credentials}"
: "${APPLE_PASSWORD:?Configure notarization credentials}"
: "${APPLE_TEAM_ID:?Configure notarization credentials}"
response=$(xcrun notarytool submit "$1" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" --wait --output-format json)
status=$(printf '%s' "$response" | plutil -extract status raw -o - -- -)
if [[ "$status" != Accepted ]]; then
    printf 'Notarization rejected %s: %s\n' "$1" "$status" >&2
    exit 1
fi
