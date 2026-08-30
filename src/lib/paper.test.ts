import { describe, expect, it } from 'vitest';

import { PAPERS, describePage, fitOnSheet, paperById, sheetSize, sheetsFor } from './paper';

const a4 = paperById('a4');

describe('paper sizes', () => {
  it('knows A4 at 96 dpi', () => {
    // 210x297mm. An SVG width is CSS pixels, and a browser prints at 96 dpi.
    expect(a4.width).toBe(794);
    expect(a4.height).toBe(1123);
  });

  it('turns a page on its side for landscape', () => {
    expect(sheetSize(a4, 'landscape')).toEqual({ w: 1123, h: 794 });
    expect(sheetSize(a4, 'portrait')).toEqual({ w: 794, h: 1123 });
  });

  it('falls back to fitting the diagram for anything it does not know', () => {
    expect(paperById('foolscap').id).toBe('fit');
    expect(paperById(undefined).id).toBe('fit');
  });

  it('offers a real range of sizes', () => {
    expect(PAPERS.map((p) => p.id)).toContain('a3');
    expect(PAPERS.map((p) => p.id)).toContain('tabloid');
  });
});

describe('fitOnSheet', () => {
  const sheet = sheetSize(a4, 'landscape'); // 1123 x 794

  it('shrinks a large diagram to fit inside the margins', () => {
    const p = fitOnSheet({ width: 3000, height: 1000 }, sheet, 36)!;
    expect(p.scale).toBeCloseTo((1123 - 72) / 3000, 4);
    expect(p.width).toBe(1123);
  });

  it('never enlarges a small one', () => {
    // A diagram with four devices blown up to fill A3 is four devices with
    // enormous text on a big sheet.
    const p = fitOnSheet({ width: 200, height: 120 }, sheet, 36)!;
    expect(p.scale).toBe(1);
  });

  it('centres what it places', () => {
    const p = fitOnSheet({ width: 200, height: 120 }, sheet, 36)!;
    expect(p.x).toBeCloseTo((1123 - 200) / 2, 4);
    expect(p.y).toBeCloseTo((794 - 120) / 2, 4);
  });

  it('fits by whichever side runs out first', () => {
    const tall = fitOnSheet({ width: 100, height: 4000 }, sheet, 36)!;
    expect(tall.scale).toBeCloseTo((794 - 72) / 4000, 4);
  });

  it('has nothing to say when the page is the diagram', () => {
    expect(fitOnSheet({ width: 500, height: 500 }, { w: 0, h: 0 })).toBeNull();
  });
});

describe('sheetsFor', () => {
  const sheet = sheetSize(a4, 'landscape');

  it('is one sheet for something that fits', () => {
    expect(sheetsFor({ width: 800, height: 500 }, sheet)).toEqual({ across: 1, down: 1, total: 1 });
  });

  it('counts the sheets a wide diagram covers at its own size', () => {
    // For the case the fit does not serve: printed across pages and taped
    // together, rather than shrunk until the port labels cannot be read.
    const s = sheetsFor({ width: 3000, height: 700 }, sheet, 36);
    expect(s.across).toBe(3);
    expect(s.down).toBe(1);
    expect(s.total).toBe(3);
  });

  it('counts both ways for something large in both', () => {
    const s = sheetsFor({ width: 3000, height: 2000 }, sheet, 36);
    expect(s.total).toBe(s.across * s.down);
    expect(s.total).toBeGreaterThan(3);
  });

  it('is always at least one sheet', () => {
    expect(sheetsFor({ width: 1, height: 1 }, { w: 0, h: 0 }).total).toBe(1);
  });
});

describe('describePage', () => {
  it('reads the way someone would say it', () => {
    expect(describePage(a4, 'landscape')).toBe('A4 landscape');
    expect(describePage(paperById('fit'), 'portrait')).toBe('sized to the diagram');
  });
});
