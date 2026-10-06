# Releases

`VERSION` is the public version for both clients and every server archive. The
first coordinated release is **0.5.0**. This deliberately replaces the old,
independent development versions (Mac 0.14.1 and Linux 0.1.0); there were no
published DictaDuo releases or updater feeds to migrate.

## CI

Every PR and push to `main` runs the existing server/type/API/native checks and
the desktop workflow:

- macOS builds and verifies the actual release app bundle. Swift tests run in
  the server workflow. The CI download is explicitly labelled unsigned and uses
  an ad-hoc signature.
- Linux builds the Bun client and all native helpers, builds the Qt GUI, runs
  the existing TypeScript and offscreen Qt/D-Bus tests, then builds an Arch
  package. The Arch container supplies Qt 6.8+ and LayerShellQt 6.6+.

Release validation reuses those same server checks and desktop builds at the
tagged commit. CI never records a microphone or types into real applications;
desktop input and GPU inference still need release-candidate validation on the
supported machines. Hyprland is verified; Plasma remains experimental.

## Downloads

A coordinated release contains:

- `DictaDuo_<version>_mac-arm64.dmg`: macOS 14+ Apple Silicon app, Developer ID
  signed, notarized, stapled and checked by Gatekeeper. It needs a running server.
- `dictaduo-bin-<version>-1-x86_64.pkg.tar.zst`: Arch/Omarchy client package.
  Install with `sudo pacman -U "/path/to/package.pkg.tar.zst"`. It includes the
  GUI, background client, native input helpers, desktop entry, icon and licenses.
- `dictaduo_<version>_linux-x64.tar.gz`: the same Linux client installation tree
  for packaging. It requires the dependencies declared in `dictaduo-bin.PKGBUILD`;
  this is an Arch build, not a universal Linux binary.
- `dictaduo-server_<version>_darwin-arm64.tar.gz`: Apple Silicon server with
  Whisper, MLX, shader/resources, VAD and licenses. Release executables are
  Developer ID signed and notarized. Command-line executables cannot carry
  stapled tickets, so their first Gatekeeper check requires internet access.
- `dictaduo-server_<version>_linux-{x64,arm64}-cpu.tar.gz`: Ubuntu 24.04 CPU
  server packages with inference, VAD, PipeWire capture, DJI button helpers,
  udev/service templates and licenses. They need libcurl, PipeWire, libusb and
  libsamplerate runtime libraries. Configure capture using the included guide.
- `dictaduo-bin.PKGBUILD` and `SHA256SUMS`: the checked Arch recipe and download
  checksums.

Speech and proofreading model weights are downloaded separately. The small VAD
model is included. CUDA servers and containers can be built using the existing
[server guide](../Server/README.md#containers); this first release does not publish
CUDA packages or container images. In-app auto-updates are a separate feature.

## Signing setup

Configure these repository secrets before pushing a release tag, using the
same Developer ID/notarization credentials as Carrier and IPTVChecker:

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12` export.
- `APPLE_CERTIFICATE_PASSWORD`: the export password.
- `APPLE_SIGNING_IDENTITY`: full `Developer ID Application: ...` identity.
- `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`: notarization account,
  app-specific password and team ID.

Keep credentials out of files in this repository and terminal output. The
workflow imports the certificate into a temporary keychain and deletes it even
when packaging fails. Tagged builds refuse missing credentials; they never
fall back to publishing unsigned files.

## Release checklist

1. Merge the intended features and fixes, including [PR #64](https://github.com/kristofferR/DictaDuo/pull/64) for 0.5.0. Confirm
   CI is green on `main`, then validate real dictation on Mac and Linux against
   the release-candidate server. Back up server data before upgrading it.
2. Set `VERSION` in a reviewed change. Mac bundle versions are injected during
   packaging; the numeric build number defaults to the Git commit count from a
   full clone. `DICTADUO_BUILD_NUMBER` can override it with a positive integer.
3. Test packaging without publication using `gh workflow run release.yml --ref
   main`, then inspect the run's `release-*` artifacts. Manual runs use unsigned
   Mac builds and do not create a tag or GitHub release.
4. Write concise release notes describing user-visible changes, installation,
   server requirements and known limitations. Create the curated draft for the
   exact commit before pushing the tag:

   ```sh
   git fetch origin
   release_sha=$(git rev-parse origin/main)
   version=$(git show "$release_sha:VERSION")
   gh release create "v$version" --draft --target "$release_sha" \
     --title "DictaDuo $version" --notes-file "/path/to/release-notes.md"
   git tag -a "v$version" "$release_sha" -m "DictaDuo $version"
   git push origin "refs/tags/v$version"
   ```

5. The tag workflow verifies that the version matches, the commit is on `main`,
   signing secrets exist and the release is still a nonempty curated draft. It
   runs CI, builds all packages, notarizes Mac downloads, checks the exact asset
   set, uploads checksums, verifies uploads and finally publishes the draft.
   It preserves the title and notes. Any earlier failure leaves the draft private.

Rerun failed jobs after correcting the cause. Do not move a published tag. A
published release cannot be overwritten by rerunning this workflow; use a new
patch version for corrected downloads.

## Homebrew and AUR

After the first release, add a `dictaduo` cask to
`kristofferR/homebrew-tap` using the DMG URL and checksum in `SHA256SUMS`, with
`depends_on macos: ">= :sonoma"`, `depends_on arch: :arm64` and
`app "DictaDuo.app"`. An installed client still needs its server.

The generated `dictaduo-bin.PKGBUILD` is suitable for the AUR: it downloads the
exact release archive and verifies its checksum. Submit it with a generated
`.SRCINFO` after validating the package. The release flow produces these inputs;
it does not write to the tap or AUR. Follow Carrier's distribution automation
once those entries exist and their credentials are configured.
