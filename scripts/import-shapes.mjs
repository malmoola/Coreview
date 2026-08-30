#!/usr/bin/env node
/**
 * Turns vendor shape libraries into a folder of named SVGs the app can index.
 *
 * Vendor icon sets — Cisco's, Fortinet's, the ones that circulate as a .pptx
 * with a slide per product family — store each icon as an EMF, which is a
 * Windows vector format no browser can read. The icons are vector and worth
 * keeping as vector, so they are converted rather than screenshotted.
 *
 * The names come from the deck itself. Every one of these decks labels its
 * icons with a caption underneath, so each picture is matched to the nearest
 * caption below it. Where there is no caption the file keeps its slide and
 * index, which is honest — inventing a name for an icon nobody labelled would
 * be worse than leaving it findable by where it came from.
 *
 * Needs Inkscape on the PATH for the EMF conversion.
 *
 * Handles what these libraries actually arrive as:
 *
 *   .pptx                a slide per product family, one EMF per icon
 *   .vssx .vsdx .vstx    Visio 2013 and later, which are zip containers
 *   .zip                 a bag of any of the above, or of loose images
 *   a folder             walked, so a whole shape collection goes in at once
 *   .emf .wmf .svg       loose files
 *
 * Legacy binary `.vss` — Visio 2003 through 2010 — is not a zip and cannot be
 * opened here. Those are reported by name rather than skipped silently, so it
 * is clear which files still need converting and which went in.
 *
 *     node scripts/import-shapes.mjs <file-or-folder> <output-folder>
 *
 * Then point Coreview's icon library at the output folder.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error('usage: node scripts/import-shapes.mjs <file-or-folder> <output-folder>');
  process.exit(2);
}

const has = (cmd) => {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
if (!has('inkscape')) {
  console.error('Inkscape is needed to read EMF. Install it and run this again.');
  process.exit(1);
}

/** XML entities, which otherwise reach the palette as "Client &amp; Device". */
const decode = (t) =>
  t
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');

/** Emu are PowerPoint's internal units. Only ratios matter here. */
const num = (v) => (v == null ? null : Number(v));

/** Every picture and every caption on one slide, with where it sits. */
function readSlide(xml) {
  const pics = [];
  for (const block of xml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) ?? []) {
    const rid = /r:embed="([^"]+)"/.exec(block)?.[1];
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(block);
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(block);
    if (!rid || !off) continue;
    pics.push({
      rid,
      x: num(off[1]),
      y: num(off[2]),
      cx: num(ext?.[1]) ?? 0,
      cy: num(ext?.[2]) ?? 0,
    });
  }

  const captions = [];
  for (const block of xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []) {
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(block);
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(block);
    const text = decode(
      (block.match(/<a:t>([^<]*)<\/a:t>/g) ?? [])
        .map((t) => t.replace(/<\/?a:t>/g, ''))
        .join(' '),
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (!off || text === '') continue;
    captions.push({
      text,
      x: num(off[1]),
      y: num(off[2]),
      cx: num(ext?.[1]) ?? 0,
      cy: num(ext?.[2]) ?? 0,
    });
  }
  return { pics, captions };
}

/** The caption that belongs to a picture: the nearest one below it, roughly
 *  under its middle. A caption far to the side belongs to a different icon. */
function captionFor(pic, captions) {
  const midX = pic.x + pic.cx / 2;
  const bottom = pic.y + pic.cy;
  let best = null;
  let bestScore = Infinity;
  for (const c of captions) {
    const cMid = c.x + c.cx / 2;
    const below = c.y - bottom;
    // Allow a caption that starts slightly above the picture's foot, which
    // happens when the text box overlaps the image.
    if (below < -pic.cy * 0.4) continue;
    const across = Math.abs(cMid - midX);
    if (across > Math.max(pic.cx, 900000)) continue;
    const score = below + across * 1.6;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best?.text ?? null;
}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

mkdirSync(outDir, { recursive: true });

const catalogue = [];
const used = new Map();
let written = 0;
let unnamed = 0;
const unreadable = [];

/** The heading a slide carries, which is the family its icons belong to —
 *  "Routing WAN", "Wireless", "Security". It becomes the palette group, so an
 *  imported set arrives sorted instead of as one list of two hundred. */
function slideTitle(captions) {
  const highest = captions.reduce((best, c) => (best === null || c.y < best.y ? c : best), null);
  return highest?.text?.slice(0, 40) ?? null;
}

/** A name that is safe as a file and still recognisable. */
function claim(name, fallback) {
  let base = slug(name ?? '') || fallback;
  const seen = (used.get(base) ?? 0) + 1;
  used.set(base, seen);
  return seen === 1 ? base : `${base}-${seen}`;
}

/** Convert one image into the output folder under the given name. */
function emit(source, name, category) {
  const id = claim(name, 'shape');
  const file = join(outDir, `${id}.svg`);
  if (/\.(emf|wmf)$/i.test(source)) {
    try {
      execFileSync(
        'inkscape',
        ['--export-type=svg', '--export-plain-svg', `--export-filename=${file}`, source],
        { stdio: 'ignore', timeout: 30_000 },
      );
    } catch {
      return;
    }
  } else if (/\.svg$/i.test(source)) {
    copyFileSync(source, file);
  } else {
    return;
  }
  if (!existsSync(file)) return;
  written += 1;
  if (!name) unnamed += 1;
  catalogue.push({ file: `${id}.svg`, name: name ?? humanise(id), category });
}

const humanise = (id) =>
  id.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());

/** A PowerPoint stencil deck: captions under icons, a family per slide. */
function fromPptx(file, category) {
  const work = mkdtempSync(join(tmpdir(), 'cv-pptx-'));
  try {
    execFileSync('unzip', ['-o', '-q', file, '-d', work], { stdio: 'ignore' });
  } catch {
    unreadable.push(`${basename(file)}: not a readable zip container`);
    rmSync(work, { recursive: true, force: true });
    return;
  }
  const slideDir = join(work, 'ppt', 'slides');
  if (!existsSync(slideDir)) {
    rmSync(work, { recursive: true, force: true });
    return;
  }
  for (const slideFile of readdirSync(slideDir).filter((f) => f.endsWith('.xml')).sort()) {
    const xml = readFileSync(join(slideDir, slideFile), 'utf8');
    const relsPath = join(slideDir, '_rels', `${slideFile}.rels`);
    if (!existsSync(relsPath)) continue;
    const rels = new Map();
    for (const m of readFileSync(relsPath, 'utf8').matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      rels.set(m[1], m[2]);
    }
    const { pics, captions } = readSlide(xml);
    const group = slideTitle(captions) || category;
    pics.forEach((pic) => {
      const target = rels.get(pic.rid);
      if (!target) return;
      const source = join(work, 'ppt', target.replace(/^\.\.\//, ''));
      if (!existsSync(source)) return;
      emit(source, captionFor(pic, captions), group);
    });
  }
  rmSync(work, { recursive: true, force: true });
}

/** A Visio 2013+ stencil, which is a zip with its images under visio/media. */
function fromVisio(file, category) {
  const work = mkdtempSync(join(tmpdir(), 'cv-visio-'));
  try {
    execFileSync('unzip', ['-o', '-q', file, '-d', work], { stdio: 'ignore' });
  } catch {
    unreadable.push(`${basename(file)}: not a readable zip container`);
    rmSync(work, { recursive: true, force: true });
    return;
  }
  const group = category || humanise(slug(basename(file).replace(/\.[^.]+$/, '')));
  // Master names live in masters.xml and are the shape names a person knows.
  const names = [];
  const mastersPath = join(work, 'visio', 'masters', 'masters.xml');
  if (existsSync(mastersPath)) {
    for (const m of readFileSync(mastersPath, 'utf8').matchAll(/<Master[^>]*NameU="([^"]*)"/g)) {
      names.push(decode(m[1]));
    }
  }
  const mediaDir = join(work, 'visio', 'media');
  if (existsSync(mediaDir)) {
    readdirSync(mediaDir)
      .sort()
      .forEach((f, i) => emit(join(mediaDir, f), names[i] ?? null, group));
  }
  rmSync(work, { recursive: true, force: true });
}

/** A plain zip: unpack it and walk whatever came out. */
function fromZip(file, category) {
  const work = mkdtempSync(join(tmpdir(), 'cv-zip-'));
  try {
    execFileSync('unzip', ['-o', '-q', file, '-d', work], { stdio: 'ignore' });
  } catch {
    unreadable.push(`${basename(file)}: could not be unpacked`);
    rmSync(work, { recursive: true, force: true });
    return;
  }
  walk(work, category || humanise(slug(basename(file).replace(/\.zip$/i, ''))), 0);
  rmSync(work, { recursive: true, force: true });
}

const MAX_DEPTH = 8;

/** Everything under a path, whatever shape it takes. */
function walk(path, category, depth) {
  if (depth > MAX_DEPTH) return;
  const stats = statSync(path);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      const child = join(path, entry);
      const group =
        depth === 0 && !category
          ? humanise(slug(entry.replace(/\.[^.]+$/, '')))
          : (category ?? humanise(slug(basename(path))));
      walk(child, statSync(child).isDirectory() ? humanise(slug(entry)) : group, depth + 1);
    }
    return;
  }
  const lower = path.toLowerCase();
  if (lower.endsWith('.pptx')) fromPptx(path, category);
  else if (/\.(vssx|vsdx|vstx|vsx)$/.test(lower)) fromVisio(path, category);
  else if (lower.endsWith('.zip')) fromZip(path, category);
  else if (/\.(emf|wmf|svg)$/.test(lower)) {
    emit(path, humanise(slug(basename(path).replace(/\.[^.]+$/, ''))), category ?? 'Imported');
  } else if (lower.endsWith('.vss') || lower.endsWith('.vsd')) {
    // Visio 2003-2010 wrote a compound binary file, not a zip. Nothing here
    // can open it, and saying which files those were is more use than a
    // count of what was skipped.
    unreadable.push(`${basename(path)}: legacy binary Visio — re-save as .vssx in Visio, or convert with libvisio-tools`);
  }
}

walk(input, null, 0);

writeFileSync(join(outDir, 'index.json'), `${JSON.stringify({ icons: catalogue }, null, 2)}\n`);

console.log(`${written} shapes written to ${outDir}`);
if (unnamed) console.log(`${unnamed} had no name in the source and are named after their file.`);
if (unreadable.length) {
  console.log(`\n${unreadable.length} file(s) could not be read:`);
  for (const u of unreadable.slice(0, 40)) console.log(`  ${u}`);
  if (unreadable.length > 40) console.log(`  ...and ${unreadable.length - 40} more`);
}
console.log(`\nPoint Coreview's icon library at ${outDir} to use them.`);
