#!/usr/bin/env node
// Deterministic, dependency-free vector and native-code exports from the Inkflow masters.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(root, 'Resources/Brand');
const config = JSON.parse(await readFile(resolve(sourceDir, 'brand.json'), 'utf8'));
const check = process.argv.includes('--check');
if (process.argv.slice(2).some(arg => arg !== '--check')) {
  throw new Error('Usage: node scripts/generate-brand.mjs [--check]');
}
const number = value => Number(value.toFixed(6)).toString();
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

// The masters intentionally use a small, editable subset of SVG. Reject unsupported
// geometry instead of silently changing it during a native export.
function commands(data) {
  const tokens = data.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? [];
  const counts = { M: 2, L: 2, H: 1, V: 1, C: 6, Q: 4, Z: 0 };
  let index = 0, command, x = 0, y = 0, startX = 0, startY = 0;
  const output = [];
  while (index < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[index])) command = tokens[index++];
    if (!command || !Object.hasOwn(counts, command.toUpperCase())) {
      throw new Error(`Unsupported SVG command: ${command}`);
    }
    const upper = command.toUpperCase();
    if (upper === 'Z') {
      output.push({ op: 'Z', values: [] });
      x = startX; y = startY; command = undefined;
      continue;
    }
    const values = tokens.slice(index, index + counts[upper]).map(Number);
    if (values.length !== counts[upper] || values.some(value => !Number.isFinite(value))) {
      throw new Error(`Incomplete SVG command: ${command}`);
    }
    index += values.length;
    const relative = command !== upper;
    let op = upper;
    if (upper === 'H') {
      values[0] += relative ? x : 0;
      values.push(y); op = 'L';
    } else if (upper === 'V') {
      values[0] += relative ? y : 0;
      values.unshift(x); op = 'L';
    } else if (relative) {
      for (let i = 0; i < values.length; i += 2) {
        values[i] += x; values[i + 1] += y;
      }
    }
    x = values.at(-2); y = values.at(-1);
    if (upper === 'M') { startX = x; startY = y; command = relative ? 'l' : 'L'; }
    output.push({ op, values });
  }
  return output;
}

async function master(name) {
  const xml = await readFile(resolve(sourceDir, name), 'utf8');
  if (/<(?:text|image|use|clipPath|mask)\b|\btransform\s*=/.test(xml)) {
    throw new Error(`${name}: export masters must contain plain outlined paths without transforms`);
  }
  const viewBox = xml.match(/\bviewBox="([^"]+)"/)?.[1].trim().split(/\s+/).map(Number);
  if (!viewBox || viewBox.length !== 4 || viewBox.some(value => !Number.isFinite(value)) ||
      viewBox[0] !== 0 || viewBox[1] !== 0 || viewBox[2] <= 0 || viewBox[3] <= 0) {
    throw new Error(`${name}: expected viewBox="0 0 width height"`);
  }
  const paths = [...xml.matchAll(/<path\b[^>]*\bd="([^"]+)"[^>]*\/?\s*>/g)].map(match => match[1]);
  if (!paths.length) throw new Error(`${name}: no outlined paths`);
  return { viewBox, paths, commands: paths.flatMap(commands) };
}

const [mark, tile, wordmark, nativeRenderer, cliTemplate] = await Promise.all([
  master(config.sources.mark), master(config.sources.tile), master(config.sources.wordmark),
  readFile(resolve(sourceDir, 'native-renderer.swift'), 'utf8'),
  readFile(resolve(root, 'scripts/make-icon.template.swift'), 'utf8'),
]);
const { ink, ivory, gold } = config.colors;
const { canvas, markBounds, markWidth, markCenter, smallCanvas, smallMarkWidth } = config.icon;
const colorValid = color => /^#[\dA-F]{6}$/.test(color);
const finite = values => Array.isArray(values) && values.every(Number.isFinite);
for (const [key, color] of Object.entries(config.colors)) {
  if (!colorValid(color)) throw new Error(`Invalid color ${key}: ${color}`);
}
if (!finite([canvas, markWidth, smallCanvas, smallMarkWidth]) ||
    canvas <= 0 || smallCanvas <= 0 || markWidth <= 0 || markWidth >= canvas ||
    smallMarkWidth <= 0 || smallMarkWidth >= smallCanvas ||
    !finite(markBounds) || markBounds.length !== 4 || markBounds[2] <= 0 || markBounds[3] <= 0 ||
    !finite(markCenter) || markCenter.length !== 2 ||
    tile.viewBox[2] !== canvas || tile.viewBox[3] !== canvas) {
  throw new Error('Invalid app-icon geometry');
}

const serialize = list => list.map(({ op, values }) => `${op}${values.map(number).join(' ')}`).join(' ');
function transformCommands(list, scale, tx, ty) {
  return list.map(({ op, values }) => ({ op, values: values.map((value, i) =>
    Number((value * scale + (i % 2 ? ty : tx)).toFixed(6))) }));
}
function derived(asset, scale, tx, ty, width, height) {
  const result = transformCommands(asset.commands, scale, tx, ty);
  return { viewBox: [0, 0, width, height], paths: [serialize(result)], commands: result };
}
const inkCenter = [markBounds[0] + markBounds[2] / 2, markBounds[1] + markBounds[3] / 2];
const markScale = markWidth / markBounds[2];
const markOffset = [markCenter[0] - inkCenter[0] * markScale, markCenter[1] - inkCenter[1] * markScale];
const appMark = derived(mark, markScale, ...markOffset, canvas, canvas);
const smallScale = smallMarkWidth / markBounds[2];
const smallMark = derived(mark, smallScale, smallCanvas / 2 - inkCenter[0] * smallScale,
  smallCanvas / 2 - inkCenter[1] * smallScale, smallCanvas, smallCanvas);
const tileRim = derived(tile, 0.996, canvas * 0.002, canvas * 0.002, canvas, canvas);
const tileSoftRim = derived(tile, 0.990, canvas * 0.005, canvas * 0.005, canvas, canvas);

function transformedPaint(paint, scale = 1, tx = 0, ty = 0) {
  const result = structuredClone(paint);
  for (const name of ['from', 'to', 'center']) {
    if (result[name]) result[name] = result[name].map((v, i) => Number((v * scale + (i ? ty : tx)).toFixed(6)));
  }
  if (result.radius) result.radius *= scale;
  return result;
}
function validatePaint(paint, name) {
  const validOpacity = value => value === undefined || (Number.isFinite(value) && value >= 0 && value <= 1);
  if (!validOpacity(paint.opacity)) throw new Error(`Invalid opacity in ${name}`);
  if (paint.kind === 'solid') {
    if (!colorValid(paint.color)) throw new Error(`Invalid solid paint ${name}`);
    return;
  }
  if (!['linear', 'radial'].includes(paint.kind) || !Array.isArray(paint.stops) || paint.stops.length < 2) {
    throw new Error(`Invalid gradient ${name}`);
  }
  let previous = -1;
  for (const stop of paint.stops) {
    if (!Number.isFinite(stop.offset) || stop.offset < previous || stop.offset < 0 || stop.offset > 1 ||
        !colorValid(stop.color) || !validOpacity(stop.opacity)) throw new Error(`Invalid gradient stop in ${name}`);
    previous = stop.offset;
  }
  const pointValid = value => finite(value) && value.length === 2;
  if (paint.kind === 'linear' && (!pointValid(paint.from) || !pointValid(paint.to) ||
      paint.from.every((v, i) => v === paint.to[i]))) throw new Error(`Invalid linear gradient geometry in ${name}`);
  if (paint.kind === 'radial' && (!pointValid(paint.center) || !Number.isFinite(paint.radius) || paint.radius <= 0)) {
    throw new Error(`Invalid radial gradient geometry in ${name}`);
  }
}
const material = config.material;
const render = {
  canvas,
  paths: { tile: tile.commands, tileRim: tileRim.commands, tileSoftRim: tileSoftRim.commands, mark: appMark.commands },
  paints: {
    tileGradient: material.tileGradient, tileLight: material.tileLight,
    tileRim: material.tileRim, tileSoftRim: { ...material.tileRim, opacity: 0.12 },
    markGradient: transformedPaint(material.markGradient, markScale, ...markOffset),
    markLight: transformedPaint(material.markLight, markScale, ...markOffset),
    markRim: transformedPaint(material.markRim, markScale, ...markOffset),
  },
  layers: [],
};
function shadow(path, shadow) {
  if (!finite(shadow.offset) || shadow.offset.length !== 2 || !Array.isArray(shadow.passes)) {
    throw new Error(`Invalid ${path} shadow geometry`);
  }
  shadow.passes.forEach((pass, index) => {
    if (!Number.isFinite(pass.width) || pass.width < 0) throw new Error(`Invalid ${path} shadow width`);
    const name = `${path}Shadow${index}`;
    render.paints[name] = { kind: 'solid', color: shadow.color, opacity: pass.opacity };
    render.layers.push({ path, paint: name, mode: pass.width ? 'fillStroke' : 'fill',
      ...(pass.width ? { width: pass.width } : {}), offset: shadow.offset });
  });
}
shadow('tile', material.tileShadow);
render.layers.push(
  { path: 'tile', paint: 'tileGradient', mode: 'fill' },
  { path: 'tile', paint: 'tileLight', mode: 'fill' },
  { path: 'tileSoftRim', paint: 'tileSoftRim', mode: 'stroke', width: 9 },
  { path: 'tileRim', paint: 'tileRim', mode: 'stroke', width: 2.5 },
);
shadow('mark', material.markShadow);
render.layers.push(
  { path: 'mark', paint: 'markGradient', mode: 'fill' },
  { path: 'mark', paint: 'markLight', mode: 'fill' },
  { path: 'mark', paint: 'markRim', mode: 'stroke', width: 1.4 },
);
for (const [name, paint] of Object.entries(render.paints)) validatePaint(paint, name);
validatePaint(material.markGradient, 'standalone mark gradient');

const paths = asset => asset.paths.map(d => `<path d="${d}"/>`).join('\n');
const svg = (title, width, height, body) =>
  `<!-- Generated by scripts/generate-brand.mjs; edit Resources/Brand masters. -->\n` +
  `<svg xmlns="http://www.w3.org/2000/svg" width="${number(width)}" height="${number(height)}" viewBox="0 0 ${number(width)} ${number(height)}" role="img" aria-labelledby="title">\n` +
  `<title id="title">${escape(title)}</title>\n${body}\n</svg>\n`;
const colored = (asset, fill) => `<g fill="${fill}">\n${paths(asset)}\n</g>`;
const standalone = (asset, fill, title) => svg(title, asset.viewBox[2], asset.viewBox[3], colored(asset, fill));
function gradientDefinition(name, paint) {
  const stops = paint.stops.map(stop => `<stop offset="${number(stop.offset)}" stop-color="${stop.color}" stop-opacity="${number((paint.opacity ?? 1) * (stop.opacity ?? 1))}"/>`).join('');
  if (paint.kind === 'linear') {
    return `<linearGradient id="${name}" gradientUnits="userSpaceOnUse" x1="${number(paint.from[0])}" y1="${number(paint.from[1])}" x2="${number(paint.to[0])}" y2="${number(paint.to[1])}">${stops}</linearGradient>`;
  }
  return `<radialGradient id="${name}" gradientUnits="userSpaceOnUse" cx="${number(paint.center[0])}" cy="${number(paint.center[1])}" r="${number(paint.radius)}">${stops}</radialGradient>`;
}
function modelSVG(model) {
  const defs = Object.entries(model.paints).filter(([, paint]) => paint.kind !== 'solid')
    .map(([name, paint]) => gradientDefinition(name, paint)).join('\n');
  const body = model.layers.map(layer => {
    const paint = model.paints[layer.paint];
    const fill = paint.kind === 'solid' ? paint.color : `url(#${layer.paint})`;
    const opacity = paint.kind === 'solid' ? paint.opacity ?? 1 : 1;
    // Fill/stroke opacities are separate: SVG and Core Graphics both composite
    // the fill first, then the stroke. No filter or bitmap dependency is used.
    return `<path d="${serialize(model.paths[layer.path])}" fill="${layer.mode === 'stroke' ? 'none' : fill}" fill-opacity="${number(opacity)}"` +
      (layer.mode !== 'fill' ? ` stroke="${fill}" stroke-opacity="${number(opacity)}" stroke-width="${number(layer.width)}" stroke-linejoin="round" stroke-linecap="round"` : '') +
      (layer.offset ? ` transform="translate(${layer.offset.map(number).join(' ')})"` : '') + '/>';
  }).join('\n');
  return `<defs>\n${defs}\n</defs>\n${body}`;
}
const appIcon = svg('DictaDuo Inkflow Graphite app icon', canvas, canvas, modelSVG(render));
const goldMark = svg('DictaDuo Inkflow gold logo', mark.viewBox[2], mark.viewBox[3],
  `<defs>${gradientDefinition('inkflowGold', material.markGradient)}</defs>\n${colored(mark, 'url(#inkflowGold)')}`);
function lockup(symbolFill, textFill, gradient = false) {
  const height = 128, markVisibleWidth = 158, textHeight = 76;
  const scale = markVisibleWidth / markBounds[2];
  const textScale = textHeight / wordmark.viewBox[3];
  const textX = 198;
  const tx = 16 - markBounds[0] * scale, ty = height / 2 - inkCenter[1] * scale;
  return svg('DictaDuo — Inkflow Graphite identity', textX + wordmark.viewBox[2] * textScale + 16, height,
    (gradient ? `<defs>${gradientDefinition('inkflowGold', material.markGradient)}</defs>\n` : '') +
    `<g fill="${gradient ? 'url(#inkflowGold)' : symbolFill}" transform="translate(${number(tx)} ${number(ty)}) scale(${number(scale)})">\n${paths(mark)}\n</g>\n` +
    `<g fill="${textFill}" transform="translate(${textX} 26) scale(${number(textScale)})">\n${paths(wordmark)}\n</g>`);
}
function swiftPath(name, asset) {
  const statements = asset.commands.map(({ op, values: v }) => {
    const point = i => `CGPoint(x: ${number(v[i])}, y: ${number(v[i + 1])})`;
    switch (op) {
      case 'M': return `path.move(to: ${point(0)})`;
      case 'L': return `path.addLine(to: ${point(0)})`;
      case 'C': return `path.addCurve(to: ${point(4)}, control1: ${point(0)}, control2: ${point(2)})`;
      case 'Q': return `path.addQuadCurve(to: ${point(2)}, control: ${point(0)})`;
      case 'Z': return 'path.closeSubpath()';
      default: throw new Error(`Cannot export ${op} to Swift`);
    }
  });
  return `    static func ${name}(in rect: CGRect) -> CGPath {\n` +
    `        let path = CGMutablePath()\n${statements.map(line => '        ' + line).join('\n')}\n` +
    `        let scale = min(rect.width / ${number(asset.viewBox[2])}, rect.height / ${number(asset.viewBox[3])})\n` +
    `        var transform = CGAffineTransform(a: scale, b: 0, c: 0, d: scale,\n` +
    `                                          tx: rect.minX + (rect.width - ${number(asset.viewBox[2])} * scale) / 2,\n` +
    `                                          ty: rect.minY + (rect.height - ${number(asset.viewBox[3])} * scale) / 2)\n` +
    `        return path.copy(using: &transform) ?? path\n    }\n`;
}
const generatedHeader = '// Generated by scripts/generate-brand.mjs. Do not hand-edit.\n';
const swift = generatedHeader + nativeRenderer + '\n\nenum DictaDuoArtwork {\n' +
  Object.entries(config.colors).map(([name, color]) => `    static let ${name}: UInt32 = 0x${color.slice(1)}\n`).join('') +
  `    static let wordmarkAspectRatio: CGFloat = ${number(wordmark.viewBox[2])} / ${number(wordmark.viewBox[3])}\n\n` +
  swiftPath('markPath', mark) + '\n' + swiftPath('smallMarkPath', smallMark) + '\n' + swiftPath('wordmarkPath', wordmark) + '\n' +
  swiftPath('appTilePath', tile) + '\n' + swiftPath('appMarkPath', appMark) + '\n' +
  '    // Generation validates this model before embedding it.\n' +
  '    private static let iconModel = try! JSONDecoder().decode(BrandIconRenderer.Model.self, from: Data(#"""\n' +
  JSON.stringify(render, null, 2).split('\n').map(line => '    ' + line).join('\n') + '\n    """#.utf8))\n\n' +
  '    static func drawAppIcon(in rect: CGRect, context: CGContext) throws {\n' +
  '        try BrandIconRenderer.draw(iconModel, in: rect, context: context)\n    }\n}\n';
const cli = generatedHeader + nativeRenderer + '\n\n' + cliTemplate;
const outputs = new Map([
  ['Resources/Brand/generated/app-icon.svg', appIcon],
  ['Resources/Brand/generated/logo.svg', standalone(mark, ink, 'DictaDuo Inkflow graphite logo')],
  ['Resources/Brand/generated/logo-gold.svg', goldMark],
  ['Resources/Brand/generated/logo-monochrome.svg', standalone(mark, '#000000', 'DictaDuo Inkflow monochrome logo')],
  ['Resources/Brand/generated/logo-reversed.svg', standalone(mark, '#FFFFFF', 'DictaDuo Inkflow reversed logo')],
  ['Resources/Brand/generated/symbol-master.svg', standalone(smallMark, 'currentColor', 'DictaDuo Inkflow same-contour small master')],
  ['Resources/Brand/generated/symbol.svg', standalone(smallMark, ink, 'DictaDuo Inkflow small symbol')],
  ['Resources/Brand/generated/symbol-reversed.svg', standalone(smallMark, ivory, 'DictaDuo Inkflow small reversed symbol')],
  ['Resources/Brand/generated/wordmark.svg', standalone(wordmark, ink, 'DictaDuo wordmark')],
  ['Resources/Brand/generated/wordmark-reversed.svg', standalone(wordmark, ivory, 'DictaDuo reversed wordmark')],
  ['Resources/Brand/generated/lockup-light.svg', lockup(ink, ink)],
  ['Resources/Brand/generated/lockup-dark.svg', lockup(gold, ivory, true)],
  ['Resources/Brand/generated/lockup-monochrome.svg', lockup('#000000', '#000000')],
  ['Resources/Brand/generated/lockup-reversed.svg', lockup('#FFFFFF', '#FFFFFF')],
  ['Resources/Brand/generated/drawing.json', JSON.stringify({
    name: config.name, identity: config.identity, colors: config.colors, icon: config.icon,
    mark: { viewBox: mark.viewBox, commands: mark.commands },
    smallMark: { viewBox: smallMark.viewBox, commands: smallMark.commands },
    tile: { viewBox: tile.viewBox, commands: tile.commands }, render,
  }, null, 2) + '\n'],
  ['Clients/Linux/gui/mark.svg', appIcon],
  ['Clients/Linux/gui/mark-symbolic.svg', standalone(smallMark, ink, 'DictaDuo Inkflow tray symbol')],
  ['Clients/Linux/gui/mark-symbolic-light.svg', standalone(smallMark, ivory, 'DictaDuo Inkflow light tray symbol')],
  ['Clients/Linux/gui/wordmark.svg', standalone(wordmark, ink, 'DictaDuo wordmark')],
  ['Clients/Linux/gui/wordmark-light.svg', standalone(wordmark, ivory, 'DictaDuo light wordmark')],
  ['Clients/macOS/Sources/DictaDuo/Views/DictaDuoArtwork.generated.swift', swift],
  ['scripts/make-icon.swift', cli],
  ['docs/images/dictaduo-light.svg', lockup(ink, ink)],
  ['docs/images/dictaduo-dark.svg', lockup(gold, ivory, true)],
]);
const stale = [];
for (const [name, content] of outputs) {
  const destination = resolve(root, name);
  if (check) {
    const current = await readFile(destination, 'utf8').catch(() => null);
    if (current !== content) stale.push(name);
  } else {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}
if (stale.length) {
  console.error('Brand exports are missing or stale:\n' + stale.map(name => '  ' + name).join('\n'));
  console.error('Run: node scripts/generate-brand.mjs');
  process.exitCode = 1;
} else {
  console.log(`${check ? 'Verified' : 'Generated'} ${outputs.size} Inkflow Graphite vector/native outputs.`);
}
