#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
version=$(bash "$project_dir/scripts/release-version.sh" "${TAG:?}")
: "${GH_REPO:?}"
: "${RELEASE_ID:?}"
cd "$project_dir/build/release"
assets=("DictaDuo_${version}_mac-arm64.dmg"
        "dictaduo_${version}_linux-x64.tar.gz"
        "dictaduo-bin-${version}-1-x86_64.pkg.tar.zst"
        dictaduo-bin.PKGBUILD
        "dictaduo-server_${version}_darwin-arm64.tar.gz"
        "dictaduo-server_${version}_linux-x64-cpu.tar.gz"
        "dictaduo-server_${version}_linux-arm64-cpu.tar.gz")
for asset in "${assets[@]}"; do test -s "$asset"; done
# Exclude unsigned/manual-run output and unexpected files from public assets.
files=(*)
expected_files=${#assets[@]}
if [[ -f SHA256SUMS ]]; then expected_files=$((expected_files + 1)); fi
if (( ${#files[@]} != expected_files )); then
    printf 'Unexpected release assets. Expected exactly %s files.\n' "${#assets[@]}" >&2
    exit 1
fi
sha256sum "${assets[@]}" > SHA256SUMS
sha256sum --check SHA256SUMS
release=$(gh api "repos/$GH_REPO/releases/$RELEASE_ID")
jq -e --arg tag "$TAG" '.draft == true and .tag_name == $tag and (.name | test("\\S")) and (.body | test("\\S"))' <<< "$release" >/dev/null
gh release upload "$TAG" "${assets[@]}" SHA256SUMS --clobber
# An interrupted upload must leave the draft intact. Recheck before publication.
remote_assets=$(gh api "repos/$GH_REPO/releases/$RELEASE_ID/assets" --paginate --slurp | jq 'add')
jq -e --argjson count "$((${#assets[@]} + 1))" 'length == $count' <<< "$remote_assets" >/dev/null
for asset in "${assets[@]}" SHA256SUMS; do
    size=$(stat -c %s "$asset")
    digest="sha256:$(sha256sum "$asset" | cut -d' ' -f1)"
    jq -e --arg name "$asset" --argjson size "$size" --arg digest "$digest" \
        'any(.[]; .name == $name and .size == $size and .digest == $digest and .state == "uploaded")' <<< "$remote_assets" >/dev/null
done
release=$(gh api "repos/$GH_REPO/releases/$RELEASE_ID")
jq -e --arg tag "$TAG" '.draft == true and .tag_name == $tag and (.name | test("\\S")) and (.body | test("\\S"))' <<< "$release" >/dev/null
gh api --method PATCH "repos/$GH_REPO/releases/$RELEASE_ID" -F draft=false >/dev/null
