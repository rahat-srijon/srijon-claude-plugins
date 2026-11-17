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

/** The opt-in AI features (both off by default; the AI milestone reads these). */
export type AiSettings = {
  explainStop: boolean;
  askForTaskList: boolean;
};

export type Settings = {
  enabled: boolean;
  display: Display;
  barStyle: BarStyle;
  barWidth: number;
  fields: Fields;
  animation: Animation;
  showOnVscodeStatus: boolean;
  ai: AiSettings;
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
    ai: { explainStop: false, askForTaskList: false },
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
    const a = isRec(raw.ai) ? raw.ai : {};
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
      ai: {
        explainStop: bool(a.explainStop, d.ai.explainStop),
        askForTaskList: bool(a.askForTaskList, d.ai.askForTaskList),
      },
    };
  } catch {
    return d;
  }
}

/** The global settings file: `<data dir>/config.json`. scripts/lib/config.js resolves the same place with Node's os.homedir(). */
export const CONFIG_FILE = 'config.json';

const trimEnd = (p: string): string => p.replace(/[\\/]+$/, '');

/**
 * The settings directory: `PACE_MAKER_DATA_DIR` when set, else `<home>/.claude/plugins/data/pace-maker`.
 * `home` is USERPROFILE or HOME, what os.homedir() reads. Undefined when neither is known (the defaults are used then).
 */
export function dataDirFor(override: string | undefined, home: string | undefined): string | undefined {
  if (override !== undefined && override !== '') return trimEnd(override);
  if (home === undefined || home === '') return undefined;
  return `${trimEnd(home)}/.claude/plugins/data/pace-maker`;
}

/** Reads settings from the text of config.json. Never throws: bad JSON or any other trouble gives the defaults. */
export function parseSettingsText(text: unknown): Settings {
  try {
    return normalizeSettings(JSON.parse(String(text)));
  } catch {
    return defaultSettings();
  }
}
