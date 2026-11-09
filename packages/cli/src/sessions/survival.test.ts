// Commit survival against real git repositories in a temp folder: the states are git's answers, so a fake git would prove nothing about them.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { deposit, loadStore } from './store.js';
import { addProject, cleanup, removeHeld, stage, type Staged } from './test-support.js';
import { readSurvival, recordSurvival, survivalFile, SURVIVAL_DAYS, type Git } from './survival.js';
import { slugOf } from './allow.js';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { readHookCalls } from './hook-calls.js';
import { runHook } from './hooks.js';

const NOW = Date.parse('2026-06-30T00:00:00Z');
const OLD = '2026-06-01T00:00:00.000Z';
const dirs: string[] = [];
const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE, index: process.env.GIT_INDEX_FILE };

// A run under a hook or `git rebase --exec` inherits these, and `git -C` does not override `GIT_DIR`: the helper's config writes would land in the real repository.
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
  cleanup();
  for (const dir of dirs.splice(0)) removeHeld(dir);
});

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
const gitIn = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, ...IDENTITY, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const commitIn = (dir: string, name: string): string => {
  writeFileSync(join(dir, name), name);
  gitIn(dir, 'add', name);
  // `core.abbrev=8` makes the commit's own summary line (`[main 1a2b3c4d] add x`) carry the eight-character sha, so no `rev-parse` process is spawned to read it back.
  const made = gitIn(dir, '-c', 'core.abbrev=8', 'commit', '-m', `add ${name}`);
  const sha = /^\[[^\]]+ ([0-9a-f]{8})\]/.exec(made)?.[1];
  if (sha === undefined) throw new Error(`no sha in the commit summary: ${made}`);
  return sha;
};

// Every test starts from the same one-commit repository, and building it costs three git processes (init, add, commit). Under load process creation is what
// slows, and that bill was paid in each of ~40 tests until a slow one ran past its timeout; so it is paid once and each test copies the folder, which spawns nothing.
let template = '';
beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), 'oars-survival-template-'));
  gitIn(template, 'init', '-q', '-b', 'main');
  commitIn(template, 'first');
});
afterAll(() => {
  removeHeld(template);
});

/** A repository whose `origin/main` is the checked-out `main`, moved by `publish`. */
const makeRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'oars-survival-'));
  dirs.push(dir);
  cpSync(template, dir, { recursive: true });
  return dir;
};

const publish = (dir: string): void => {
  gitIn(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
};

const pointOriginHead = (dir: string, branch = 'main'): void => {
  gitIn(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`);
};

/** `ts: null` leaves the timestamp off the assistant and result lines, as a transcript line the harness did not date. */
type Commit = { sha: string; ts?: string | null };

const transcript = (cwd: string, commits: readonly Commit[], firstCwd = cwd): string[] => [
  JSON.stringify({ type: 'user', timestamp: OLD, cwd: firstCwd, message: { role: 'user', content: 'do it' } }),
  ...commits.flatMap(({ sha, ts = OLD }, index) => [
    JSON.stringify({ type: 'assistant', timestamp: ts ?? undefined, cwd, message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: `c${String(index)}`, name: 'Bash', input: { command: 'git commit -m x' } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    JSON.stringify({ type: 'user', timestamp: ts ?? undefined, cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${String(index)}`, is_error: false, content: `[main ${sha}] x\n 1 file changed` }] } }),
  ]),
];

/** A deposited store holding one session in `cwd`'s project folder, with the transcript where the harness would put it. */
const staged = async (cwd: string, commits: readonly Commit[], name = 'one'): Promise<{ s: Staged; project: string }> => {
  const s = stage('unused');
  const project = slugOf(cwd);
  addProject(s, project, name, transcript(cwd, commits));
  await deposit(s.runtime, { allow: [project], redactDomains: [], now: () => NOW });
  return { s, project };
};

const lines = (s: Staged): unknown[] =>
  existsSync(survivalFile(s.storeDir))
    ? readFileSync(survivalFile(s.storeDir), 'utf8').trim().split('\n').map((line): unknown => JSON.parse(line))
    : [];

describe('cleanup', () => {
  it('waits out a child that still holds a registered temp folder as its cwd, then removes the folder', async () => {
    const s = stage();
    const child = spawn(process.execPath, ['-e', 'console.log(1); setTimeout(() => {}, 1500)'], { cwd: s.root, stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    // Wait for the child to be running in the folder (its first output), not merely spawned: before that Windows holds no handle on it.
    await new Promise((resolve) => child.stdout.once('data', resolve));
    cleanup();
    expect(existsSync(s.root)).toBe(false);
    await exited;
  });
});

describe('recordSurvival', () => {
  it('reads an ancestor of the default branch as survived, on a day-resolution date, in a file beside the store', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'kept');
    publish(repo);
    pointOriginHead(repo);
    const { s, project } = await staged(repo, [{ sha }]);
    const done = await recordSurvival(s.runtime, [project], () => NOW);
    expect(done).toEqual({ survived: 1, reverted: 0, unreachable: 0, unknown: 0 });
    expect(lines(s)).toEqual([{ sha, state: 'survived', day: '2026-06-30' }]);
    expect(survivalFile(s.storeDir)).toBe(join(s.storeDir, 'commit-survival.jsonl'));
  });

  it('names no commit younger than SURVIVAL_DAYS', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'young');
    publish(repo);
    const young = new Date(NOW - (SURVIVAL_DAYS - 1) * 86_400_000).toISOString();
    const { s, project } = await staged(repo, [{ sha, ts: young }]);
    expect(SURVIVAL_DAYS).toBe(7);
    expect(await recordSurvival(s.runtime, [project], () => NOW)).toEqual({ survived: 0, reverted: 0, unreachable: 0, unknown: 0 });
    expect(lines(s)).toEqual([]);
  });

  // The boundary is `>=` on a day-resolution promise ("more than" SURVIVAL_DAYS old): a call exactly at the cutoff is not due, and one a millisecond older is.
  const countsFor = async (ts: string | null) => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'kept');
    publish(repo);
    pointOriginHead(repo);
    const { s, project } = await staged(repo, [{ sha, ts }]);
    return recordSurvival(s.runtime, [project], () => NOW);
  };
  const CUTOFF = NOW - SURVIVAL_DAYS * 86_400_000;

  it('names no commit exactly SURVIVAL_DAYS old: it has to be more than that', async () => {
    expect(await countsFor(new Date(CUTOFF).toISOString())).toEqual({ survived: 0, reverted: 0, unreachable: 0, unknown: 0 });
  });

  it('names a commit a millisecond older than SURVIVAL_DAYS', async () => {
    expect(await countsFor(new Date(CUTOFF - 1).toISOString())).toEqual({ survived: 1, reverted: 0, unreachable: 0, unknown: 0 });
  });

  it('names no commit with no timestamp: its age is unknown, not old', async () => {
    expect(await countsFor(null)).toEqual({ survived: 0, reverted: 0, unreachable: 0, unknown: 0 });
  });

  it('reads a commit a later commit reverts as reverted, and one whose revert was itself reverted as survived', async () => {
    const repo = makeRepo();
    const undone = commitIn(repo, 'undone');
    const redone = commitIn(repo, 'redone');
    gitIn(repo, 'revert', '--no-edit', 'HEAD~1');
    gitIn(repo, 'revert', '--no-edit', 'HEAD~1');
    gitIn(repo, 'revert', '--no-edit', 'HEAD');
    publish(repo);
    const { s, project } = await staged(repo, [{ sha: undone }, { sha: redone }]);
    await recordSurvival(s.runtime, [project], () => NOW);
    expect(Object.fromEntries(await readSurvival(s.storeDir))).toEqual({ [undone]: 'reverted', [redone]: 'survived' });
  });

  it('reads a revert of a revert as undoing it even when clock skew dates the undoing commit older, across a merge', async () => {
    const repo = makeRepo();
    const dated = (date: string, ...args: string[]): void => {
      execFileSync('git', ['-C', repo, ...IDENTITY, ...args], { stdio: 'ignore', env: { ...process.env, GIT_COMMITTER_DATE: date } });
    };
    const undone = commitIn(repo, 'undone');
    dated('2026-01-03T00:00:00Z', 'revert', '--no-edit', 'HEAD');
    gitIn(repo, 'checkout', '-q', '-b', 'redo');
    dated('2026-01-01T00:00:00Z', 'revert', '--no-edit', 'HEAD');
    gitIn(repo, 'checkout', '-q', 'main');
    writeFileSync(join(repo, 'other'), 'other');
    gitIn(repo, 'add', 'other');
    dated('2026-01-04T00:00:00Z', 'commit', '-q', '-m', 'add other');
    dated('2026-01-05T00:00:00Z', 'merge', '-q', '--no-ff', '--no-edit', 'redo');
    publish(repo);
    const { s, project } = await staged(repo, [{ sha: undone }]);
    await recordSurvival(s.runtime, [project], () => NOW);
    expect(Object.fromEntries(await readSurvival(s.storeDir))).toEqual({ [undone]: 'survived' });
  });

  it('reads a commit left on a branch the default branch never took as unreachable', async () => {
    const repo = makeRepo();
    gitIn(repo, 'checkout', '-q', '-b', 'side');
    const sha = commitIn(repo, 'side');
    gitIn(repo, 'checkout', '-q', 'main');
    publish(repo);
    const { s, project } = await staged(repo, [{ sha }]);
    expect(await recordSurvival(s.runtime, [project], () => NOW)).toEqual({ survived: 0, reverted: 0, unreachable: 1, unknown: 0 });
  });

  it('falls back to a local main when no remote names a default branch', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'local');
    const { s, project } = await staged(repo, [{ sha }]);
    expect(await recordSurvival(s.runtime, [project], () => NOW)).toEqual({ survived: 1, reverted: 0, unreachable: 0, unknown: 0 });
  });

  it('reads a repository with no default branch it knows as unknown', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'oars-survival-'));
    dirs.push(repo);
    gitIn(repo, 'init', '-q', '-b', 'trunk');
    const sha = commitIn(repo, 'trunk');
    const { s, project } = await staged(repo, [{ sha }]);
    expect(await recordSurvival(s.runtime, [project], () => NOW)).toEqual({ survived: 0, reverted: 0, unreachable: 0, unknown: 1 });
  });

  it('reads a sha this repository does not hold as unknown, since the session may have committed in another repository', async () => {
    const repo = makeRepo();
    publish(repo);
    const { s, project } = await staged(repo, [{ sha: 'abcdef12' }]);
    expect(await recordSurvival(s.runtime, [project], () => NOW)).toEqual({ survived: 0, reverted: 0, unreachable: 0, unknown: 1 });
  });

  it('reads a shallow repository as unknown', async () => {
    const source = makeRepo();
    const sha = commitIn(source, 'deep');
    commitIn(source, 'deeper');
    const clone = mkdtempSync(join(tmpdir(), 'oars-survival-'));
    dirs.push(clone);
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${source.replace(/\\/g, '/')}`, clone], { stdio: 'ignore' });
    const { s, project } = await staged(clone, [{ sha }]);
    expect(await recordSurvival(s.runtime, [project], () => NOW)).toEqual({ survived: 0, reverted: 0, unreachable: 0, unknown: 1 });
  });

  /** A partial clone of a repository whose `side` branch holds a commit the clone lacks. Only a full sha can reach it: git resolves a short one from local objects alone. */
  const partialCloneLacking = (): { clone: string; sha: string } => {
    const source = makeRepo();
    gitIn(source, 'config', 'uploadpack.allowFilter', 'true');
    gitIn(source, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    gitIn(source, 'checkout', '-q', '-b', 'side');
    commitIn(source, 'side');
    const sha = gitIn(source, 'rev-parse', 'HEAD');
    gitIn(source, 'checkout', '-q', 'main');
    const clone = mkdtempSync(join(tmpdir(), 'oars-survival-'));
    dirs.push(clone);
    execFileSync('git', ['clone', '-q', '--filter=blob:none', '--single-branch', '--branch', 'main', `file://${source.replace(/\\/g, '/')}`, clone], { stdio: 'ignore' });
    return { clone, sha };
  };

  const objectsOf = (clone: string): string[] => readdirSync(join(clone, '.git', 'objects'), { recursive: true, encoding: 'utf8' }).sort();

  it('fetches nothing into a partial clone: a full sha only its remote holds reads as unknown, and the objects stay as they were', async () => {
    const { clone, sha } = partialCloneLacking();
    const { s, project } = await staged(clone, [{ sha }]);
    const before = objectsOf(clone);
    expect(await recordSurvival(s.runtime, [project], () => NOW)).toEqual({ survived: 0, reverted: 0, unreachable: 0, unknown: 1 });
    expect(objectsOf(clone)).toEqual(before);
  });

  it('fetches nothing even where the clone allows its own protocol: a per-protocol key beats `protocol.allow`, so only the environment holds', async () => {
    const { clone, sha } = partialCloneLacking();
    gitIn(clone, 'config', 'protocol.file.allow', 'always');
    const { s, project } = await staged(clone, [{ sha }]);
    const before = objectsOf(clone);
    expect(await recordSurvival(s.runtime, [project], () => NOW)).toEqual({ survived: 0, reverted: 0, unreachable: 0, unknown: 1 });
    expect(objectsOf(clone)).toEqual(before);
  });

  it('reads an absent repository as unknown', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'oars-survival-'));
    dirs.push(parent);
    const gone = join(parent, 'gone');
    mkdirSync(gone);
    const { s, project } = await staged(gone, [{ sha: 'abcdef12' }]);
    expect(await recordSurvival(s.runtime, [project], () => NOW)).toEqual({ survived: 0, reverted: 0, unreachable: 0, unknown: 1 });
  });

  it('reads the repository only from a cwd whose slug is the project: a later cd is never followed', async () => {
    const repo = makeRepo();
    const elsewhere = makeRepo();
    const sha = commitIn(elsewhere, 'elsewhere');
    publish(elsewhere);
    const s = stage('unused');
    const project = slugOf(repo);
    // The first cwd is another repository's, whose slug is not this project's; the lines after it name this project's own folder.
    addProject(s, project, 'one', [
      JSON.stringify({ type: 'user', timestamp: OLD, cwd: elsewhere, message: { role: 'user', content: 'start' } }),
      ...transcript(repo, [{ sha }], repo),
    ]);
    await deposit(s.runtime, { allow: [project], redactDomains: [], now: () => NOW });
    const seen: string[] = [];
    const git: Git = (root) => {
      seen.push(root);
      return Promise.reject(new Error('stop here'));
    };
    await recordSurvival(s.runtime, [project], () => NOW, git);
    expect(new Set(seen)).toEqual(new Set([repo.replace(/\\/g, '/')]));
  });

  it('never reads a folder outside the allowlist, even one the store holds', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'private');
    publish(repo);
    const { s } = await staged(repo, [{ sha }]);
    const seen: string[] = [];
    const git: Git = (root) => {
      seen.push(root);
      return Promise.resolve('');
    };
    expect(await recordSurvival(s.runtime, ['some-other-folder'], () => NOW, git)).toEqual({ survived: 0, reverted: 0, unreachable: 0, unknown: 0 });
    expect(seen).toEqual([]);
    expect(lines(s)).toEqual([]);
  });

  it('reads the transcript from raw/ once the harness has cleaned it up', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'kept');
    publish(repo);
    const { s, project } = await staged(repo, [{ sha }]);
    rmSync(join(s.projectsRoot, project), { recursive: true, force: true });
    expect(await recordSurvival(s.runtime, [project], () => NOW)).toEqual({ survived: 1, reverted: 0, unreachable: 0, unknown: 0 });
  });

  it('appends only on a change of state, so the latest observation wins and the file stays small', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'later');
    const first = await staged(repo, [{ sha }]);
    gitIn(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');
    const { s, project } = first;
    await recordSurvival(s.runtime, [project], () => NOW);
    await recordSurvival(s.runtime, [project], () => NOW + 86_400_000);
    expect(lines(s)).toEqual([{ sha, state: 'unreachable', day: '2026-06-30' }]);
    publish(repo);
    await recordSurvival(s.runtime, [project], () => NOW + 2 * 86_400_000);
    expect(lines(s)).toEqual([
      { sha, state: 'unreachable', day: '2026-06-30' },
      { sha, state: 'survived', day: '2026-07-02' },
    ]);
    expect((await readSurvival(s.storeDir)).get(sha)).toBe('survived');
  });

  it('keeps a known state when a later read fails, so a passing git failure does not undo an observation', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'kept');
    publish(repo);
    const { s, project } = await staged(repo, [{ sha }]);
    await recordSurvival(s.runtime, [project], () => NOW);
    const failing: Git = () => Promise.reject(new Error('git broke'));
    expect(await recordSurvival(s.runtime, [project], () => NOW, failing)).toEqual({ survived: 1, reverted: 0, unreachable: 0, unknown: 0 });
    expect(lines(s)).toHaveLength(1);
  });

  it('counts a sha only once when two sessions name it, and keeps a known state over the other session unknown', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'twice');
    publish(repo);
    const { s, project } = await staged(repo, [{ sha }]);
    addProject(s, project, 'two', transcript(repo, [{ sha }]));
    await deposit(s.runtime, { allow: [project], redactDomains: [], now: () => NOW });
    expect(await recordSurvival(s.runtime, [project], () => NOW)).toEqual({ survived: 1, reverted: 0, unreachable: 0, unknown: 0 });
    expect(lines(s)).toHaveLength(1);
  });

  it('reads the repository it names, not one an inherited GIT_DIR points at', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'named');
    publish(repo);
    const other = makeRepo();
    publish(other);
    const { s, project } = await staged(repo, [{ sha }]);
    const inherited = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, '.git');
    try {
      expect(await recordSurvival(s.runtime, [project], () => NOW)).toEqual({ survived: 1, reverted: 0, unreachable: 0, unknown: 0 });
    } finally {
      if (inherited === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = inherited;
    }
  });

  it('reads a signed revert under log.showSignature, whose signature line git prints ahead of the format', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'undone');
    publish(repo);
    const { s, project } = await staged(repo, [{ sha }]);
    const full = gitIn(repo, 'rev-parse', 'HEAD');
    const revert = 'a'.repeat(40);
    // A signing setup is not something every test machine has, so this is the output git 2.37 gave a signed revert with the setting on.
    const answers = (args: readonly string[]): string => {
      if (args[0] === 'rev-parse') return 'false\n';
      if (args[0] === 'symbolic-ref') return 'refs/remotes/origin/main\n';
      if (args[0] === 'rev-list') return `${full}\n`;
      if (args[0] === 'cat-file') return `${full} commit\n`;
      const record = `${revert}\nRevert "x"\n\nThis reverts commit ${full}.\n\0\n`;
      return args.includes('--no-show-signature') ? record : `No signature\n${record}`;
    };
    const git: Git = (_root, args) => Promise.resolve(answers(args));
    expect(await recordSurvival(s.runtime, [project], () => NOW, git)).toEqual({ survived: 0, reverted: 1, unreachable: 0, unknown: 0 });
  });

  it('takes the default branch from origin/HEAD, so a repository whose default is neither main nor master reads against its own', async () => {
    const repo = makeRepo();
    gitIn(repo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    const sha = commitIn(repo, 'main-only');
    publish(repo);
    pointOriginHead(repo, 'develop');
    const { s, project } = await staged(repo, [{ sha }]);
    expect(await recordSurvival(s.runtime, [project], () => NOW)).toEqual({ survived: 0, reverted: 0, unreachable: 1, unknown: 0 });
  });

  it('reads no commit from a sidechain call in the main transcript', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'side');
    publish(repo);
    const s = stage('unused');
    const project = slugOf(repo);
    const onSidechain = transcript(repo, [{ sha }]).map((line, index) => (index === 0 ? line : `{"isSidechain":true,${line.slice(1)}`));
    addProject(s, project, 'one', onSidechain);
    await deposit(s.runtime, { allow: [project], redactDomains: [], now: () => NOW });
    expect((await loadStore(s.storeDir)).tools.flatMap((tool) => tool.commits ?? [])).toEqual([sha]);
    expect(await recordSurvival(s.runtime, [project], () => NOW)).toEqual({ survived: 0, reverted: 0, unreachable: 0, unknown: 0 });
    expect(lines(s)).toEqual([]);
  });

  it('reads no commit a subagent transcript names', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'agent');
    publish(repo);
    const s = stage('unused');
    const project = slugOf(repo);
    addProject(s, project, 'one', transcript(repo, []));
    const subagents = join(s.projectsRoot, project, 'one', 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, 'agent-x.jsonl'), `${transcript(repo, [{ sha }]).join('\n')}\n`);
    await deposit(s.runtime, { allow: [project], redactDomains: [], now: () => NOW });
    expect((await loadStore(s.storeDir)).tools.flatMap((tool) => tool.commits ?? [])).toEqual([sha]);
    expect(await recordSurvival(s.runtime, [project], () => NOW)).toEqual({ survived: 0, reverted: 0, unreachable: 0, unknown: 0 });
    expect(lines(s)).toEqual([]);
  });

  describe('a transcript that names no usable cwd', () => {
    /** One old commit under a `cwd` of another project, then `after`: git must never run and the sha must read unknown. */
    const expectUnread = async (after: (repo: string, elsewhere: string) => string[]): Promise<void> => {
      const repo = makeRepo();
      const sha = commitIn(repo, 'kept');
      publish(repo);
      // A real repository, so that reading a cwd of another project would run git and fail this.
      const elsewhere = makeRepo();
      const s = stage('unused');
      const project = slugOf(repo);
      addProject(s, project, 'one', [...transcript(elsewhere, [{ sha }]), ...after(repo, elsewhere)]);
      await deposit(s.runtime, { allow: [project], redactDomains: [], now: () => NOW });
      let calls = 0;
      const git: Git = () => {
        calls += 1;
        return Promise.reject(new Error('git must not run'));
      };
      expect(await recordSurvival(s.runtime, [project], () => NOW, git)).toEqual({ survived: 0, reverted: 0, unreachable: 0, unknown: 1 });
      expect(calls).toBe(0);
    };
    const filler = (cwd: string): string => JSON.stringify({ type: 'system', timestamp: OLD, cwd });

    it('stops looking after line 200, so a matching cwd on line 201 is never read', async () => {
      // `transcript` writes 3 lines for one commit, so 197 fillers end at line 200.
      await expectUnread((repo, elsewhere) => [...Array.from({ length: 197 }, () => filler(elsewhere)), filler(repo)]);
    });

    it('reads no repository when no line carries a cwd of the project', async () => {
      await expectUnread((_repo, elsewhere) => [filler(elsewhere)]);
    });
  });

  it('reads both shas when two allowlisted projects share one repository root', async () => {
    const repo = makeRepo();
    const inRepo = commitIn(repo, 'in-repo');
    const inWorktree = commitIn(repo, 'in-worktree');
    publish(repo);
    const worktree = join(repo, '.claude', 'worktrees', 'x');
    const s = stage('unused');
    addProject(s, slugOf(repo), 'one', transcript(repo, [{ sha: inRepo }]));
    addProject(s, slugOf(worktree), 'two', transcript(worktree, [{ sha: inWorktree }]));
    const allow = [slugOf(repo), slugOf(worktree)];
    await deposit(s.runtime, { allow, redactDomains: [], now: () => NOW });
    expect(await recordSurvival(s.runtime, allow, () => NOW)).toEqual({ survived: 2, reverted: 0, unreachable: 0, unknown: 0 });
    expect(Object.fromEntries(await readSurvival(s.storeDir))).toEqual({ [inRepo]: 'survived', [inWorktree]: 'survived' });
  });

  it('fails open: a store it cannot read returns null and never throws', async () => {
    const s = stage('unused');
    // A directory where the log should be: reading it fails with EISDIR, which `loadStore` does not swallow as a missing file.
    mkdirSync(join(s.storeDir, 'observations.jsonl'), { recursive: true });
    await expect(recordSurvival(s.runtime, ['proj'], () => NOW)).resolves.toBeNull();
  });
});

describe('who reads it', () => {
  afterEach(removeTestDirs);

  it('a manual deposit observes and reports it, as text and in --json', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'kept');
    publish(repo);
    const { s, project } = await staged(repo, [{ sha }]);
    const h = harness();
    h.deps.sessions = s.runtime;
    h.deps.now = () => NOW;
    expect(await run(['sessions', 'deposit', '--allow', project], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('Commits older than 7 days: 1 survived, 0 reverted, 0 unreachable, 0 unknown.');
    h.out.length = 0;
    expect(await run(['--json', 'sessions', 'deposit', '--allow', project], h.deps)).toBe(ExitCode.OK);
    expect(JSON.parse(h.out.join(''))).toMatchObject({ survival: { survived: 1 } });
    expect(lines(s)).toHaveLength(1);
  });

  it('a manual deposit says so when it could not read survival, and still succeeds', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'kept');
    publish(repo);
    const { s, project } = await staged(repo, [{ sha }]);
    // Reads back fine, and the append fails: the file's name is taken by a directory.
    rmSync(survivalFile(s.storeDir), { force: true });
    mkdirSync(survivalFile(s.storeDir));
    const h = harness();
    h.deps.sessions = s.runtime;
    h.deps.now = () => NOW;
    expect(await run(['sessions', 'deposit', '--allow', project], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('Commit survival not read this run.');
  });

  it('a manual deposit observes only the folders it read: a saved folder this run did not name is not read', async () => {
    const other = makeRepo();
    const otherSha = commitIn(other, 'saved-only');
    publish(other);
    const { s } = await staged(other, [{ sha: otherSha }]);
    const repo = makeRepo();
    const sha = commitIn(repo, 'named');
    publish(repo);
    const project = slugOf(repo);
    addProject(s, project, 'two', transcript(repo, [{ sha }]));
    const h = harness();
    h.deps.sessions = s.runtime;
    h.deps.now = () => NOW;
    expect(await run(['sessions', 'deposit', '--allow', project], h.deps)).toBe(ExitCode.OK);
    expect(lines(s)).toEqual([{ sha, state: 'survived', day: '2026-06-30' }]);
  });

  it('the nightly run observes it, from the saved allowlist', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'kept');
    publish(repo);
    const { s } = await staged(repo, [{ sha }]);
    await runHook('nightly', '', s.runtime, () => NOW);
    expect(lines(s)).toEqual([{ sha, state: 'survived', day: '2026-06-30' }]);
    expect((await readHookCalls(s.storeDir)).map((call) => call.error)).toEqual([null]);
  });

  it('the nightly run records one line when it could not read survival, since no one is watching it', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'kept');
    publish(repo);
    const { s } = await staged(repo, [{ sha }]);
    // Reads back fine, and the append fails: the file's name is taken by a directory.
    mkdirSync(survivalFile(s.storeDir));
    await runHook('nightly', '', s.runtime, () => NOW);
    expect((await readHookCalls(s.storeDir)).map((call) => call.error)).toEqual(['Commit survival not read this run.']);
  });

  it('the Stop hook never does: a session waits on it', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'kept');
    publish(repo);
    const { s, project } = await staged(repo, [{ sha }]);
    const file = join(s.projectsRoot, project, 'one.jsonl');
    await runHook('stop', JSON.stringify({ transcript_path: file }), s.runtime, () => NOW);
    expect(lines(s)).toEqual([]);
  });
});

describe('books reads it', () => {
  afterEach(removeTestDirs);

  it('over a real deposit, with the closing line last, and no closing line when there is no row', async () => {
    const repo = makeRepo();
    const sha = commitIn(repo, 'kept');
    publish(repo);
    const { s, project } = await staged(repo, [{ sha }]);
    const h = harness();
    h.deps.sessions = s.runtime;
    h.deps.now = () => NOW;
    await run(['sessions', 'deposit', '--allow', project], h.deps);
    h.out.length = 0;
    expect(await run(['sessions', 'books', '--by', 'pull'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('No pulls in the store.');
    expect(h.out.join('')).not.toContain('associations');
    h.out.length = 0;
    expect(await run(['sessions', 'books', '--by', 'class'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('').trim().split('\n').at(-1)).toBe("These are associations in one operator's logs, not measured lift.");
    h.out.length = 0;
    expect(await run(['--json', 'sessions', 'books', '--by', 'model'], h.deps)).toBe(ExitCode.OK);
    expect(JSON.parse(h.out.join(''))).toMatchObject({ rows: [{ commits: 1, settled: 1, survived: { count: 1, of: 1, share: null } }] });
  });
});

describe('readSurvival', () => {
  it('reads nothing from an absent file, skips a torn or foreign line, and lets the latest line win', async () => {
    const s = stage('unused');
    mkdirSync(s.storeDir, { recursive: true });
    expect((await readSurvival(s.storeDir)).size).toBe(0);
    const file = survivalFile(s.storeDir);
    appendFileSync(file, `${JSON.stringify({ sha: 'aaa1111', state: 'unreachable', day: '2026-06-01' })}\n`);
    appendFileSync(file, 'torn{\n');
    appendFileSync(file, `${JSON.stringify({ sha: 'bbb2222', state: 'great', day: '2026-06-01' })}\n`);
    appendFileSync(file, `${JSON.stringify({ sha: 7, state: 'survived', day: '2026-06-01' })}\n`);
    appendFileSync(file, 'null\n');
    appendFileSync(file, `${JSON.stringify({ sha: 'aaa1111', state: 'survived', day: '2026-06-02' })}\n`);
    expect([...(await readSurvival(s.storeDir)).entries()]).toEqual([['aaa1111', 'survived']]);
  });
});
