import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runHook } from './hooks.js';
import { books, formatMeasure, measure, recall } from './query.js';
import { harnessOf } from './schema.js';
import { deposit, loadStore, paths, readSkeletons } from './store.js';
import { verifyAll, verifyCaptured } from './verify.js';
import { cleanup, copilotEvent as event, NOW, stage, stageCopilot } from './test-support.js';

afterEach(cleanup);

// Fixtures follow github/copilot-sdk @ d28a136 (see copilot.test.ts); no live Copilot store was read.

const A = 'aaaa1111-1111-4111-8111-111111111111';
const B = 'bbbb2222-2222-4222-8222-222222222222';
const C = 'cccc3333-3333-4333-8333-333333333333';
const D = 'dddd4444-4444-4444-8444-444444444444';
const E = 'eeee5555-5555-4555-8555-555555555555';

const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const start = (id: string, cwd: string) => event(T(0), 'session.start', { sessionId: id, copilotVersion: '1.0.105', producer: 'copilot-agent', selectedModel: 'claude-sonnet-4.5', startTime: T(0), version: 1, context: { cwd } });
const prompt = (second: number, content: string) => event(T(second), 'user.message', { content });
const say = (second: number, content: string, extra: object = {}) => event(T(second), 'assistant.message', { messageId: `m${String(second)}`, content, model: 'claude-sonnet-4.5', ...extra });
// A failed shell call: success says true, the exit code says 2 (ToolExecutionCompleteData.shellExecution.exitCode).
const failedShell = [
  say(2, 'running it', { outputTokens: 5, toolRequests: [{ toolCallId: 'c1', name: 'bash', arguments: { command: 'make' } }] }),
  event(T(3), 'tool.execution_start', { toolCallId: 'c1', toolName: 'bash', arguments: { command: 'make' }, shellToolInfo: { hasWriteFileRedirection: false, possiblePaths: [] } }),
  event(T(4), 'tool.execution_complete', { toolCallId: 'c1', success: true, shellExecution: { exitCode: 2 }, result: { content: 'make: *** No rule to make target' } }),
];
const shutdown = event(T(7), 'session.shutdown', {
  shutdownType: 'routine',
  totalApiDurationMs: 5,
  sessionStartTime: 0,
  codeChanges: {},
  modelMetrics: { 'claude-sonnet-4.5': { requests: { count: 2 }, usage: { inputTokens: 10, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } },
});
const session = (id: string, cwd: string): unknown[] => [start(id, cwd), prompt(1, 'fix the build'), ...failedShell, say(5, 'it failed', { outputTokens: 2 }), shutdown];

const options = (allow: string[]) => ({ allow, redactDomains: [], now: () => NOW });

const staged = () => {
  const s = stage();
  const home = stageCopilot(s.root, [
    { id: A, lines: session(A, join(s.root, 'not-a-repo')) },
    { id: B, lines: session(B, join(s.root, 'other')) },
  ]);
  return { ...s, home, runtime: { ...s.runtime, sourceRoots: { copilot: home } } };
};

const trackedKeys = (storeDir: string): string[] => {
  const state: unknown = JSON.parse(readFileSync(paths(storeDir).state, 'utf8'));
  const files = typeof state === 'object' && state !== null && 'files' in state ? state.files : {};
  return typeof files === 'object' && files !== null ? Object.keys(files).sort() : [];
};

describe('depositing the Copilot source', () => {
  it('captures each session as a copilot-harness session, with its own cursor, and a second deposit adds nothing', async () => {
    const s = staged();
    const first = await deposit(s.runtime, options(['copilot']));
    expect(first).toMatchObject({ sessions: 2, unchanged: 0, missing: [] });
    expect(first.sources.copilot?.read).toBe(2);
    const store = await loadStore(s.storeDir);
    expect(store.sessions.map((entry) => [entry.session, harnessOf(entry)]).sort()).toEqual([
      [`copilot-${A}`, 'copilot'],
      [`copilot-${B}`, 'copilot'],
    ]);
    const log = readFileSync(paths(s.storeDir).observations, 'utf8');
    const second = await deposit(s.runtime, options(['copilot']));
    expect(second).toMatchObject({ sessions: 0, unchanged: 2 });
    expect(readFileSync(paths(s.storeDir).observations, 'utf8')).toBe(log);
    expect(trackedKeys(s.storeDir)).toEqual([`copilot/${A}`, `copilot/${B}`]);
  });

  it('reads a Copilot call by its own table and frames its session as Copilot, with the failed call an error', async () => {
    const s = staged();
    await deposit(s.runtime, options(['copilot']));
    const store = await loadStore(s.storeDir);
    const calls = store.tools.filter((tool) => tool.session === `copilot-${A}`);
    expect(calls.flatMap((tool) => tool.steps ?? [])[0]).toMatchObject({ action: 'shell.exec' });
    expect(calls.map((tool) => tool.status)).toEqual(['error']);
    const found = store.sessions.find((candidate) => candidate.session === `copilot-${A}`);
    expect(found).toMatchObject({ harness: 'copilot' });
    expect(found?.frame).toMatchObject({ harness: 'copilot' });
  });

  it('is read only when allowed, and an allowed name reports nothing missing while a typo does', async () => {
    const s = staged();
    await expect(deposit(s.runtime, options([]))).rejects.toThrow(/Nothing to read/);
    expect((await deposit(s.runtime, options(['copilot']))).missing).toEqual([]);
    expect((await deposit(s.runtime, options(['copilt']))).missing).toEqual(['copilt']);
  });

  it('holds every verify invariant, including --strict, for a normal session, one with no usage, and one ending in an assistant line', async () => {
    const s = staged();
    stageCopilot(s.root, [
      { id: C, lines: [start(C, '/x'), prompt(1, 'hi'), say(2, 'hello'), say(3, 'more')] },
      { id: D, lines: [...session(D, '/x'), say(8, 'aborted turn')] },
    ]);
    await deposit(s.runtime, options(['copilot']));
    const { skeletons } = await readSkeletons(s.storeDir);
    expect(skeletons).toHaveLength(4);
    const store = await loadStore(s.storeDir);
    expect([...verifyAll(skeletons), ...verifyCaptured(store.sessions, store.tools)].filter((result) => result.violations > 0)).toEqual([]);
  });

  it('skips silently when the runtime names no Copilot home or the home does not exist', async () => {
    const s = staged();
    expect(await deposit({ ...s.runtime, sourceRoots: {} }, options(['copilot']))).toMatchObject({ sessions: 0 });
    expect(await deposit({ ...s.runtime, sourceRoots: { copilot: join(s.root, 'nowhere') } }, options(['copilot']))).toMatchObject({ sessions: 0 });
  });

  it('fails open on an unreadable session: the good ones deposit, the Claude Code folder is kept, and the problem is named', async () => {
    const s = staged();
    const project = join(s.projectsRoot, 'mine');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'one.jsonl'), `${JSON.stringify({ type: 'user', timestamp: '2026-06-02T00:00:00Z', message: { role: 'user', content: 'hello' } })}\n`);
    // A folder where the events file should be makes the read throw.
    mkdirSync(join(s.home, 'session-state', C, 'events.jsonl'), { recursive: true });
    const result = await deposit(s.runtime, options(['mine', 'copilot']));
    expect(trackedKeys(s.storeDir)).toEqual(expect.arrayContaining(['mine/one.jsonl', `copilot/${A}`, `copilot/${B}`]));
    expect(result.sources.copilot?.unreadable.join('\n')).toContain(C);
  });

  it('names a wholly torn events file and leaves its cursor alone, so a fixed file is read next time', async () => {
    const s = staged();
    stageCopilot(s.root, [{ id: E, lines: '{torn\nnot json\n' }]);
    const result = await deposit(s.runtime, options(['copilot']));
    expect(result.sources.copilot?.unreadable.join('\n')).toContain(E);
    expect(trackedKeys(s.storeDir)).toEqual([`copilot/${A}`, `copilot/${B}`]);
    expect(result.sessions).toBe(2);
  });

  it('counts a torn line in the events file as a bad line, so the deposit line does not under-report', async () => {
    const s = staged();
    stageCopilot(s.root, [{ id: E, lines: `${JSON.stringify(start(E, '/x'))}\n{torn\n${JSON.stringify(prompt(2, 'hi'))}\n` }]);
    const result = await deposit(s.runtime, options(['copilot']));
    expect(result.badLines).toBe(1);
  });

  it('reads rotated events.N.jsonl archives in order with the live file as one session, once, and a second deposit adds nothing', async () => {
    const s = staged();
    const link = (previous: string) => event(T(20), 'session.journal_link', { previousFile: previous, sessionId: D, version: 1 });
    stageCopilot(s.root, [
      {
        id: D,
        archives: [
          { n: 2, lines: [link('events.1.jsonl'), start(D, '/work/d'), prompt(21, 'second prompt'), say(22, 'two', { outputTokens: 1 })] },
          { n: 10, lines: [link('events.2.jsonl'), prompt(30, 'third prompt'), say(31, 'three', { outputTokens: 1 })] },
          { n: 1, lines: [start(D, '/work/d'), prompt(10, 'first prompt'), say(11, 'one', { outputTokens: 1 })] },
        ],
        // The live head replays earlier state as checkpoint events (the same user.message as the archive holds, under a fresh id, so only the checkpoint flag drops it), then goes on.
        lines: [link('events.10.jsonl'), { ...prompt(30, 'third prompt'), id: 'replayed-30', checkpoint: true }, prompt(40, 'fourth prompt'), say(41, 'four', { outputTokens: 1 })],
      },
    ]);
    await deposit(s.runtime, options(['copilot']));
    const store = await loadStore(s.storeDir);
    expect(store.sessions.filter((entry) => entry.session.endsWith(D))).toHaveLength(1);
    expect(store.prompts.filter((entry) => entry.session === `copilot-${D}`)).toHaveLength(4);
    const log = readFileSync(paths(s.storeDir).observations, 'utf8');
    expect(await deposit(s.runtime, options(['copilot']))).toMatchObject({ sessions: 0, unchanged: 3 });
    expect(readFileSync(paths(s.storeDir).observations, 'utf8')).toBe(log);
    // A new archive is a change, so the session is read again.
    writeFileSync(join(s.home, 'session-state', D, 'events.11.jsonl'), `${JSON.stringify(prompt(35, 'late archive'))}
`);
    expect(await deposit(s.runtime, options(['copilot']))).toMatchObject({ sessions: 1 });
  });

  it('lets the nightly run repeat a saved allow, so it reads Copilot with no flag', async () => {
    const s = staged();
    await deposit(s.runtime, options(['copilot']));
    stageCopilot(s.root, [{ id: D, lines: session(D, '/x') }]);
    await runHook('nightly', '', s.runtime, () => NOW);
    expect(trackedKeys(s.storeDir)).toContain(`copilot/${D}`);
  });
});

describe('recall, books, and measure over Copilot skeletons', () => {
  it('measure counts Copilot sessions in its window as "of which Copilot"', async () => {
    const s = staged();
    await deposit(s.runtime, options(['copilot']));
    const signal = measure(await loadStore(s.storeDir), [], [], 5);
    expect(signal.last.sessions).toBe(2);
    expect(signal.last.otherSessions).toMatchObject({ copilot: 2 });
    expect(formatMeasure(signal)).toMatch(/of which Copilot\s+2\s/);
  });

  it('books --by harness separates copilot from claude-code', async () => {
    const s = staged();
    await deposit(s.runtime, options(['copilot']));
    const store = await loadStore(s.storeDir);
    const rows = books(store, 'harness', NOW);
    expect(rows.find((row) => row.key === 'copilot')?.prompts).toBe(2);
    expect(rows.reduce((total, row) => total + row.prompts, 0)).toBe(store.prompts.length);
  });

  it('recall finds the Copilot session by its error line', async () => {
    const s = staged();
    await deposit(s.runtime, options(['copilot']));
    const found = recall(await loadStore(s.storeDir), { error: 'No rule' }, NOW);
    expect(found.matches.map((match) => [match.tool, match.sessions])).toEqual([['Bash', 2]]);
  });
});
