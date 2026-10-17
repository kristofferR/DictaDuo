#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$project_dir"
version=$(bash scripts/release-version.sh)
release_dir="$project_dir/build/release"
mkdir -p "$release_dir"
if [[ "${1:-}" == --unsigned && $# == 1 ]]; then
    DICTADUO_SIGNING_IDENTITY=- bash scripts/build-app.sh
    ditto -c -k --sequesterRsrc --keepParent build/DictaDuo.app \
        "$release_dir/DictaDuo_${version}_mac-arm64-unsigned.zip"
    exit 0
fi
if [[ $# != 0 ]]; then printf 'Usage: %s [--unsigned]\n' "$0" >&2; exit 2; fi
: "${APPLE_SIGNING_IDENTITY:?Configure a Developer ID Application identity}"
: "${APPLE_ID:?Configure notarization credentials}"
: "${APPLE_PASSWORD:?Configure notarization credentials}"
: "${APPLE_TEAM_ID:?Configure notarization credentials}"
if [[ "$APPLE_SIGNING_IDENTITY" != 'Developer ID Application:'* ]]; then
    printf 'Release signing requires a Developer ID Application identity.\n' >&2
    exit 1
fi
export DICTADUO_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY"
bash scripts/build-app.sh
app="$project_dir/build/DictaDuo.app"
submission="$project_dir/build/DictaDuo-notarization.zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$submission"
bash scripts/notarize.sh "$submission"
xcrun stapler staple "$app"
codesign --verify --deep --strict "$app"
spctl --assess --type execute --verbose=2 "$app"
xcrun stapler validate "$app"
staging=$(mktemp -d "$project_dir/build/.dmg.XXXXXX")
trap 'rm -rf "$staging"' EXIT
ditto "$app" "$staging/DictaDuo.app"
ln -s /Applications "$staging/Applications"
dmg="$release_dir/DictaDuo_${version}_mac-arm64.dmg"
hdiutil create -volname DictaDuo -srcfolder "$staging" -ov -format UDZO "$dmg"
codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$dmg"
bash scripts/notarize.sh "$dmg"
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
