# DictaDuo — Inkflow / Graphite

Inkflow is the shared DictaDuo identity on macOS and Linux. Its soft speech pulse
resolves into a long, narrow written line. The Graphite finish pairs a dark tile
with a gold-to-copper mark, using gradients, restrained highlights, and layered
vector shadows to give the app icon depth.

The canonical filled silhouette has a **2.08294:1 width-to-height ratio**. Its
asymmetric crests and long flat tail come from the original Inkflow concept.
Preserve that outline in the app icon, standalone logo, small symbols, and
wordmark lockups. Apply material and color through the shared rendering model.

## Editable sources

| File | Role |
| --- | --- |
| [inkflow.svg](inkflow.svg) | Canonical recovered outline. Its padded viewBox is `0 0 1000 500.88697`; the visible outline retains the 2.08294:1 proportion. |
| [icon-tile.svg](icon-tile.svg) | Editable app-tile geometry on a 1024 × 1024 canvas. |
| [wordmark.svg](wordmark.svg) | Eight individually editable letter outlines, with custom spacing. Production exports need no installed font. |
| [wordmark-editable.svg](wordmark-editable.svg) | Optional live-text editing source. Requires the Noto Sans Bold version recorded in the font notice. |
| [brand.json](brand.json) | Shared palette, source filenames, composition, gradients, and material-layer parameters. |
| [native-renderer.swift](native-renderer.swift) | Shared Core Graphics renderer used by the macOS app and native icon CLI. |
| [make-icon.template.swift](../../scripts/make-icon.template.swift) | Editable command-line wrapper for native icon generation. |
| [FONT-LICENSE.txt](FONT-LICENSE.txt) | Noto Sans Bold 2.015 provenance, construction parameters, and SIL OFL 1.1 license. |

Change the canonical geometry or rendering model, then regenerate its outputs.
The live-text alternative is an editing aid; automated exports use outlined
letters so font substitution cannot change the name treatment.

The small symbol is derived from the **same Inkflow path**, uniformly scaled
and centered in a 24 × 24 canvas. `generated/symbol-master.svg` and the exported
symbolic variants are derived artwork. Keep the pulse, tail length, and bar thickness
identical in proportion; do not maintain a separately redesigned small mark.

## Palette and material

| Token | Value | Use |
| --- | --- | --- |
| Ink | `#141C26` | Graphite lettering and logos on light surfaces; dark material base. |
| Ivory | `#FFF8EC` | Reversed wordmark and light foreground treatment. |
| Gold / dark accent | `#F6C263` | Warm mark highlights and readable accents on dark surfaces. |
| Copper | `#C9773C` | The deeper portion of the gold-to-copper material. |
| Accent | `#965222` | Deep copper for controls and accents on light surfaces. |
| Tint | `#F8E7D2` | Warm selection and accent backgrounds on light surfaces. |

The app icon uses the same Graphite material on both platforms. Its shading
uses standard linear and radial gradients plus ordered vector layers. This
keeps the depth reproducible in the SVG, Qt, and Core Graphics renderers without
SVG filters or bitmap textures. Highlights and shadows sit around the original
front-face outline; they must not inflate the pulse or shorten the written line.

Use graphite artwork on light backgrounds and the gold-gradient logo with the
ivory name on dark backgrounds. Monochrome black and white versions preserve
the same contour for masks and compact interface use. The window's controls can
adapt to the selected appearance or an Omarchy palette while the app icon keeps
its shared finish.

### Proportions and clear space

Always scale the mark uniformly. The canonical source has 20 units of padding
on each side of its visible width: the ink runs from `x=20` to `x=980`, and from
`y=20` to approximately `y=480.88697`. Its padded viewBox has a different ratio
from the filled outline. Neither the viewBox nor a square icon slot authorizes
changing the outline's proportions.

For a desired visible mark width `W`, use `scale = W / 960`. The ink center is
`(500, 250.443485)` in source coordinates. Center that point in the destination
and use the same scale horizontally and vertically. Leave clear space around
external logo placements of at least half the written line's thickness.

Keep the wordmark's own proportions and spacing. Use its outlined source for
artwork; ordinary interface text remains platform text.

## Regenerate vectors and native sources

From the repository root:

```sh
node scripts/generate-brand.mjs
node docs/design/build-linux-gallery.mjs
node scripts/generate-brand.mjs --check
```

The repository also provides `bun run brand:generate`, `bun run brand:check`,
and `bun run brand:export`. Vector/native generation uses built-in modules.
The `--check` command compares the expected generated files byte for byte and
fails if an asset or generated renderer is missing or stale.

Generated output includes:

- `generated/`: the Graphite app icon, standalone logos, derived small symbols,
  outlined wordmarks, light/dark/monochrome lockups, and `drawing.json` render data.
- `Clients/Linux/gui/`: the app icon, symbolic variants, and outlined wordmarks
  embedded by Qt.
- `Clients/macOS/Sources/DictaDuo/Views/DictaDuoArtwork.generated.swift`: shared
  paths, palette, render model, and the canonical native renderer.
- `scripts/make-icon.swift`: the generated native renderer and icon CLI wrapper.
- `docs/images/`: light and dark README artwork.

Do not hand-edit these copies. The native app and icon CLI both use
`native-renderer.swift`; fix or extend the renderer there and regenerate.
The CLI wrapper's source is `scripts/make-icon.template.swift`.

The Linux design gallery reads the generated app icon, canonical mark,
outlined name, and shared palette. It embeds each asset once and prefixes all
gradient definitions and their references before reuse. Rebuild it after an
artwork or palette change. The generator checks vector freshness before writing
the self-contained HTML.

## Reproducible raster and platform exports

Install the pinned export renderer outside the application's dependencies:

```sh
npm install --prefix .build/brand-tools --no-save --no-package-lock sharp@0.35.4
node scripts/export-brand.mjs
```

The default destination is `build/brand`. To choose another dedicated directory:

```sh
node scripts/export-brand.mjs --output build/inkflow-assets
```

`DICTADUO_SHARP_MODULE` can point to an existing compatible Sharp module by
absolute path. The exporter requires Sharp 0.35.4 and checks that the shared
vector/native outputs are current before rendering. Its manifest records the
full renderer versions, source hashes, output hashes, dimensions, and alpha
bounds. The pack includes a SHA-256 inventory and the editable sources.

Matching sources and renderer versions are required for byte-identical raster
output. Core Graphics and librsvg can differ in edge antialiasing while using
the same geometry, gradients, and layer model. Native builds do not require
Sharp or an installed font.

| Export directory | Contents |
| --- | --- |
| `png/app-icon/` | App PNGs at 16, 22, 24, 32, 48, 64, 128, 256, 512, and 1024 px. |
| `png/symbol/black/`, `png/symbol/white/` | Transparent masks derived from the original contour, including 18/36 px macOS template sizes. |
| `png/logo/`, `png/lockup/`, `png/wordmark/` | Color and monochrome artwork at useful export sizes. |
| `macOS/DictaDuo.iconset/` | The standard ten PNG iconset representations. |
| `macOS/DictaDuo.icns` | PNG-backed ICNS container, also reproducible on Linux. |
| `linux/hicolor/` | Scalable and raster application/symbol artwork arranged for desktop installation. |
| `svg/`, `sources/` | Portable artwork and a minimal source repository that can regenerate the pack independently. |
| `proof/` | Actual-size raster studies and labeled pixel magnifications. Tray geometry studies are identified separately from native captures. |

The source bundle preserves the repository layout: artwork and the shared
renderer are under `sources/Resources/Brand/`, and generation scripts plus the
native CLI template are under `sources/scripts/`. To regenerate an extracted
bundle, use its `sources/` directory as the repository root and run the commands
above. The live-text source remains optional; the outlined files are sufficient
for rendering.

### macOS integration

The existing build process uses the generated native icon CLI. It applies the
same render model and Core Graphics renderer as the in-app branding, creates
the ten PNG representations, and packages them with `iconutil`:

```sh
swift scripts/make-icon.swift .build/DictaDuo.iconset
iconutil -c icns .build/DictaDuo.iconset -o .build/DictaDuo.icns
```

`scripts/build-app.sh` and its development variant use this path automatically.
The app bundle's icon filename remains `DictaDuo.icns`. Use the generated
renderer for the sidebar and other in-app artwork so the material does not
drift from the bundled icon.

The menu bar uses a template mask derived from the same outline. AppKit chooses
the foreground appropriate to the menu bar. Review its activity indicators
alongside the base mark at actual size.

### Linux integration

Qt embeds the generated SVG artwork, including the portable gradients and
layered shadows. The app icon's material matches the macOS rendering model.
CMake installs the application and symbolic icons under the hicolor icon tree;
desktop entries use `Icon=dictaduo`.

The sidebar name and compact foreground symbols choose ink or ivory against
the rendered surface, including custom Omarchy colors. The tray follows the
desktop palette independently of the selected window theme. Its opposite-color
edge and recording badge must leave the long written line readable.

The built-in dark appearance is labeled **Graphite**. Existing stored appearance
identifiers remain compatible. Follow-system and Omarchy appearance selection
continue to select the appropriate control colors.

## Verification

Inspect the exported 16/18/22/24/32 px samples on light and dark backgrounds,
including the flat written line, asymmetric pulse, and recording indicator.
Use the enlarged nearest-neighbor samples to inspect actual pixels; a large
material rendering alone does not establish small-size readability.

Verify both the vector pipeline and native integrations:

```sh
node scripts/generate-brand.mjs --check
node docs/design/build-linux-gallery.mjs
swift test --filter NativeIntegrationTests
bash scripts/build-linux-gui.sh
ctest --test-dir build/linux-gui --output-on-failure
```

Use the Linux [preview capture commands](../../Clients/Linux/gui/README.md#automated-checks)
for light, dark, and custom themes, and inspect a live panel at 16, 22, and 24 px.
On macOS, inspect the Dock, menu bar, sidebar, and HUD in Aqua, Dark Aqua, and
both high-contrast appearances.

Native runtime checks require the corresponding toolchains: macOS/AppKit for
the Swift app and icon CLI, and Qt 6.8+/LayerShellQt for the Linux GUI. Portable
asset proofs and gallery mockups do not establish native widget or panel behavior.
