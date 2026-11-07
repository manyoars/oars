// The coverage a deposit states (t871): the operator's two settings, read from one file on this machine, and the team band counted from the local git log. A real repository proves the count, because a fake git would only prove the fake.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { slugOf } from './allow.js';
import { authorsIn, coverageFile, makeCoverage, readCoverageSetting, teamOf, writeCoverageSetting } from './coverage.js';
import { session } from './pool-fixture.js';
import { runGit } from './survival.js';

const dirs: string[] = [];
const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE, index: process.env.GIT_INDEX_FILE };
beforeAll(() => {
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  delete process.env.GIT_INDEX_FILE;
});
afterAll(() => {
  if (saved.dir !== undefined) process.env.GIT_DIR = saved.dir;
  if (saved.tree !== undefined) process.env.GIT_WORK_TREE = saved.tree;
  if (saved.index !== undefined) process.env.GIT_INDEX_FILE = saved.index;
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'oars-coverage-'));
  dirs.push(dir);
  return dir;
};

const gitIn = (dir: string, author: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, '-c', `user.name=${author}`, '-c', `user.email=${author}@example.com`, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** A repository with one commit by each named author, in order. */
const repoBy = (...authors: string[]): string => {
  const dir = temp();
  gitIn(dir, 'init', 'init', '-q', '-b', 'main');
  for (const [index, author] of authors.entries()) {
    writeFileSync(join(dir, `f${String(index)}`), author);
    gitIn(dir, author, 'add', '.');
    gitIn(dir, author, 'commit', '-q', '-m', `by ${author}`);
  }
  return dir;
};

describe('the team band', () => {
  it('reads one author as solo, two or more as team, and none or unreadable as unknown', () => {
    expect(teamOf(1)).toBe('solo');
    expect(teamOf(2)).toBe('team');
    expect(teamOf(40)).toBe('team');
    expect(teamOf(0)).toBe('unknown');
    expect(teamOf(null)).toBe('unknown');
  });

  it('counts the distinct authors of the local log and keeps no name', async () => {
    expect(await authorsIn(runGit, repoBy('ada'))).toBe(1);
    expect(await authorsIn(runGit, repoBy('ada', 'ada', 'ada'))).toBe(1);
    expect(await authorsIn(runGit, repoBy('ada', 'grace', 'ada'))).toBe(2);
    const count: unknown = await authorsIn(runGit, repoBy('ada', 'grace'));
    expect(typeof count).toBe('number');
  });

  it('is null for a folder git cannot read, and for a repository with no commit', async () => {
    expect(await authorsIn(runGit, temp())).toBeNull();
    const empty = temp();
    gitIn(empty, 'ada', 'init', '-q', '-b', 'main');
    expect(await authorsIn(runGit, empty)).toBeNull();
  });

  it('reads the log with a bound, so a huge history costs a bounded read', async () => {
    const seen: string[][] = [];
    await authorsIn((_root, args) => {
      seen.push([...args]);
      return Promise.resolve('a@x\nb@x\n');
    }, '/r');
    expect(seen[0]).toContain('log');
    expect(seen[0]?.some((arg) => arg.startsWith('--max-count='))).toBe(true);
  });
});

describe('the operator setting', () => {
  it('is unknown for both when nothing was set, when the file is damaged, and for a value outside the lists', async () => {
    const store = temp();
    expect(await readCoverageSetting(store)).toEqual({ orgSize: 'unknown', repoVisibility: 'unknown' });
    writeFileSync(coverageFile(store), '{not json');
    expect(await readCoverageSetting(store)).toEqual({ orgSize: 'unknown', repoVisibility: 'unknown' });
    writeFileSync(coverageFile(store), JSON.stringify({ orgSize: '5000', repoVisibility: 'internal' }));
    expect(await readCoverageSetting(store)).toEqual({ orgSize: 'unknown', repoVisibility: 'unknown' });
    writeFileSync(coverageFile(store), '[]');
    expect(await readCoverageSetting(store)).toEqual({ orgSize: 'unknown', repoVisibility: 'unknown' });
    writeFileSync(coverageFile(store), 'null');
    expect(await readCoverageSetting(store)).toEqual({ orgSize: 'unknown', repoVisibility: 'unknown' });
  });

  it('keeps what was written, each setting on its own', async () => {
    const store = temp();
    await writeCoverageSetting(store, { orgSize: '11-100', repoVisibility: 'private' });
    expect(await readCoverageSetting(store)).toEqual({ orgSize: '11-100', repoVisibility: 'private' });
    await writeCoverageSetting(store, { orgSize: '11-100', repoVisibility: 'public' });
    expect(await readCoverageSetting(store)).toEqual({ orgSize: '11-100', repoVisibility: 'public' });
  });
});

describe('the coverage of a session', () => {
  /** A project folder whose one transcript names `cwd`, the way the harness stamps every line. */
  const projectOf = (cwd: string, name: string): { projectsRoot: string; storeDir: string; project: string } => {
    const projectsRoot = temp();
    const project = slugOf(cwd);
    mkdirSync(join(projectsRoot, project), { recursive: true });
    writeFileSync(join(projectsRoot, project, `${name}.jsonl`), `${JSON.stringify({ type: 'user', cwd })}\n`);
    return { projectsRoot, storeDir: temp(), project };
  };

  it('joins the settings and the team band of the repository the session sat in', async () => {
    const repo = repoBy('ada', 'grace');
    const { project, ...runtime } = projectOf(repo, 's1');
    const coverage = makeCoverage(runtime, { orgSize: '2-10', repoVisibility: 'private' }, runGit);
    expect(await coverage(session('s1', { project }))).toEqual({ orgSize: '2-10', team: 'team', repoVisibility: 'private' });
    const solo = repoBy('ada');
    const other = projectOf(solo, 's2');
    expect(await makeCoverage(other, { orgSize: 'unknown', repoVisibility: 'unknown' }, runGit)(session('s2', { project: other.project }))).toEqual({ orgSize: 'unknown', team: 'solo', repoVisibility: 'unknown' });
  });

  it('reads each repository once per pass', async () => {
    const repo = repoBy('ada');
    const { project, ...runtime } = projectOf(repo, 's1');
    let calls = 0;
    const coverage = makeCoverage(runtime, { orgSize: 'unknown', repoVisibility: 'unknown' }, (root, args, stdin) => {
      calls += 1;
      return runGit(root, args, stdin);
    });
    await coverage(session('s1', { project }));
    await coverage(session('s1', { project }));
    expect(calls).toBe(1);
  });

  it('says unknown for a session whose folder holds no transcript, or sat in no repository', async () => {
    const none = makeCoverage({ projectsRoot: temp(), storeDir: temp() }, { orgSize: '2-10', repoVisibility: 'public' }, runGit);
    expect(await none(session('s1', { project: 'gone' }))).toEqual({ orgSize: '2-10', team: 'unknown', repoVisibility: 'public' });
    const loose = temp();
    const { project, ...runtime } = projectOf(loose, 's1');
    expect(await makeCoverage(runtime, { orgSize: 'unknown', repoVisibility: 'unknown' }, runGit)(session('s1', { project }))).toMatchObject({ team: 'unknown' });
  });
});
