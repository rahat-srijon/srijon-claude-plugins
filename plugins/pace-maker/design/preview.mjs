// Writes one HTML file that shows pace-maker's band the way each surface draws it, so the look can be judged before installing.
//
//   node plugins/pace-maker/design/preview.mjs [output.html]
//
// Not loaded by the plugin. It imports the same pure functions the plugin draws with (hooks/lib/bar.ts, format.ts), so what it
// shows is what the plugin sends: the terminal's Raster cells as coloured monospace spans, and the Svg markup inline. Run with
// Node 24 or later (it strips the types of the .ts files it imports). With no argument the file goes to `prompts/` of the
// nearest folder above this one that has one: prompts/pace-maker-v3-preview.html.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { barCells, barSvg, hex } from '../hooks/lib/bar.ts';
import { formatView, glyphWidth } from '../hooks/lib/format.ts';
import { defaultSettings } from '../hooks/lib/settings.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WIDTHS = [60, 100, 140];

// Sample views, one per state (the same shapes lib/view.ts derives).
const STATES = [
  { name: 'Progress 3/5', view: { kind: 'progress', done: 3, total: 5, fraction: 0.6, label: 'Running tests', elapsedMs: 12 * 60_000 } },
  { name: 'Working, no list (sliding)', view: { kind: 'working', elapsedMs: 40_000, subagents: 0 } },
  { name: 'Working, background shell', view: { kind: 'working', detail: 'npm test', elapsedMs: 95_000, subagents: 2 } },
  { name: 'Done, with a list', view: { kind: 'done', done: 5, total: 5, durationMs: 18 * 60_000 } },
  { name: 'Done, no list', view: { kind: 'done', done: 0, total: 0, durationMs: 40_000 } },
  { name: 'Waiting for your answer', view: { kind: 'waiting', why: 'question', done: 3, total: 5, running: false } },
  { name: 'Waiting for permission, no list', view: { kind: 'waiting', why: 'permission', detail: 'Bash', done: 0, total: 0, running: true } },
  { name: 'Blocked', view: { kind: 'blocked', why: 'error', detail: 'API error 529: overloaded', done: 2, total: 5, running: false } },
  { name: 'Paused', view: { kind: 'paused', why: 'interrupt', done: 3, total: 5, running: false } },
  { name: 'Stopped', view: { kind: 'stopped', done: 3, total: 5, left: 2 } },
];

// What the theme tokens look like on a dark terminal (the real colours come from the user's theme).
const TOKENS = { suggestion: '#b1b9f9', success: '#4eba65', warning: '#ffc107', error: '#ff6b80', planMode: '#48968c', subtle: '#8b8b8b' };
const DIM = '#8b8b8b';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const settings = defaultSettings();
const formatted = STATES.map((s) => ({ ...s, f: formatView(s.view, settings, 0, Date.now(), 20) }));

/** Row 1 on the terminal at `cols` columns: the state run, the dim step, then the tail at the right edge; truncated, never wrapped. */
function row1Terminal(f, cols) {
  const runs = [[`${f.icon} ${f.text}`, TOKENS[f.tone] ?? '#ddd', true]];
  if (f.label !== '') runs.push([` · ${f.label}`, DIM, false]);
  const tail = f.tail === '' ? '' : f.tail;
  const room = Math.max(1, cols - (tail === '' ? 0 : [...tail].length + 2));
  let used = 0;
  let html = '';
  for (const [text, color, bold] of runs) {
    const chars = [...text];
    const left = room - used;
    if (left <= 0) break;
    const cut = chars.length > left;
    const shown = cut ? `${chars.slice(0, Math.max(0, left - 1)).join('')}…` : text;
    html += `<span style="color:${color}${bold ? ';font-weight:700' : ''}">${esc(shown)}</span>`;
    used += [...shown].length;
    if (cut) break;
  }
  const gap = Math.max(tail === '' ? 0 : 2, cols - used - [...tail].length);
  return `${html}${' '.repeat(gap)}${tail === '' ? '' : `<span style="color:${DIM}">${esc(tail)}</span>`}`;
}

/** Cells as coloured spans, runs of one colour pair joined. */
function cellsHtml(cells) {
  let html = '';
  let i = 0;
  while (i < cells.length) {
    const [cp, fg, bg] = cells[i];
    let j = i + 1;
    while (j < cells.length && cells[j][0] === cp && cells[j][1] === fg && cells[j][2] === bg) j += 1;
    html += `<span style="color:${hex(fg)};background:${hex(bg)}">${String.fromCodePoint(cp).repeat(j - i)}</span>`;
    i = j;
  }
  return html;
}

const terminalBlock = (f, cols, id) => {
  const shape = f.shape;
  const cells = shape === null ? [] : barCells(shape, cols, 0);
  const moving = shape !== null && shape.mode === 'sliding' && shape.moving;
  let frames = '';
  if (moving) {
    // One frame per cell of travel: the colour of each cell (the segment's cells have the same fore and background).
    const all = Array.from({ length: cols }, (_, t) => barCells(shape, cols, t).map((c) => c[1]));
    frames = ` data-frames='${JSON.stringify(all)}'`;
  }
  return `<div class="term" style="width:${cols}ch"><div class="r1">${row1Terminal(f, cols)}</div><div class="r2${moving ? ' anim' : ''}" id="${id}"${frames}>${cellsHtml(cells)}</div></div>`;
};

const svgBlock = (f, theme, id) => {
  const shape = f.shape;
  const left = `<span style="color:${theme === 'dark' ? '#d4d4d4' : '#24292f'}"><b style="color:${theme === 'dark' ? TOKENS[f.tone] : LIGHT[f.tone] ?? '#444'}">${esc(`${f.icon} ${f.text}`)}</b>${f.label === '' ? '' : `<span class="dim"> · ${esc(f.label)}</span>`}</span>`;
  const tail = f.tail === '' ? '' : `<span class="dim">${esc(f.tail)}</span>`;
  const bar = shape === null ? '' : barSvg(shape, { width: 960, height: 8, idPrefix: id });
  return `<div class="svgband ${theme}"><div class="r1ui">${left}${tail}</div><div class="bar">${bar}</div></div>`;
};
const LIGHT = { suggestion: '#4f46e5', success: '#1a7f37', warning: '#9a6700', error: '#cf222e', planMode: '#0b7a75', subtle: '#6e7781' };

let n = 0;
const sections = formatted
  .map(({ name, f }) => {
    const term = WIDTHS.map((w) => `<div class="w"><div class="cap">${w} columns</div>${terminalBlock(f, w, `t${(n += 1)}`)}</div>`).join('');
    const svg = ['dark', 'light'].map((t) => `<div class="w">${svgBlock(f, t, `s${(n += 1)}`)}<div class="cap">${t} background</div></div>`).join('');
    return `<section><h2>${esc(name)}</h2><h3>Terminal (Raster cells, 2 rows)</h3><div class="row">${term}</div><h3>Desktop, VS Code, mobile (Svg)</h3><div class="row svgs">${svg}</div></section>`;
  })
  .join('\n');

const glyphNote = `${glyphWidth(100)} cells`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pace-maker 0.3.0 band preview</title>
<style>
  body { margin: 0; padding: 24px 28px 60px; background: #14151a; color: #d4d4d4; font: 14px/1.45 system-ui, 'Segoe UI', sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; } p.lead { margin: 0 0 20px; color: #9aa0ad; max-width: 80ch; }
  section { margin: 0 0 30px; padding-top: 14px; border-top: 1px solid #262833; }
  h2 { font-size: 15px; margin: 0 0 6px; } h3 { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #7e8594; margin: 12px 0 6px; }
  .row { display: flex; flex-wrap: wrap; gap: 14px 26px; align-items: flex-start; }
  .cap { font-size: 11px; color: #7e8594; margin: 3px 0; }
  .term { background: #0e0f13; padding: 8px 10px; border-radius: 4px; font: 14px/1.25 'Cascadia Mono', 'Cascadia Code', Consolas, 'DejaVu Sans Mono', monospace; box-sizing: content-box; max-width: calc(100vw - 80px); overflow: hidden; }
  .term .r1 { white-space: pre; } .term .r2 { white-space: pre; line-height: 1; margin-top: 1px; }
  .svgband { width: 460px; max-width: calc(100vw - 80px); padding: 8px 12px 10px; border-radius: 6px; font-size: 13px; }
  .svgband.dark { background: #1e2028; } .svgband.light { background: #fafbfc; border: 1px solid #d8dde3; }
  .svgband .r1ui { display: flex; justify-content: space-between; gap: 16px; white-space: nowrap; overflow: hidden; } .svgband .r1ui > :first-child { overflow: hidden; text-overflow: ellipsis; }
  .svgband .dim { color: #8b8b8b; } .svgband .bar { margin-top: 5px; height: 8px; } .svgband svg { display: block; width: 100%; height: 8px; }
  .note { color: #7e8594; font-size: 12px; margin-top: 28px; max-width: 90ch; }
</style></head><body>
<h1>pace-maker 0.3.0: the band, two rows</h1>
<p class="lead">Row 1 is one line of text (state and step on the left, count, percent and time on the right) that truncates instead of wrapping. Row 2 is the bar. On the terminal the bar is a Raster of cells; in the desktop app and VS Code it is a vector bar. The sliding segment (no task list) moves by itself in both.</p>
${sections}
<p class="note">Terminal text colours here are approximations of the theme tokens on a dark terminal; the bar colours are exact. A glyph bar style (blocks, thin, dots, ascii) replaces row 2 with text on every surface, ${glyphNote} wide at 100 columns. Generated from hooks/lib/bar.ts and hooks/lib/format.ts.</p>
<script>
  // The terminal's sliding segment: one frame per cell of travel, 100 ms each (the plugin's own pace).
  const nodes = [...document.querySelectorAll('.r2.anim')].map((el) => ({ el, frames: JSON.parse(el.dataset.frames), spans: null, t: 0 }));
  const hexOf = (c) => '#' + c.toString(16).padStart(6, '0');
  for (const n of nodes) { n.el.textContent = ''; n.spans = n.frames[0].map(() => { const s = document.createElement('span'); s.textContent = '\\u2588'; n.el.appendChild(s); return s; }); }
  function paint() { for (const n of nodes) { const f = n.frames[n.t % n.frames.length]; for (let i = 0; i < f.length; i += 1) { const c = hexOf(f[i]); n.spans[i].style.color = c; n.spans[i].style.background = c; } n.t += 1; } }
  paint(); if (!matchMedia('(prefers-reduced-motion: reduce)').matches) setInterval(paint, 100);
</script>
</body></html>
`;

function target() {
  if (process.argv[2]) return resolve(process.argv[2]);
  for (let dir = here; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'prompts'))) return join(dir, 'prompts', 'pace-maker-v3-preview.html');
    if (dirname(dir) === dir) return join(here, 'pace-maker-v3-preview.html');
  }
}
const out = target();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`wrote ${out} (${Math.round(html.length / 1024)} KB)`);
