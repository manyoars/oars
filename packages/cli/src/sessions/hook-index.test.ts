import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { slugOf } from './allow.js';
import type { ErrorObservation, SessionObservation } from './schema.js';
import { buildIndex, contextBlock, readIndex, repositoryRoot } from './hook-index.js';
import { loadStore } from './store.js';
import { cleanup, stage } from './test-support.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  const session = (name: string, day: number): SessionObservation => ({
    kind: 'session', cv: '1', sid: null, session: name, project: slugOf(REPO), parent: null, agentType: null, spawnedBy: null, rev: 1, at: '', bytes: 0, lines: 0, badLines: 0, userTurns: 0, assistantTurns: 0,
    tsFirst: new Date(Date.UTC(2026, 0, 1) + day * 86_400_000).toISOString(), tsLast: null, versions: [], models: {}, branches: [], tools: {}, files: [], fileHashes: [], repo: null, urls: [], searches: [],
    bashCmds: 0, tldrs: [], confidences: [], compactSummaries: 0, promptFingerprint: null, env: { harness: null, oars: '0.0.0', node: 'v0', os: 'test' }, costUsd: null, usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 },
  });
  const failure = (name: string, sig: string): ErrorObservation => ({
    kind: 'error', v: '1', session: name, rev: 1, ts: null, harnessVersion: null, tool: 'Bash', sig, example: sig, next: ['Read'], editFollowed: false, prompt: null, cls: null,
  });

  it('ranks by sessions within the last 300, so an old high-count signature falls below a recent one', () => {
    const sessions: SessionObservation[] = [];
    const errors: ErrorObservation[] = [];
    // 40 old sessions all hit "stale error"; 300 later sessions, 3 of them hit "fresh error". 40 > 3 over the whole store, 0 < 3 in the window.
    for (let day = 0; day < 40; day += 1) {
      sessions.push(session(`old-${String(day)}`, day));
      errors.push(failure(`old-${String(day)}`, 'Bash | stale error'));
    }
    for (let day = 0; day < 300; day += 1) {
      sessions.push(session(`new-${String(day)}`, 100 + day));
      if (day % 100 === 0) errors.push(failure(`new-${String(day)}`, 'Bash | fresh error'));
    }
    const block = contextBlock(buildIndex({ sessions, prompts: [], errors, subagents: [], tools: [], newerCaptures: 0 }, [], ''), { cwd: REPO, top: 5, maxChars: 1200 }) ?? '';
    expect(block).toContain('fresh error (3 sessions in the last 300');
    expect(block).not.toContain('stale error');
  });
});
