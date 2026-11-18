// The display settings and their normalizer. Pure. The values come from the manifest's `userConfig` (register's `options`);
// a value of the wrong type falls back to its default on its own, so a bad entry never breaks the rest.

/** `smooth` draws a Raster (terminal) or an Svg (desktop, VS Code, mobile); the others are hand-drawn glyph bars on every surface. */
export type BarStyle = 'smooth' | 'blocks' | 'thin' | 'dots' | 'ascii';
export type GlyphStyle = Exclude<BarStyle, 'smooth'>;

export type Settings = {
  enabled: boolean;
  barStyle: BarStyle;
  showCount: boolean;
  showPercent: boolean;
  showLabel: boolean;
  showElapsed: boolean;
  showSubagents: boolean;
  /** Opt-in "Uses AI": one small-model call to explain an unexplained stop. */
  explainStop: boolean;
};

export const BAR_STYLES: readonly BarStyle[] = ['smooth', 'blocks', 'thin', 'dots', 'ascii'];
export const GLYPH_STYLES: readonly GlyphStyle[] = ['blocks', 'thin', 'dots', 'ascii'];

/** A fresh copy of the defaults (the same ones plugin.json declares). */
export function defaultSettings(): Settings {
  return {
    enabled: true,
    barStyle: 'smooth',
    showCount: true,
    showPercent: false,
    showLabel: true,
    showElapsed: true,
    showSubagents: true,
    explainStop: false,
  };
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);
const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;

/** Reads settings from register's `options` (or any value). Never throws; each field falls back to its default on its own. */
export function normalizeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  try {
    if (!isRec(raw)) return d;
    return {
      enabled: bool(raw.enabled, d.enabled),
      barStyle: pick(raw.barStyle, BAR_STYLES, d.barStyle),
      showCount: bool(raw.showCount, d.showCount),
      showPercent: bool(raw.showPercent, d.showPercent),
      showLabel: bool(raw.showLabel, d.showLabel),
      showElapsed: bool(raw.showElapsed, d.showElapsed),
      showSubagents: bool(raw.showSubagents, d.showSubagents),
      explainStop: bool(raw.explainStop, d.explainStop),
    };
  } catch {
    return d;
  }
}
