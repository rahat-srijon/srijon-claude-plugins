// The smooth bar, as pure functions: terminal cells for a Raster and an SVG document for the remote surfaces.
// No Node or DOM APIs and no imports, so the plugin, the tests and design/preview.mjs all load it the same way.
//
// Raster rules this file keeps (RasterProps): every cell is ONE printable width-1 BMP glyph with a foreground and a
// background as 0x00RRGGBB, and at most about a thousand distinct (foreground, background) pairs may be on screen at once,
// so every colour that varies along the bar is quantized to a few steps (LEVELS).

export type BarTone = 'progress' | 'working' | 'done' | 'waiting' | 'blocked' | 'paused' | 'stopped';
/** One Raster cell: [code point, foreground, background]. */
export type Cell = [number, number, number];

/** What a bar shows: a share (`fraction`), a sliding segment (`moving` or held still), in a state's colours. */
export type BarShape = {
  tone: BarTone;
  mode: 'determinate' | 'sliding';
  /** determinate: the finished share, 0 to 1. Ignored when sliding. */
  fraction: number;
  /** sliding: false holds the segment still in the middle of the track. */
  moving: boolean;
};

/** Raw colours that read on a dark and a light background: the gradient runs from `from` (the tail) to `to` (the leading edge). */
export const PALETTE: Record<BarTone, { from: number; to: number }> = {
  progress: { from: 0x4a56d4, to: 0xa3b0ff },
  working: { from: 0x4a56d4, to: 0xa3b0ff },
  done: { from: 0x168f6c, to: 0x62e3b4 },
  waiting: { from: 0xc4811a, to: 0xffcb5c },
  blocked: { from: 0xbb3347, to: 0xff8590 },
  paused: { from: 0x2689b8, to: 0x78d8ff },
  stopped: { from: 0x626a79, to: 0xa1abbb },
};
/** The empty part of the track: dim, and still a visible bar on a dark background. */
export const TRACK = 0x2c313d;

/** Gradient and fade steps: the number of distinct fill colours a bar may use. */
export const LEVELS = 8;

/** Terminal glyphs: a full cell (fill and track both colour the background) and the left half at the fill edge. */
export const FULL = 0x2588;
export const HALF = 0x258c;

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const whole = (n: number, dflt: number): number => (Number.isFinite(n) ? Math.floor(n) : dflt);

/** Linear mix of two 0xRRGGBB colours; `t` 0 gives `a`, 1 gives `b`. */
export function mix(a: number, b: number, t: number): number {
  const k = clamp01(t);
  const ch = (shift: number): number => {
    const x = (a >> shift) & 255;
    const y = (b >> shift) & 255;
    return Math.round(x + (y - x) * k) & 255;
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Rounds a 0..1 weight to one of LEVELS + 1 steps. */
export const quantize = (t: number): number => Math.round(clamp01(t) * LEVELS) / LEVELS;

export const hex = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;

/** The length of the sliding segment: about a fifth of the track, at least 3 cells and never the whole track. */
export function segmentCells(width: number): number {
  const w = Math.max(1, whole(width, 1));
  if (w <= 3) return w;
  return Math.min(w - 1, Math.max(3, Math.round(w / 5)));
}

/**
 * Where the head of the segment moves: `tick` counts steps of one cell. The segment's first cell is at
 * `tick mod width` and it wraps round the end of the track.
 */
export function slideStart(tick: number, width: number, moving = true): number {
  const w = Math.max(1, whole(width, 1));
  if (!moving) return Math.floor((w - segmentCells(w)) / 2);
  const t = whole(tick, 0);
  return ((t % w) + w) % w;
}

/** A gradient fill of `n` cells ending in a leading edge: dim at the left, bright at the right. */
function fillColor(tone: BarTone, index: number, count: number): number {
  const p = PALETTE[tone];
  return mix(p.from, p.to, quantize((index + 1) / Math.max(1, count)));
}

/**
 * The cells of a bar `width` wide (at least 1). determinate: whole cells filled with a gradient that brightens toward the
 * leading edge, a left-half cell at the edge (half-cell precision), the dim track after it; never full before 1, never
 * empty above 0. sliding: a soft segment (bright toward its head) over the track at `tick`.
 */
export function barCells(shape: BarShape, width: number, tick = 0): Cell[] {
  const w = Math.max(1, whole(width, 1));
  const cells: Cell[] = [];

  if (shape.mode === 'sliding') {
    const seg = segmentCells(w);
    const start = slideStart(tick, w, shape.moving);
    const p = PALETTE[shape.tone];
    const weight: number[] = new Array(w).fill(0);
    for (let k = 0; k < seg; k += 1) {
      const u = (k + 0.5) / seg;
      weight[(start + k) % w] = quantize(Math.sin(Math.PI * u ** 1.5));
    }
    for (let i = 0; i < w; i += 1) {
      const c = weight[i] === 0 ? TRACK : mix(TRACK, mix(p.from, p.to, weight[i]!), Math.min(1, 0.25 + weight[i]! * 0.75));
      cells.push([FULL, c, c]);
    }
    return cells;
  }

  const f = clamp01(shape.fraction);
  let halves = Math.round(f * w * 2);
  if (f > 0 && halves < 1) halves = 1;
  if (f < 1 && halves > w * 2 - 1) halves = w * 2 - 1;
  const full = halves >> 1;
  const half = (halves & 1) === 1;
  const lit = full + (half ? 1 : 0);
  for (let i = 0; i < w; i += 1) {
    if (i < full) {
      const c = fillColor(shape.tone, i, lit);
      cells.push([FULL, c, c]);
    } else if (i === full && half) {
      cells.push([HALF, fillColor(shape.tone, i, lit), TRACK]);
    } else {
      cells.push([FULL, TRACK, TRACK]);
    }
  }
  return cells;
}

/** The distinct (foreground, background) pairs of a cell list: the Raster's palette budget (about 1000). */
export function pairCount(cells: readonly Cell[]): number {
  const seen: Record<string, true> = {};
  let n = 0;
  for (const c of cells) {
    const key = `${c[1]}/${c[2]}`;
    if (seen[key] !== true) {
      seen[key] = true;
      n += 1;
    }
  }
  return n;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Packs cells as RasterProps `cells` wants them: standard padded base64 of little-endian u32 [codePoint, fg, bg] triplets. */
export function packCells(cells: readonly Cell[]): string {
  const bytes: number[] = [];
  for (const [cp, fg, bg] of cells) {
    for (const word of [cp, fg, bg]) {
      const v = word >>> 0;
      bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

/** The decoded form of packCells (for tests and the preview): `[codePoint, fg, bg]` per cell. */
export function unpackCells(b64: string): Cell[] {
  const bytes: number[] = [];
  const clean = b64.replace(/=+$/, '');
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i]!);
    const b = B64.indexOf(clean[i + 1] ?? 'A');
    const c = clean[i + 2] === undefined ? -1 : B64.indexOf(clean[i + 2]!);
    const d = clean[i + 3] === undefined ? -1 : B64.indexOf(clean[i + 3]!);
    bytes.push((a << 2) | (b >> 4));
    if (c >= 0) bytes.push(((b & 15) << 4) | (c >> 2));
    if (d >= 0) bytes.push(((c & 3) << 6) | d);
  }
  const cells: Cell[] = [];
  for (let i = 0; i + 12 <= bytes.length; i += 12) {
    const word = (j: number): number => (bytes[i + j]! | (bytes[i + j + 1]! << 8) | (bytes[i + j + 2]! << 16) | (bytes[i + j + 3]! << 24)) >>> 0;
    cells.push([word(0), word(4), word(8)]);
  }
  return cells;
}

/** Moves `current` toward `target` for `dtMs` of an ease-out that settles in about 300 ms; snaps once it is within 0.2%. */
export function easeToward(current: number, target: number, dtMs: number, tauMs = 100): number {
  const cur = clamp01(current);
  const tgt = clamp01(target);
  if (!(dtMs > 0)) return cur;
  const next = cur + (tgt - cur) * (1 - Math.exp(-dtMs / tauMs));
  return Math.abs(tgt - next) < 0.002 ? tgt : next;
}

// ---- SVG ---------------------------------------------------------------------------------------------------------------

export type SvgOptions = {
  /** The drawing's own width and height in CSS pixels (the viewBox); it scales to the slot. Default 480 x 8. */
  width?: number;
  height?: number;
  /** Prefix for ids, so several bars inlined in one page do not clash. */
  idPrefix?: string;
  /** determinate: where the fill was before, so it grows from there to `fraction` in 300 ms (SMIL). */
  from?: number;
  /** sliding: the seconds a pass takes. Default 1.6. */
  seconds?: number;
};

const num = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * A standalone `<svg>` string: a rounded track, and either a rounded fill with a linear gradient (determinate) or a soft
 * gradient segment that slides across by SMIL `<animate>` (sliding; static when not `moving`). It carries width, height
 * and viewBox, and stays far below the 131072-character limit.
 */
export function barSvg(shape: BarShape, opts: SvgOptions = {}): string {
  const W = Math.max(8, whole(opts.width ?? 480, 480));
  const H = Math.max(2, whole(opts.height ?? 8, 8));
  const id = (opts.idPrefix ?? 'pm').replace(/[^A-Za-z0-9_-]/g, '') || 'pm';
  const p = PALETTE[shape.tone];
  const r = H / 2;
  const head =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">`;
  const track = `<rect width="${W}" height="${H}" rx="${num(r)}" fill="#8a91a3" fill-opacity="0.3"/>`;
  const grad = (name: string, stops: [number, string, number][]): string =>
    `<linearGradient id="${id}-${name}" x1="0" y1="0" x2="1" y2="0">${stops
      .map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a === 1 ? '' : ` stop-opacity="${a}"`}/>`)
      .join('')}</linearGradient>`;

  if (shape.mode === 'sliding') {
    const seg = Math.round(W * 0.28);
    const dur = `${num(opts.seconds ?? 1.6)}s`;
    const x0 = shape.moving ? -seg : Math.round((W - seg) / 2);
    const motion = shape.moving
      ? `<animate attributeName="x" from="${-seg}" to="${W}" dur="${dur}" repeatCount="indefinite"/>`
      : '';
    return (
      `${head}<defs>${grad('seg', [[0, hex(p.from), 0], [0.65, hex(p.to), 1], [1, hex(p.to), 0]])}` +
      `<clipPath id="${id}-clip"><rect width="${W}" height="${H}" rx="${num(r)}"/></clipPath></defs>` +
      `${track}<g clip-path="url(#${id}-clip)"><rect x="${x0}" width="${seg}" height="${H}" fill="url(#${id}-seg)">${motion}</rect></g></svg>`
    );
  }

  const f = clamp01(shape.fraction);
  // A fill is at least a dot wide above 0 and never the whole track before 1; below one corner radius a rect would look broken.
  const widthOf = (x: number): number => (x <= 0 ? 0 : Math.min(x >= 1 ? W : W - 1, Math.max(H, x * W)));
  const to = widthOf(f);
  const from = opts.from === undefined ? to : widthOf(clamp01(opts.from));
  const motion =
    from !== to ? `<animate attributeName="width" from="${num(from)}" to="${num(to)}" dur="0.3s" fill="freeze"/>` : '';
  const fill =
    to === 0 && from === 0
      ? ''
      : `<rect width="${num(from)}" height="${H}" rx="${num(r)}" fill="url(#${id}-fill)">${motion}</rect>`;
  return (
    `${head}<defs>${grad('fill', [[0, hex(p.from), 1], [1, hex(p.to), 1]])}</defs>${track}${fill}</svg>`
  );
}
