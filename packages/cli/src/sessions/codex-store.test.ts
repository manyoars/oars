import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runHook } from './hooks.js';
import { books, formatMeasure, measure, recall } from './query.js';
import { harnessOf } from './schema.js';
import type { Source, SourceStore } from './sources.js';
import { deposit, loadStore, paths, readSkeletons } from './store.js';
import { verifyAll, verifyCaptured } from './verify.js';
import { cleanup, NOW, rolloutLine as line, stage, stageCodex } from './test-support.js';

afterEach(cleanup);

// Fixtures follow openai/codex @ ac558e2 (see codex.test.ts); no live Codex store was read.

const A = 'aaaa1111-1111-4111-8111-111111111111';
const B = 'bbbb2222-2222-4222-8222-222222222222';
const C = 'cccc3333-3333-4333-8333-333333333333';
const D = 'dddd4444-4444-4444-8444-444444444444';
const E = 'eeee5555-5555-4555-8555-555555555555';
const F = 'ffff6666-6666-4666-8666-666666666666';
const STEM = (id: string): string => `2026-06-01T10-00-00-${id}`;

const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const NL = String.fromCharCode(10);
const meta = (id: string, cwd: string, extra: object = {}) => line(T(0), 'session_meta', { id, timestamp: T(0), cwd, cli_version: '0.50.0', ...extra });
// A failed shell call in the persisted text form (core/src/tools/mod.rs:107-113), as ac558e2 writes it.
const failedShell = [
  line(T(3), 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'make'] }), call_id: 'c1' }),
  line(T(4), 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'Exit code: 2\nWall time: 0.1 seconds\nOutput:\nmake: *** No rule' }),
];
const usage = line(T(6), 'event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 15 } } });
const rollout = (id: string, cwd: string): unknown[] => [
  meta(id, cwd),
  line(T(1), 'turn_context', { model: 'gpt-5-codex', cwd }),
  line(T(2), 'event_msg', { type: 'user_message', message: 'fix the build' }),
  ...failedShell,
  line(T(5), 'event_msg', { type: 'agent_message', message: 'it failed' }),
  usage,
];

const options = (allow: string[]) => ({ allow, redactDomains: [], now: () => NOW });

const staged = () => {
  const s = stage();
  const home = stageCodex(s.root, [
    { id: A, lines: rollout(A, join(s.root, 'not-a-repo')) },
    { id: B, lines: rollout(B, join(s.root, 'other')), archived: true },
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
      [`codex-${A}`, 'codex'],
      [`codex-${B}`, 'codex'],
    ]);
    const log = readFileSync(paths(s.storeDir).observations, 'utf8');
    const second = await deposit(s.runtime, options(['codex']));
    expect(second).toMatchObject({ sessions: 0, unchanged: 2 });
    expect(readFileSync(paths(s.storeDir).observations, 'utf8')).toBe(log);
    expect(trackedKeys(s.storeDir)).toEqual([`codex/${A}`, `codex/${B}`]);
  });

  it('is read only when allowed, and an allowed name reports nothing missing while a typo does', async () => {
    const s = staged();
    await expect(deposit(s.runtime, options([]))).rejects.toThrow(/Nothing to read/);
    expect((await deposit(s.runtime, options(['codex']))).missing).toEqual([]);
    expect((await deposit(s.runtime, options(['codx']))).missing).toEqual(['codx']);
  });

  it('holds every verify invariant, including --strict, for a normal session, one with no usage, and one ending in an assistant line', async () => {
    const s = staged();
    stageCodex(s.root, [
      { id: C, lines: [meta(C, '/x'), line(T(2), 'event_msg', { type: 'user_message', message: 'hi' }), line(T(3), 'event_msg', { type: 'agent_message', message: 'hello' }), line(T(4), 'event_msg', { type: 'agent_message', message: 'more' })] },
      { id: D, lines: [...rollout(D, '/x'), line(T(8), 'event_msg', { type: 'agent_message', message: 'aborted turn' })] },
    ]);
    await deposit(s.runtime, options(['codex']));
    const { skeletons } = await readSkeletons(s.storeDir);
    expect(skeletons).toHaveLength(4);
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
    writeFileSync(join(s.home, 'sessions', '2026', '06', '01', `rollout-${STEM(C)}.jsonl.zst`), 'not zstd at all');
    const result = await deposit(s.runtime, options(['mine', 'codex']));
    expect(trackedKeys(s.storeDir)).toEqual(expect.arrayContaining(['mine/one.jsonl', `codex/${A}`, `codex/${B}`]));
    expect(result.sources.codex?.unreadable.join(NL)).toContain(C);
  });

  it('names a wholly corrupt or Paginated rollout and leaves its cursor alone, so a fixed file is read next time', async () => {
    const s = staged();
    stageCodex(s.root, [
      { id: E, lines: '{torn\nnot json\n' },
      { id: F, lines: [meta(F, '/x', { history_mode: 'paginated' }), line(T(2), 'event_msg', { type: 'item_completed' })] },
    ]);
    const result = await deposit(s.runtime, options(['codex']));
    const unreadable = result.sources.codex?.unreadable.join(NL) ?? '';
    expect(unreadable).toContain(E);
    expect(unreadable).toContain(F);
    expect(unreadable).toMatch(/paginated/);
    expect(trackedKeys(s.storeDir)).toEqual([`codex/${A}`, `codex/${B}`]);
    expect(result.sessions).toBe(2);
  });

  it('counts a torn line in the rollout as a bad line, so the deposit line does not under-report', async () => {
    const s = staged();
    stageCodex(s.root, [{ id: E, lines: `${JSON.stringify(meta(E, '/x'))}${NL}{torn${NL}${JSON.stringify(line(T(2), 'event_msg', { type: 'user_message', message: 'hi' }))}${NL}` }]);
    const result = await deposit(s.runtime, options(['codex']));
    expect(result.badLines).toBe(1);
  });

  it('lets the nightly run repeat a saved allow, so it reads Codex with no flag', async () => {
    const s = staged();
    await deposit(s.runtime, options(['codex']));
    const text = `${rollout(D, '/x').map((entry) => JSON.stringify(entry)).join(NL)}${NL}`;
    writeFileSync(join(s.home, 'sessions', '2026', '06', '01', `rollout-${STEM(D)}.jsonl`), text);
    await runHook('nightly', '', s.runtime, () => NOW);
    expect(trackedKeys(s.storeDir)).toContain(`codex/${D}`);
  });
});

describe('recall, books, and measure over Codex skeletons', () => {
  it('measure counts Codex sessions in its window as "of which Codex"', async () => {
    const s = staged();
    await deposit(s.runtime, options(['codex']));
    const signal = measure(await loadStore(s.storeDir), [], [], 5);
    expect(signal.last.sessions).toBe(2);
    expect(signal.last.otherSessions).toEqual({ codex: 2 });
    expect(formatMeasure(signal)).toMatch(/of which Codex\s+2\s/);
  });

  it('books --by harness separates codex from claude-code', async () => {
    const s = staged();
    await deposit(s.runtime, options(['codex']));
    const store = await loadStore(s.storeDir);
    const rows = books(store, 'harness', NOW);
    expect(rows.find((row) => row.key === 'codex')?.prompts).toBe(2);
    expect(rows.reduce((total, row) => total + row.prompts, 0)).toBe(store.prompts.length);
  });

  it('recall finds the Codex session by its error line', async () => {
    const s = staged();
    await deposit(s.runtime, options(['codex']));
    const found = recall(await loadStore(s.storeDir), { error: 'No rule' }, NOW);
    expect(found.matches.map((match) => [match.tool, match.sessions])).toEqual([['Bash', 2]]);
  });
});

describe('the source table', () => {
  const fake = (root: string, transcripts: { [id: string]: string | Error }, stopOnTranscriptError?: boolean): Source => ({
    name: 'fake',
    harness: 'codex',
    label: 'Fakery',
    ...(stopOnTranscriptError === undefined ? {} : { stopOnTranscriptError }),
    root: () => root,
    storeFile: (at) => join(at, 'fake.db'),
    open: () =>
      Promise.resolve<SourceStore>({
        sessions: Object.keys(transcripts).map((id, index) => ({ id, folder: null, size: 1, mtimeMs: index + 1 })),
        transcript: (session) => {
          const text = transcripts[session.id];
          if (text instanceof Error) throw text;
          return text ?? '';
        },
        rejected: 0,
        unreadable: [],
        where: () => join(root, 'fake.db'),
        close: () => undefined,
      }),
  });
  const hi = `${JSON.stringify({ type: 'user', timestamp: T(1), message: { role: 'user', content: 'hi' } })}${NL}`;

  it('picks up a second entry with no other wiring, labeled from the table in force', async () => {
    const s = stage();
    const result = await deposit({ ...s.runtime, sources: [fake(s.root, { one: hi })], sourceRoots: { fake: s.root } }, options(['fake']));
    expect(result).toMatchObject({ sessions: 1, missing: [] });
    expect(trackedKeys(s.storeDir)).toEqual(['fake/one']);
  });

  it('keeps reading after one session fails, unless the entry says to stop (Cursor stops)', async () => {
    const transcripts = { one: new Error('bad one'), two: hi };
    const s = stage();
    const carry = await deposit({ ...s.runtime, sources: [fake(s.root, transcripts)], sourceRoots: { fake: s.root } }, options(['fake']));
    expect(carry.sources.fake?.read).toBe(1);
    const t = stage();
    const stop = await deposit({ ...t.runtime, sources: [fake(t.root, transcripts, true)], sourceRoots: { fake: t.root } }, options(['fake']));
    expect(stop.sources.fake?.read).toBe(0);
    expect(stop.sources.fake?.unreadable.join(NL)).toContain('bad one');
  });
});

describe('Codex subagent rollouts', () => {
  it('counts a spawned agent under subagents, not sessions, and records its parent', async () => {
    const s = stage();
    const home = stageCodex(s.root, [
      { id: A, lines: rollout(A, '/work/app') },
      { id: B, lines: [meta(B, '/work/app', { parent_thread_id: A, agent_role: 'explorer' }), line(T(2), 'event_msg', { type: 'user_message', message: 'look around' }), usage] },
    ]);
    const result = await deposit({ ...s.runtime, sourceRoots: { codex: home } }, options(['codex']));
    expect(result).toMatchObject({ sessions: 1, subagents: 1 });
    const store = await loadStore(s.storeDir);
    expect(store.sessions.map((session) => session.session)).toEqual([`codex-${A}`]);
    expect(store.subagents.map((session) => [session.session, session.parent])).toEqual([[`codex-${B}`, `codex-${A}`]]);
  });
});
