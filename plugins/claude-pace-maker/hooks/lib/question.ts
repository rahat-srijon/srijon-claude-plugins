// Narrow, model-free detector for "Claude asked the user a plain-text question".
// Known misses (kept on purpose, a wrong "waiting" is worse than a missed one):
// - a question phrased without a question mark ("Let me know which one you prefer.");
// - a rhetorical question that ends in "?" while Claude is actually done;
// - a question whose last token is a URL, or a question mark inside a trailing code span.

const FENCE = /^\s*```/;
const BULLET = /^\s*([-*+•]\s|\d+[.)]\s|\|)/;
const URL_TOKEN = /^[("'<[]*(https?:\/\/|www\.)/i;
// Characters dropped from the end before looking for the question mark: whitespace, closers,
// emphasis marks, punctuation, symbols and emoji (joiners and variation selectors included).
const TRAILING = /[\s\p{P}\p{S}\p{Extended_Pictographic}‍️]/u;

/** True when the answer's last paragraph is a short plain-text question ending in ? (or the fullwidth ？). */
export function endsWithQuestion(answer: string): boolean {
  if (typeof answer !== 'string') return false;
  const lines = answer.split(/\r?\n/);
  if (lines.filter((l) => FENCE.test(l)).length % 2 === 1) return false;
  const paragraphs = answer.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter((p) => p !== '');
  const last = paragraphs[paragraphs.length - 1];
  if (!last || last.length > 300) return false;
  const lastLine = last.split(/\r?\n/).pop() ?? '';
  if (BULLET.test(lastLine)) return false;
  const lastToken = last.split(/\s+/).pop() ?? '';
  if (URL_TOKEN.test(lastToken)) return false;
  const chars = Array.from(last.replace(/`[^`\n]*`/g, ''));
  while (chars.length > 0) {
    const c = chars[chars.length - 1] ?? '';
    if (c === '?' || c === '？') return true;
    if (!TRAILING.test(c)) return false;
    chars.pop();
  }
  return false;
}
