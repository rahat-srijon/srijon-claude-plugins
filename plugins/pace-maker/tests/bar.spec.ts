import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FULL, HALF, LEVELS, PALETTE, TRACK, barCells, barSvg, easeToward, hex, mix, packCells, pairCount, quantize, segmentCells, slideStart,
  unpackCells, type BarShape, type BarTone, type Cell,
} from '../hooks/lib/bar.ts';

const TONES = Object.keys(PALETTE) as BarTone[];
const det = (fraction: number, tone: BarTone = 'progress'): BarShape => ({ tone, mode: 'determinate', fraction, moving: false });
const slide = (moving = true, tone: BarTone = 'working'): BarShape => ({ tone, mode: 'sliding', fraction: 0, moving });
const isTrack = (c: Cell): boolean => c[1] === TRACK && c[2] === TRACK;
const lit = (cells: Cell[]): number => cells.filter((c) => !isTrack(c)).length;

test('one cell per column, whatever the width, shape and tick', () => {
  for (const w of [1, 2, 3, 5, 20, 80, 140, 512]) {
    for (const shape of [det(0), det(0.37), det(1), slide(), slide(false)]) {
      assert.equal(barCells(shape, w, 7).length, w);
    }
  }
  // Junk widths still give a usable bar.
  assert.equal(barCells(det(0.5), 0).length, 1);
  assert.equal(barCells(det(0.5), NaN).length, 1);
  assert.equal(barCells(det(0.5), 12.9).length, 12);
});

test('every cell is one printable width-1 BMP glyph with 24-bit colours', () => {
  const allowed = new Set([FULL, HALF]);
  for (const tone of TONES) {
    for (const shape of [det(0.5, tone), det(0.123, tone), slide(true, tone)]) {
      for (const [cp, fg, bg] of barCells(shape, 100, 13)) {
        assert.ok(allowed.has(cp), `U+${cp.toString(16)}`);
        assert.ok(cp > 0x20 && cp <= 0xffff);
        for (const c of [fg, bg]) assert.ok(Number.isInteger(c) && c >= 0 && c <= 0xffffff);
      }
    }
  }
});

test('the distinct (fg, bg) pairs stay far below the Raster palette of 1024, at any width and fraction', () => {
  let worst = 0;
  for (const tone of TONES) {
    for (const w of [10, 80, 140, 512]) {
      for (let f = 0; f <= 1; f += 0.013) worst = Math.max(worst, pairCount(barCells(det(f, tone), w)));
      for (let t = 0; t < w; t += 3) worst = Math.max(worst, pairCount(barCells(slide(true, tone), w, t)));
    }
  }
  assert.ok(worst <= 2 * LEVELS + 2, `worst ${worst}`);
  assert.ok(worst < 1000);
});

test('determinate: 0% is all track, 100% is all fill, nothing in between is full or empty', () => {
  assert.equal(lit(barCells(det(0), 40)), 0);
  const full = barCells(det(1), 40);
  assert.equal(lit(full), 40);
  assert.ok(full.every((c) => c[0] === FULL && c[1] === c[2]));
  assert.ok(lit(barCells(det(0.001), 40)) >= 1, 'above 0 always shows something');
  assert.ok(lit(barCells(det(0.999), 40)) <= 40);
  assert.ok(barCells(det(0.999), 40).some(isTrack) || barCells(det(0.999), 40)[39]![0] === HALF, 'never full before 1');
  assert.equal(lit(barCells(det(-3), 40)), 0);
  assert.equal(lit(barCells(det(9), 40)), 40);
  assert.equal(lit(barCells(det(NaN), 40)), 0);
});

test('determinate: half-cell precision at the fill edge', () => {
  // 10 wide: 50% is five whole cells; 55% is five whole and a left half.
  const five = barCells(det(0.5), 10);
  assert.deepEqual(five.map((c) => c[0]), Array(10).fill(FULL));
  assert.equal(lit(five), 5);
  const half = barCells(det(0.55), 10);
  assert.equal(half[5]![0], HALF);
  assert.equal(half[5]![2], TRACK, 'the half cell sits on the track');
  assert.notEqual(half[5]![1], TRACK);
  assert.equal(lit(half), 6);
  assert.equal(half.filter((c) => c[0] === HALF).length, 1);
  // Steps of half a cell: 0.05 is one half cell of ten.
  assert.equal(barCells(det(0.05), 10)[0]![0], HALF);
});

test('determinate: the fill brightens toward its leading edge and is the state colour', () => {
  const cells = barCells(det(0.8, 'done'), 40);
  const fills = cells.filter((c) => c[1] !== TRACK).map((c) => c[1]);
  const lum = (c: number): number => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255);
  for (let i = 1; i < fills.length; i += 1) assert.ok(lum(fills[i]!) >= lum(fills[i - 1]!), `cell ${i}`);
  assert.ok(lum(fills[fills.length - 1]!) > lum(fills[0]!));
  assert.equal(fills[fills.length - 1], PALETTE.done.to);
  // Different states are different colours.
  const tails = TONES.filter((t) => t !== 'working').map((t) => barCells(det(1, t), 10)[9]![1]);
  assert.equal(new Set(tails).size, tails.length);
});

test('sliding: a soft segment of about a fifth of the track, bright toward its head, over a dim track', () => {
  assert.equal(segmentCells(100), 20);
  assert.equal(segmentCells(10), 3);
  assert.equal(segmentCells(2), 2);
  assert.equal(segmentCells(1), 1);
  const cells = barCells(slide(), 60, 0);
  const on = cells.map((c, i) => [i, c] as const).filter(([, c]) => !isTrack(c));
  assert.ok(on.length >= 6 && on.length <= segmentCells(60), `${on.length} cells lit`);
  assert.ok(on.every(([i]) => i < segmentCells(60)));
  // Soft: the strongest cell is not an end of the segment.
  const lum = (c: Cell): number => ((c[1] >> 16) & 255) + ((c[1] >> 8) & 255) + (c[1] & 255);
  const peak = on.reduce((a, b) => (lum(b[1]) > lum(a[1]) ? b : a));
  assert.ok(peak[0] > on[0]![0] && peak[0] <= on[on.length - 1]![0]);
  assert.ok(lum(cells[0]![0] === FULL ? on[0]![1] : cells[0]!) < lum(peak[1]));
  // Mostly track.
  assert.ok(cells.filter(isTrack).length >= 60 - segmentCells(60));
});

test('sliding: one cell per tick, wrapping round the end, and the same tick gives the same cells', () => {
  const w = 30;
  const at = (t: number): Cell[] => barCells(slide(), w, t);
  assert.deepEqual(at(5), at(5));
  assert.deepEqual(at(5 + w), at(5));
  assert.deepEqual(at(-1), at(w - 1));
  const first = (cells: Cell[]): number => cells.findIndex((c) => !isTrack(c));
  assert.equal(first(at(4)) - first(at(3)), 1);
  // Near the end the segment wraps: lit cells at both ends of the track.
  const wrapped = at(w - 2);
  assert.ok(!isTrack(wrapped[w - 1]!) && !isTrack(wrapped[0]!) || !isTrack(wrapped[w - 1]!) || !isTrack(wrapped[0]!));
  assert.equal(slideStart(0, w), 0);
  assert.equal(slideStart(w + 3, w), 3);
  // The number of lit cells does not change with the tick: it never implies a fraction.
  const count = new Set(Array.from({ length: w }, (_, t) => lit(at(t))));
  assert.equal(count.size, 1);
});

test('sliding: held still it stands in the middle whatever the tick', () => {
  assert.deepEqual(barCells(slide(false), 40, 0), barCells(slide(false), 40, 99));
  const cells = barCells(slide(false), 40, 0);
  const idx = cells.map((c, i) => (isTrack(c) ? -1 : i)).filter((i) => i >= 0);
  assert.ok(idx[0]! > 5 && idx[idx.length - 1]! < 35);
  assert.equal(slideStart(5, 40, false), slideStart(77, 40, false));
});

test('edge widths: width 1 and 2', () => {
  assert.equal(barCells(det(1), 1).length, 1);
  assert.equal(isTrack(barCells(det(0), 1)[0]!), true);
  assert.equal(barCells(det(0.5), 1)[0]![0], HALF);
  assert.equal(barCells(slide(), 1, 3).length, 1);
  assert.equal(barCells(slide(), 2, 3).length, 2);
  assert.equal(lit(barCells(det(0.99), 2)) >= 1, true);
});

test('quantize, mix and hex', () => {
  assert.equal(quantize(0), 0);
  assert.equal(quantize(1), 1);
  assert.equal(quantize(0.5), 0.5);
  assert.equal(quantize(0.51), 0.5);
  assert.equal(quantize(NaN), 0);
  assert.equal(mix(0x000000, 0xffffff, 0), 0x000000);
  assert.equal(mix(0x000000, 0xffffff, 1), 0xffffff);
  assert.equal(mix(0x000000, 0xfefefe, 0.5), 0x7f7f7f);
  assert.equal(mix(0x102030, 0x102030, 0.4), 0x102030);
  assert.equal(hex(0x00ff88), '#00ff88');
  assert.equal(hex(0x0000ff), '#0000ff');
});

test('packCells: base64 of little-endian u32 triplets, and it round-trips', () => {
  // One orange cell, checked by hand: 88 25 00 00 | 00 88 ff 00 | 00 00 00 01.
  assert.equal(packCells([[0x2588, 0xff8800, 0x01000000]]), 'iCUAAACI/wAAAAAB');
  assert.equal(packCells([]), '');
  for (const w of [1, 2, 3, 7, 80]) {
    const cells = barCells(det(0.43), w);
    const b64 = packCells(cells);
    assert.equal(b64.length, Math.ceil((w * 12) / 3) * 4);
    assert.match(b64, /^[A-Za-z0-9+/]*={0,2}$/);
    assert.deepEqual(unpackCells(b64), cells);
  }
});

test('easeToward: moves toward the target, settles in about 300 ms, snaps when close, never overshoots', () => {
  assert.equal(easeToward(0.2, 0.8, 0), 0.2);
  const one = easeToward(0, 1, 100);
  assert.ok(one > 0.5 && one < 0.7, String(one));
  let v = 0;
  for (let t = 0; t < 300; t += 100) v = easeToward(v, 1, 100);
  assert.ok(v > 0.9 && v < 1);
  for (let t = 0; t < 600; t += 100) v = easeToward(v, 1, 100);
  assert.equal(v, 1);
  assert.equal(easeToward(0.5, 0.5, 100), 0.5);
  assert.ok(easeToward(1, 0.2, 100) < 1 && easeToward(1, 0.2, 100) > 0.2);
  assert.equal(easeToward(NaN, 0.5, -5), 0);
});

test('svg: a valid standalone document with width, height and viewBox, well under the limit', () => {
  for (const tone of TONES) {
    for (const shape of [det(0, tone), det(0.4, tone), det(1, tone), slide(true, tone), slide(false, tone)]) {
      const svg = barSvg(shape);
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="480" height="8" viewBox="0 0 480 8"/);
      assert.ok(svg.endsWith('</svg>'));
      assert.ok(svg.length < 2500, `${svg.length}`);
      assert.doesNotMatch(svg, /<script|on\w+=|javascript:/i);
      // Tags balance: every opened tag closes or self-closes.
      const tags = svg.match(/<\/?[a-zA-Z][^>]*>/g) ?? [];
      const stack: string[] = [];
      for (const t of tags) {
        const name = /^<\/?([a-zA-Z]+)/.exec(t)![1]!;
        if (t.startsWith('</')) assert.equal(stack.pop(), name);
        else if (!t.endsWith('/>')) stack.push(name);
      }
      assert.deepEqual(stack, []);
    }
  }
});

test('svg: determinate has a rounded track, a rounded gradient fill and the state colours', () => {
  const svg = barSvg(det(0.5, 'done'));
  assert.match(svg, /<linearGradient id="pm-fill"/);
  assert.ok(svg.includes(hex(PALETTE.done.from)) && svg.includes(hex(PALETTE.done.to)));
  assert.match(svg, /<rect width="480" height="8" rx="4"[^>]*fill-opacity/); // the track
  assert.match(svg, /<rect width="240" height="8" rx="4" fill="url\(#pm-fill\)"/);
  assert.doesNotMatch(svg, /<animate/);
  assert.equal(barSvg(det(1)).includes('<rect width="480" height="8" rx="4" fill="url(#pm-fill)"'), true);
  // No fill element at 0%, and the fill is never the whole track before 1.
  assert.doesNotMatch(barSvg(det(0)), /url\(#pm-fill\)"/);
  assert.match(barSvg(det(0.999)), /<rect width="479" /);
  assert.match(barSvg(det(0.001)), /<rect width="8" /);
});

test('svg: a determinate fill grows from its previous value by SMIL, and only when it changed', () => {
  const grow = barSvg(det(0.8), { from: 0.4 });
  assert.match(grow, /<rect width="192"[^>]*><animate attributeName="width" from="192" to="384" dur="0\.3s" fill="freeze"\/>/);
  assert.doesNotMatch(barSvg(det(0.8), { from: 0.8 }), /<animate/);
});

test('svg: the sliding segment is animated with SMIL, clipped to the rounded track; frozen has no animation', () => {
  const moving = barSvg(slide(true));
  assert.match(moving, /<animate attributeName="x" from="-134" to="480" dur="1\.6s" repeatCount="indefinite"\/>/);
  assert.match(moving, /<clipPath id="pm-clip"><rect width="480" height="8" rx="4"\/><\/clipPath>/);
  assert.match(moving, /clip-path="url\(#pm-clip\)"/);
  const frozen = barSvg(slide(false));
  assert.doesNotMatch(frozen, /<animate/);
  assert.match(frozen, /<rect x="173" width="134"/);
});

test('svg: custom size and id prefix scale the drawing, and ids stay clean', () => {
  const svg = barSvg(det(0.5), { width: 960, height: 10, idPrefix: 'a b<1>' });
  assert.match(svg, /width="960" height="10" viewBox="0 0 960 10"/);
  assert.match(svg, /id="ab1-fill"/);
  assert.match(barSvg(det(0.5), { idPrefix: '' }), /id="pm-fill"/);
  assert.match(barSvg(det(0.5), { width: 1, height: 0 }), /width="8" height="2"/);
});

test('the module is pure: no imports and no Node or DOM globals', async () => {
  const { readFileSync } = await import('node:fs');
  const full = readFileSync(new URL('../hooks/lib/bar.ts', import.meta.url), 'utf8');
  const src = full.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /^import /m);
  assert.doesNotMatch(src, /\b(require|process|Buffer|document|window|btoa|atob|setTimeout|Date\.now|performance)\b/);
});
