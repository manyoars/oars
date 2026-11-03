import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runHook } from './hooks.js';
import { harnessOf } from './schema.js';
import type { Source } from './sources.js';
import { deposit, loadStore, paths, readSkeletons } from './store.js';
import { verifyAll, verifyCaptured } from './verify.js';
import { cleanup, NOW, rolloutLine as line, stage, stageCodex } from './test-support.js';

afterEach(cleanup);

// Fixtures follow openai/codex @ ac558e2 (see codex.test.ts); no live Codex store was read.

const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const NL = String.fromCharCode(10);
const rollout = (id: string, cwd: string): unknown[] => [
  line(T(0), 'session_meta', { id, timestamp: T(0), cwd, cli_version: '0.50.0' }),
  line(T(1), 'turn_context', { model: 'gpt-5-codex', cwd }),
  line(T(2), 'event_msg', { type: 'user_message', message: 'fix the build' }),
  line(T(3), 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'make'] }), call_id: 'c1' }),
  line(T(4), 'event_msg', { type: 'exec_command_end', call_id: 'c1', exit_code: 2, aggregated_output: 'make: *** No rule', status: 'completed' }),
  line(T(5), 'event_msg', { type: 'agent_message', message: 'it failed' }),
  line(T(6), 'event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 15 } } }),
];

const options = (allow: string[]) => ({ allow, redactDomains: [], now: () => NOW });

const staged = () => {
  const s = stage();
  const home = stageCodex(s.root, [
    { id: 'aaaa1111', lines: rollout('aaaa1111', join(s.root, 'not-a-repo')) },
    { id: 'bbbb2222', lines: rollout('bbbb2222', join(s.root, 'other')), archived: true },
  ]);
  return { ...s, home, runtime: { ...s.runtime, sourceRoots: { codex: home } } };
};

const trackedKeys = (storeDir: string): string[] => {
  const state: unknown = JSON.parse(readFileSync(paths(storeDir).state, 'utf8'));
  const files = typeof state === 'object' && state !== null && 'files' in state ? state.files : {};
  return typeof files === 'object' && files !== null ? Object.keys(files).sort() : [];
};

describe('depositing the Codex source', () => {
  it('captures each rollout as a codex-harness session, with its own cursor, and a second deposit adds nothing', async () => {
    const s = staged();
    const first = await deposit(s.runtime, options(['codex']));
    expect(first).toMatchObject({ sessions: 2, unchanged: 0, missing: [] });
    expect(first.sources.codex?.read).toBe(2);
    const store = await loadStore(s.storeDir);
    expect(store.sessions.map((session) => [session.session, harnessOf(session)]).sort()).toEqual([
      ['codex-2026-06-01T10-00-00-aaaa1111', 'codex'],
      ['codex-2026-06-01T10-00-00-bbbb2222', 'codex'],
    ]);
    const log = readFileSync(paths(s.storeDir).observations, 'utf8');
    const second = await deposit(s.runtime, options(['codex']));
    expect(second).toMatchObject({ sessions: 0, unchanged: 2 });
    expect(readFileSync(paths(s.storeDir).observations, 'utf8')).toBe(log);
    expect(trackedKeys(s.storeDir)).toEqual(['codex/2026-06-01T10-00-00-aaaa1111', 'codex/2026-06-01T10-00-00-bbbb2222']);
  });

  it('is read only when allowed, and an allowed name reports nothing missing while a typo does', async () => {
    const s = staged();
    await expect(deposit(s.runtime, options([]))).rejects.toThrow(/Nothing to read/);
    expect((await deposit(s.runtime, options(['codex']))).missing).toEqual([]);
    expect((await deposit(s.runtime, options(['codx']))).missing).toEqual(['codx']);
  });

  it('holds every verify invariant, including --strict on assistant lines', async () => {
    const s = staged();
    await deposit(s.runtime, options(['codex']));
    const { skeletons } = await readSkeletons(s.storeDir);
    expect(skeletons).toHaveLength(2);
    const store = await loadStore(s.storeDir);
    expect([...verifyAll(skeletons), ...verifyCaptured(store.sessions, store.tools)].filter((result) => result.violations > 0)).toEqual([]);
  });

  it('skips silently when the runtime names no Codex home or the home does not exist', async () => {
    const s = staged();
    expect(await deposit({ ...s.runtime, sourceRoots: {} }, options(['codex']))).toMatchObject({ sessions: 0 });
    expect(await deposit({ ...s.runtime, sourceRoots: { codex: join(s.root, 'nowhere') } }, options(['codex']))).toMatchObject({ sessions: 0 });
  });

  it('fails open on a corrupt rollout: the good ones deposit, the Claude Code folder is kept, and the file is named', async () => {
    const s = staged();
    const project = join(s.projectsRoot, 'mine');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'one.jsonl'), `${JSON.stringify({ type: 'user', timestamp: '2026-06-02T00:00:00Z', message: { role: 'user', content: 'hello' } })}${NL}`);
    writeFileSync(join(s.home, 'sessions', '2026', '06', '01', 'rollout-2026-06-01T10-00-00-cccc3333.jsonl.zst'), 'not zstd at all');
    const result = await deposit(s.runtime, options(['mine', 'codex']));
    expect(trackedKeys(s.storeDir)).toEqual(expect.arrayContaining(['mine/one.jsonl', 'codex/2026-06-01T10-00-00-aaaa1111', 'codex/2026-06-01T10-00-00-bbbb2222']));
    expect(result.sources.codex?.unreadable.join(NL)).toContain('cccc3333');
  });

  it('lets the nightly run repeat a saved allow, so it reads Codex with no flag', async () => {
    const s = staged();
    await deposit(s.runtime, options(['codex']));
    const text = `${rollout('dddd4444', '/x').map((entry) => JSON.stringify(entry)).join(NL)}${NL}`;
    writeFileSync(join(s.home, 'sessions', '2026', '06', '01', 'rollout-2026-06-01T10-00-00-dddd4444.jsonl'), text);
    await runHook('nightly', '', s.runtime, () => NOW);
    expect(trackedKeys(s.storeDir)).toContain('codex/2026-06-01T10-00-00-dddd4444');
  });
});

describe('the source table', () => {
  it('picks up a second entry with no other wiring', async () => {
    const s = stage();
    const second: Source = {
      name: 'fake',
      harness: 'codex',
      label: 'Fake',
      root: () => s.root,
      storeFile: (root) => join(root, 'fake.db'),
      open: () => Promise.resolve({
        sessions: [{ id: 'one', folder: null, size: 1, mtimeMs: 1 }],
        transcript: () => `${JSON.stringify({ type: 'user', timestamp: T(1), message: { role: 'user', content: 'hi' } })}${NL}`,
        rejected: 0,
        unreadable: [],
        where: () => join(s.root, 'fake.db'),
        close: () => undefined,
      }),
    };
    const result = await deposit({ ...s.runtime, sources: [second], sourceRoots: { fake: s.root } }, options(['fake']));
    expect(result).toMatchObject({ sessions: 1, missing: [] });
    expect(trackedKeys(s.storeDir)).toEqual(['fake/one']);
  });
});
