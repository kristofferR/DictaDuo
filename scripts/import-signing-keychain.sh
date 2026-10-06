#!/usr/bin/env bash
set -euo pipefail
: "${APPLE_CERTIFICATE:?Configure the Developer ID Application certificate secret}"
: "${APPLE_CERTIFICATE_PASSWORD:?Configure its password secret}"
: "${RUNNER_TEMP:?This helper is for an ephemeral GitHub runner}"
keychain="$RUNNER_TEMP/dictaduo-signing.keychain-db"
certificate="$RUNNER_TEMP/dictaduo-signing.p12"
password=$(openssl rand -hex 32)
printf '%s' "$APPLE_CERTIFICATE" | /usr/bin/base64 -D > "$certificate"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$certificate" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" \
    -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain"
security list-keychains -d user -s "$keychain"
security default-keychain -d user -s "$keychain"
rm -f "$certificate"
