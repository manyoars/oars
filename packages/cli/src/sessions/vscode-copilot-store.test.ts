import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { runHook } from './hooks.js';
import { books, formatMeasure, measure, recall } from './query.js';
import { harnessOf } from './schema.js';
import { deposit, loadStore, paths, readSkeletons } from './store.js';
import { verifyAll, verifyCaptured } from './verify.js';
import { cleanup, NOW, stage, stageVscode } from './test-support.js';

afterEach(cleanup);

// Fixtures follow microsoft/vscode @ f92b8f3adcd9bc034e6b9ade05c093dd59b99c5f (see vscode-copilot.test.ts for the source lines); no live VS Code store was read.
// Every folder here is a temp folder: the app-data base is `sourceRoots['vscode-copilot']`, so the real `%APPDATA%` is never read or written.

const A = 'aaaa1111-1111-4111-8111-111111111111';
const B = 'bbbb2222-2222-4222-8222-222222222222';
const C = 'cccc3333-3333-4333-8333-333333333333';
const D = 'dddd4444-4444-4444-8444-444444444444';
const E = 'eeee5555-5555-4555-8555-555555555555';

const T0 = Date.parse('2026-06-01T10:00:00Z');
const MS = (second: number): number => T0 + second * 1000;
const approved = { type: 4 };
const md = (value: string) => ({ value });
const turn = (second: number, text: string, response: readonly unknown[], extra: object = {}) => ({
  requestId: `request_${String(second)}`,
  message: { text, parts: [] },
  variableData: { variables: [] },
  response,
  timestamp: MS(second),
  responseTimestamp: MS(second + 1),
  modelId: 'copilot/claude-sonnet-4.5',
  ...extra,
});
// A failed shell call: the exit code says 2 (IChatTerminalToolInvocationData.terminalCommandState.exitCode, chatService.ts:803-807).
const failedShell = {
  kind: 'toolInvocationSerialized',
  toolId: 'run_in_terminal',
  toolCallId: 'c1',
  isConfirmed: approved,
  isComplete: true,
  toolSpecificData: { kind: 'terminal', commandLine: { original: 'make' }, terminalCommandOutput: { text: 'make: *** No rule to make target' }, terminalCommandState: { exitCode: 2 } },
};
const session = (id: string, extra: object = {}): object => ({
  version: 3,
  sessionId: id,
  creationDate: MS(0),
  requests: [turn(1, 'fix the build', [md('running it'), failedShell, md('it failed')], { completionTokens: 7, modelTotals: [{ model: 'claude-sonnet-4.5', inputTokens: 10, cachedTokens: 0, outputTokens: 7 }] })],
  ...extra,
});

const options = (allow: string[]) => ({ allow, redactDomains: [], now: () => NOW });

const staged = () => {
  const s = stage();
  const appData = stageVscode(s.root, [
    { id: A, data: session(A), hash: 'h1', workspace: { folder: pathToFileURL(join(s.root, 'not-a-repo')).href } },
    { id: B, log: [{ kind: 0, v: session(B) }], channel: 'Code - Insiders', hash: 'h2', workspace: { folder: pathToFileURL(join(s.root, 'other')).href } },
  ]);
  // The path the deposit will read, confirmed before the first write: a folder under this test's temp root, never the real store.
  expect(appData.startsWith(s.root)).toBe(true);
  return { ...s, appData, runtime: { ...s.runtime, sourceRoots: { 'vscode-copilot': appData } } };
};

const trackedKeys = (storeDir: string): string[] => {
  const state: unknown = JSON.parse(readFileSync(paths(storeDir).state, 'utf8'));
  const files = typeof state === 'object' && state !== null && 'files' in state ? state.files : {};
  return typeof files === 'object' && files !== null ? Object.keys(files).sort() : [];
};

describe('depositing the VS Code Copilot Chat source', () => {
  it('captures each session as a vscode-copilot session, from both file forms, with its own cursor, and a second deposit adds nothing', async () => {
    const s = staged();
    const first = await deposit(s.runtime, options(['vscode-copilot']));
    expect(first).toMatchObject({ sessions: 2, unchanged: 0, missing: [] });
    expect(first.sources['vscode-copilot']?.read).toBe(2);
    const store = await loadStore(s.storeDir);
    expect(store.sessions.map((entry) => [entry.session, harnessOf(entry)]).sort()).toEqual([
      [`vscode-copilot-${A}`, 'vscode-copilot'],
      [`vscode-copilot-${B}`, 'vscode-copilot'],
    ]);
    const log = readFileSync(paths(s.storeDir).observations, 'utf8');
    const second = await deposit(s.runtime, options(['vscode-copilot']));
    expect(second).toMatchObject({ sessions: 0, unchanged: 2 });
    expect(readFileSync(paths(s.storeDir).observations, 'utf8')).toBe(log);
    expect(trackedKeys(s.storeDir)).toEqual([`vscode-copilot/${A}`, `vscode-copilot/${B}`]);
  });

  it('reads a call by its own table and frames its session as VS Code Copilot Chat, with the failed shell call an error', async () => {
    const s = staged();
    await deposit(s.runtime, options(['vscode-copilot']));
    const store = await loadStore(s.storeDir);
    const calls = store.tools.filter((tool) => tool.session === `vscode-copilot-${A}`);
    expect(calls.flatMap((tool) => tool.steps ?? [])[0]).toMatchObject({ action: 'shell.exec' });
    expect(calls.map((tool) => tool.status)).toEqual(['error']);
    const found = store.sessions.find((candidate) => candidate.session === `vscode-copilot-${A}`);
    expect(found).toMatchObject({ harness: 'vscode-copilot' });
    expect(found?.frame).toMatchObject({ harness: 'vscode-copilot' });
  });

  it('is read by default and not when denied, and an allowed name reports nothing missing while a typo does', async () => {
    const s = staged();
    // With nothing named every source is read; a denial keeps this one out.
    expect((await deposit(s.runtime, options([]))).missing).toEqual([]);
    expect((await deposit(s.runtime, options(['!vscode-copilot']))).sources['vscode-copilot']).toBeUndefined();
    expect((await deposit(s.runtime, options(['vscode-copilot']))).missing).toEqual([]);
    expect((await deposit(s.runtime, options(['vscode-copilt']))).missing).toEqual(['vscode-copilt']);
  });

  it('holds every verify invariant, including --strict, for a normal session, one with no usage, an empty-window one, and one ending in an assistant line', async () => {
    const s = staged();
    stageVscode(s.root, [
      { id: C, data: { version: 3, sessionId: C, creationDate: MS(0), requests: [turn(1, 'hi', [md('hello')])] } },
      { id: D, data: session(D, { requests: [turn(1, 'go', [md('x')], { completionTokens: 3 }), turn(3, 'again', [md('one'), md('two')])] }), hash: 'h1' },
    ]);
    await deposit(s.runtime, options(['vscode-copilot']));
    const { skeletons } = await readSkeletons(s.storeDir);
    expect(skeletons).toHaveLength(4);
    const store = await loadStore(s.storeDir);
    expect([...verifyAll(skeletons), ...verifyCaptured(store.sessions, store.tools)].filter((result) => result.violations > 0)).toEqual([]);
  });

  it('skips silently when the runtime names no app-data folder or the folder holds no VS Code build', async () => {
    const s = staged();
    expect(await deposit({ ...s.runtime, sourceRoots: {} }, options(['vscode-copilot']))).toMatchObject({ sessions: 0 });
    expect(await deposit({ ...s.runtime, sourceRoots: { 'vscode-copilot': join(s.root, 'nowhere') } }, options(['vscode-copilot']))).toMatchObject({ sessions: 0 });
  });

  it('fails open on an unreadable session: the good ones deposit, the Claude Code folder is kept, and the problem is named', async () => {
    const s = staged();
    const project = join(s.projectsRoot, 'mine');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'one.jsonl'), `${JSON.stringify({ type: 'user', timestamp: '2026-06-02T00:00:00Z', message: { role: 'user', content: 'hello' } })}\n`);
    // A chat file that is a torn write makes the read throw.
    stageVscode(s.root, [{ id: C, data: '{torn' }]);
    const result = await deposit(s.runtime, options(['mine', 'vscode-copilot']));
    expect(trackedKeys(s.storeDir)).toEqual(expect.arrayContaining(['mine/one.jsonl', `vscode-copilot/${A}`, `vscode-copilot/${B}`]));
    expect(result.sources['vscode-copilot']?.unreadable.join('\n')).toContain(C);
  });

  it('names a wholly torn chat file and leaves its cursor alone, so a fixed file is read next time', async () => {
    const s = staged();
    stageVscode(s.root, [{ id: E, data: '{torn' }]);
    const result = await deposit(s.runtime, options(['vscode-copilot']));
    expect(result.sources['vscode-copilot']?.unreadable.join('\n')).toContain(E);
    expect(trackedKeys(s.storeDir)).toEqual([`vscode-copilot/${A}`, `vscode-copilot/${B}`]);
    expect(result.sessions).toBe(2);
  });

  it('counts a torn line in a log file as a bad line, so the deposit line does not under-report', async () => {
    const s = staged();
    stageVscode(s.root, [{ id: E, log: `${JSON.stringify({ kind: 0, v: session(E) })}\n{torn\n` }]);
    const result = await deposit(s.runtime, options(['vscode-copilot']));
    expect(result.badLines).toBe(1);
  });

  it('lets the nightly run repeat a saved allow, so it reads VS Code Copilot Chat with no flag', async () => {
    const s = staged();
    await deposit(s.runtime, options(['vscode-copilot']));
    stageVscode(s.root, [{ id: D, data: session(D), hash: 'h1' }]);
    await runHook('nightly', '', s.runtime, () => NOW);
    expect(trackedKeys(s.storeDir)).toContain(`vscode-copilot/${D}`);
  });
});

describe('recall, books, and measure over VS Code Copilot Chat skeletons', () => {
  it('measure counts its sessions in its window as "of which VS Code Copilot Chat"', async () => {
    const s = staged();
    await deposit(s.runtime, options(['vscode-copilot']));
    const signal = measure(await loadStore(s.storeDir), [], [], 5);
    expect(signal.last.sessions).toBe(2);
    expect(signal.last.otherSessions).toMatchObject({ 'vscode-copilot': 2 });
    expect(formatMeasure(signal)).toMatch(/of which VS Code Copilot Chat\s+2\s/);
  });

  it('books --by harness separates vscode-copilot from claude-code', async () => {
    const s = staged();
    await deposit(s.runtime, options(['vscode-copilot']));
    const store = await loadStore(s.storeDir);
    const rows = books(store, 'harness', NOW);
    expect(rows.find((row) => row.key === 'vscode-copilot')?.prompts).toBe(2);
    expect(rows.reduce((total, row) => total + row.prompts, 0)).toBe(store.prompts.length);
  });

  it('recall finds the session by its error line', async () => {
    const s = staged();
    await deposit(s.runtime, options(['vscode-copilot']));
    const found = recall(await loadStore(s.storeDir), { error: 'No rule' }, NOW);
    expect(found.matches.map((match) => [match.tool, match.sessions])).toEqual([['Bash', 2]]);
  });
});
