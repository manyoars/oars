import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { foldToolRows, withoutReplays } from './fold.js';
import type { SessionObservation, ToolObservation, ToolStatus } from './schema.js';
import { deposit, loadStore, paths } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

const tool = (id: string | null, status: ToolStatus, extra: Partial<ToolObservation> = {}): ToolObservation => ({
  kind: 'tool', cv: '5', sid: null, session: 's', rev: 1, parent: 's', agentType: null, n: 0, ts: null, tool: 'Read', status, target: 'a', targetBase: 'cwd', keys: [], durationMs: null,
  toolUseId: id, harnessVersion: null, side: false, prompt: 0, ...extra,
});

describe('foldToolRows', () => {
  it('keeps the first record of a tool-use id in its place and drops the replay', () => {
    const { tools, dropped } = foldToolRows([tool('a', 'ok', { n: 0 }), tool('b', 'error', { n: 1 }), tool('a', 'none', { n: 2, target: 'other' })]);
    expect(tools.map((entry) => [entry.toolUseId, entry.status, entry.target])).toEqual([['a', 'ok', 'a'], ['b', 'error', 'a']]);
    expect(dropped.map((entry) => entry.n)).toEqual([2]);
  });

  it('gives the kept record the status and duration of a later record when its own is none', () => {
    const { tools } = foldToolRows([tool('a', 'none', { n: 0, prompt: 0 }), tool('a', 'error', { n: 5, prompt: 2, durationMs: 40 })]);
    expect(tools).toEqual([tool('a', 'error', { n: 0, prompt: 0, durationMs: 40 })]);
  });

  it('keeps the status of the kept record when a later one also has one, and every record with no id', () => {
    expect(foldToolRows([tool('a', 'ok'), tool('a', 'error')]).tools.map((entry) => entry.status)).toEqual(['ok']);
    expect(foldToolRows([tool('a', 'none'), tool('a', 'none')]).tools.map((entry) => entry.status)).toEqual(['none']);
    expect(foldToolRows([tool(null, 'none'), tool(null, 'none')]).tools).toHaveLength(2);
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
