#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$project_dir"
version=$(bash scripts/release-version.sh)
release_dir="$project_dir/build/release"
staging="$project_dir/build/linux-package"
arch_dir="$project_dir/build/arch-package"
mkdir -p "$release_dir" "$arch_dir"
rm -rf "$staging"
DESTDIR="$staging" cmake --install build/linux-gui --prefix /usr
install -Dm644 LICENSE "$staging/usr/share/licenses/dictaduo/LICENSE"
install -Dm644 THIRD_PARTY_NOTICES.md "$staging/usr/share/licenses/dictaduo/THIRD_PARTY_NOTICES.md"
install -Dm644 VERSION "$staging/usr/share/doc/dictaduo/VERSION"
cp Resources/*-LICENSE.txt "$staging/usr/share/licenses/dictaduo/"
# Check every compiled helper, including those added by client changes.
for executable in build/linux-client/dictaduo*; do
    [[ -x "$executable" && -f "$executable" ]] || continue
    test -x "$staging/usr/bin/$(basename "$executable")"
done
test -x "$staging/usr/bin/dictaduo-gui"
"$staging/usr/bin/dictaduo" --help
for executable in "$staging/usr/bin/"*; do
    dependencies=$(ldd "$executable" 2>&1 || true)
    if [[ "$dependencies" == *'not found'* ]]; then
        printf 'Unresolved libraries for %s:\n%s\n' "$executable" "$dependencies" >&2
        exit 1
    fi
done
archive="dictaduo_${version}_linux-x64.tar.gz"
tar -czf "$release_dir/$archive" -C "$staging" usr
checksum=$(sha256sum "$release_dir/$archive" | cut -d' ' -f1)
sed -e "s/@VERSION@/$version/g" -e "s/@SHA256@/$checksum/g" \
    packaging/arch/PKGBUILD.in > "$arch_dir/PKGBUILD"
cp "$release_dir/$archive" "$arch_dir/"
cd "$arch_dir"
makepkg --nodeps --noconfirm --cleanbuild --force
package="dictaduo-bin-${version}-1-x86_64.pkg.tar.zst"
test -s "$package"
verification=$(mktemp -d "$project_dir/build/.arch-verify.XXXXXX")
trap 'rm -rf "$verification"' EXIT
bsdtar -xf "$package" -C "$verification"
for executable in "$staging/usr/bin/"*; do
    cmp "$executable" "$verification/usr/bin/$(basename "$executable")"
done
"$verification/usr/bin/dictaduo" --help
cp "$package" "$release_dir/"
cp PKGBUILD "$release_dir/dictaduo-bin.PKGBUILD"
