// The two opt-in "Uses AI" features, as pure helpers: when to ask for a stop reason, what to send, how to clean the reply,
// and when the task-list line goes into the system prompt. Nothing here does I/O or calls a model.

import type { View } from './view.ts';

export type AiGate = { enabled: boolean; ai: { explainStop: boolean; askForTaskList: boolean } };

/** The call's settings, kept in one place so a test can pin them. */
export const EXPLAIN_REQUEST = { model: 'haiku', maxTokens: 30, effort: 'low', timeoutMs: 15_000 } as const;
export const EXPLAIN_TAIL_CHARS = 1500;
export const EXPLAIN_INSTRUCTION = 'Reply with the reason this turn stopped in at most 8 words, no quotes, no trailing period.';
export const REASON_MAX_WORDS = 8;
export const REASON_MAX_CHARS = 60;

export const TASK_LIST_LINE = 'When a request has several steps, keep a task list with your task tool so progress can be shown.';
export const TASK_LIST_SECTION_ID = 'pace-maker:task-list';
/** The tools that can hold a task list; the line is only worth its tokens when the session has one of them. */
export const TASK_TOOLS: ReadonlySet<string> = new Set(['TaskCreate', 'TodoWrite', 'mcp__ccd_turn__update_plan']);

/** True only for an unexplained stop with tasks left, with the feature and the plugin on, and no reason stored yet. */
export function shouldExplain(view: View, settings: AiGate): boolean {
  return settings.enabled === true && settings.ai.explainStop === true && view.kind === 'stopped' && view.reason === undefined;
}

/** True when the task-list line should be added: setting and plugin on, and the offered tools include a task tool. */
export function shouldAskForTaskList(settings: AiGate, tools: unknown): boolean {
  if (settings.enabled !== true || settings.ai.askForTaskList !== true) return false;
  return Array.isArray(tools) && tools.some((t) => typeof t === 'string' && TASK_TOOLS.has(t));
}

/** The whole prompt: the last answer cut to its final characters, then the instruction. Nothing else is sent. */
export function buildExplainPrompt(answer: string): string {
  const tail = typeof answer === 'string' && answer.length > EXPLAIN_TAIL_CHARS ? answer.slice(-EXPLAIN_TAIL_CHARS) : String(answer ?? '');
  return `${tail.trim()}\n\n${EXPLAIN_INSTRUCTION}`;
}

/** Cleans a model reply into at most 8 words and 60 characters, one line, no quotes or trailing period. '' means unusable. */
export function clampReason(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const flat = raw.replace(/[\r\n\t]+/g, ' ').replace(/["`“”]/g, '').replace(/\s+/g, ' ').replace(/^['‘’]+|['‘’]+$/g, '').trim();
  let out = flat.split(' ').filter((w) => w !== '').slice(0, REASON_MAX_WORDS).join(' ');
  if (out.length > REASON_MAX_CHARS) {
    out = out.slice(0, REASON_MAX_CHARS);
    const cut = out.lastIndexOf(' ');
    if (cut > 0) out = out.slice(0, cut);
  }
  return out.replace(/[\s.。]+$/u, '').trim();
}
