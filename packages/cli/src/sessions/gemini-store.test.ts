import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runHook } from './hooks.js';
import { books, formatMeasure, measure, recall } from './query.js';
import { harnessOf } from './schema.js';
import { deposit, loadStore, paths, readSkeletons } from './store.js';
import { verifyAll, verifyCaptured } from './verify.js';
import { cleanup, geminiHead, NOW, stage, stageGemini } from './test-support.js';

afterEach(cleanup);

// Fixtures follow google-gemini/gemini-cli @ 89e9d25d (see gemini.test.ts); no live Gemini CLI store was read.

const A = 'aaaa1111-1111-4111-8111-111111111111';
const B = 'bbbb2222-2222-4222-8222-222222222222';
const C = 'cccc3333-3333-4333-8333-333333333333';
const D = 'dddd4444-4444-4444-8444-444444444444';
const E = 'eeee5555-5555-4555-8555-555555555555';
const F = 'ffff6666-6666-4666-8666-666666666666';
const G = '99996666-6666-4666-8666-666666666666';

const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const prompt = (second: number, text: string) => ({ id: `u${String(second)}`, timestamp: T(second), type: 'user', content: [{ text }] });
const say = (second: number, content: string, extra: object = {}) => ({ id: `g${String(second)}`, timestamp: T(second), type: 'gemini', content, model: 'gemini-2.5-pro', ...extra });
// A failed shell call: status says success, the `Exit Code:` trailer says 2 (packages/core/src/tools/shell.ts).
const failedShell = say(2, 'running it', {
  tokens: { input: 100, output: 5, cached: 40, total: 105 },
  toolCalls: [
    {
      id: 'c1',
      name: 'run_shell_command',
      args: { command: 'make' },
      status: 'success',
      timestamp: T(3),
      result: [{ functionResponse: { id: 'c1', name: 'run_shell_command', response: { output: '<untrusted_context source="shell">\nOutput: make: *** No rule to make target\nExit Code: 2\n</untrusted_context>' } } }],
    },
  ],
});
const session = (id: string): unknown[] => [geminiHead(id), prompt(1, 'fix the build'), failedShell, say(5, 'it failed', { tokens: { input: 120, output: 2, cached: 0, thoughts: 0, tool: 0, total: 122 } })];

const options = (allow: string[]) => ({ allow, redactDomains: [], now: () => NOW });

const staged = () => {
  const s = stage();
  const home = stageGemini(s.root, [
    { id: A, slug: 'app', projectRoot: join(s.root, 'not-a-repo'), lines: session(A) },
    { id: B, slug: 'other', projectRoot: join(s.root, 'other'), lines: session(B) },
  ]);
  return { ...s, home, runtime: { ...s.runtime, sourceRoots: { gemini: home } } };
};

const trackedKeys = (storeDir: string): string[] => {
  const state: unknown = JSON.parse(readFileSync(paths(storeDir).state, 'utf8'));
  const files = typeof state === 'object' && state !== null && 'files' in state ? state.files : {};
  return typeof files === 'object' && files !== null ? Object.keys(files).sort() : [];
};

describe('depositing the Gemini source', () => {
  it('captures each session as a gemini-harness session, with its own cursor, and a second deposit adds nothing', async () => {
    const s = staged();
    const first = await deposit(s.runtime, options(['gemini']));
    expect(first).toMatchObject({ sessions: 2, unchanged: 0, missing: [] });
    expect(first.sources.gemini?.read).toBe(2);
    const store = await loadStore(s.storeDir);
    expect(store.sessions.map((entry) => [entry.session, harnessOf(entry)]).sort()).toEqual([
      [`gemini-${A}`, 'gemini'],
      [`gemini-${B}`, 'gemini'],
    ]);
    const log = readFileSync(paths(s.storeDir).observations, 'utf8');
    const second = await deposit(s.runtime, options(['gemini']));
    expect(second).toMatchObject({ sessions: 0, unchanged: 2 });
    expect(readFileSync(paths(s.storeDir).observations, 'utf8')).toBe(log);
    expect(trackedKeys(s.storeDir)).toEqual([`gemini/${A}`, `gemini/${B}`]);
  });

  it('reads a Gemini call by its own table and frames its session as Gemini, with the failed call an error', async () => {
    const s = staged();
    await deposit(s.runtime, options(['gemini']));
    const store = await loadStore(s.storeDir);
    const calls = store.tools.filter((tool) => tool.session === `gemini-${A}`);
    expect(calls.flatMap((tool) => tool.steps ?? [])[0]).toMatchObject({ action: 'shell.exec' });
    expect(calls.map((tool) => tool.status)).toEqual(['error']);
    const found = store.sessions.find((candidate) => candidate.session === `gemini-${A}`);
    expect(found).toMatchObject({ harness: 'gemini' });
    expect(found?.frame).toMatchObject({ harness: 'gemini' });
  });

  it('is read only when allowed, and an allowed name reports nothing missing while a typo does', async () => {
    const s = staged();
    await expect(deposit(s.runtime, options([]))).rejects.toThrow(/Nothing to read/);
    expect((await deposit(s.runtime, options(['gemini']))).missing).toEqual([]);
    expect((await deposit(s.runtime, options(['gemni']))).missing).toEqual(['gemni']);
  });

  it('holds every verify invariant, including --strict, for a normal session, one with no usage, and one ending in an assistant line', async () => {
    const s = staged();
    stageGemini(s.root, [
      { id: C, slug: 'plain', projectRoot: '/x', lines: [geminiHead(C), prompt(1, 'hi'), say(2, 'hello'), say(3, 'more')] },
      { id: D, slug: 'ended', projectRoot: '/x', lines: [...session(D), say(8, 'aborted turn')] },
      // A short tool-call response of a thinking model: thoughts above candidates (chatRecordingTypes.ts:21-25 keeps them apart), so the stored output must hold both.
      { id: F, slug: 'thinking', projectRoot: '/x', lines: [geminiHead(F), prompt(1, 'plan it'), say(2, '', { tokens: { input: 50, output: 3, cached: 0, thoughts: 40, tool: 0, total: 93 } })] },
      // A compressed session: the summary and the kept turn are re-recorded under fresh ids and the old ids removed (chatRecordingService.ts:1533-1590, chatCompressionService.ts:665-673).
      {
        id: G,
        slug: 'compressed',
        projectRoot: '/x',
        lines: [
          ...session(G),
          { id: 's1', timestamp: T(20), type: 'user', content: [{ text: '<state_snapshot>\n<overall_goal>fix the build</overall_goal>\n</state_snapshot>' }] },
          { id: 's2', timestamp: T(20), type: 'gemini', content: [{ text: 'Got it. Thanks for the additional context!' }] },
          { $patch: { removeIds: ['u1', 'g2', 'g5'], orderIds: ['s1', 's2'] } },
        ],
      },
    ]);
    await deposit(s.runtime, options(['gemini']));
    const { skeletons } = await readSkeletons(s.storeDir);
    expect(skeletons).toHaveLength(6);
    const store = await loadStore(s.storeDir);
    expect([...verifyAll(skeletons), ...verifyCaptured(store.sessions, store.tools)].filter((result) => result.violations > 0)).toEqual([]);
  });

  it('skips silently when the runtime names no Gemini home or the home does not exist', async () => {
    const s = staged();
    expect(await deposit({ ...s.runtime, sourceRoots: {} }, options(['gemini']))).toMatchObject({ sessions: 0 });
    expect(await deposit({ ...s.runtime, sourceRoots: { gemini: join(s.root, 'nowhere') } }, options(['gemini']))).toMatchObject({ sessions: 0 });
  });

  it('fails open on an unreadable session: the good ones deposit, the Claude Code folder is kept, and the problem is named', async () => {
    const s = staged();
    const project = join(s.projectsRoot, 'mine');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'one.jsonl'), `${JSON.stringify({ type: 'user', timestamp: '2026-06-02T00:00:00Z', message: { role: 'user', content: 'hello' } })}\n`);
    // A file where a project's chats folder should be makes the listing throw.
    mkdirSync(join(s.home, 'tmp', 'broken'), { recursive: true });
    writeFileSync(join(s.home, 'tmp', 'broken', 'chats'), 'a file, not a folder');
    const result = await deposit(s.runtime, options(['mine', 'gemini']));
    expect(trackedKeys(s.storeDir)).toEqual(expect.arrayContaining(['mine/one.jsonl', `gemini/${A}`, `gemini/${B}`]));
    expect(result.sources.gemini?.unreadable.join('\n')).toContain('chats');
  });

  it('names a wholly torn chat file and leaves its cursor alone, so a fixed file is read next time', async () => {
    const s = staged();
    stageGemini(s.root, [{ id: E, slug: 'torn', projectRoot: '/x', lines: '{torn\nnot json\n' }]);
    const result = await deposit(s.runtime, options(['gemini']));
    expect(result.sources.gemini?.unreadable.join('\n')).toContain(E.slice(0, 8));
    expect(trackedKeys(s.storeDir)).toEqual([`gemini/${A}`, `gemini/${B}`]);
    expect(result.sessions).toBe(2);
  });

  it('counts a torn line in the chat file as a bad line, so the deposit line does not under-report', async () => {
    const s = staged();
    stageGemini(s.root, [{ id: E, slug: 'half', projectRoot: '/x', lines: `${JSON.stringify(geminiHead(E))}\n{torn\n${JSON.stringify(prompt(2, 'hi'))}\n` }]);
    const result = await deposit(s.runtime, options(['gemini']));
    expect(result.badLines).toBe(1);
  });

  it('does not deposit a head-only file (a launch and quit, or a /clear: chatRecordingService.ts:855-865) as an empty session, and deposits it once a prompt is appended', async () => {
    const s = staged();
    const home = stageGemini(s.root, [{ id: E, slug: 'quit', projectRoot: '/x', lines: [geminiHead(E)] }]);
    const file = join(home, 'tmp', 'quit', 'chats', `session-2026-06-01T10-00-${E.slice(0, 8)}.jsonl`);
    const first = await deposit(s.runtime, options(['gemini']));
    expect(first.sessions).toBe(2);
    expect(first.sources.gemini?.unreadable).toEqual([]);
    expect(measure(await loadStore(s.storeDir), [], [], 5).last.sessions).toBe(2);
    expect(trackedKeys(s.storeDir)).toEqual([`gemini/${A}`, `gemini/${B}`]);
    writeFileSync(file,`${JSON.stringify(geminiHead(E))}\n${JSON.stringify(prompt(1, 'now a prompt'))}\n`);
    const second = await deposit(s.runtime, options(['gemini']));
    expect(second.sessions).toBe(1);
    expect(trackedKeys(s.storeDir)).toEqual([`gemini/${A}`, `gemini/${B}`, `gemini/${E}`]);
  });

  it('deposits a subagent under its parent, so session counts stay main sessions', async () => {
    const s = staged();
    stageGemini(s.root, [{ id: 'agent1', slug: 'app', projectRoot: join(s.root, 'not-a-repo'), parent: A, lines: [geminiHead('agent1', { kind: 'subagent' }), prompt(1, 'look it up'), say(2, 'found it')] }]);
    await deposit(s.runtime, options(['gemini']));
    const store = await loadStore(s.storeDir);
    expect(store.subagents.map((entry) => [entry.session, entry.parent])).toEqual([[`gemini-${A}-agent1`, `gemini-${A}`]]);
    expect(measure(store, [], [], 5).last.sessions).toBe(2);
  });

  it('lets the nightly run repeat a saved allow, so it reads Gemini with no flag', async () => {
    const s = staged();
    await deposit(s.runtime, options(['gemini']));
    stageGemini(s.root, [{ id: D, slug: 'later', projectRoot: '/x', lines: session(D) }]);
    await runHook('nightly', '', s.runtime, () => NOW);
    expect(trackedKeys(s.storeDir)).toContain(`gemini/${D}`);
  });
});

describe('recall, books, and measure over Gemini skeletons', () => {
  it('measure counts Gemini sessions in its window as "of which Gemini"', async () => {
    const s = staged();
    await deposit(s.runtime, options(['gemini']));
    const signal = measure(await loadStore(s.storeDir), [], [], 5);
    expect(signal.last.sessions).toBe(2);
    expect(signal.last.otherSessions).toMatchObject({ gemini: 2 });
    expect(formatMeasure(signal)).toMatch(/of which Gemini\s+2\s/);
  });

  it('books --by harness separates gemini from claude-code', async () => {
    const s = staged();
    await deposit(s.runtime, options(['gemini']));
    const store = await loadStore(s.storeDir);
    const rows = books(store, 'harness', NOW);
    expect(rows.find((row) => row.key === 'gemini')?.prompts).toBe(2);
    expect(rows.reduce((total, row) => total + row.prompts, 0)).toBe(store.prompts.length);
  });

  it('recall finds the Gemini session by its error line', async () => {
    const s = staged();
    await deposit(s.runtime, options(['gemini']));
    const found = recall(await loadStore(s.storeDir), { error: 'No rule' }, NOW);
    expect(found.matches.map((match) => [match.tool, match.sessions])).toEqual([['Bash', 2]]);
  });
});
