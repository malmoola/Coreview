/**
 * The parts of the PPTX stencil pipeline that do not need LibreOffice,
 * tested against the operator's real deck (checked into test intent, read
 * from uploads at run time when present) and against a synthetic
 * LibreOffice-shaped SVG for the crop.
 */
import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as pipe from './import-pptx-stencils.mjs';

const LO_STYLE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:ooo="http://xml.openoffice.org/svg/export" width="210mm" height="297mm" viewBox="0 0 21000 29700">
 <defs class="ClipPathGroup"><clipPath id="p"><rect x="0" y="0" width="21000" height="29700"/></clipPath></defs>
 <g clip-path="url(#p)">
  <g><path d="M 500,400 L 1500,400 L 1500,1200 L 500,1200 Z" fill="#049fd9"/></g>
  <g></g>
 </g>
</svg>`;

describe('cropping a LibreOffice page down to its artwork', () => {
  it('rewrites the viewBox to the content, not the page', () => {
    // LibreOffice puts a 1000x800 icon on a 21000x29700 page. Without the
    // crop it renders as a speck — the "Untitled Drawing" bug.
    const out = pipe.cropToContent(pipe.stripCruft(LO_STYLE_SVG));
    const vb = /viewBox="([^"]+)"/.exec(out)[1].split(' ').map(Number);
    expect(vb[0]).toBeCloseTo(480, 0);
    expect(vb[2]).toBeCloseTo(1040, 0);
    expect(vb[3]).toBeCloseTo(840, 0);
  });

  it('drops width and height so the icon scales to its container', () => {
    const out = pipe.cropToContent(pipe.stripCruft(LO_STYLE_SVG));
    expect(out).not.toContain('width="210mm"');
    expect(out).not.toContain('height="297mm"');
  });

  it('strips the DOCTYPE, the page clip and the empty wrappers', () => {
    const out = pipe.cropToContent(pipe.stripCruft(LO_STYLE_SVG));
    expect(out).not.toContain('DOCTYPE');
    expect(out).not.toContain('ClipPathGroup');
    expect(out).not.toContain('clip-path=');
    expect(out).not.toContain('<g></g>');
    expect(out).toContain('<path');
  });

  it('follows relative path commands, or the box is wrong for half the deck', () => {
    const rel = '<svg viewBox="0 0 21000 29700"><path d="m 100,100 l 50,0 l 0,50 z"/></svg>';
    const out = pipe.cropToContent(rel);
    const vb = /viewBox="([^"]+)"/.exec(out)[1].split(' ').map(Number);
    expect(vb[0]).toBeLessThan(100);
    expect(vb[0] + vb[2]).toBeGreaterThan(150);
    expect(vb[0] + vb[2]).toBeLessThan(200);
  });

  it('has nothing to say about a file with no drawable content', () => {
    expect(pipe.cropToContent('<svg viewBox="0 0 10 10"></svg>')).toBeNull();
  });
});

describe('reading a slide', () => {
  const slide = `
<p:sld><p:cSld><p:spTree>
  <p:sp><p:spPr><a:xfrm><a:off x="100" y="50"/><a:ext cx="8000" cy="600"/></a:xfrm></p:spPr>
    <p:txBody><a:t>LAN Switching</a:t></p:txBody></p:sp>
  <p:pic><p:blipFill><a:blip r:embed="rId3"/></p:blipFill>
    <p:spPr><a:xfrm><a:off x="1000" y="2000"/><a:ext cx="900" cy="900"/></a:xfrm></p:spPr></p:pic>
  <p:sp><p:spPr><a:xfrm><a:off x="900" y="3000"/><a:ext cx="1100" cy="300"/></a:xfrm></p:spPr>
    <p:txBody><a:t>Catalyst 9300</a:t></p:txBody></p:sp>
  <p:sp><p:spPr><a:xfrm><a:off x="9000" y="3000"/><a:ext cx="1100" cy="300"/></a:xfrm></p:spPr>
    <p:txBody><a:t>Somebody else&#8217;s caption</a:t></p:txBody></p:sp>
  <p:grpSp><p:grpSpPr><a:xfrm><a:off x="5000" y="5000"/><a:ext cx="2000" cy="1000"/>
      <a:chOff x="0" y="0"/><a:chExt cx="1000" cy="500"/></a:xfrm></p:grpSpPr>
    <p:pic><p:blipFill><a:blip r:embed="rId4"/></p:blipFill>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500" cy="500"/></a:xfrm></p:spPr></p:pic>
    <p:pic><p:blipFill><a:blip r:embed="rId5"/></p:blipFill>
      <p:spPr><a:xfrm><a:off x="500" y="0"/><a:ext cx="500" cy="500"/></a:xfrm></p:spPr></p:pic>
  </p:grpSp>
</p:spTree></p:cSld></p:sld>`;

  it('finds the pictures, with group children as separate icons', () => {
    const { pics } = pipe.readSlide(slide);
    // One loose picture plus two group children — never a merged blob.
    expect(pics).toHaveLength(3);
    expect(pics.map((p) => p.rid).sort()).toEqual(['rId3', 'rId4', 'rId5']);
  });

  it('maps a group child through the group transform', () => {
    const { pics } = pipe.readSlide(slide);
    const child = pics.find((p) => p.rid === 'rId5');
    // Group at 5000,5000, child space 1000x500 scaled to 2000x1000: the
    // second child (500,0 / 500x500) lands at 6000,5000 sized 1000x1000.
    expect(child.x).toBe(6000);
    expect(child.y).toBe(5000);
    expect(child.cx).toBe(1000);
  });

  it('names a picture from the caption under it, not the one beside it', () => {
    const { pics, captions } = pipe.readSlide(slide);
    const loose = pics.find((p) => p.rid === 'rId3');
    expect(pipe.captionFor(loose, captions)).toBe('Catalyst 9300');
  });

  it('uses the top text as the slide title', () => {
    const { captions } = pipe.readSlide(slide);
    expect(pipe.slideTitle(captions)).toBe('LAN Switching');
  });
});

describe('against the real deck, when it is present', () => {
  const deck =
    '/home/malmoola/.claude/uploads/3bf4382a-ef2a-4f01-ac0c-17eab660e89c/c08af792-UnmaintainedDesignIcons_v2.02.pptx';

  it.runIf(existsSync(deck))('reads every slide and names most pictures', () => {
    const work = mkdtempSync(join(tmpdir(), 'cv-deck-'));
    try {
      execFileSync('unzip', ['-o', '-q', deck, '-d', work]);
      const slideDir = join(work, 'ppt', 'slides');
      let pics = 0, named = 0;
      for (const f of ['slide2.xml', 'slide3.xml', 'slide4.xml']) {
        const xml = readFileSync(join(slideDir, f), 'utf8');
        const s = pipe.readSlide(xml);
        pics += s.pics.length;
        named += s.pics.filter((p) => pipe.captionFor(p, s.captions)).length;
      }
      expect(pics).toBeGreaterThan(30);
      // Most pictures carry a caption; the deck itself leaves some unnamed.
      expect(named / pics).toBeGreaterThan(0.7);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('line endings survive a Windows checkout (LT-044)', () => {
  // The Windows runner checks out with autocrlf. That gave the pipeline
  // script a CRLF shebang, vite's shebang strip left the carriage return
  // behind, and V8 rejected the transformed module — with the error blamed
  // on whichever file imported it. The pin below is the fix; these fail
  // without it.
  it('the repo pins eol=lf so every checkout sees the same bytes', () => {
    const attrs = readFileSync(join(import.meta.dirname, '..', '.gitattributes'), 'utf8');
    expect(attrs).toMatch(/^\*\s+text=auto\s+eol=lf/m);
  });

  it('the pipeline script itself carries no carriage returns', () => {
    const src = readFileSync(join(import.meta.dirname, 'import-pptx-stencils.mjs'), 'utf8');
    expect(src).not.toContain('\r');
  });
});
