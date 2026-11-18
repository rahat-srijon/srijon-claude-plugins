// Reads how a turn ended into a state event: an API error or a refusal, and whether it is a usage or rate limit.
// Pure. `turn.complete` carries no error object: for reason 'error' the only text is `answer`, for 'refusal' the
// API's `refusal.category` and `refusal.explanation`, so a limit is recognised by its words.

import type { StateEvent } from './state.ts';

export type TurnEnd = {
  reason?: unknown;
  answer?: unknown;
  refusal?: { category?: unknown; explanation?: unknown } | null;
};

const LIMIT = /rate[ _-]?limit|usage[ _-]?limit|limit (?:reached|exceeded|hit)|hit your (?:\w+ )?limit|too many requests|\b429\b|quota|out of (?:extra )?usage/i;
const RESET_AT = /\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The state event for a turn that ended in an error or a refusal; null for an answer or an interrupt. Never throws. */
export function failureEvent(e: TurnEnd): StateEvent | null {
  try {
    if (e.reason === 'error') {
      const text = flat(str(e.answer));
      if (LIMIT.test(text)) {
        const at = RESET_AT.exec(text)?.[0];
        return at === undefined ? { kind: 'usageLimit' } : { kind: 'usageLimit', resetsAt: at };
      }
      return { kind: 'stopFailure', code: 'error', message: clip(text === '' ? 'API error' : text, 120) };
    }
    if (e.reason === 'refusal') {
      const why = flat(str(e.refusal?.explanation)) || flat(str(e.refusal?.category)) || 'the model declined';
      return { kind: 'stopFailure', code: 'refusal', message: clip(why, 120) };
    }
  } catch { /* fall through */ }
  return null;
}

const DENIED_TEXT = /^(?:Error: )?(?:Permission to use .+? has been denied|The user doesn't want to proceed|Permission denied)/i;

/**
 * True when a finished `tool.call` result is a refusal: the `deny` variant, or the errored result the engine builds from a
 * permission denial (a deny decision or a person saying no), whose text says so. A tool's own failure is not one.
 */
export function isDeniedResult(r: { deny?: unknown; isError?: unknown; text?: unknown; result?: unknown } | null | undefined): boolean {
  try {
    if (r === null || r === undefined) return false;
    if (r.deny !== undefined) return true;
    if (r.isError !== true) return false;
    const t = typeof r.text === 'string' ? r.text : typeof r.result === 'string' ? r.result : '';
    return DENIED_TEXT.test(t.trim());
  } catch {
    return false;
  }
}
