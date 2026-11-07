import type { HookCall, PromptObservation, ToolObservation, UsageField } from './schema.js';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOKS_MIN_PROMPTS, books, formatBooks, formatMeasure, formatRecall, measure, recall } from './query.js';
import type { SurvivalState } from './survival.js';
import { deposit, loadStore, type Store } from './store.js';
import { addProject, cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

const loaded = async (): Promise<Store> => {
  const staged = stage();
  await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
  return loadStore(staged.storeDir);
};

const SIGNATURE = 'Bash | bash: -c: line <n>: unexpected EOF while looking for matching quote';

describe('recall', () => {
  it('returns the bash-quoting signature with its session count, dates, versions, and following tools', async () => {
    const store = await loaded();
    const result = recall(store, { error: "bash: -c: line 7: unexpected EOF while looking for matching quote\n" }, NOW);
    expect(result.normalized).toBe('bash: -c: line <n>: unexpected EOF while looking for matching quote');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ sig: SIGNATURE, sessions: 2, count: 2, harnessVersions: ['2.1.300', '2.1.310'], editFollowed: 1 });
    expect(result.matches[0]?.firstSeen).toMatch(/^2026-05-/);
    expect(result.matches[0]?.followedBy.map((entry) => entry.tool)).toEqual(['Bash', 'Read', 'Write']);
    expect(formatRecall(result)).toContain('2 sessions, 2 errors');
  });

  it('matches --path against the stored files only', async () => {
    const store = await loaded();
    const session = store.sessions.find((candidate) => candidate.files.includes('/work/app/src/main.ts'));
    if (session === undefined) throw new Error('fixture session with main.ts not found');
    expect(recall(store, { path: 'main.ts' }, NOW).matches.length).toBeGreaterThan(0);
    session.files = session.files.filter((file) => !file.endsWith('main.ts'));
    expect(recall(store, { path: 'main.ts' }, NOW).matches).toHaveLength(0);
  });

  it('takes a pasted signature, filters by tool, and matches by class, path, and age', async () => {
    const store = await loaded();
    expect(recall(store, { error: `Bash | ${SIGNATURE.slice(7)}` }, NOW).matches).toHaveLength(1);
    expect(recall(store, { error: `Write | ${SIGNATURE.slice(7)}` }, NOW).matches).toHaveLength(0);
    expect(recall(store, { error: '   ' }, NOW).matches).toHaveLength(0);
    expect(recall(store, { cls: 'edit-verify' }, NOW).matches.map((match) => match.tool).sort()).toEqual(['Bash', 'Bash', 'Write']);
    expect(recall(store, { path: 'main.ts' }, NOW).matches).toHaveLength(2);
    expect(recall(store, { path: '/work/app/src/main.ts' }, NOW).matches).toHaveLength(2);
    expect(recall(store, { path: 'nothing.ts' }, NOW).matches).toHaveLength(0);
    expect(recall(store, { error: 'unexpected EOF', sinceDays: 30 }, NOW).matches).toHaveLength(1);
    expect(recall(store, { error: 'unexpected EOF', sinceDays: 30 }, NOW + 400 * 86_400_000).matches).toHaveLength(0);
    expect(formatRecall(recall(store, { error: 'never seen' }, NOW))).toBe('No matching signature in the store.');
  });
});

describe('books', () => {
  it('sums tokens, wall time, turns, and errors per class with the verify-after-edit rate', async () => {
    const rows = books(await loaded(), 'class', NOW);
    const verify = rows.find((row) => row.key === 'edit-verify');
    expect(verify).toMatchObject({ prompts: 2, errors: 4, verifyAfterEdit: 1 });
    expect(verify?.cacheRead).toBeGreaterThan(0);
    expect(verify?.wallSec).toBeGreaterThan(0);
    expect(rows.find((row) => row.key === 'edit-only')?.verifyAfterEdit).toBe(0);
    expect(rows.find((row) => row.key === 'research')?.verifyAfterEdit).toBeNull();
    expect(rows.reduce((total, row) => total + row.prompts, 0)).toBe(7);
    expect(formatBooks(rows, 'class')).toContain('edit-verify');
    expect(formatBooks([], 'class')).toBe('No prompts in the store.');
  });

  it('groups by model and filters by age', async () => {
    const store = await loaded();
    expect(books(store, 'model', NOW).map((row) => row.key).sort()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(books(store, 'class', NOW, 30).reduce((total, row) => total + row.prompts, 0)).toBe(7);
    expect(books(store, 'class', NOW + 3650 * 86_400_000, 1)).toHaveLength(0);
  });
});

describe('measure', () => {
  it('reads the last N sessions and the N before', async () => {
    const store = await loaded();
    const result = measure(store, [], [], 2);
    expect(result.last.sessions).toBe(2);
    expect(result.before.sessions).toBe(2);
    // Order by first timestamp: every fixture starts at the same instant, so the session id breaks ties:
    // errors-a, errors-b, sidechain, tldr. errors-b repeats a signature errors-a saw first.
    expect(result.before.recurringPer100).toBe(50);
    expect(result.last.recurringPer100).toBe(0);
    expect(result.before.recurringSignatures).toBe(1);
    expect(result.last.recurringSignatures).toBe(0);
    expect(result.before.cacheWritePerSession).toBeGreaterThan(0);
    expect(formatMeasure(result)).toContain('recurring errors per 100 sessions');
    expect(formatMeasure(result)).toContain('distinct recurring signatures');
  });

  it('counts MCP recall calls inside each window and handles an empty store', async () => {
    const store = await loaded();
    const calls = [{ at: store.sessions[0]?.tsFirst ?? '', query: '{}', matches: 1 }];
    const result = measure(store, calls, [], 4);
    expect(result.last.recallPerSession).toBe(0.25);
    expect(result.before).toEqual({ sessions: 0, cursorSessions: 0, recurringPer100: null, recurringSignatures: null, cacheWritePerSession: null, cacheWriteSessions: 0, recallPerSession: null, hookRecallPerSession: null, hookHitsPerSession: null, hookDepositsPerSession: null });
    expect(formatMeasure(result)).toContain('-');
    expect(measure({ sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0 }, [], [], 5).last.sessions).toBe(0);
  });

  it('counts hook lookups and hits per session from the hook counters, by the session they ran in', async () => {
    const store = await loaded();
    const names = store.sessions.map((session) => session.session).sort();
    const at = '2026-06-10T00:00:00Z';
    const hookCalls: HookCall[] = [
      { at, event: 'session-start', session: names[2] ?? null, hit: true, ms: 40, error: null },
      { at, event: 'post-tool', session: names[2] ?? null, hit: false, ms: 20, error: null },
      { at, event: 'post-tool', session: names[3] ?? null, hit: true, ms: 20, error: null },
      { at, event: 'stop', session: names[3] ?? null, hit: true, ms: 200, error: null },
      { at, event: 'nightly', session: null, hit: true, ms: 900, error: null },
      { at, event: 'post-tool', session: 'not-in-the-window', hit: true, ms: 20, error: null },
    ];
    const result = measure(store, [], hookCalls, 2);
    expect(result.last.hookRecallPerSession).toBe(1.5);
    expect(result.last.hookHitsPerSession).toBe(1);
    expect(result.last.hookDepositsPerSession).toBe(0.5);
    expect(result.before.hookDepositsPerSession).toBe(0);
    expect(formatMeasure(result)).toContain('hook deposits per session');
    expect(result.before.hookRecallPerSession).toBe(0);
    expect(formatMeasure(result)).toContain('hook recall calls per session');
  });

  it('with a cutoff, the current window is the first N sessions at or after it and the prior window the N before, however many come later', async () => {
    const loadedStore = await loaded();
    const stamp = (position: number): string => `2026-06-0${String(position + 1)}T00:00:00Z`;
    const sessions = loadedStore.sessions.map((session, position) => ({ ...session, session: `s${String(position)}`, tsFirst: stamp(position) }));
    const store = { ...loadedStore, sessions, errors: [] };
    const pinned = measure(store, [], [], 1, '2026-06-02T00:00:00Z');
    expect(pinned.since).toBe('2026-06-02T00:00:00Z');
    expect(pinned.last.cacheWritePerSession).toBe(sessions[1]?.usage.cacheWrite);
    expect(pinned.before.cacheWritePerSession).toBe(sessions[0]?.usage.cacheWrite);
    const wide = measure(store, [], [], 2, '2026-06-02T00:00:00Z');
    expect(wide.last.sessions).toBe(2);
    expect(wide.before.sessions).toBe(1);
    // A later session does not move the pinned window; the moving window shifts.
    const late = loadedStore.sessions.slice(0, 1).map((session) => ({ ...session, session: 'late', tsFirst: '2026-07-01T00:00:00Z' }));
    const later = { ...store, sessions: [...sessions, ...late] };
    expect(measure(later, [], [], 1, '2026-06-02T00:00:00Z').last.cacheWritePerSession).toBe(sessions[1]?.usage.cacheWrite);
    expect(measure(later, [], [], 1).last.cacheWritePerSession).toBe(sessions[0]?.usage.cacheWrite);
    expect(formatMeasure(pinned)).toContain('from 2026-06-02T00:00:00Z');
  });

  it('averages cache writes over the sessions that recorded them, and prints a figure no session recorded as absent', async () => {
    const loadedStore = await loaded();
    const [first, second] = loadedStore.sessions.slice(0, 2).map((session, position) => ({ ...session, session: `s${String(position)}`, tsFirst: `2026-06-0${String(position + 1)}T00:00:00Z`, usage: { ...session.usage, cacheWrite: position === 0 ? 40 : 99 } }));
    if (first === undefined || second === undefined) throw new Error('the fixture has no sessions');
    const withCoverage = (usageObserved: UsageField[]) => ({ ...loadedStore, sessions: [{ ...first, usageObserved: ['cacheWrite' as const] }, { ...second, usageObserved }], errors: [] });
    // The second session's 99 is a placeholder beside usageObserved: it must not enter the mean.
    const partial = measure(withCoverage([]), [], [], 2);
    expect(partial.last).toMatchObject({ sessions: 2, cacheWritePerSession: 40, cacheWriteSessions: 1 });
    expect(formatMeasure(partial)).toContain('40 (1 of 2)');
    const none = measure({ ...withCoverage([]), sessions: [{ ...first, usageObserved: [] }, { ...second, usageObserved: [] }] }, [], [], 2);
    expect(none.last).toMatchObject({ cacheWritePerSession: null, cacheWriteSessions: 0 });
    expect(formatMeasure(none)).toContain('n/a');
  });

  it('a cutoff after every session leaves the current window empty and the prior window the latest sessions', async () => {
    const store = await loaded();
    const result = measure(store, [], [], 2, '2999-01-01T00:00:00Z');
    expect(result.last.sessions).toBe(0);
    expect(result.before.sessions).toBe(2);
  });
});

describe('recall keys an error the way deposit does', () => {
  it('recalls a deposited error that carries an email with digits', async () => {
    const staged = stage();
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-06-01T00:00:00Z', message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-06-01T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'Exit code 1\nmail user123@corp.example refused' }] } }),
    ];
    addProject(staged, 'mail', 'm1', lines);
    await deposit(staged.runtime, { allow: ['mail'], redactDomains: [], now: () => NOW });
    const store = await loadStore(staged.storeDir);
    const result = recall(store, { error: 'mail user123@corp.example refused' }, NOW);
    expect(result.normalized).toBe('mail <email> refused');
    expect(result.matches).toHaveLength(1);
  });
});

describe('books outcome columns', () => {
  const prompt = (over: Partial<PromptObservation> & { session: string; index: number }): PromptObservation => ({
    kind: 'prompt', v: '6', rev: 1, ts: '2026-06-01T00:00:00.000Z', wallSec: 1, head: '', cls: 'edit-verify', tools: [], shape: '', errors: 0, thinking: 0, sideTools: 0, turns: 1, model: 'm', efforts: [], skills: [],
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 },
    recovery: [], explore: 0, act: 0, bigrams: {}, contextFingerprint: null, verify: 'passed', stopped: null, commits: 0, redo: false, ...over,
  });
  const tool = (over: Partial<ToolObservation> & { session: string; prompt: number }): ToolObservation => ({ kind: 'tool', cv: '6', sid: null, rev: 1, parent: over.session, agentType: null, n: 0, ts: '2026-06-01T00:00:00.000Z', tool: 'Bash', status: 'ok', target: null, targetBase: null, keys: [], durationMs: null, toolUseId: null, harnessVersion: null, side: false, ...over });
  const storeOf = (prompts: PromptObservation[], tools: ToolObservation[] = []): Store => ({ sessions: [], prompts, errors: [], subagents: [], tools, newerCaptures: 0 });
  const many = (count: number, over: Partial<PromptObservation>): PromptObservation[] => Array.from({ length: count }, (_, index) => prompt({ session: 's', index, ...over }));

  it('gives each signal its count, its denominator, and its share', () => {
    const list = [...many(30, { verify: 'passed' }).slice(0, 15), ...many(30, { verify: 'failed' }).slice(15), prompt({ session: 'n', index: 0, verify: 'na', stopped: 'interrupt', redo: true }), prompt({ session: 'a', index: 0, verify: undefined }), prompt({ session: 'm', index: 0, verify: 'masked' }), prompt({ session: 'o', index: 0, verify: 'none' })];
    const [row] = books(storeOf(list), 'model', NOW);
    // `masked` leaves the denominator, since its exit is unknown; `none` stays in, since no runner reads as passing.
    expect(row?.verifyPassed).toEqual({ count: 15, of: 31, share: 0.484 });
    expect(row?.stopped).toEqual({ count: 1, of: 34, share: 0.029 });
    expect(row?.redone).toEqual({ count: 1, of: 34, share: 0.029 });
  });

  it('leaves out a line that predates a signal, and a cell below the minimum has no share', () => {
    expect(BOOKS_MIN_PROMPTS).toBe(30);
    const [row] = books(storeOf(many(BOOKS_MIN_PROMPTS - 1, { stopped: undefined, redo: undefined })), 'model', NOW);
    expect(row?.stopped).toEqual({ count: 0, of: 0, share: null });
    expect(row?.redone).toEqual({ count: 0, of: 0, share: null });
    expect(row?.verifyPassed).toEqual({ count: 29, of: 29, share: null });
    const text = formatBooks(row === undefined ? [] : [row], 'model');
    expect(text).toContain('too few');
  });

  it('sums commits, and settles only the shas with a known state, once each', () => {
    const list = many(40, { commits: 1 });
    const tools = [
      tool({ session: 's', prompt: 0, commits: ['aaa', null] }),
      tool({ session: 's', prompt: 1, commits: ['bbb'] }),
      tool({ session: 's', prompt: 2, commits: ['ccc'] }),
      tool({ session: 's', prompt: 3, commits: ['ddd'] }),
      tool({ session: 's', prompt: 4, commits: ['aaa'] }),
    ];
    const survival = new Map<string, SurvivalState>([['aaa', 'survived'], ['bbb', 'reverted'], ['ccc', 'unreachable'], ['ddd', 'unknown']]);
    const [row] = books(storeOf(list, tools), 'model', NOW, undefined, survival);
    expect(row?.commits).toBe(40);
    expect(row?.settled).toBe(3);
    expect(row?.survived).toEqual({ count: 1, of: 3, share: null });
  });

  it('reads a resumed session repeated call once, and a side call not at all, as commits does', () => {
    const list = many(2, {});
    const tools = [
      tool({ session: 's', prompt: 0, toolUseId: 't', commits: ['aaa'] }),
      tool({ session: 's', prompt: 1, toolUseId: 't', commits: ['bbb'] }),
      tool({ session: 's', prompt: 1, side: true, commits: ['ccc'] }),
      tool({ session: 'gone', prompt: 0, commits: ['ddd'] }),
    ];
    const survival = new Map<string, SurvivalState>([['aaa', 'survived'], ['bbb', 'survived'], ['ccc', 'survived'], ['ddd', 'survived']]);
    expect(books(storeOf(list, tools), 'model', NOW, undefined, survival)[0]?.settled).toBe(1);
  });

  it('--by pull gives one row per ecosystem and name, and a prompt once in each row it pulled', () => {
    const list = [prompt({ session: 's', index: 0 }), prompt({ session: 's', index: 1 }), prompt({ session: 's', index: 2 })];
    const foo = { ecosystem: 'npm', name: 'foo', version: null } as const;
    const server = { ecosystem: 'mcp', name: 'example-server', version: null } as const;
    const tools = [
      tool({ session: 's', prompt: 0, pulls: [foo, foo] }),
      tool({ session: 's', prompt: 0, pulls: [server] }),
      tool({ session: 's', prompt: 1, pulls: [foo], commits: ['aaa'] }),
      tool({ session: 'other', prompt: 0, pulls: [{ ecosystem: 'npm', name: 'subagent-only', version: null }] }),
    ];
    const rows = books(storeOf(list, tools), 'pull', NOW);
    expect(rows.map((row) => [row.key, row.prompts])).toEqual([['npm:foo', 2], ['mcp:example-server', 1]]);
    expect(formatBooks(rows, 'pull').split('\n')[0]).toMatch(/^pull/);
    expect(formatBooks([], 'pull')).toBe('No pulls in the store.');
  });

  it('keeps a long key from shifting the columns', () => {
    const name = 'a-rather-long-package-name-indeed';
    const rows = books(storeOf([prompt({ session: 's', index: 0, model: name }), prompt({ session: 's', index: 1, model: 'm' })]), 'model', NOW);
    const [header, first, second] = formatBooks(rows, 'model').split('\n');
    expect(first?.length).toBe(header?.length);
    expect(second?.length).toBe(header?.length);
  });

  it('sums only the usage a prompt recorded: a category no prompt recorded is absent, and a partial one says how many did', () => {
    const base = { input: 1, cacheWrite: 2, cacheRead: 10, output: 5, thinking: 0 };
    // The second prompt's cacheRead 7 and thinking 9 are placeholders beside usageObserved, not measurements.
    const list = [prompt({ session: 's', index: 0, usage: base, usageObserved: ['input', 'cacheWrite', 'cacheRead', 'output'] }), prompt({ session: 's', index: 1, usage: { ...base, cacheRead: 7, output: 3, thinking: 9 }, usageObserved: ['output'] })];
    const [row] = books(storeOf(list), 'model', NOW);
    expect(row).toMatchObject({ prompts: 2, cacheRead: 10, cacheWrite: 2, output: 8, thinking: null, usageRecorded: { cacheRead: 1, cacheWrite: 1, output: 2, thinking: 0 } });
    const [header, line, ...notes] = formatBooks(row === undefined ? [] : [row], 'model').split('\n');
    expect(line).toContain('n/a');
    expect(line).not.toMatch(/\b0\b.*\bn\/a\b/);
    expect(notes).toContain('m cache read: 1 of 2 prompts recorded');
    expect(notes).toContain('m cache write: 1 of 2 prompts recorded');
    // A column already printing n/a needs no "0 of N" line.
    expect(notes.join('\n')).not.toContain('thinking');
    expect(notes.join('\n')).not.toContain('output');
    expect(header?.length).toBe(line?.length);
  });

  it('prints the columns, with a share where the cell has enough prompts', () => {
    const [row] = books(storeOf(many(40, { verify: 'passed', stopped: 'rejected', redo: true, commits: 2 })), 'model', NOW);
    const text = formatBooks(row === undefined ? [] : [row], 'model');
    for (const column of ['passed', 'stop', 'redo', 'commits', 'settled', 'survived']) expect(text.split('\n')[0]).toContain(column);
    expect(text.split('\n')[1]).toContain('100%');
    expect(text.split('\n')[1]).toContain('80');
  });
});
