// The display settings and their normalizer. Pure: loading them from a file is the settings milestone.

export type Display = 'bar' | 'text';
export type BarStyle = 'native' | 'blocks' | 'thin' | 'dots' | 'ascii';
export type Animation = 'smooth' | 'instant';

export type Fields = {
  stepCount: boolean;
  percentage: boolean;
  stepLabel: boolean;
  elapsed: boolean;
  subagents: boolean;
};

export type Settings = {
  enabled: boolean;
  display: Display;
  barStyle: BarStyle;
  barWidth: number;
  fields: Fields;
  animation: Animation;
  showOnVscodeStatus: boolean;
};

export const DISPLAYS: readonly Display[] = ['bar', 'text'];
export const BAR_STYLES: readonly BarStyle[] = ['native', 'blocks', 'thin', 'dots', 'ascii'];
export const ANIMATIONS: readonly Animation[] = ['smooth', 'instant'];
export const BAR_WIDTH_MIN = 10;
export const BAR_WIDTH_MAX = 40;

/** A fresh copy of the defaults. */
export function defaultSettings(): Settings {
  return {
    enabled: true,
    display: 'bar',
    barStyle: 'native',
    barWidth: 20,
    fields: { stepCount: true, percentage: false, stepLabel: true, elapsed: true, subagents: true },
    animation: 'smooth',
    showOnVscodeStatus: true,
  };
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);
const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;

/** Reads settings from any value. Never throws; each field falls back to its default on its own. */
export function normalizeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  try {
    if (!isRec(raw)) return d;
    const f = isRec(raw.fields) ? raw.fields : {};
    const w = raw.barWidth;
    const width = typeof w === 'number' && Number.isFinite(w) ? Math.min(BAR_WIDTH_MAX, Math.max(BAR_WIDTH_MIN, Math.round(w))) : d.barWidth;
    return {
      enabled: bool(raw.enabled, d.enabled),
      display: pick(raw.display, DISPLAYS, d.display),
      barStyle: pick(raw.barStyle, BAR_STYLES, d.barStyle),
      barWidth: width,
      fields: {
        stepCount: bool(f.stepCount, d.fields.stepCount),
        percentage: bool(f.percentage, d.fields.percentage),
        stepLabel: bool(f.stepLabel, d.fields.stepLabel),
        elapsed: bool(f.elapsed, d.fields.elapsed),
        subagents: bool(f.subagents, d.fields.subagents),
      },
      animation: pick(raw.animation, ANIMATIONS, d.animation),
      showOnVscodeStatus: bool(raw.showOnVscodeStatus, d.showOnVscodeStatus),
    };
  } catch {
    return d;
  }
}
