import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runHook } from './hooks.js';
import { books, formatMeasure, measure, recall } from './query.js';
import { harnessOf } from './schema.js';
import { SOURCES, type Source } from './sources.js';
import { deposit, loadStore, paths, readSkeletons } from './store.js';
import { verifyAll, verifyCaptured } from './verify.js';
import { cleanup, NOW, piEntry, piHeader, stage, stagePi } from './test-support.js';

afterEach(cleanup);

// Fixtures follow badlogic/pi-mono @ 085c84e (see pi.test.ts); no live Pi store was read. Every agent folder below is under the test's own temp folder (`stagePi` puts
// it under `root`, and the runtime's `sourceRoots` names it), so the real `~/.pi/agent` is never touched.

const A = 'aaaa1111-1111-4111-8111-111111111111';
const B = 'bbbb2222-2222-4222-8222-222222222222';
const C = 'cccc3333-3333-4333-8333-333333333333';
const D = 'dddd4444-4444-4444-8444-444444444444';
const E = 'eeee5555-5555-4555-8555-555555555555';

const BASE = Date.parse('2026-06-01T10:00:00Z');
const at = (second: number): string => new Date(BASE + second * 1000).toISOString();
const user = (id: string, parent: string | null, second: number, text: string) => piEntry('message', id, parent, at(second), { message: { role: 'user', content: text, timestamp: BASE + second * 1000 } });
const assistant = (id: string, parent: string, second: number, content: object[], extra: object = {}) =>
  piEntry('message', id, parent, at(second), {
    message: { role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', usage: { input: 10, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 17, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: BASE + second * 1000, ...extra },
  });
// A failed shell call: a non-zero exit is an error result whose text ends with the code (tools/bash.ts:434-440).
const failedShell = (header: object): unknown[] => [
  header,
  user('e1', null, 1, 'fix the build'),
  assistant('e2', 'e1', 2, [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'make' } }], { stopReason: 'toolUse' }),
  piEntry('message', 'e3', 'e2', at(3), { message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'make: *** No rule to make target\n\nCommand exited with code 2' }], isError: true, timestamp: BASE + 3000 } }),
  assistant('e4', 'e3', 5, [{ type: 'text', text: 'it failed' }]),
];
const session = (id: string, cwd: string): unknown[] => failedShell(piHeader({ id, cwd }));

const options = (allow: string[]) => ({ allow, redactDomains: [], now: () => NOW });

const staged = () => {
  const s = stage();
  const home = stagePi(s.root, [
    { id: A, cwd: join(s.root, 'not-a-repo'), lines: session(A, join(s.root, 'not-a-repo')) },
    { id: B, cwd: join(s.root, 'other'), lines: session(B, join(s.root, 'other')) },
  ]);
  expect(home.startsWith(s.root)).toBe(true);
  return { ...s, home, runtime: { ...s.runtime, sourceRoots: { pi: home } } };
};

const fileOf = (home: string, cwd: string, id: string): string => join(home, 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`, `2026-06-01T10-00-00-000Z_${id}.jsonl`);

const trackedKeys = (storeDir: string): string[] => {
  const state: unknown = JSON.parse(readFileSync(paths(storeDir).state, 'utf8'));
  const files = typeof state === 'object' && state !== null && 'files' in state ? state.files : {};
  return typeof files === 'object' && files !== null ? Object.keys(files).sort() : [];
};

const claudeCodeProject = (projectsRoot: string): void => {
  const project = join(projectsRoot, 'mine');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'one.jsonl'), `${JSON.stringify({ type: 'user', timestamp: '2026-06-02T00:00:00Z', message: { role: 'user', content: 'hello' } })}\n`);
};

describe('depositing the Pi source', () => {
  it('captures each session as a pi-harness session, with its own cursor, and a second deposit adds nothing', async () => {
    const s = staged();
    const first = await deposit(s.runtime, options(['pi']));
    expect(first).toMatchObject({ sessions: 2, unchanged: 0, missing: [] });
    expect(first.sources.pi?.read).toBe(2);
    const store = await loadStore(s.storeDir);
    expect(store.sessions.map((entry) => [entry.session, harnessOf(entry)]).sort()).toEqual([
      [`pi-${A}`, 'pi'],
      [`pi-${B}`, 'pi'],
    ]);
    const log = readFileSync(paths(s.storeDir).observations, 'utf8');
    const second = await deposit(s.runtime, options(['pi']));
    expect(second).toMatchObject({ sessions: 0, unchanged: 2 });
    expect(readFileSync(paths(s.storeDir).observations, 'utf8')).toBe(log);
    expect(trackedKeys(s.storeDir)).toEqual([`pi/${A}`, `pi/${B}`]);
  });

  it('reads a Pi call by its own table and frames its session as Pi, with the failed call an error', async () => {
    const s = staged();
    await deposit(s.runtime, options(['pi']));
    const store = await loadStore(s.storeDir);
    const calls = store.tools.filter((tool) => tool.session === `pi-${A}`);
    expect(calls.flatMap((tool) => tool.steps ?? [])[0]).toMatchObject({ action: 'shell.exec' });
    expect(calls.map((tool) => tool.status)).toEqual(['error']);
    const found = store.sessions.find((candidate) => candidate.session === `pi-${A}`);
    expect(found).toMatchObject({ harness: 'pi' });
    expect(found?.frame).toMatchObject({ harness: 'pi' });
  });

  it('is read by default and not when denied, and an allowed name reports nothing missing while a typo does', async () => {
    const s = staged();
    // With nothing named every source is read; a denial keeps this one out.
    expect((await deposit(s.runtime, options([]))).missing).toEqual([]);
    expect((await deposit(s.runtime, options(['!pi']))).sources['pi']).toBeUndefined();
    expect((await deposit(s.runtime, options(['pi']))).missing).toEqual([]);
    expect((await deposit(s.runtime, options(['p1']))).missing).toEqual(['p1']);
  });

  it('does not read a discovered Pi store that is not allowed: another allowed source reads, pi stays unread and untracked', async () => {
    const s = staged();
    claudeCodeProject(s.projectsRoot);
    const result = await deposit(s.runtime, options(['mine']));
    expect(result.sources.pi).toBeUndefined();
    expect(trackedKeys(s.storeDir)).toEqual(['mine/one.jsonl']);
  });

  it('changes nothing in the Pi folder: a deposit only reads', async () => {
    const s = staged();
    const file = fileOf(s.home, join(s.root, 'other'), B);
    const before = readFileSync(file, 'utf8');
    await deposit(s.runtime, options(['pi']));
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('holds every verify invariant, including --strict, for a normal session, one with no usage, and one ending in an assistant line', async () => {
    const s = staged();
    stagePi(s.root, [
      { id: C, cwd: '/x', lines: [piHeader({ id: C, cwd: '/x' }), user('e1', null, 1, 'hi'), assistant('e2', 'e1', 2, [{ type: 'text', text: 'hello' }], { usage: undefined }), user('e3', 'e2', 3, 'again'), assistant('e4', 'e3', 4, [{ type: 'text', text: 'more' }])] },
      { id: D, cwd: '/x', lines: [...session(D, '/x'), assistant('e5', 'e4', 8, [{ type: 'text', text: 'aborted turn' }], { stopReason: 'aborted' })] },
    ]);
    await deposit(s.runtime, options(['pi']));
    const { skeletons } = await readSkeletons(s.storeDir);
    expect(skeletons).toHaveLength(4);
    const store = await loadStore(s.storeDir);
    expect([...verifyAll(skeletons), ...verifyCaptured(store.sessions, store.tools)].filter((result) => result.violations > 0)).toEqual([]);
  });

  it('holds every verify invariant, including --strict, for a session that opens with the operator’s own !cmd before any prompt', async () => {
    const s = staged();
    const bang = piEntry('message', 'e1', null, at(1), { message: { role: 'bashExecution', command: 'git status', output: 'fatal: not a git repository', exitCode: 1, cancelled: false, truncated: false, timestamp: BASE + 1000 } });
    stagePi(s.root, [{ id: C, cwd: '/x', lines: [piHeader({ id: C, cwd: '/x' }), bang, user('e2', 'e1', 2, 'hi'), assistant('e3', 'e2', 3, [{ type: 'text', text: 'hello' }])] }]);
    await deposit(s.runtime, options(['pi']));
    const { skeletons } = await readSkeletons(s.storeDir);
    const store = await loadStore(s.storeDir);
    expect(store.tools.map((tool) => [tool.tool, tool.status])).toContainEqual(['Bash', 'error']);
    expect([...verifyAll(skeletons), ...verifyCaptured(store.sessions, store.tools)].filter((result) => result.violations > 0)).toEqual([]);
  });

  it('skips silently when the runtime names no Pi folder or the folder does not exist', async () => {
    const s = staged();
    expect(await deposit({ ...s.runtime, sourceRoots: {} }, options(['pi']))).toMatchObject({ sessions: 0 });
    expect(await deposit({ ...s.runtime, sourceRoots: { pi: join(s.root, 'nowhere') } }, options(['pi']))).toMatchObject({ sessions: 0 });
  });

  it('fails open on a session whose file cannot be read: the good ones deposit, the Claude Code folder is kept, and the file is named', async () => {
    const s = staged();
    claudeCodeProject(s.projectsRoot);
    stagePi(s.root, [{ id: C, cwd: '/x', lines: session(C, '/x') }]);
    // A file that lists (its header reads) and then fails to read in full: the table's own entry with one transcript that throws, as a disk error would.
    const flaky = (source: Source): Source => ({
      ...source,
      open: async (root) => {
        const store = await source.open(root);
        return store === undefined ? undefined : { ...store, transcript: (found) => (found.id === C ? Promise.reject(new Error('EIO: i/o error')) : Promise.resolve(store.transcript(found))) };
      },
    });
    const result = await deposit({ ...s.runtime, sources: SOURCES.map((source) => (source.name === 'pi' ? flaky(source) : source)) }, options(['mine', 'pi']));
    expect(trackedKeys(s.storeDir)).toEqual(expect.arrayContaining(['mine/one.jsonl', `pi/${A}`, `pi/${B}`]));
    expect(trackedKeys(s.storeDir)).not.toContain(`pi/${C}`);
    expect(result.sources.pi?.unreadable.join('\n')).toContain(C);
  });

  it('names a file with no header and one wholly torn, leaves their cursors alone, and reads the rest', async () => {
    const s = staged();
    stagePi(s.root, [
      { id: E, cwd: '/x', lines: '{torn\nnot json\n' },
      { id: D, cwd: '/x', lines: `${JSON.stringify(user('e1', null, 1, 'no header here'))}\n` },
    ]);
    const result = await deposit(s.runtime, options(['pi']));
    expect(result.sources.pi?.unreadable.join('\n')).toContain(E);
    expect(result.sources.pi?.unreadable.join('\n')).toContain(D);
    expect(trackedKeys(s.storeDir)).toEqual([`pi/${A}`, `pi/${B}`]);
    expect(result.sessions).toBe(2);
  });

  it('counts a torn line in a session as a bad line, so the deposit line does not under-report', async () => {
    const s = staged();
    stagePi(s.root, [{ id: E, cwd: '/x', lines: `${JSON.stringify(piHeader({ id: E, cwd: '/x' }))}\n${JSON.stringify(user('e1', null, 1, 'hi'))}\n{torn\n${JSON.stringify(assistant('e2', 'e1', 2, [{ type: 'text', text: 'ok' }]))}\n` }]);
    const result = await deposit(s.runtime, options(['pi']));
    expect(result.badLines).toBe(1);
  });

  it('lets the nightly run repeat a saved allow, so it reads Pi with no flag', async () => {
    const s = staged();
    await deposit(s.runtime, options(['pi']));
    stagePi(s.root, [{ id: D, cwd: '/x', lines: session(D, '/x') }]);
    await runHook('nightly', '', s.runtime, () => NOW);
    expect(trackedKeys(s.storeDir)).toContain(`pi/${D}`);
  });

  it('reads a session again when its file grows, as a resume appends to the same file', async () => {
    const s = staged();
    await deposit(s.runtime, options(['pi']));
    const file = fileOf(s.home, join(s.root, 'other'), B);
    writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify(user('e9', 'e4', 20, 'one more'))}\n`);
    expect(await deposit(s.runtime, options(['pi']))).toMatchObject({ sessions: 1, unchanged: 1 });
  });

  it('keeps a fork apart from its parent: the copied path is not counted twice', async () => {
    const s = staged();
    const forkHeader = piHeader({ id: E, cwd: '/x', timestamp: at(100), parentSession: fileOf(s.home, join(s.root, 'other'), B) });
    stagePi(s.root, [{ id: E, cwd: '/x', lines: [forkHeader, ...failedShell(forkHeader).slice(1), user('e5', 'e4', 101, 'its own prompt'), assistant('e6', 'e5', 102, [{ type: 'text', text: 'its own reply' }])] }]);
    await deposit(s.runtime, options(['pi']));
    const store = await loadStore(s.storeDir);
    const fork = store.sessions.find((candidate) => candidate.session === `pi-${E}`);
    expect(fork?.userTurns).toBe(1);
    expect(store.tools.filter((tool) => tool.session === `pi-${E}`)).toEqual([]);
  });
});

describe('recall, books, and measure over Pi skeletons', () => {
  it('measure counts Pi sessions in its window as "of which Pi"', async () => {
    const s = staged();
    await deposit(s.runtime, options(['pi']));
    const signal = measure(await loadStore(s.storeDir), [], [], 5);
    expect(signal.last.sessions).toBe(2);
    expect(signal.last.otherSessions).toMatchObject({ pi: 2 });
    expect(formatMeasure(signal)).toMatch(/of which Pi\s+2\s/);
  });

  it('books --by harness separates pi from claude-code', async () => {
    const s = staged();
    await deposit(s.runtime, options(['pi']));
    const store = await loadStore(s.storeDir);
    const rows = books(store, 'harness', NOW);
    expect(rows.find((row) => row.key === 'pi')?.prompts).toBe(2);
    expect(rows.reduce((total, row) => total + row.prompts, 0)).toBe(store.prompts.length);
  });

  it('recall finds the Pi session by its error line', async () => {
    const s = staged();
    await deposit(s.runtime, options(['pi']));
    const found = recall(await loadStore(s.storeDir), { error: 'No rule' }, NOW);
    expect(found.matches.map((match) => [match.tool, match.sessions])).toEqual([['Bash', 2]]);
  });
});
