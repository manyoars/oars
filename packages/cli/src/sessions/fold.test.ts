import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { foldToolRows, withoutReplays } from './fold.js';
import type { ErrorLineObservation, SessionObservation, ToolObservation, ToolStatus } from './schema.js';
import { deposit, loadStore, paths } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

const tool = (id: string | null, status: ToolStatus, extra: Partial<ToolObservation> = {}): ToolObservation => ({
  kind: 'tool', cv: '5', sid: null, session: 's', rev: 1, parent: 's', agentType: null, n: 0, ts: null, tool: 'Read', status, target: 'a', targetBase: 'cwd', keys: [], durationMs: null,
  toolUseId: id, harnessVersion: null, side: false, prompt: 0, ...extra,
});

describe('foldToolRows', () => {
  it('keeps the first record of a tool-use id in its place and drops the replay', () => {
    const { tools, dropped } = foldToolRows([tool('a', 'ok', { n: 0 }), tool('b', 'error', { n: 1 }), tool('a', 'none', { n: 2, target: 'other' })], []);
    expect(tools.map((entry) => [entry.toolUseId, entry.status, entry.target])).toEqual([['a', 'ok', 'a'], ['b', 'error', 'a']]);
    expect(dropped.map((entry) => entry.n)).toEqual([2]);
  });

  it('gives the kept record the status and duration of a later record when its own is none', () => {
    const { tools } = foldToolRows([tool('a', 'none', { n: 0, prompt: 0 }), tool('a', 'error', { n: 5, prompt: 2, durationMs: 40 })], []);
    expect(tools).toEqual([tool('a', 'error', { n: 0, prompt: 0, durationMs: 40 })]);
  });

  it('keeps the status of the kept record when a later one also has one, and every record with no id', () => {
    expect(foldToolRows([tool('a', 'ok'), tool('a', 'error')], []).tools.map((entry) => entry.status)).toEqual(['ok']);
    expect(foldToolRows([tool('a', 'none'), tool('a', 'none')], []).tools.map((entry) => entry.status)).toEqual(['none']);
    expect(foldToolRows([tool(null, 'none'), tool(null, 'none')], []).tools).toHaveLength(2);
  });
  it('takes the target, path base, ts, and harness version of a later copy when the first has no ts, once', () => {
    const blob = tool('a', 'none', { n: 0, target: 'blob', targetBase: 'cwd', ts: null, harnessVersion: null });
    const real = tool('a', 'ok', { n: 1, target: 'real', targetBase: 'repo', ts: '2026-01-01T00:00:00Z', harnessVersion: '2.1', durationMs: 7 });
    const later = tool('a', 'ok', { n: 2, target: 'later', targetBase: 'repo', ts: '2026-01-02T00:00:00Z', harnessVersion: '2.2' });
    const [kept] = foldToolRows([blob, real, later], []).tools;
    expect(kept).toEqual({ ...blob, status: 'ok', durationMs: 7, target: 'real', targetBase: 'repo', ts: '2026-01-01T00:00:00Z', harnessVersion: '2.1' });
    expect(foldToolRows([real, tool('a', 'none', { n: 2, target: 'blob', ts: null })], []).tools[0]).toEqual({ ...real, n: 0 });
  });

  it('numbers the kept records from zero and moves each error line to the count of kept records before it', () => {
    const error = (after: number): ErrorLineObservation => ({
      kind: 'error-line', cv: '5', sid: null, session: 's', rev: 1, toolUseId: null, tool: 'Read', line: 'x', ts: null, harnessVersion: null, side: false, prompt: 0, after,
    });
    // Written order: a, a-replay, b, b-replay, c, c-replay (n 0 to 5); the lines were seen before the first, after b, and at the end.
    const written = ['a', 'a', 'b', 'b', 'c', 'c'].map((id, n) => tool(id, n % 2 === 0 ? 'ok' : 'none', { n }));
    const folded = foldToolRows(written, [error(0), error(3), error(4), error(6)]);
    expect(folded.tools.map((entry) => [entry.toolUseId, entry.n])).toEqual([['a', 0], ['b', 1], ['c', 2]]);
    expect(folded.errorLines.map((entry) => entry.after)).toEqual([0, 2, 2, 3]);
    expect(foldToolRows([tool('b', 'ok', { n: 4 }), tool('a', 'ok', { n: 1 })], []).tools.map((entry) => [entry.toolUseId, entry.n])).toEqual([['a', 0], ['b', 1]]);
  });
});

describe('withoutReplays', () => {
  const session: SessionObservation = { ...captureSession({ text: '', session: 's', project: 'p', rev: 1, at: '', bytes: 0, redact: makeRedactor(), salt: 'salt' }).session, tools: { Read: 2, Bash: 2, Grep: 1 }, bashCmds: 2 };

  it('returns the session itself when nothing was dropped', () => {
    expect(withoutReplays(session, [])).toBe(session);
  });

  it('takes each dropped call out of the per-tool counts and the shell count, and removes a name that reaches zero', () => {
    const folded = withoutReplays(session, [tool('a', 'none'), tool('b', 'none', { tool: 'Bash' }), tool('c', 'none', { tool: 'Grep' }), tool('d', 'none', { tool: 'Grep' })]);
    expect(folded.tools).toEqual({ Read: 1, Bash: 1 });
    expect(folded.bashCmds).toBe(1);
    expect(withoutReplays(session, [tool('b', 'none', { tool: 'Bash' }), tool('c', 'none', { tool: 'Bash' }), tool('d', 'none', { tool: 'Bash' })]).bashCmds).toBe(0);
  });
});

describe('loadStore over a mixed old and new store', () => {
  it('counts a replayed call once: an old session gets its replay folded, a current one is untouched', async () => {
    const staged = stage();
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const file = paths(staged.storeDir).observations;
    const lines = readFileSync(file, 'utf8').split('\n').filter((entry) => entry !== '');
    const before = await loadStore(staged.storeDir);
    // errors-a is written back as an older capture: every one of its tool records is repeated with status none and another target, and its counts include the replay.
    const old = lines.map((entry): string => {
      const parsed: unknown = JSON.parse(entry);
      if (typeof parsed !== 'object' || parsed === null || Reflect.get(parsed, 'session') !== 'errors-a') return entry;
      if (Reflect.get(parsed, 'kind') === 'session') {
        Reflect.set(parsed, 'cv', '5');
        Reflect.set(parsed, 'tools', Object.fromEntries(Object.entries(before.sessions.find((session) => session.session === 'errors-a')?.tools ?? {}).map(([name, count]) => [name, count * 2])));
        return JSON.stringify(parsed);
      }
      return entry;
    });
    const replays = lines
      .map((entry): unknown => JSON.parse(entry))
      .filter((entry): entry is ToolObservation => typeof entry === 'object' && entry !== null && Reflect.get(entry, 'kind') === 'tool' && Reflect.get(entry, 'session') === 'errors-a')
      .map((entry) => JSON.stringify({ ...entry, cv: '5', status: 'none', durationMs: null, target: 'replayed', n: entry.n + 100 }));
    writeFileSync(file, `${old.join('\n')}\n`);
    appendFileSync(file, `${replays.join('\n')}\n`);
    expect(replays.length).toBeGreaterThan(0);
    const after = await loadStore(staged.storeDir);
    expect(after.tools.length).toBe(before.tools.length);
    expect(after.tools.filter((entry) => entry.status === 'none').length).toBe(before.tools.filter((entry) => entry.status === 'none').length);
    expect(after.sessions.find((session) => session.session === 'errors-a')?.tools).toEqual(before.sessions.find((session) => session.session === 'errors-a')?.tools);
    expect(after.tools.some((entry) => entry.target === 'replayed')).toBe(false);
    expect(after.prompts.map((prompt) => prompt.session + String(prompt.index))).toEqual(before.prompts.map((prompt) => prompt.session + String(prompt.index)));
  });
});

describe('loadStore over an old session with replays interleaved', () => {
  it('derives what the current capture derives: renumbered rows, and error lines that point at the kept calls', async () => {
    const staged = stage();
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const file = paths(staged.storeDir).observations;
    const before = await loadStore(staged.storeDir);
    const records = readFileSync(file, 'utf8').split('\n').filter((entry) => entry !== '').map((entry): unknown => JSON.parse(entry)).filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
    const mine = (entry: Record<string, unknown>): boolean => entry.session === 'errors-a';
    // An older capture put the replay of each call right after it: row i is at n 2i, its replay at 2i + 1, and an error line seen after a calls says `after` 2a.
    const old = records.flatMap((entry): Record<string, unknown>[] => {
      if (!mine(entry)) return [entry];
      if (entry.kind === 'session') return [{ ...entry, cv: '5' }];
      if (entry.kind === 'error-line') return [{ ...entry, cv: '5', after: Number(entry.after) * 2 }];
      if (entry.kind !== 'tool') return [entry];
      const n = Number(entry.n);
      return [{ ...entry, cv: '5', n: n * 2 }, { ...entry, cv: '5', n: n * 2 + 1, status: 'none', durationMs: null, target: 'replayed' }];
    });
    writeFileSync(file, `${old.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    const after = await loadStore(staged.storeDir);
    const errors = before.errors.filter((error) => error.session === 'errors-a');
    expect(errors.some((error) => error.next.length > 0)).toBe(true);
    expect(after.errors.filter((error) => error.session === 'errors-a').map((error) => [error.sig, error.next, error.editFollowed])).toEqual(errors.map((error) => [error.sig, error.next, error.editFollowed]));
    expect(after.tools.filter((entry) => entry.session === 'errors-a').map((entry) => entry.n)).toEqual(before.tools.filter((entry) => entry.session === 'errors-a').map((entry) => entry.n));
    expect(after.prompts.filter((prompt) => prompt.session === 'errors-a')).toEqual(before.prompts.filter((prompt) => prompt.session === 'errors-a'));
  });
});
