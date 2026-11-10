// A store with known values for the crew card's tests, and a plant of every kind of thing the card must never print. The window is the week ending NOW.
import { error, prompt, session, store, tool } from './pool-fixture.js';
import type { Harness, ToolObservation, Usage } from './schema.js';
import type { Store } from './store.js';
import type { SurvivalState } from './survival.js';

export const CARD_NOW = Date.parse('2026-11-09T12:00:00Z');

/** Each is a string that must appear in no output of the card. */
export const PLANTED = {
  folder: 'C--Users-alice-secret-repo',
  path: 'C:/Users/alice/secret-repo/src/app.ts',
  branch: 'feature/secret-launch',
  promptText: 'PROMPT-SECRET-TEXT sk-live-123456',
  errorText: 'ENOENT /home/alice/secret-dir',
  longTailTool: 'mcp__secretserver__do_thing',
  longTailModel: 'acme-internal-model-7',
  skill: 'private-skill-name',
} as const;

const usage = (over: Partial<Usage>): Usage => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, ...over });

const owned = (id: string, harness: Harness | undefined, over: Parameters<typeof session>[1] = {}): ReturnType<typeof session> =>
  session(id, { project: PLANTED.folder, files: [PLANTED.path], branches: [PLANTED.branch], ...(harness === undefined ? {} : { harness }), ...over });

const call = (id: string, n: number, name: string, over: Partial<ToolObservation> = {}): ToolObservation => tool(id, n, name, { prompt: 0, ...over });

/**
 * Window facts (a week ending 2026-11-09): 3 sessions on 3 days, 44 prompts, 13 strokes, 4 crabs (2 followed by a different next step), 40 of the claude-code
 * session's prompts edited and 30 of those verified, 3 commits of which 1 has a settled state, cost on 2 of 3 sessions. An old session outside the window
 * carries a model and a commit that must not show.
 */
export const cardStore = (): Store => {
  const claude = owned('s-claude', undefined, { costUsd: 1.5, tsFirst: '2026-11-03T09:00:00.000Z' });
  const codex = owned('s-codex', 'codex', { costUsd: 0.25, tsFirst: '2026-11-05T09:00:00.000Z' });
  const cursor = owned('s-cursor', 'cursor', { tsFirst: '2026-11-06T09:00:00.000Z' });
  const old = owned('s-old', undefined, { costUsd: 99, tsFirst: '2026-10-01T09:00:00.000Z' });
  const claudePrompts = Array.from({ length: 40 }, (_, index) =>
    prompt('s-claude', index, {
      ts: '2026-11-03T09:00:00.000Z',
      cls: index < 30 ? 'edit-verify' : 'edit-only',
      model: 'claude-opus-5-5',
      head: PLANTED.promptText,
      skills: [PLANTED.skill],
      usage: usage({ input: 10, cacheWrite: 20, cacheRead: 30, output: 40 }),
      commits: index === 0 ? 2 : index === 1 ? 1 : 0,
    }),
  );
  const codexPrompts = [0, 1, 2].map((index) => prompt('s-codex', index, { ts: index === 2 ? '2026-11-06T09:00:00.000Z' : '2026-11-05T09:00:00.000Z', cls: 'explore-only', model: 'gpt-5-codex', head: PLANTED.promptText, usage: usage({ output: 100 }) }));
  const cursorPrompts = [prompt('s-cursor', 0, { ts: '2026-11-06T10:00:00.000Z', cls: 'explore-only', model: PLANTED.longTailModel, head: PLANTED.promptText, usage: usage({ output: 50 }) })];
  const oldPrompts = [prompt('s-old', 0, { ts: '2026-10-01T09:00:00.000Z', model: 'claude-haiku-5-5', usage: usage({ output: 7777 }), commits: 5 })];
  const tools: ToolObservation[] = [
    ...Array.from({ length: 10 }, (_, n) => call('s-claude', n, n < 5 ? 'Bash' : 'Read', { status: n >= 1 && n <= 4 ? 'error' : 'ok', toolUseId: `c${String(n)}`, commits: n === 0 ? ['aaa111', null] : n === 1 ? ['bbb222'] : undefined })),
    call('s-codex', 0, 'shell', { toolUseId: 'x0' }),
    call('s-codex', 1, PLANTED.longTailTool, { toolUseId: 'x1', prompt: 1 }),
    call('s-cursor', 0, 'Edit', { toolUseId: 'u0' }),
    call('s-old', 0, 'Bash', { toolUseId: 'o0', commits: ['ccc333'] }),
    // a replayed copy of a call: one call is one stroke
    call('s-claude', 0, 'Bash', { toolUseId: 'c0', n: 10 }),
  ];
  const errors = [
    error('s-claude', 'Bash | exit 1', { tool: 'Bash', toolUseId: 'c1', prompt: 0, next: ['Edit', 'Read'], example: PLANTED.errorText, ts: '2026-11-03T09:01:00.000Z' }),
    error('s-claude', 'Bash | exit 2', { tool: 'Bash', toolUseId: 'c2', prompt: 0, next: ['Read'], example: PLANTED.errorText, ts: '2026-11-03T09:02:00.000Z' }),
    error('s-claude', 'Bash | exit 3', { tool: 'Bash', toolUseId: 'c3', prompt: 0, next: ['Bash'], example: PLANTED.errorText, ts: '2026-11-03T09:03:00.000Z' }),
    error('s-claude', 'Bash | exit 4', { tool: 'Bash', toolUseId: 'c4', prompt: 0, next: [], example: PLANTED.errorText, ts: '2026-11-03T09:04:00.000Z' }),
    error('s-old', 'Bash | old', { tool: 'Bash', toolUseId: 'o0', prompt: 0, next: ['Edit'], ts: '2026-10-01T09:01:00.000Z' }),
  ];
  return store({ sessions: [claude, codex, cursor, old], prompts: [...claudePrompts, ...codexPrompts, ...cursorPrompts, ...oldPrompts], tools, errors });
};

export const cardSurvival = (): Map<string, SurvivalState> => new Map<string, SurvivalState>([['aaa111', 'survived']]);
