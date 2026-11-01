import type { HookCall } from './schema.js';
import { afterEach, describe, expect, it } from 'vitest';
import { books, formatBooks, formatMeasure, formatRecall, measure, recall } from './query.js';
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
    expect(result.before).toEqual({ sessions: 0, recurringPer100: null, recurringSignatures: null, cacheWritePerSession: null, recallPerSession: null, hookRecallPerSession: null, hookHitsPerSession: null, hookDepositsPerSession: null });
    expect(formatMeasure(result)).toContain('-');
    expect(measure({ sessions: [], prompts: [], errors: [] }, [], [], 5).last.sessions).toBe(0);
  });

  it('counts hook lookups and hits per session from the hook counters, by the session they ran in', async () => {
    const store = await loaded();
    const names = store.sessions.map((session) => session.session).sort();
    const at = '2026-06-10T00:00:00Z';
    const hookCalls: HookCall[] = [
      { at, event: 'session-start', session: names[2] ?? null, hit: true, ms: 40 },
      { at, event: 'post-tool', session: names[2] ?? null, hit: false, ms: 20 },
      { at, event: 'post-tool', session: names[3] ?? null, hit: true, ms: 20 },
      { at, event: 'stop', session: names[3] ?? null, hit: true, ms: 200 },
      { at, event: 'nightly', session: null, hit: true, ms: 900 },
      { at, event: 'post-tool', session: 'not-in-the-window', hit: true, ms: 20 },
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

  it('a cutoff after every session leaves the current window empty and the prior window the latest sessions', async () => {
    const store = await loaded();
    const result = measure(store, [], [], 2, '2999-01-01T00:00:00Z');
    expect(result.last.sessions).toBe(0);
    expect(result.before.sessions).toBe(2);
  });
});

describe('recall keys an error the way deposit does (fix round 2)', () => {
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
