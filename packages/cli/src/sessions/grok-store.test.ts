import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runHook } from './hooks.js';
import { books, formatMeasure, measure, recall } from './query.js';
import { harnessOf } from './schema.js';
import { deposit, loadStore, paths, readSkeletons } from './store.js';
import { verifyAll, verifyCaptured } from './verify.js';
import { cleanup, grokUpdate as line, NOW, stage, stageGrok } from './test-support.js';

afterEach(cleanup);

// Fixtures follow xai-org/grok-build @ 2bdd1d6 (see grok.test.ts); no live Grok Build store was read. Every home below is under the test's own temp folder
// (`stageGrok` puts it under `root`, and the runtime's `sourceRoots` names it), so the real `~/.grok` is never touched.

const A = 'aaaa1111-1111-4111-8111-111111111111';
const B = 'bbbb2222-2222-4222-8222-222222222222';
const C = 'cccc3333-3333-4333-8333-333333333333';
const D = 'dddd4444-4444-4444-8444-444444444444';
const E = 'eeee5555-5555-4555-8555-555555555555';

const BASE = Date.parse('2026-06-01T10:00:00Z') / 1000;
const S = (second: number): number => BASE + second;
const iso = (second: number): string => new Date((BASE + second) * 1000).toISOString();
const prompt = (second: number, text: string) => line(S(second), { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
const say = (second: number, text: string) => line(S(second), { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
// A failed shell call: the status says completed, the exit code says 2 (types/output.rs:384-405, acp_conversion.rs:241-250), and output_for_prompt is the formatted
// prompt with its `exit: 2` header (grok_build/bash/mod.rs:2246).
const failedShell = [
  line(S(2), { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'run_terminal_cmd', kind: 'other', status: 'pending', rawInput: { command: 'make' } }),
  line(S(3), {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c1',
    status: 'completed',
    rawOutput: { type: 'Bash', exit_code: 2, command: 'make', output: [...Buffer.from('make: *** No rule to make target')], output_for_prompt: 'exit: 2\nmake: *** No rule to make target', signal: null, timed_out: false, truncated: false, description: null, output_file: '', total_bytes: Buffer.byteLength('make: *** No rule to make target'), current_dir: '/work' },
  }),
];
const usage = { sessionId: 'x', updatedAt: iso(9), session: { inputTokens: 10, outputTokens: 7, cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 17, modelCalls: 1 }, turns: [{ turnNumber: 1, endedAt: iso(8), inputTokens: 10, outputTokens: 7, cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 17, modelCalls: 1, primaryModelId: 'grok-build' }] };
const session = (): unknown[] => [prompt(1, 'fix the build'), ...failedShell, say(5, 'it failed')];

const options = (allow: string[]) => ({ allow, redactDomains: [], now: () => NOW });

const staged = () => {
  const s = stage();
  const home = stageGrok(s.root, [
    { id: A, cwd: join(s.root, 'not-a-repo'), updates: session(), usage },
    { id: B, cwd: join(s.root, 'other'), updates: session(), usage },
  ]);
  expect(home.startsWith(s.root)).toBe(true);
  return { ...s, home, runtime: { ...s.runtime, sourceRoots: { grok: home } } };
};

const trackedKeys = (storeDir: string): string[] => {
  const state: unknown = JSON.parse(readFileSync(paths(storeDir).state, 'utf8'));
  const files = typeof state === 'object' && state !== null && 'files' in state ? state.files : {};
  return typeof files === 'object' && files !== null ? Object.keys(files).sort() : [];
};

describe('depositing the Grok Build source', () => {
  it('captures each session as a grok-harness session, with its own cursor, and a second deposit adds nothing', async () => {
    const s = staged();
    const first = await deposit(s.runtime, options(['grok']));
    expect(first).toMatchObject({ sessions: 2, unchanged: 0, missing: [] });
    expect(first.sources.grok?.read).toBe(2);
    const store = await loadStore(s.storeDir);
    expect(store.sessions.map((entry) => [entry.session, harnessOf(entry)]).sort()).toEqual([
      [`grok-${A}`, 'grok'],
      [`grok-${B}`, 'grok'],
    ]);
    const log = readFileSync(paths(s.storeDir).observations, 'utf8');
    const second = await deposit(s.runtime, options(['grok']));
    expect(second).toMatchObject({ sessions: 0, unchanged: 2 });
    expect(readFileSync(paths(s.storeDir).observations, 'utf8')).toBe(log);
    expect(trackedKeys(s.storeDir)).toEqual([`grok/${A}`, `grok/${B}`]);
  });

  it('reads a Grok Build call by its own table and frames its session as Grok Build, with the failed call an error', async () => {
    const s = staged();
    await deposit(s.runtime, options(['grok']));
    const store = await loadStore(s.storeDir);
    const calls = store.tools.filter((tool) => tool.session === `grok-${A}`);
    expect(calls.flatMap((tool) => tool.steps ?? [])[0]).toMatchObject({ action: 'shell.exec' });
    expect(calls.map((tool) => tool.status)).toEqual(['error']);
    const found = store.sessions.find((candidate) => candidate.session === `grok-${A}`);
    expect(found).toMatchObject({ harness: 'grok' });
    expect(found?.frame).toMatchObject({ harness: 'grok' });
  });

  it('reads the user’s own !cmd call (titled "Execute `cmd`") as a shell call, not an unknown tool', async () => {
    const s = staged();
    stageGrok(s.root, [
      {
        id: E,
        cwd: '/x',
        updates: [
          prompt(1, 'ls'),
          line(S(2), { sessionUpdate: 'tool_call', toolCallId: 'bash-mode-1', title: 'Execute `ls -a`', kind: 'execute', status: 'in_progress', rawInput: { variant: 'Bash', command: 'ls -a', description: 'ls -a', is_background: false } }),
          line(S(3), { sessionUpdate: 'tool_call_update', toolCallId: 'bash-mode-1', status: 'completed', rawOutput: { type: 'Bash', exit_code: 0, command: 'ls -a', output: [...Buffer.from('a b')], output_for_prompt: 'a b', signal: null, timed_out: false, truncated: false, description: null, output_file: '', total_bytes: 3, current_dir: '/x' } }),
        ],
      },
    ]);
    await deposit(s.runtime, options(['grok']));
    const store = await loadStore(s.storeDir);
    const calls = store.tools.filter((tool) => tool.session === `grok-${E}`);
    expect(calls.map((tool) => tool.tool)).toEqual(['Bash']);
    // The stored step reads the command upstream's input holds (rawInput.command), not the title.
    expect(calls.flatMap((tool) => tool.steps ?? [])[0]).toMatchObject({ action: 'shell.exec', identity: { program: 'ls' } });
  });

  it('is read only when allowed, and an allowed name reports nothing missing while a typo does', async () => {
    const s = staged();
    await expect(deposit(s.runtime, options([]))).rejects.toThrow(/Nothing to read/);
    expect((await deposit(s.runtime, options(['grok']))).missing).toEqual([]);
    expect((await deposit(s.runtime, options(['grk']))).missing).toEqual(['grk']);
  });

  it('does not read a discovered Grok Build store that is not allowed: another allowed source reads, grok stays unread and untracked', async () => {
    const s = staged();
    const project = join(s.projectsRoot, 'mine');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'one.jsonl'), `${JSON.stringify({ type: 'user', timestamp: '2026-06-02T00:00:00Z', message: { role: 'user', content: 'hello' } })}\n`);
    const result = await deposit(s.runtime, options(['mine']));
    expect(result.sources.grok).toBeUndefined();
    expect(trackedKeys(s.storeDir)).toEqual(['mine/one.jsonl']);
  });

  it('changes nothing in the Grok home: a deposit only reads', async () => {
    const s = staged();
    const before = readFileSync(join(s.home, 'sessions', encodeURIComponent(join(s.root, 'other')), B, 'updates.jsonl'), 'utf8');
    await deposit(s.runtime, options(['grok']));
    expect(readFileSync(join(s.home, 'sessions', encodeURIComponent(join(s.root, 'other')), B, 'updates.jsonl'), 'utf8')).toBe(before);
  });

  it('holds every verify invariant, including --strict, for a normal session, one with no usage, and one ending in an assistant line', async () => {
    const s = staged();
    stageGrok(s.root, [
      { id: C, cwd: '/x', updates: [prompt(1, 'hi'), say(2, 'hello'), prompt(3, 'again'), say(4, 'more')] },
      { id: D, cwd: '/x', updates: [...session(), say(8, 'aborted turn')], usage },
    ]);
    await deposit(s.runtime, options(['grok']));
    const { skeletons } = await readSkeletons(s.storeDir);
    expect(skeletons).toHaveLength(4);
    const store = await loadStore(s.storeDir);
    expect([...verifyAll(skeletons), ...verifyCaptured(store.sessions, store.tools)].filter((result) => result.violations > 0)).toEqual([]);
  });

  it('skips silently when the runtime names no Grok home or the home does not exist', async () => {
    const s = staged();
    expect(await deposit({ ...s.runtime, sourceRoots: {} }, options(['grok']))).toMatchObject({ sessions: 0 });
    expect(await deposit({ ...s.runtime, sourceRoots: { grok: join(s.root, 'nowhere') } }, options(['grok']))).toMatchObject({ sessions: 0 });
  });

  it('fails open on an unreadable session: the good ones deposit, the Claude Code folder is kept, and the problem is named', async () => {
    const s = staged();
    const project = join(s.projectsRoot, 'mine');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'one.jsonl'), `${JSON.stringify({ type: 'user', timestamp: '2026-06-02T00:00:00Z', message: { role: 'user', content: 'hello' } })}\n`);
    // A folder where the log should be makes the read throw.
    const broken = join(s.home, 'sessions', encodeURIComponent('/x'), C);
    mkdirSync(join(broken, 'updates.jsonl'), { recursive: true });
    writeFileSync(join(broken, 'summary.json'), JSON.stringify({ info: { id: C, cwd: '/x' }, num_messages: 2 }));
    const result = await deposit(s.runtime, options(['mine', 'grok']));
    expect(trackedKeys(s.storeDir)).toEqual(expect.arrayContaining(['mine/one.jsonl', `grok/${A}`, `grok/${B}`]));
    expect(result.sources.grok?.unreadable.join('\n')).toContain(C);
  });

  it('names a wholly torn log and leaves its cursor alone, so a fixed file is read next time', async () => {
    const s = staged();
    stageGrok(s.root, [{ id: E, cwd: '/x', updates: '{torn\nnot json\n' }]);
    const result = await deposit(s.runtime, options(['grok']));
    expect(result.sources.grok?.unreadable.join('\n')).toContain(E);
    expect(trackedKeys(s.storeDir)).toEqual([`grok/${A}`, `grok/${B}`]);
    expect(result.sessions).toBe(2);
  });

  it('counts a torn line in the log as a bad line, so the deposit line does not under-report', async () => {
    const s = staged();
    stageGrok(s.root, [{ id: E, cwd: '/x', updates: `${JSON.stringify(prompt(1, 'hi'))}\n{torn\n${JSON.stringify(say(2, 'ok'))}\n` }]);
    const result = await deposit(s.runtime, options(['grok']));
    expect(result.badLines).toBe(1);
  });

  it('lets the nightly run repeat a saved allow, so it reads Grok Build with no flag', async () => {
    const s = staged();
    await deposit(s.runtime, options(['grok']));
    stageGrok(s.root, [{ id: D, cwd: '/x', updates: session(), usage }]);
    await runHook('nightly', '', s.runtime, () => NOW);
    expect(trackedKeys(s.storeDir)).toContain(`grok/${D}`);
  });

  it('reads a session again when its log grows, as a resume appends to the same file', async () => {
    const s = staged();
    await deposit(s.runtime, options(['grok']));
    const file = join(s.home, 'sessions', encodeURIComponent(join(s.root, 'other')), B, 'updates.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify(prompt(20, 'one more'))}\n`);
    expect(await deposit(s.runtime, options(['grok']))).toMatchObject({ sessions: 1, unchanged: 1 });
  });
});

describe('recall, books, and measure over Grok Build skeletons', () => {
  it('measure counts Grok Build sessions in its window as "of which Grok Build"', async () => {
    const s = staged();
    await deposit(s.runtime, options(['grok']));
    const signal = measure(await loadStore(s.storeDir), [], [], 5);
    expect(signal.last.sessions).toBe(2);
    expect(signal.last.otherSessions).toMatchObject({ grok: 2 });
    expect(formatMeasure(signal)).toMatch(/of which Grok Build\s+2\s/);
  });

  it('books --by harness separates grok from claude-code', async () => {
    const s = staged();
    await deposit(s.runtime, options(['grok']));
    const store = await loadStore(s.storeDir);
    const rows = books(store, 'harness', NOW);
    expect(rows.find((row) => row.key === 'grok')?.prompts).toBe(2);
    expect(rows.reduce((total, row) => total + row.prompts, 0)).toBe(store.prompts.length);
  });

  it('recall finds the Grok Build session by its error line', async () => {
    const s = staged();
    await deposit(s.runtime, options(['grok']));
    const found = recall(await loadStore(s.storeDir), { error: 'No rule' }, NOW);
    expect(found.matches.map((match) => [match.tool, match.sessions])).toEqual([['Bash', 2]]);
  });
});
