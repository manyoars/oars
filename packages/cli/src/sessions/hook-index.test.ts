import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { slugOf } from './allow.js';
import { CAPTURE_VERSION, type ErrorObservation, type SessionObservation } from './schema.js';
import { buildIndex, contextBlock, inRepository, readIndex, repositoryRoot } from './hook-index.js';
import { sessionsBooks, sessionsMeasure } from './command.js';
import { readHookCalls } from './hook-calls.js';
import { tool as toolRow } from './pool-fixture.js';
import { toolShapeId } from './recall-reads.js';
import { books, BOOKS_CAVEAT, formatBooks, formatMeasure, measure } from './query.js';
import { formatStepCounters, readSteps, stepCounters } from './steps.js';
import { deposit, loadStore, paths, readCalls } from './store.js';
import { addProject, cleanup, FIXTURES, NOW, stage } from './test-support.js';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

afterEach(() => {
  cleanup();
  removeTestDirs();
});

const REPO = join('work', 'app');

const setup = () => {
  const staged = stage(slugOf(REPO));
  const h = harness();
  h.deps.sessions = staged.runtime;
  return { ...h, staged };
};

const base = (project: string, name: string, day: number): SessionObservation => ({
  kind: 'session', cv: '1', sid: null, session: name, project, parent: null, agentType: null, spawnedBy: null, spawnedIn: null, rev: 1, at: '', bytes: 0, lines: 0, badLines: 0, userTurns: 0, assistantTurns: 0,
  tsFirst: new Date(Date.UTC(2026, 0, 1) + day * 86_400_000).toISOString(), tsLast: null, versions: [], models: {}, branches: [], tools: {}, files: [], fileHashes: [], repo: null, urls: [], searches: [],
  bashCmds: 0, tldrs: [], confidences: [], compactSummaries: 0, promptFingerprint: null, env: { harness: null, oars: '0.0.0', node: 'v0', os: 'test' }, costUsd: null, usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 },
});
const failure = (name: string, sig: string): ErrorObservation => ({
  kind: 'error', v: '1', session: name, rev: 1, ts: null, harnessVersion: null, tool: 'Bash', sig, example: sig, next: ['Read'], editFollowed: false, prompt: null, cls: null,
});

describe('repositoryRoot', () => {
  it('maps a worktree path to its repository and leaves other paths alone', () => {
    expect(repositoryRoot('/home/me/app/.claude/worktrees/t1')).toBe('/home/me/app');
    expect(repositoryRoot(String.raw`C:\work\app\.claude\worktrees\t1\src`)).toBe(String.raw`C:\work\app`);
    expect(repositoryRoot('/home/me/app/src')).toBe('/home/me/app/src');
  });
});

describe('hook index and context block', () => {
  it('writes the index at deposit and names the recurring bash-quoting error for the repository', async () => {
    const { deps, staged } = setup();
    await run(['sessions', 'deposit', '--allow', REPO], deps);
    const index = await readIndex(staged.storeDir);
    expect(index?.projects[slugOf(REPO)]?.length).toBeGreaterThan(0);
    const block = contextBlock(index ?? buildIndex({ sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0 }, [], ''), { cwd: REPO, top: 5, maxChars: 1200 });
    expect(block).toContain('unexpected EOF while looking for matching');
    expect(block).toContain('2 sessions');
    expect(block?.length).toBeLessThan(1200);
  });

  it('is under the length limit by dropping whole lines, and says nothing for a repository with no history', async () => {
    const { deps, staged } = setup();
    await run(['sessions', 'deposit', '--allow', REPO], deps);
    const index = await readIndex(staged.storeDir);
    if (index === undefined) throw new Error('no index');
    const tight = contextBlock(index, { cwd: REPO, top: 5, maxChars: 40 });
    expect(tight).toBeUndefined();
    const trimmed = contextBlock(index, { cwd: REPO, top: 5, maxChars: 260 });
    expect((trimmed ?? '').length).toBeLessThanOrEqual(260);
    expect(contextBlock(index, { cwd: join('elsewhere', 'other'), top: 5, maxChars: 1200 })).toBeUndefined();
    expect(contextBlock(index, { cwd: REPO, harness: '0.0.0-none', top: 5, maxChars: 1200 })).toBeUndefined();
  });

  it('a worktree session sees its repository, and the harness filter keeps only matching versions', async () => {
    const { deps, staged } = setup();
    await run(['sessions', 'deposit', '--allow', REPO], deps);
    const index = await readIndex(staged.storeDir);
    if (index === undefined) throw new Error('no index');
    const worktree = join(REPO, '.claude', 'worktrees', 't1');
    expect(contextBlock(index, { cwd: worktree, top: 5, maxChars: 1200 })).toContain('oars recall');
    const version = Object.values(index.projects).flat().flatMap((row) => row.harness)[0];
    if (version !== undefined) expect(contextBlock(index, { cwd: REPO, harness: version, top: 5, maxChars: 1200 })).toContain(`Claude Code ${version}`);
  });

  const followed = (tool: string, count: number): [string, number][] => [[tool, count]];

  it('merges the sessions of the root and its worktree project folders', () => {
    const row = { sig: 'Bash | boom', sessions: 2, recent: 2, followed: followed('Edit', 3), harness: [] };
    const other = { sig: 'Bash | boom', sessions: 3, recent: 3, followed: followed('Bash', 1), harness: [] };
    const index = { at: '', redactDomains: [], signatures: {}, projects: { [slugOf(REPO)]: [row], [`${slugOf(REPO)}--claude-worktrees-t1`]: [other], 'unrelated-app': [row] } };
    const block = contextBlock(index, { cwd: REPO, top: 5, maxChars: 1200 });
    expect(block).toContain('(5 sessions in the last 300; next: Edit, Bash)');
  });

  it('recall --context prints the block and --json carries it', async () => {
    const { deps, out } = setup();
    await run(['sessions', 'deposit', '--allow', REPO], deps);
    out.length = 0;
    expect(await run(['sessions', 'recall', '--context', '--cwd', REPO], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('unexpected EOF');
    out.length = 0;
    expect(await run(['--json', 'sessions', 'recall', '--context', '--cwd', REPO, '--top', '1', '--max-chars', '500'], deps)).toBe(ExitCode.OK);
    expect(typeof Reflect.get(JSON.parse(out.join('')), 'context')).toBe('string');
    out.length = 0;
    expect(await run(['sessions', 'recall', '--context', '--cwd', join('elsewhere', 'x')], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('Nothing recurs');
  });

  it('builds the block from the store when no index file exists, and treats a torn index as none', async () => {
    const { deps, out, staged } = setup();
    await run(['sessions', 'deposit', '--allow', REPO], deps);
    writeFileSync(join(staged.storeDir, 'hook-index.json'), '{"at": ');
    expect(await readIndex(staged.storeDir)).toBeUndefined();
    out.length = 0;
    expect(await run(['sessions', 'recall', '--context', '--cwd', REPO], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('unexpected EOF');
    expect((await loadStore(staged.storeDir)).errors.length).toBeGreaterThan(0);
  });
});

describe('recency ranking', () => {
  it('ranks by sessions within the last 300, so an old high-count signature falls below a recent one', () => {
    const sessions: SessionObservation[] = [];
    const errors: ErrorObservation[] = [];
    // 40 old sessions all hit "stale error"; 300 later sessions, 3 of them hit "fresh error". 40 > 3 over the whole store, 0 < 3 in the window.
    for (let day = 0; day < 40; day += 1) {
      sessions.push(base(slugOf(REPO), `old-${String(day)}`, day));
      errors.push(failure(`old-${String(day)}`, 'Bash | stale error'));
    }
    for (let day = 0; day < 300; day += 1) {
      sessions.push(base(slugOf(REPO), `new-${String(day)}`, 100 + day));
      if (day % 100 === 0) errors.push(failure(`new-${String(day)}`, 'Bash | fresh error'));
    }
    const block = contextBlock(buildIndex({ sessions, prompts: [], errors, subagents: [], tools: [], newerCaptures: 0 }, [], ''), { cwd: REPO, top: 5, maxChars: 1200 }) ?? '';
    expect(block).toContain('fresh error (3 sessions in the last 300');
    expect(block).not.toContain('stale error');
  });
});

describe('per-repository scope', () => {
  // Absolute roots outside any worktree: the test checkout itself sits in one, and `--repo` resolves its argument before stripping the marker.
  const HOME = resolve('/zz/app');
  const OTHER = resolve('/zz/other');

  it('measure --repo counts only that repository, and its absence leaves the whole-store output unchanged', async () => {
    const staged = stage(slugOf(HOME));
    // A second repository, deposited from the same transcript lines under another session name.
    const lines = readFileSync(join(staged.projectsRoot, slugOf(HOME), 'errors-a.jsonl'), 'utf8').split('\n').filter((line) => line !== '');
    addProject(staged, slugOf(OTHER), 'other-session', lines);
    await deposit(staged.runtime, { allow: [slugOf(HOME), slugOf(OTHER)], redactDomains: [], now: () => NOW });
    const store = await loadStore(staged.storeDir);
    const own = store.sessions.filter((session) => session.project === slugOf(HOME)).length;
    expect(own).toBeGreaterThan(0);
    expect(store.sessions.length).toBe(own + 1);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const all = await sessionsMeasure(deps, { last: 300, since: undefined });
    const scoped = await sessionsMeasure(deps, { last: 300, since: undefined, repo: HOME });
    const worktree = await sessionsMeasure(deps, { last: 300, since: undefined, repo: join(HOME, '.claude', 'worktrees', 't1') });
    expect(all.document).toMatchObject({ last: { sessions: own + 1 } });
    expect(scoped.document).toMatchObject({ last: { sessions: own } });
    expect(worktree.document).toEqual(scoped.document);
    // A path whose worktree marker only shows once it is resolved (`..`, `.`) still names the repository.
    const relative = await sessionsMeasure(deps, { last: 300, since: undefined, repo: `${HOME}/.claude/wt/../worktrees/t1` });
    expect(relative.document).toEqual(scoped.document);
    // The command line passes the flag through.
    const cli = harness();
    cli.deps.sessions = staged.runtime;
    expect(await run(['--json', 'sessions', 'measure', '--last', '300', '--repo', HOME], cli.deps)).toBe(ExitCode.OK);
    expect(JSON.parse(cli.out.join(''))).toMatchObject({ last: { sessions: own } });
    // No flag: the same output as the store's own `measure`.
    // The G1 table is the unchanged whole-store output; the step counters follow it (all-time, never repository-scoped).
    expect(all.text).toBe(`${formatMeasure(measure(store, await readCalls(staged.storeDir), await readHookCalls(staged.storeDir), 300))}
${formatStepCounters(stepCounters(await readSteps(staged.storeDir)))}`);
  });

  it('books --repo books only that repository, whole rows and its worktrees included, and its absence leaves the whole-store output unchanged', async () => {
    const staged = stage(slugOf(HOME));
    const lines = readFileSync(join(staged.projectsRoot, slugOf(HOME), 'errors-a.jsonl'), 'utf8').split('\n').filter((line) => line !== '');
    const worktree = `${slugOf(HOME)}--claude-worktrees-t1`;
    addProject(staged, slugOf(OTHER), 'other-session', lines);
    addProject(staged, worktree, 'wt-session', lines);
    // A subagent under each session spawned by its `t1` call, so tokens delegated, turns, and cache read all differ by repository.
    for (const [project, session] of [[slugOf(HOME), 'errors-a'], [slugOf(OTHER), 'other-session'], [worktree, 'wt-session']] as const) {
      const folder = join(staged.projectsRoot, project, session, 'subagents');
      mkdirSync(folder, { recursive: true });
      copyFileSync(join(FIXTURES, 'proj', 'sidechain.jsonl'), join(folder, 'agent-x.jsonl'));
      writeFileSync(join(folder, 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 't1' }));
    }
    await deposit(staged.runtime, { allow: [slugOf(HOME), slugOf(OTHER), worktree], redactDomains: [], now: () => NOW });
    const store = await loadStore(staged.storeDir);
    const call = async (...extra: string[]): Promise<unknown> => {
      const cli = harness();
      cli.deps.sessions = staged.runtime;
      expect(await run(['--json', 'sessions', 'books', '--by', 'class', ...extra], cli.deps)).toBe(ExitCode.OK);
      return Reflect.get(JSON.parse(cli.out.join('')), 'rows');
    };
    // The books over the sessions a repository test keeps: its prompts, with every other record left whole.
    const ownBooks = (keep: (project: string) => boolean): ReturnType<typeof books> => {
      const mains = new Set(store.sessions.filter((session) => keep(session.project)).map((session) => session.session));
      return books({ ...store, prompts: store.prompts.filter((prompt) => mains.has(prompt.session)) }, 'class', NOW);
    };
    const delegated = (rows: ReturnType<typeof books>): number => rows.reduce((total, row) => total + row.delegated, 0);
    const mine = ownBooks((project) => inRepository(project, HOME));
    expect(delegated(mine)).toBeGreaterThan(0);
    // The worktree's session counts for the root, so the root books more than its root folder alone.
    expect(mine).not.toEqual(ownBooks((project) => project === slugOf(HOME)));
    expect(await call('--repo', HOME)).toEqual(mine);
    // A worktree path names its repository.
    expect(await call('--repo', join(HOME, '.claude', 'worktrees', 't1'))).toEqual(mine);
    expect(await call('--repo', OTHER)).toEqual(ownBooks((project) => project === slugOf(OTHER)));
    expect(await call()).toEqual(books(store, 'class', NOW));
    const plain = harness();
    plain.deps.sessions = staged.runtime;
    expect(await run(['sessions', 'books', '--by', 'class'], plain.deps)).toBe(ExitCode.OK);
    expect(plain.out.join('')).toBe(`${formatBooks(books(store, 'class', NOW), 'class')}\n${BOOKS_CAVEAT}\n`);
  });

  it("books --repo counts only its own repository's newer captures, sessions and subagents alike", async () => {
    const staged = stage(slugOf(HOME));
    const lines = readFileSync(join(staged.projectsRoot, slugOf(HOME), 'errors-a.jsonl'), 'utf8').split('\n').filter((line) => line !== '');
    addProject(staged, slugOf(OTHER), 'other-session', lines);
    const folder = join(staged.projectsRoot, slugOf(OTHER), 'other-session', 'subagents');
    mkdirSync(folder, { recursive: true });
    copyFileSync(join(FIXTURES, 'proj', 'sidechain.jsonl'), join(folder, 'agent-x.jsonl'));
    writeFileSync(join(folder, 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 't1' }));
    await deposit(staged.runtime, { allow: [slugOf(HOME), slugOf(OTHER)], redactDomains: [], now: () => NOW });
    // A newer oars wrote the other repository's session and its subagent.
    const file = paths(staged.storeDir).observations;
    const marked = readFileSync(file, 'utf8').split('\n').filter((entry) => entry !== '').map((entry) => (entry.includes('"session":"other-session') ? entry.replace(`"cv":"${CAPTURE_VERSION}"`, `"cv":"${String(Number(CAPTURE_VERSION) + 1)}"`) : entry));
    writeFileSync(file, `${marked.join('\n')}\n`);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const newer = async (repo?: string): Promise<unknown> => (await sessionsBooks(deps, { by: 'class', sinceDays: undefined, repo })).document;
    expect(await newer()).toMatchObject({ newerCaptures: 2 });
    expect(await newer(OTHER)).toMatchObject({ newerCaptures: 2 });
    const mine = await sessionsBooks(deps, { by: 'class', sinceDays: undefined, repo: HOME });
    expect(mine.document).toMatchObject({ newerCaptures: 0 });
    expect(mine.text).not.toContain('captured by a newer oars');
  });

  it("books --repo keeps a subagent by its own project even when its parent's session record is absent", async () => {
    const staged = stage(slugOf(HOME));
    const lines = readFileSync(join(staged.projectsRoot, slugOf(HOME), 'errors-a.jsonl'), 'utf8').split('\n').filter((line) => line !== '');
    addProject(staged, slugOf(OTHER), 'other-session', lines);
    const folder = join(staged.projectsRoot, slugOf(OTHER), 'other-session', 'subagents');
    mkdirSync(folder, { recursive: true });
    copyFileSync(join(FIXTURES, 'proj', 'sidechain.jsonl'), join(folder, 'agent-x.jsonl'));
    writeFileSync(join(folder, 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 't1' }));
    await deposit(staged.runtime, { allow: [slugOf(HOME), slugOf(OTHER)], redactDomains: [], now: () => NOW });
    const file = paths(staged.storeDir).observations;
    const rewritten = readFileSync(file, 'utf8')
      .split('\n')
      .filter((entry) => entry !== '')
      // The parent's main session record is gone; the subagent's remains, one version newer.
      .filter((entry) => !(entry.includes('"kind":"session"') && entry.includes('"session":"other-session"') && entry.includes('"parent":null')))
      .map((entry) => entry.replace(`"cv":"${CAPTURE_VERSION}"`, `"cv":"${String(Number(CAPTURE_VERSION) + 1)}"`));
    writeFileSync(file, `${rewritten.join('\n')}\n`);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const other = await sessionsBooks(deps, { by: 'class', sinceDays: undefined, repo: OTHER });
    expect(other.document).toMatchObject({ newerCaptures: 1 });
  });

  it('books --repo over a mistyped root names the root and the store prompt count, not an empty store', async () => {
    const staged = stage(slugOf(HOME));
    await deposit(staged.runtime, { allow: [slugOf(HOME)], redactDomains: [], now: () => NOW });
    const store = await loadStore(staged.storeDir);
    expect(store.prompts.length).toBeGreaterThan(0);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const none = resolve('/zz/none');
    const { text } = await sessionsBooks(deps, { by: 'class', sinceDays: undefined, repo: none });
    expect(text).toContain(`No prompts for ${none} in the store (${String(store.prompts.length)} prompts across all repositories).`);
    expect(text).not.toBe('No prompts in the store.');
  });

  it('books --by pull --repo tells a kept repository with no pulls from a root the store does not hold', async () => {
    const staged = stage(slugOf(HOME));
    await deposit(staged.runtime, { allow: [slugOf(HOME)], redactDomains: [], now: () => NOW });
    const store = await loadStore(staged.storeDir);
    expect(store.prompts.length).toBeGreaterThan(0);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const kept = await sessionsBooks(deps, { by: 'pull', sinceDays: undefined, repo: HOME });
    expect(kept.text).toBe('No pulls in the store.');
    const none = resolve('/zz/none');
    const absent = await sessionsBooks(deps, { by: 'pull', sinceDays: undefined, repo: none });
    expect(absent.text).toBe(`No prompts for ${none} in the store (${String(store.prompts.length)} prompts across all repositories).`);
  });

  it('books over a --since window nothing falls in says so, with or without --repo, and an empty store still reads as empty', async () => {
    const staged = stage(slugOf(HOME));
    await deposit(staged.runtime, { allow: [slugOf(HOME)], redactDomains: [], now: () => NOW });
    expect((await loadStore(staged.storeDir)).prompts.length).toBeGreaterThan(0);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW + 3650 * 86_400_000 };
    expect((await sessionsBooks(deps, { by: 'class', sinceDays: 1, repo: HOME })).text).toBe('No prompts in the --since window.');
    expect((await sessionsBooks(deps, { by: 'pull', sinceDays: 1, repo: HOME })).text).toBe('No pulls in the --since window.');
    expect((await sessionsBooks(deps, { by: 'class', sinceDays: 1 })).text).toBe('No prompts in the --since window.');
    const empty = stage(slugOf(HOME));
    const emptyDeps = { sessions: empty.runtime, install: undefined, now: () => NOW };
    expect((await sessionsBooks(emptyDeps, { by: 'class', sinceDays: 1 })).text).toBe('No prompts in the store.');
  });

  it("measure --repo drops another repository's MCP recall calls and keeps calls with no folder", async () => {
    const staged = stage(slugOf(HOME));
    const lines = readFileSync(join(staged.projectsRoot, slugOf(HOME), 'errors-a.jsonl'), 'utf8').split('\n').filter((line) => line !== '');
    addProject(staged, slugOf(OTHER), 'other-session', lines);
    await deposit(staged.runtime, { allow: [slugOf(HOME), slugOf(OTHER)], redactDomains: [], now: () => NOW });
    const store = await loadStore(staged.storeDir);
    const mine = store.sessions.filter((session) => session.project === slugOf(HOME));
    const at = mine.map((session) => session.tsFirst ?? '').sort()[0] ?? '';
    const call = (cwd?: string): string => JSON.stringify({ at, query: '{}', matches: 1, ...(cwd === undefined ? {} : { cwd }) });
    // One call from this repository's worktree, one from the other repository, and one older call with no folder.
    writeFileSync(paths(staged.storeDir).calls, [call(join(HOME, '.claude', 'worktrees', 't1')), call(OTHER), call()].join('\n') + '\n');
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const scoped = await sessionsMeasure(deps, { last: 300, since: undefined, repo: HOME });
    expect(scoped.document).toMatchObject({ last: { recallPerSession: Math.round((2 / mine.length) * 100) / 100 } });
    const all = await sessionsMeasure(deps, { last: 300, since: undefined });
    expect(all.document).toMatchObject({ last: { recallPerSession: Math.round((3 / store.sessions.length) * 100) / 100 } });
  });

  it("a subfolder's newer sessions share the repository's window, so an old root-only signature drops out", () => {
    const sub = `${slugOf(HOME)}-packages`;
    // Two old sessions in the root folder, then 300 newer ones in a subfolder: all one repository, so the old signature is outside its latest 300.
    const sessions = [base(slugOf(HOME), 'r-1', 1), base(slugOf(HOME), 'r-2', 2), ...Array.from({ length: 300 }, (_unused, day) => base(sub, `s-${String(day)}`, 10 + day))];
    const errors = [failure('r-1', 'Bash | old'), failure('r-2', 'Bash | old'), failure('s-0', 'Bash | new'), failure('s-1', 'Bash | new')];
    const block = contextBlock(buildIndex({ sessions, prompts: [], errors, subagents: [], tools: [], newerCaptures: 0 }, [], ''), { cwd: HOME, top: 5, maxChars: 1200 }) ?? '';
    expect(block).toContain('Bash | new (2 sessions in the last 300');
    expect(block).not.toContain('Bash | old');
  });

  it("another repository's 300 newer deposits leave this repository's block unchanged", () => {
    const sessions = [base(slugOf(HOME), 'a-1', 1), base(slugOf(HOME), 'a-2', 2), base(`${slugOf(HOME)}--claude-worktrees-t1`, 'a-3', 3), base(`${slugOf(HOME)}--claude-worktrees-t1`, 'a-4', 4)];
    const errors = sessions.map((session) => failure(session.session, 'Bash | mine'));
    const block = (extra: SessionObservation[]): string | undefined =>
      contextBlock(buildIndex({ sessions: [...sessions, ...extra], prompts: [], errors, subagents: [], tools: [], newerCaptures: 0 }, [], ''), { cwd: HOME, top: 5, maxChars: 1200 });
    const rival = Array.from({ length: 300 }, (_unused, day) => base(slugOf(OTHER), `b-${String(day)}`, 100 + day));
    const alone = block([]);
    expect(alone).toContain('Bash | mine (4 sessions in the last 300');
    expect(block(rival)).toBe(alone);
  });

  it('expands a leading ~ in the repository root before resolving it, as an allow-list entry does', () => {
    const project = slugOf(join(homedir(), 'oars-t731-repo'));
    expect(inRepository(project, '~/oars-t731-repo')).toBe(true);
  });

  it('a stored parent folder joins two repositories into one window, so the isolation reverts to the whole store', () => {
    const parent = slugOf(resolve('/zz'));
    const mine = [base(slugOf(HOME), 'a-1', 1), base(slugOf(HOME), 'a-2', 2)];
    const errors = mine.map((session) => failure(session.session, 'Bash | mine'));
    const rival = Array.from({ length: 300 }, (_unused, day) => base(slugOf(OTHER), `b-${String(day)}`, 100 + day));
    // The project's own rows, which are the ranking the SessionStart block shows for a folder with history.
    const rows = (extra: SessionObservation[]): unknown =>
      buildIndex({ sessions: [...mine, ...extra, ...rival], prompts: [], errors, subagents: [], tools: [], newerCaptures: 0 }, [], '').projects[slugOf(HOME)];
    expect(rows([])).toBeDefined();
    // One allow-listed session from the parent folder: `/zz` is a prefix of both slugs, so the 300 newer sessions now crowd this repository out.
    expect(rows([base(parent, 'p-1', 0)])).toBeUndefined();
  });
});

describe('the call shapes in the index', () => {
  const SHAPE = toolShapeId('Monitor', ['query']);
  const calls = (name: string) =>
    Array.from({ length: 10 }, (_, n) => toolRow(name, n, 'Monitor', { ts: '2026-11-01T00:00:00.000Z', status: n < 2 ? 'error' : 'ok', keys: ['query'], durationMs: 5, toolUseId: `${name}-${String(n)}`, harnessVersion: '2.1.300', prompt: 0 }));
  const indexOver = (names: readonly string[]) => buildIndex({ sessions: [], prompts: [], errors: [], subagents: [], tools: names.flatMap(calls), newerCaptures: 0 }, [], '2026-11-02T00:00:00.000Z');

  it('holds a shape over the fit floors by its shape ID', () => {
    expect(indexOver(['a', 'b', 'c']).fit?.[SHAPE]).toMatchObject({ family: 'fit', tool: 'Monitor', keys: ['query'], n: 3, count: 6, calls: 30 });
  });

  it('leaves out a shape under them', () => {
    expect(indexOver(['a', 'b']).fit).toEqual({});
  });

  describe('against the base rate of its action (a push says more than the fleet already knows)', () => {
    const shaped = (session: string, tool: string, keys: string[], total: number, failed: number) =>
      Array.from({ length: total }, (_, n) => toolRow(session, n, tool, { ts: '2026-11-01T00:00:00.000Z', status: n < failed ? 'error' : 'ok', keys, durationMs: 5, toolUseId: `${session}-${tool}-${keys.join('')}-${String(n)}`, harnessVersion: '2.1.300', prompt: 0 }));
    const over = (tools: ReturnType<typeof shaped>) => buildIndex({ sessions: [], prompts: [], errors: [], subagents: [], tools, newerCaptures: 0 }, [], '2026-11-02T00:00:00.000Z').fit ?? {};
    const sessions = ['a', 'b', 'c'];

    it('drops a shape that fails only a little more than its action does, though it is over the floors', () => {
      // 20 percent and 15 percent over two shell shapes: the action's share is 21 of 130, so neither reaches twice it.
      const fit = over([...sessions.flatMap((name) => shaped(name, 'PowerShell', ['command'], 10, 2)), ...shaped('d', 'PowerShell', ['command', 'timeout'], 100, 15)]);
      expect(fit).toEqual({});
    });

    it('keeps a shape that fails at twice its action share or more, in the same action', () => {
      const broad = shaped('d', 'PowerShell', ['command', 'timeout'], 100, 15);
      const sharp = sessions.flatMap((name) => shaped(name, 'PowerShell', ['pattern'], 7, 5));
      // Over the floors at 20 percent, but under twice the action's 24 percent.
      const middling = sessions.flatMap((name) => shaped(name, 'PowerShell', ['command'], 10, 2));
      const fit = over([...broad, ...sharp, ...middling]);
      expect(Object.keys(fit)).toEqual([toolShapeId('PowerShell', ['pattern'])]);
    });

    it('lets a shape of a tool no action table lists fire against the base rate of other', () => {
      const quiet = shaped('d', 'Quiet', ['x'], 200, 0);
      const sharp = sessions.flatMap((name) => shaped(name, 'Monitor', ['query'], 10, 2));
      expect(Object.keys(over([...quiet, ...sharp]))).toEqual([SHAPE]);
    });

    it('requires exactly twice the share: a tie fires, one failure fewer does not', () => {
      // The action holds 2 shapes: base is (6 + 4) of (30 + 70) = 0.10; twice is 0.20.
      const tie = sessions.flatMap((name) => shaped(name, 'PowerShell', ['pattern'], 10, 2));
      const rest = shaped('d', 'PowerShell', ['command'], 70, 4);
      expect(Object.keys(over([...tie, ...rest]))).toEqual([toolShapeId('PowerShell', ['pattern'])]);
      const under = sessions.flatMap((name, at) => shaped(name, 'PowerShell', ['pattern'], 10, at === 0 ? 1 : 2));
      expect(over([...under, ...rest])).toEqual({});
    });
  });
});
