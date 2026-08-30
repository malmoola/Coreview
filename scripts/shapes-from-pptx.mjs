#!/usr/bin/env node
/**
 * Turns a PowerPoint stencil deck into a folder of named SVGs.
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
 *     node scripts/shapes-from-pptx.mjs <deck.pptx> <output-folder>
 *
 * Then point Coreview's icon library at the output folder.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, existsSync, writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const [deck, outDir] = process.argv.slice(2);
if (!deck || !outDir) {
  console.error('usage: node scripts/shapes-from-pptx.mjs <deck.pptx> <output-folder>');
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

const work = mkdtempSync(join(tmpdir(), 'cv-shapes-'));
execFileSync('unzip', ['-o', '-q', deck, '-d', work]);

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

const slideDir = join(work, 'ppt', 'slides');
const slides = existsSync(slideDir)
  ? readdirSync(slideDir).filter((f) => f.endsWith('.xml')).sort()
  : [];

const used = new Map();
const catalogue = [];
let written = 0;
let unnamed = 0;

/** The heading a slide carries, which is the family these icons belong to —
 *  "Routing WAN", "Wireless", "Security". It becomes the palette group, so an
 *  imported set arrives sorted instead of as one list of two hundred. */
function slideTitle(captions) {
  const highest = captions.reduce((best, c) => (best === null || c.y < best.y ? c : best), null);
  return highest?.text?.slice(0, 40) ?? 'Imported';
}

for (const slideFile of slides) {
  const xml = readFileSync(join(slideDir, slideFile), 'utf8');
  const relsPath = join(slideDir, '_rels', `${slideFile}.rels`);
  if (!existsSync(relsPath)) continue;
  const rels = new Map();
  for (const m of readFileSync(relsPath, 'utf8').matchAll(
    /Id="([^"]+)"[^>]*Target="([^"]+)"/g,
  )) {
    rels.set(m[1], m[2]);
  }

  const { pics, captions } = readSlide(xml);
  const slideNo = /slide(\d+)\.xml/.exec(slideFile)?.[1] ?? '0';
  const category = slideTitle(captions);

  pics.forEach((pic, index) => {
    const target = rels.get(pic.rid);
    if (!target) return;
    const source = join(work, 'ppt', target.replace(/^\.\.\//, ''));
    if (!existsSync(source)) return;

    const caption = captionFor(pic, captions);
    let name = caption ? slug(caption) : '';
    if (!name) {
      name = `unnamed-slide${slideNo}-${index + 1}`;
      unnamed += 1;
    }
    // Two icons with the same caption on one deck is normal — "Router"
    // appears half a dozen times in the Cisco set with different artwork.
    const seen = (used.get(name) ?? 0) + 1;
    used.set(name, seen);
    const file = join(outDir, seen === 1 ? `${name}.svg` : `${name}-${seen}.svg`);

    if (/\.emf$/i.test(source) || /\.wmf$/i.test(source)) {
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
      renameSync(source, file);
    } else {
      return;
    }
    if (existsSync(file)) {
      written += 1;
      catalogue.push({
        file: basename(file),
        name: caption ? caption.replace(/\s+/g, ' ').trim() : `Unnamed ${slideNo}-${index + 1}`,
        category,
      });
    }
  });
}

// Names and groups for the palette. Without this every icon shows up under
// its filename in one undifferentiated list.
writeFileSync(join(outDir, 'index.json'), `${JSON.stringify({ icons: catalogue }, null, 2)}\n`);

rmSync(work, { recursive: true, force: true });
console.log(
  `${written} shapes written to ${outDir}` +
    (unnamed ? `, ${unnamed} of them with no caption in the deck` : ''),
);
console.log(`Point Coreview's icon library at ${outDir} to use them.`);
