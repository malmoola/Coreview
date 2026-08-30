#!/usr/bin/env node
/**
 * Cisco-style PPTX stencil deck -> stencils/<out>/<category>/<slug>.svg
 *
 * The deck stores each icon as an EMF. LibreOffice converts EMF to SVG, but it
 * emits every icon on a full A4 page with the artwork in the top-left corner —
 * so each result must have its viewBox cropped to the real content, or every
 * icon renders as a tiny speck in a huge empty canvas (the "Untitled Drawing"
 * bug this replaces).
 *
 * Names come from the deck itself: each picture's nearest caption box below
 * it, matched by geometry from <a:off>/<a:ext>. Slide titles are categories.
 * <p:grpSp> groups are expanded into separate icons, never merged.
 *
 *     node scripts/import-pptx-stencils.mjs <deck.pptx> <out-dir>
 *
 * Needs `soffice` (LibreOffice) on PATH. It fails loudly when missing,
 * because silently skipping the conversion is how a broken library ships.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ------------------------------------------------------------- pure pieces
// Exported so they can be tested without LibreOffice installed.

const decode = (t) =>
  t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
   .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
   .replace(/&amp;/g, '&');

export const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'shape';

/**
 * Every number a path's d attribute walks through, as absolute coordinates.
 * Handles the commands LibreOffice actually emits (M L C Q H V Z, upper and
 * lower). Enough for a bounding box; not a general path engine.
 */
export function pathPoints(d) {
  const out = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let i = 0, cmd = '';
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase() && cmd !== 'z' && cmd !== 'Z';
    switch (cmd.toUpperCase()) {
      case 'M': case 'L': case 'T': {
        const nx = num(), ny = num();
        x = rel ? x + nx : nx; y = rel ? y + ny : ny;
        if (cmd.toUpperCase() === 'M') { sx = x; sy = y; }
        out.push({ x, y });
        break;
      }
      case 'H': { const n = num(); x = rel ? x + n : n; out.push({ x, y }); break; }
      case 'V': { const n = num(); y = rel ? y + n : n; out.push({ x, y }); break; }
      case 'C': {
        for (let k = 0; k < 2; k++) { const cx = num(), cy = num();
          out.push({ x: rel ? x + cx : cx, y: rel ? y + cy : cy }); }
        const nx = num(), ny = num();
        x = rel ? x + nx : nx; y = rel ? y + ny : ny; out.push({ x, y });
        break;
      }
      case 'S': case 'Q': {
        const cx = num(), cy = num();
        out.push({ x: rel ? x + cx : cx, y: rel ? y + cy : cy });
        const nx = num(), ny = num();
        x = rel ? x + nx : nx; y = rel ? y + ny : ny; out.push({ x, y });
        break;
      }
      case 'A': { i += 5; const nx = num(), ny = num();
        x = rel ? x + nx : nx; y = rel ? y + ny : ny; out.push({ x, y }); break; }
      case 'Z': x = sx; y = sy; break;
      default: i++;
    }
  }
  return out;
}

/**
 * Crops a LibreOffice SVG to its real content.
 *
 * The content bounding box comes from every <path d>, <rect>, <circle> and
 * <ellipse>; the viewBox is rewritten to that box plus ~2% padding, and
 * width/height are dropped so the icon scales to its container.
 */
export function cropToContent(svg) {
  const points = [];
  for (const m of svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)) {
    points.push(...pathPoints(m[1]));
  }
  for (const m of svg.matchAll(/<rect[^>]*\bx="(-?[\d.]+)"[^>]*\by="(-?[\d.]+)"[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/g)) {
    const [x, y, w, h] = [+m[1], +m[2], +m[3], +m[4]];
    points.push({ x, y }, { x: x + w, y: y + h });
  }
  for (const m of svg.matchAll(/<(?:circle|ellipse)[^>]*\bcx="(-?[\d.]+)"[^>]*\bcy="(-?[\d.]+)"[^>]*\br[xy]?="([\d.]+)"/g)) {
    const [cx, cy, r] = [+m[1], +m[2], +m[3]];
    points.push({ x: cx - r, y: cy - r }, { x: cx + r, y: cy + r });
  }
  if (points.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const pad = Math.max(w, h) * 0.02;
  const vb = [minX - pad, minY - pad, w + pad * 2, h + pad * 2]
    .map((n) => Math.round(n * 100) / 100).join(' ');
  let out = svg
    .replace(/(<svg[^>]*?)\sviewBox="[^"]*"/, '$1')
    .replace(/(<svg[^>]*?)\swidth="[^"]*"/, '$1')
    .replace(/(<svg[^>]*?)\sheight="[^"]*"/, '$1')
    .replace(/<svg/, `<svg viewBox="${vb}"`);
  return out;
}

/** LibreOffice cruft the icons do not need. */
export function stripCruft(svg) {
  return svg
    .replace(/<!DOCTYPE[^>]*>\s*/g, '')
    .replace(/<\?xml[^>]*\?>\s*/g, '')
    .replace(/\sxmlns:(?:ooo|smil|anim|presentation)="[^"]*"/g, '')
    .replace(/<defs[^>]*class="[^"]*(?:ClipPathGroup|EmbeddedBulletChars|TextShapeIndex|BackgroundShapes)[^"]*"[\s\S]*?<\/defs>/g, '')
    // A <g> that only carries a clip-path reference contributes nothing once
    // the page-sized clip is gone.
    .replace(/<g\s+clip-path="[^"]*"\s*>/g, '<g>')
    // Empty wrappers, applied repeatedly because removing one exposes the next.
    .replace(/<g>\s*<\/g>/g, '').replace(/<g>\s*<\/g>/g, '').replace(/<g>\s*<\/g>/g, '');
}

/** Pictures and caption boxes on one slide, with geometry — groups expanded. */
export function readSlide(xml) {
  const pics = [];
  const geometryOf = (block) => {
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(block);
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(block);
    return off ? { x: +off[1], y: +off[2], cx: ext ? +ext[1] : 0, cy: ext ? +ext[2] : 0 } : null;
  };
  const collect = (xmlPart, shift) => {
    // Groups first: a <p:grpSp> child's coordinates are in the group's own
    // space (chOff/chExt) and must be mapped through the group's transform —
    // each child becomes its OWN icon, never a merged one.
    let rest = xmlPart;
    for (const g of xmlPart.match(/<p:grpSp>[\s\S]*?<\/p:grpSp>/g) ?? []) {
      rest = rest.replace(g, '');
      const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(g);
      const chOff = /<a:chOff x="(-?\d+)" y="(-?\d+)"\/>/.exec(g);
      const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(g);
      const chExt = /<a:chExt cx="(\d+)" cy="(\d+)"\/>/.exec(g);
      const scaleX = ext && chExt && +chExt[1] ? +ext[1] / +chExt[1] : 1;
      const scaleY = ext && chExt && +chExt[2] ? +ext[2] / +chExt[2] : 1;
      const inner = g.replace(/^<p:grpSp>[\s\S]*?<\/p:grpSpPr>/, '');
      collect(inner, (p) => shift({
        x: (off ? +off[1] : 0) + (p.x - (chOff ? +chOff[1] : 0)) * scaleX,
        y: (off ? +off[2] : 0) + (p.y - (chOff ? +chOff[2] : 0)) * scaleY,
        cx: p.cx * scaleX,
        cy: p.cy * scaleY,
      }));
    }
    for (const block of rest.match(/<p:pic>[\s\S]*?<\/p:pic>/g) ?? []) {
      const rid = /r:embed="([^"]+)"/.exec(block)?.[1];
      const geo = geometryOf(block);
      if (rid && geo) pics.push({ rid, ...shift(geo) });
    }
  };
  collect(xml, (p) => p);

  const captions = [];
  for (const block of xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []) {
    const geo = geometryOf(block);
    const text = decode((block.match(/<a:t>([^<]*)<\/a:t>/g) ?? [])
      .map((t) => t.replace(/<\/?a:t>/g, '')).join(' ')).replace(/\s+/g, ' ').trim();
    if (geo && text) captions.push({ text, ...geo });
  }
  return { pics, captions };
}

/** The caption that belongs to a picture: x-centre nearest, sitting at or just
 *  below the picture's bottom edge. */
export function captionFor(pic, captions) {
  const midX = pic.x + pic.cx / 2;
  const bottom = pic.y + pic.cy;
  let best = null, bestScore = Infinity;
  for (const c of captions) {
    const below = c.y - bottom;
    if (below < -pic.cy * 0.4) continue;
    const across = Math.abs(c.x + c.cx / 2 - midX);
    if (across > Math.max(pic.cx, 900000)) continue;
    const score = Math.max(0, below) + across * 1.6;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return best?.text ?? null;
}

export function slideTitle(captions) {
  const top = captions.reduce((b, c) => (b === null || c.y < b.y ? c : b), null);
  return top?.text?.slice(0, 40) ?? null;
}

// ---------------------------------------------------------------- pipeline

function convertBatch(files, outDir) {
  const r = spawnSync('soffice', [
    '--headless', '--convert-to', 'svg', '--outdir', outDir, ...files,
  ], { stdio: 'pipe', timeout: 180_000 });
  if (r.error || r.status !== 0) {
    throw new Error(`soffice failed on a batch of ${files.length}: ${r.error ?? r.stderr}`);
  }
}

export function main(deck, outRoot) {
  try {
    execFileSync('which', ['soffice'], { stdio: 'ignore' });
  } catch {
    console.error(
      'FAILED: `soffice` (LibreOffice) is not on PATH and this pipeline cannot\n' +
      'run without it. Install it (e.g. `sudo apt-get install libreoffice-draw`)\n' +
      'and run this again. Nothing was written.',
    );
    process.exit(1);
  }

  const work = mkdtempSync(join(tmpdir(), 'cv-pptx-'));
  execFileSync('unzip', ['-o', '-q', deck, '-d', work]);
  const mediaDir = join(work, 'ppt', 'media');
  const emfs = readdirSync(mediaDir).filter((f) => /\.(emf|wmf)$/i.test(f)).sort();
  console.log(`${emfs.length} EMF/WMF files in the deck`);

  const svgDir = join(work, 'svg');
  mkdirSync(svgDir);
  for (let i = 0; i < emfs.length; i += 25) {
    convertBatch(emfs.slice(i, i + 25).map((f) => join(mediaDir, f)), svgDir);
    process.stdout.write(`converted ${Math.min(i + 25, emfs.length)}/${emfs.length}\r`);
  }
  console.log('');

  mkdirSync(outRoot, { recursive: true });
  const manifest = [];
  const unnamed = [];
  const used = new Map();
  const slideDir = join(work, 'ppt', 'slides');
  for (const slideFile of readdirSync(slideDir).filter((f) => f.endsWith('.xml')).sort()) {
    const xml = readFileSync(join(slideDir, slideFile), 'utf8');
    const rels = new Map([...readFileSync(join(slideDir, '_rels', `${slideFile}.rels`), 'utf8')
      .matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
    const slideNo = +(/slide(\d+)\.xml/.exec(slideFile)?.[1] ?? 0);
    const { pics, captions } = readSlide(xml);
    const category = slideTitle(captions) ?? `Slide ${slideNo}`;
    const catDir = join(outRoot, slug(category));
    mkdirSync(catDir, { recursive: true });

    for (const pic of pics) {
      const media = basename(rels.get(pic.rid) ?? '');
      const converted = join(svgDir, media.replace(/\.(emf|wmf)$/i, '.svg'));
      if (!existsSync(converted)) continue;
      const caption = captionFor(pic, captions);
      if (!caption) unnamed.push(`${slideFile}: ${media}`);
      let name = slug(caption ?? media.replace(/\.[^.]+$/, ''));
      const n = (used.get(name) ?? 0) + 1;
      used.set(name, n);
      if (n > 1) name = `${name}-${n}`;

      const raw = readFileSync(converted, 'utf8');
      const cropped = cropToContent(stripCruft(raw));
      if (!cropped) continue;
      const file = join(catDir, `${name}.svg`);
      writeFileSync(file, cropped);
      manifest.push({
        id: name, name: caption ?? name, category,
        file: `${slug(category)}/${name}.svg`, slide: slideNo,
      });
    }
  }

  writeFileSync(join(outRoot, 'manifest.json'), JSON.stringify({ icons: manifest }, null, 2));
  // The contact sheet: every icon in a tile, so a human can confirm each is
  // centred, fills its tile and is recognisable before the palette sees it.
  const tiles = manifest.map((m) =>
    `<div class="t"><img src="${m.file}"/><span>${m.name}</span></div>`).join('\n');
  writeFileSync(join(outRoot, 'contact-sheet.html'),
    `<!doctype html><style>body{font:12px sans-serif;display:grid;grid-template-columns:repeat(auto-fill,140px);gap:10px;padding:16px}.t{border:1px solid #ccc;padding:8px;text-align:center}.t img{width:100%;height:90px;object-fit:contain}</style>${tiles}`);
  rmSync(work, { recursive: true, force: true });
  console.log(`${manifest.length} icons written, ${unnamed.length} without a caption`);
  for (const u of unnamed.slice(0, 20)) console.log(`  no caption: ${u}`);
  console.log(`Open ${join(outRoot, 'contact-sheet.html')} and look before wiring anything.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [deck, out] = process.argv.slice(2);
  if (!deck || !out) {
    console.error('usage: node scripts/import-pptx-stencils.mjs <deck.pptx> <out-dir>');
    process.exit(2);
  }
  main(deck, out);
}
