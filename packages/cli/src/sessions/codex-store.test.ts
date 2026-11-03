import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runHook } from './hooks.js';
import { books, formatMeasure, measure, recall } from './query.js';
import { harnessOf } from './schema.js';
import type { Source, SourceStore } from './sources.js';
import { deposit, frozenSessions, loadStore, paths, readSkeletons } from './store.js';
import { verifyAll, verifyCaptured } from './verify.js';
import { cleanup, NOW, rolloutLine as line, stage, stageCodex } from './test-support.js';

afterEach(cleanup);

// Fixtures follow openai/codex @ ac558e2 (see codex.test.ts); no live Codex store was read.

const A = 'aaaa1111-1111-4111-8111-111111111111';
const B = 'bbbb2222-2222-4222-8222-222222222222';
const C = 'cccc3333-3333-4333-8333-333333333333';
const D = 'dddd4444-4444-4444-8444-444444444444';
const E = 'eeee5555-5555-4555-8555-555555555555';
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

  // t755's frame and action table meet this source here: the deposit passes the source's own harness, not a literal, so a Codex call is
  // read by Codex's table and its frame says `codex`, never `cursor` (review M6 on 6f162bf, where main's literal would have won the merge).
  it('reads a Codex call by its own table and frames its session as Codex, from the deposit down', async () => {
    const s = staged();
    await deposit(s.runtime, options(['codex']));
    const store = await loadStore(s.storeDir);
    const steps = store.tools.filter((tool) => tool.session === `codex-${A}`).flatMap((tool) => tool.steps ?? []);
    expect(steps[0]).toMatchObject({ action: 'shell.exec' });
    const session = store.sessions.find((candidate) => candidate.session === `codex-${A}`);
    expect(session).toMatchObject({ harness: 'codex' });
    expect(session?.frame).toMatchObject({ harness: 'codex' });
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

  it('names a wholly corrupt rollout and leaves its cursor alone, so a fixed file is read next time', async () => {
    const s = staged();
    stageCodex(s.root, [
      { id: E, lines: '{torn\nnot json\n' },
    ]);
    const result = await deposit(s.runtime, options(['codex']));
    const unreadable = result.sources.codex?.unreadable.join(NL) ?? '';
    expect(unreadable).toContain(E);
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

  // `SessionMeta.source` (protocol/src/protocol.rs:3477) is a `SessionSource`; serde writes it lowercase and externally tagged (:3141-3144), so a subagent is
  // `{subagent: review}` (`SubAgentSource`, snake_case, :3223-3241) and an internal thread `{internal: guardian}` (:3151, :3215-3221). Upstream's own
  // `is_non_root_agent` is `Internal(_) | SubAgent(_)` (:3280-3285), and `parent_thread_id` is set only for ThreadSpawn by `SubAgentSource::parent_thread_id`
  // (:3376-3386), so a rollout can be a subagent's without one. The root thread is `session_id` (:3451-3452).
  it('counts a rollout whose source is a subagent as one with no parent_thread_id, under its session_id (Review, protocol.rs:3226-3227)', async () => {
    const s = stage();
    const home = stageCodex(s.root, [{ id: B, lines: [meta(B, '/work/app', { session_id: A, source: { subagent: 'review' } }), line(T(2), 'event_msg', { type: 'user_message', message: 'review the diff' }), usage] }]);
    const result = await deposit({ ...s.runtime, sourceRoots: { codex: home } }, options(['codex']));
    expect(result).toMatchObject({ sessions: 0, subagents: 1 });
    const store = await loadStore(s.storeDir);
    expect(store.sessions).toEqual([]);
    expect(store.subagents.map((session) => [session.session, session.parent])).toEqual([[`codex-${B}`, `codex-${A}`]]);
  });

  it('counts an internal source (guardian, memory_consolidation) as a subagent too, and names itself when it has neither parent_thread_id nor session_id', async () => {
    const s = stage();
    const prompt = line(T(2), 'event_msg', { type: 'user_message', message: 'summarize' });
    const home = stageCodex(s.root, [
      { id: B, lines: [meta(B, '/work/app', { session_id: A, source: { internal: 'guardian' } }), prompt, usage] },
      { id: C, lines: [meta(C, '/work/app', { source: { internal: 'memory_consolidation' } }), prompt, usage] },
    ]);
    const result = await deposit({ ...s.runtime, sourceRoots: { codex: home } }, options(['codex']));
    expect(result).toMatchObject({ sessions: 0, subagents: 2 });
    const store = await loadStore(s.storeDir);
    expect(store.subagents.map((session) => [session.session, session.parent]).sort()).toEqual([[`codex-${B}`, `codex-${A}`], [`codex-${C}`, `codex-${C}`]]);
  });

  it('keeps every other source a main session: cli, vscode, exec, mcp, and a custom client', async () => {
    const s = stage();
    const ids = [A, B, C, D, E];
    const sources: unknown[] = ['cli', 'vscode', 'exec', 'mcp', { custom: 'sdk' }];
    const home = stageCodex(s.root, ids.map((id, index) => ({ id, lines: [meta(id, '/work/app', { source: sources[index] }), line(T(2), 'event_msg', { type: 'user_message', message: 'go' }), usage] })));
    const result = await deposit({ ...s.runtime, sourceRoots: { codex: home } }, options(['codex']));
    expect(result).toMatchObject({ sessions: 5, subagents: 0 });
  });
});

describe('Paginated and forked rollouts through the store', () => {
  // The rollout upstream writes by default (thread-store/src/local/mod.rs:512-515): every record carries a rising `ordinal` from 0 (rollout/src/ordinal.rs:30,
  // :47-53), the prompt and the reply are `item_completed` TurnItems (rollout/src/policy.rs:142-156, :253), and an AgentMessage's content part is `{type: Text}`
  // (protocol/src/items.rs:131-135) while a UserMessage's is `{type: text}` (user_input.rs:16).
  const paginated = (id: string): unknown[] => {
    const records = [
      meta(id, '/work/app', { history_mode: 'paginated' }),
      line(T(1), 'turn_context', { model: 'gpt-5-codex', cwd: '/work/app' }),
      line(T(2), 'event_msg', { type: 'item_completed', thread_id: id, turn_id: 't1', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'fix the build', text_elements: [] }] } }),
      ...failedShell,
      line(T(5), 'event_msg', { type: 'item_completed', thread_id: id, turn_id: 't1', item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'it failed' }] } }),
      usage,
      line(T(7), 'event_msg', { type: 'item_completed', thread_id: id, turn_id: 't2', item: { type: 'UserMessage', id: 'u2', content: [{ type: 'text', text: 'explain why', text_elements: [] }] } }),
      line(T(8), 'event_msg', { type: 'item_completed', thread_id: id, turn_id: 't2', item: { type: 'AgentMessage', id: 'a2', content: [{ type: 'Text', text: 'the rule is missing' }] } }),
    ];
    return records.map((record, ordinal) => ({ ...record, ordinal }));
  };

  it('deposits a Paginated rollout (the default upstream writes), with a reply on every turn, and holds every verify invariant, including --strict', async () => {
    const s = stage();
    const home = stageCodex(s.root, [{ id: A, lines: paginated(A) }]);
    const result = await deposit({ ...s.runtime, sourceRoots: { codex: home } }, options(['codex']));
    expect(result).toMatchObject({ sessions: 1 });
    expect(result.sources.codex?.unreadable).toEqual([]);
    const { skeletons } = await readSkeletons(s.storeDir);
    const store = await loadStore(s.storeDir);
    expect(store.prompts.filter((entry) => entry.session === `codex-${A}`)).toHaveLength(2);
    expect(store.sessions[0]).toMatchObject({ userTurns: 2, assistantTurns: 3 });
    expect([...verifyAll(skeletons), ...verifyCaptured(store.sessions, store.tools)].filter((entry) => entry.violations > 0)).toEqual([]);
  });

  it('deposits a thread and its reverted rollout as one session and one subagent (rollout/src/rollout_file_name.rs:12-14)', async () => {
    const s = stage();
    const home = stageCodex(s.root, [
      { id: A, lines: rollout(A, '/work/app') },
      { id: `${A}_${B}`, lines: rollout(A, '/work/app') },
    ]);
    const result = await deposit({ ...s.runtime, sourceRoots: { codex: home } }, options(['codex']));
    expect(result).toMatchObject({ sessions: 1, subagents: 1 });
  });

  it('drops a Legacy fork copy of its parent, found through forked_from_id in the same store', async () => {
    const s = stage();
    const fork = [meta(B, '/work/app', { forked_from_id: A }), ...rollout(A, '/work/app').slice(1, 3), line(T(20), 'event_msg', { type: 'user_message', message: 'own prompt' })];
    const home = stageCodex(s.root, [
      { id: A, lines: rollout(A, '/work/app') },
      { id: B, lines: fork },
    ]);
    await deposit({ ...s.runtime, sourceRoots: { codex: home } }, options(['codex']));
    const store = await loadStore(s.storeDir);
    expect(store.prompts.filter((entry) => entry.session === `codex-${B}`)).toHaveLength(1);
  });

  it('keeps a session whose store cannot be listed out of the cv-frozen set, but freezes one a readable store no longer lists', async () => {
    const s = stage();
    const unreadable = join(s.root, 'unreadable-home');
    mkdirSync(unreadable, { recursive: true });
    writeFileSync(join(unreadable, 'sessions'), 'a plain file, not a folder');
    const behind = [{ project: 'p', session: `codex-${A}` }];
    expect([...(await frozenSessions({ ...s.runtime, sourceRoots: { codex: unreadable } }, behind))]).toEqual([]);
    const home = stageCodex(s.root, [{ id: B, lines: rollout(B, '/work/app') }]);
    expect([...(await frozenSessions({ ...s.runtime, sourceRoots: { codex: home } }, behind))]).toEqual([`codex-${A}`]);
  });

  it('logs an unreadable sessions folder by base name and reason only, even when the root is outside the home folder', async () => {
    const s = stage();
    const outside = join(s.root, 'elsewhere', 'codex-home-name');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'sessions'), 'a plain file, not a folder');
    const result = await deposit({ ...s.runtime, sourceRoots: { codex: outside } }, options(['codex']));
    const logged = result.sources.codex?.unreadableLogged.join(NL) ?? '';
    expect(logged).toContain('sessions');
    expect(logged).not.toContain('codex-home-name');
  });
});
