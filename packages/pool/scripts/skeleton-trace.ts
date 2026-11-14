// The worked trace on a skeleton-only card: one kept session, read back from its own skeleton.json, pointing at places in this pack's files.
// Only values from the closed lists are printed (a prompt class, an action, an error code, a status). Anything else reads "unresolved", so a name the pack masks cannot reach the card.
import { CANONICAL_ACTIONS } from '../../cli/src/sessions/actions.js';
import { ERROR_CODES, PROMPT_CLASSES, PROMPT_INTERVENTIONS } from '../../cli/src/sessions/schema.js';

/** A kept session: its match id and its parsed `skeleton.json`. */
export interface TraceInput {
  readonly matchId: string;
  readonly skeleton: unknown;
}

export const MATCH_ID = /^[0-9a-f]{64}$/;
const STATUSES: readonly string[] = ['ok', 'error', 'none'];
const WINDOW = 4;

const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const oneOf = (value: unknown, allowed: readonly string[] | ReadonlySet<string>): string => {
  if (typeof value === 'string' && (Array.isArray(allowed) ? allowed.includes(value) : allowed instanceof Set && allowed.has(value))) return `\`${value}\``;
  return 'unresolved';
};
const actionOf = (tool: unknown): string => oneOf(field(list(field(tool, 'steps'))[0], 'action'), CANONICAL_ACTIONS);
const mainTools = (skeleton: unknown): unknown[] => list(field(list(field(skeleton, 'transcripts'))[0], 'tools'));
const failedCalls = (skeleton: unknown): number => mainTools(skeleton).filter((tool) => field(tool, 'status') === 'error').length;

/** The rule that picks the session: most failed calls in the main transcript, then the lowest match id. */
export const TRACE_RULE = 'the kept session with the most failed calls, then the lowest match id';

/** The trace's card lines, or none when no kept session has a tool call. */
export const traceOf = (inputs: readonly TraceInput[]): string[] => {
  const usable = inputs.filter((input) => MATCH_ID.test(input.matchId) && mainTools(input.skeleton).length > 0);
  const [chosen] = [...usable].sort((a, b) => failedCalls(b.skeleton) - failedCalls(a.skeleton) || (a.matchId < b.matchId ? -1 : 1));
  if (chosen === undefined) return [];
  const main = list(field(chosen.skeleton, 'transcripts'))[0];
  const tools = mainTools(chosen.skeleton);
  const failed = tools.findIndex((tool) => field(tool, 'status') === 'error');
  const at = Math.max(failed, 0);
  const tool = tools[at];
  const promptAt = field(tool, 'prompt');
  const prompt = typeof promptAt === 'number' ? list(field(main, 'prompts'))[promptAt] : undefined;
  const same = tools.flatMap((other, index) => (index <= at && field(other, 'prompt') === promptAt ? [index] : [])).slice(-WINDOW);
  const steps = same.map((index) => `\`transcripts[0].tools[${String(index)}]\` is ${actionOf(tools[index])}, ${oneOf(field(tools[index], 'status'), STATUSES)}.`).join(' ');
  const code = field(tool, 'errorCode');
  const recovery = field(tool, 'recoveryCalls');
  const next = list(field(recovery, 'next')).map((action) => oneOf(action, CANONICAL_ACTIONS));
  const errors = field(prompt, 'errors');
  const ref = (index: number): string => `\`transcripts[0].tools[${String(index)}]\``;
  const first = Math.min(at, ...same);
  const run = first === at ? `at ${ref(at)}` : `from ${ref(first)} to ${ref(at)}`;
  const span = typeof promptAt === 'number' ? `from \`transcripts[0].prompts[${String(promptAt)}]\` ${first === at ? `at ${ref(at)}` : `and ${ref(first)} to ${ref(at)}`}` : run;
  return [
    '## A worked trace',
    '',
    `This trace is built from one session in this pack, picked by a fixed rule: ${TRACE_RULE}. It is generated from that session's record, not written by hand. It shows structure. It does not show that the session worked, or that it fits your task.`,
    '',
    `- Session: \`sessions/${chosen.matchId}/skeleton.json\`.`,
    typeof promptAt === 'number'
      ? `- Prompt: \`transcripts[0].prompts[${String(promptAt)}]\`. Class ${oneOf(field(prompt, 'cls'), PROMPT_CLASSES)}, ${typeof errors === 'number' ? `${String(errors)} failed ${errors === 1 ? 'call' : 'calls'}` : 'failed calls unresolved'}, intervention ${oneOf(field(prompt, 'intervention'), PROMPT_INTERVENTIONS)}. The prompt words are not in this pack.`
      : '- Prompt: unresolved. The call names no prompt. The prompt words are not in this pack.',
    `- Tool steps: ${steps}`,
    `- Observed result: \`transcripts[0].tools[${String(at)}]\` ended ${oneOf(field(tool, 'status'), STATUSES)}${code === null || code === undefined ? '' : ` with error code ${oneOf(code, ERROR_CODES)}`}.${recovery === null || recovery === undefined ? '' : ` The next calls were ${next.length === 0 ? 'none' : next.join(', ')}; ${field(recovery, 'editFollowed') === true ? 'a file write followed' : 'no file write followed'}.`}`,
    `- Candidate task: ${span}, build a task ${field(tool, 'status') === 'error' ? 'that checks how an agent recovers' : 'from these steps'}. You would write the repository state and the grader.`,
    '- Unresolved: the repository and commit, the expected answer, the grader or replay command, and the prompt text. This pack holds none of them.',
    '',
  ];
};
