#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
fixture="$temporary/release fixture"
mkdir -p "$fixture/scripts" "$fixture/build/release" "$fixture/bin"
cp "$project_dir/scripts/release-version.sh" "$project_dir/scripts/publish-release.sh" "$fixture/scripts/"
printf '0.5.0\n' > "$fixture/VERSION"
export TEST_FIXTURE="$fixture"
export PATH="$fixture/bin:$PATH" TAG=v0.5.0 GH_REPO=test/release RELEASE_ID=123
# No test invokes the real gh command or a network service.
cat > "$fixture/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
    'release upload') echo upload >> "$TEST_FIXTURE/trace" ;;
    'api --method') echo publish >> "$TEST_FIXTURE/trace" ;;
    'api repos/test/release/releases/123/assets') cat "$TEST_FIXTURE/assets.json" ;;
    'api repos/test/release/releases/123') cat "$TEST_FIXTURE/draft.json" ;;
    *) printf 'Unexpected gh call: %s\n' "$*" >&2; exit 1 ;;
esac
MOCK
chmod +x "$fixture/bin/gh"
assets=(DictaDuo_0.5.0_mac-arm64.dmg dictaduo_0.5.0_linux-x64.tar.gz
        dictaduo-bin-0.5.0-1-x86_64.pkg.tar.zst dictaduo-bin.PKGBUILD
        dictaduo-server_0.5.0_darwin-arm64.tar.gz
        dictaduo-server_0.5.0_linux-x64-cpu.tar.gz
        dictaduo-server_0.5.0_linux-arm64-cpu.tar.gz)
reset_fixture() {
    rm -f "$fixture/build/release/"* "$fixture/trace"
    printf '{"draft":true,"tag_name":"v0.5.0","name":"DictaDuo 0.5.0","body":"Curated notes"}\n' > "$fixture/draft.json"
    for asset in "${assets[@]}"; do printf '%s\n' "$asset" > "$fixture/build/release/$asset"; done
    (cd "$fixture/build/release" && sha256sum "${assets[@]}" > SHA256SUMS)
    for asset in "${assets[@]}" SHA256SUMS; do
        jq -n --arg name "$asset" --argjson size "$(stat -c %s "$fixture/build/release/$asset")" \
            --arg digest "sha256:$(sha256sum "$fixture/build/release/$asset" | cut -d' ' -f1)" \
            '{name:$name,size:$size,digest:$digest,state:"uploaded"}'
    done | jq -s '[.]' > "$fixture/assets.json"
}
expect_rejection() {
    if bash "$fixture/scripts/publish-release.sh" > "$fixture/output" 2>&1; then
        printf 'Publication unexpectedly accepted: %s\n' "$1" >&2; exit 1
    fi
    if [[ -f "$fixture/trace" ]] && [[ $(cat "$fixture/trace") == *publish* ]]; then
        printf 'Rejected scenario published: %s\n' "$1" >&2; exit 1
    fi
}
reset_fixture
TAG=v0.5.1 expect_rejection 'tag does not match version'
reset_fixture
rm "$fixture/build/release/${assets[0]}"
expect_rejection 'missing package'
reset_fixture
printf 'unsigned\n' > "$fixture/build/release/unsigned.zip"
expect_rejection 'unexpected unsigned asset'
reset_fixture
jq '.draft = false' "$fixture/draft.json" > "$fixture/changed.json"
mv "$fixture/changed.json" "$fixture/draft.json"
expect_rejection 'already published release'
test ! -f "$fixture/trace"
reset_fixture
jq '.body = " "' "$fixture/draft.json" > "$fixture/changed.json"
mv "$fixture/changed.json" "$fixture/draft.json"
expect_rejection 'empty release notes'
test ! -f "$fixture/trace"
reset_fixture
jq '.[0][0].digest = "sha256:wrong"' "$fixture/assets.json" > "$fixture/changed.json"
mv "$fixture/changed.json" "$fixture/assets.json"
expect_rejection 'upload bytes differ'
reset_fixture
jq '.[0] += [{name:"stale.zip"}]' "$fixture/assets.json" > "$fixture/changed.json"
mv "$fixture/changed.json" "$fixture/assets.json"
expect_rejection 'unexpected remote asset'
reset_fixture
bash "$fixture/scripts/publish-release.sh" > "$fixture/output" 2>&1
test "$(cat "$fixture/trace")" = $'upload\npublish'
printf 'Release publication gates passed (8 scenarios, no network writes).\n'
