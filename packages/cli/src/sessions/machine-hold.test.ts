// The hold commit of a machine's batch (`machine-hold.ts`): the terms digest, and the commit made with git plumbing in a real repository in a temp folder. Nothing reads the network or the store.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { holdBatch, holdBranch, holdCommit, runNetGit, termsDigest, type HoldDeps, type HoldInput } from './machine-hold.js';
import { runGit, type Git } from './survival.js';
import { stubGitHousekeepingOff } from './test-support.js';

// Process creation is the cost on a Windows runner: a loaded one took up to 3 s for one git process (a spawn timed under eight concurrent spawners: median 1.2 s, max 2.9 s). A case's bound is its git
// processes (the test's own commands and the product's, counted from a git trace) times that. The most any case starts is 47 (a push refused once for a branch another VM moved, with two checkouts and a fetch); 50 x 3 s keeps a margin of three.
const PROCESS_BOUND_MS = 3_000;
const MOST_PROCESSES = 50;
const SLOW = MOST_PROCESSES * PROCESS_BOUND_MS;

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

// A repository with work costs 11 git processes to build and a bare one 1, and a push or a fetch starts a `gc --auto` or `maintenance run --auto` child on top of its own processes. Each is built once and copied
// per case, and auto gc and maintenance are off for every git a case starts (the bare repository carries the receiving side's), so a case starts only the processes it is about.
let work = '';
let bareTemplate = '';
beforeAll(() => {
  stubGitHousekeepingOff();
  work = buildRepoWithWork();
  bareTemplate = mkdtempSync(join(tmpdir(), 'oars-machine-hold-bare-template-'));
  git(bareTemplate, 'init', '-q', '--bare');
  // The receiving side of a push starts `gc --auto` itself, and git drops the environment's config when it enters another repository, so this one is set in the repository.
  git(bareTemplate, 'config', 'receive.autogc', 'false');
}, 20 * PROCESS_BOUND_MS);
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(work, { recursive: true, force: true });
  rmSync(bareTemplate, { recursive: true, force: true });
});

/** A repository in a temp folder with one commit, `origin` named as a cloud session shows it, one staged change, and one unstaged edit. */
const buildRepoWithWork = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-machine-hold-template-'));
  git(folder, 'init', '-q');
  git(folder, 'config', 'core.autocrlf', 'false');
  git(folder, 'remote', 'add', 'origin', 'https://github.com/owner/name');
  writeFileSync(join(folder, 'a.txt'), 'one\n');
  writeFileSync(join(folder, 'b.txt'), 'two\n');
  git(folder, 'add', '.');
  git(folder, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first');
  writeFileSync(join(folder, 'a.txt'), 'one staged\n');
  git(folder, 'add', 'a.txt');
  writeFileSync(join(folder, 'b.txt'), 'two unstaged\n');
  return folder;
};

/** A copy of the repository with work. The copied index holds the old files' stat data, so one refresh makes it as git would have written it, before a case reads its bytes. */
const repoWithWork = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-machine-hold-'));
  made.push(folder);
  cpSync(work, folder, { recursive: true });
  git(folder, 'update-index', '-q', '--refresh');
  return folder;
};

const inputFor = (cwd: string, extra: Partial<HoldInput> = {}): HoldInput => ({
  cwd,
  allowRepos: ['owner/name'],
  machine: 'm1',
  id: '0123456789abcdef',
  batch: '{"id":"0123456789abcdef"}\n',
  stamp: 'v1-abcdef01',
  terms: ['acme corp', 'project x'],
  salt: 'session-salt',
  ...extra,
});

describe('termsDigest', () => {
  it('is the same for one list in any order, case, or blank lines, and with a term twice', () => {
    const base = termsDigest('salt', ['acme corp', 'project x']);
    expect(termsDigest('salt', ['project x', 'acme corp'])).toBe(base);
    expect(termsDigest('salt', ['ACME Corp', '  Project X  '])).toBe(base);
    expect(termsDigest('salt', ['', 'acme corp', '   ', 'project x', ''])).toBe(base);
    expect(termsDigest('salt', ['acme corp', 'acme corp', 'project x'])).toBe(base);
  });

  it('differs for a changed list, and for another salt, and is a SHA-256 in hex', () => {
    const base = termsDigest('salt', ['acme corp', 'project x']);
    expect(termsDigest('salt', ['acme corp'])).not.toBe(base);
    expect(termsDigest('salt', ['acme corp', 'project y'])).not.toBe(base);
    expect(termsDigest('another', ['acme corp', 'project x'])).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is the HMAC-SHA-256 of the sorted list joined with newlines, keyed by the salt', () => {
    expect(termsDigest('salt', ['b', 'a'])).toBe(execFileSync('node', ['-e', "process.stdout.write(require('node:crypto').createHmac('sha256','salt').update('a\\nb').digest('hex'))"], { encoding: 'utf8' }));
  });
});

describe('holdBranch', () => {
  it('names the machine and the id under oars-hold', () => {
    expect(holdBranch('m1', '0123456789abcdef')).toBe('oars-hold/m1/0123456789abcdef');
  });
});

describe('holdCommit', () => {
  it('commits the batch, the stamp, and the terms digest with [skip ci], and changes neither HEAD, the index, nor the working tree', async () => {
    const repo = repoWithWork();
    const head = git(repo, 'rev-parse', 'HEAD');
    const index = readFileSync(join(repo, '.git', 'index'));
    const status = git(repo, 'status', '--porcelain=v1');
    const refs = git(repo, 'for-each-ref');
    const files = ['a.txt', 'b.txt'].map((name) => readFileSync(join(repo, name), 'utf8'));
    const input = inputFor(repo);
    const sha = await holdCommit(runGit, input);
    expect(sha).toMatch(/^[0-9a-f]{40}$/u);
    const commit = sha ?? '';
    expect(git(repo, 'cat-file', 'commit', commit)).toContain('[skip ci]');
    expect(git(repo, 'show', `${commit}:batch.json`)).toBe(input.batch);
    expect(git(repo, 'show', `${commit}:stamp`)).toBe('v1-abcdef01\n');
    expect(git(repo, 'show', `${commit}:terms`)).toBe(`${termsDigest('session-salt', input.terms)}\n`);
    expect(git(repo, 'ls-tree', '--name-only', commit).split('\n').filter((name) => name !== '')).toEqual(['batch.json', 'stamp', 'terms']);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(repo, '.git', 'index')).equals(index)).toBe(true);
    expect(git(repo, 'status', '--porcelain=v1')).toBe(status);
    expect(['a.txt', 'b.txt'].map((name) => readFileSync(join(repo, name), 'utf8'))).toEqual(files);
    expect(git(repo, 'for-each-ref')).toBe(refs);
  }, SLOW);

  it('writes the batch bytes as they are, whatever the line-ending settings of the repository', async () => {
    const repo = repoWithWork();
    git(repo, 'config', 'core.autocrlf', 'true');
    const sha = (await holdCommit(runGit, inputFor(repo, { batch: 'line one\nline two\n' }))) ?? '';
    expect(execFileSync('git', ['-C', repo, 'cat-file', 'blob', `${sha}:batch.json`]).toString('latin1')).toBe('line one\nline two\n');
  }, SLOW);

  it('has the given parent, so a later turn extends the branch', async () => {
    const repo = repoWithWork();
    const first = (await holdCommit(runGit, inputFor(repo))) ?? '';
    const second = (await holdCommit(runGit, inputFor(repo, { batch: '{"id":"0123456789abcdef","turn":2}\n' }), first)) ?? '';
    expect(git(repo, 'rev-parse', `${second}^`).trim()).toBe(first);
    expect(git(repo, 'show', `${second}:batch.json`)).toContain('"turn":2');
  }, SLOW);

  it('commits nothing for a repository that left the list, and reads nothing but the remote', async () => {
    const repo = repoWithWork();
    const calls: string[] = [];
    const watching: Git = (root, args, stdin) => {
      calls.push(args.join(' '));
      return runGit(root, args, stdin);
    };
    expect(await holdCommit(watching, inputFor(repo, { allowRepos: ['owner/other'] }))).toBeUndefined();
    expect(await holdCommit(watching, inputFor(repo, { allowRepos: [] }))).toBeUndefined();
    expect(await holdCommit(watching, inputFor(repo, { cwd: undefined }))).toBeUndefined();
    expect(calls.filter((call) => !call.startsWith('remote get-url'))).toEqual([]);
  }, SLOW);
});

/** The `origin` URL read as a cloud session shows it, with every other git call real. */
const asCloud = (git: Git): Git => (root, args, stdin) => (args[0] === 'remote' && args[1] === 'get-url' ? Promise.resolve('https://github.com/owner/name\n') : git(root, args, stdin));

/** A bare repository standing in for the private repository, and a clone of it that is the VM's checkout. */
const vmWithRemote = (): { bare: string; repo: string } => {
  const bare = mkdtempSync(join(tmpdir(), 'oars-machine-hold-bare-'));
  made.push(bare);
  cpSync(bareTemplate, bare, { recursive: true });
  const repo = repoWithWork();
  git(repo, 'remote', 'set-url', 'origin', bare);
  return { bare, repo };
};

const heldIn = (bare: string, branch: string): string => git(bare, 'rev-parse', '--verify', `refs/heads/${branch}`).trim();

describe('holdBatch', () => {
  const logged: unknown[] = [];
  const depsFor = (net: Git = runNetGit): HoldDeps => ({ git: asCloud(runGit), net, log: (error) => (logged.push(error), Promise.resolve()) });
  afterEach(() => {
    logged.length = 0;
  });

  it('pushes the commit to oars-hold/<machine>/<id> and changes nothing of the checkout', async () => {
    const { bare, repo } = vmWithRemote();
    const head = git(repo, 'rev-parse', 'HEAD');
    const index = readFileSync(join(repo, '.git', 'index'));
    const input = inputFor(repo);
    expect(await holdBatch(depsFor(), input)).toBe('pushed');
    const tip = heldIn(bare, holdBranch('m1', input.id));
    expect(git(bare, 'show', `${tip}:batch.json`)).toBe(input.batch);
    expect(git(bare, 'log', '-1', '--format=%s', tip).trim()).toContain('[skip ci]');
    expect(git(bare, 'for-each-ref', '--format=%(refname)').trim()).toBe(`refs/heads/${holdBranch('m1', input.id)}`);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(repo, '.git', 'index')).equals(index)).toBe(true);
  }, SLOW);

  it('pushes each later turn on the branch as a fast-forward, with no refusal in between', async () => {
    const { bare, repo } = vmWithRemote();
    const pushes: string[] = [];
    const counting: Git = (root, args, stdin) => (args[0] === 'push' ? (pushes.push(args.join(' ')), runNetGit(root, args, stdin)) : runNetGit(root, args, stdin));
    const input = inputFor(repo);
    expect(await holdBatch(depsFor(counting), input)).toBe('pushed');
    expect(await holdBatch(depsFor(counting), { ...input, batch: '{"turn":2}\n' })).toBe('pushed');
    expect(pushes).toHaveLength(2);
    const tip = heldIn(bare, holdBranch('m1', input.id));
    expect(git(bare, 'show', `${tip}:batch.json`)).toBe('{"turn":2}\n');
    expect(git(bare, 'rev-list', '--count', tip).trim()).toBe('2');
  }, SLOW);

  it('is refused once for a branch another VM moved, fetches its tip, and is accepted on top of it', async () => {
    const { bare, repo } = vmWithRemote();
    const other = vmWithRemote().repo;
    git(other, 'remote', 'set-url', 'origin', bare);
    const input = inputFor(repo);
    // The earlier VM of this session deposited first: its commit is the branch's tip, and this VM has never seen it.
    expect(await holdBatch(depsFor(), { ...inputFor(other), batch: '{"vm":"earlier"}\n' })).toBe('pushed');
    const earlier = heldIn(bare, holdBranch('m1', input.id));
    const pushes: string[] = [];
    const counting: Git = (root, args, stdin) => (args[0] === 'push' ? (pushes.push(args.join(' ')), runNetGit(root, args, stdin)) : runNetGit(root, args, stdin));
    expect(await holdBatch(depsFor(counting), input)).toBe('pushed');
    expect(pushes).toHaveLength(2);
    const tip = heldIn(bare, holdBranch('m1', input.id));
    expect(git(bare, 'rev-parse', `${tip}^`).trim()).toBe(earlier);
    expect(git(bare, 'show', `${tip}:batch.json`)).toBe(input.batch);
    expect(logged).toEqual([]);
  }, SLOW);

  it('is refused every time: three pushes, one log row, no throw, and the branch stays as it was', async () => {
    const { bare, repo } = vmWithRemote();
    writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const pushes: string[] = [];
    const counting: Git = (root, args, stdin) => (args[0] === 'push' ? (pushes.push(args.join(' ')), runNetGit(root, args, stdin)) : runNetGit(root, args, stdin));
    const input = inputFor(repo);
    expect(await holdBatch(depsFor(counting), input)).toBe('refused');
    expect(pushes).toHaveLength(3);
    expect(logged).toHaveLength(1);
    expect(String(logged[0])).not.toContain(input.batch);
    expect(git(bare, 'for-each-ref').trim()).toBe('');
  }, SLOW);

  it("does not run the session repository's own pre-push hook, so a project's check neither runs per Stop nor refuses the hold push", async () => {
    const { bare, repo } = vmWithRemote();
    const ran = join(repo, 'pre-push-ran');
    writeFileSync(join(repo, '.git', 'hooks', 'pre-push'), `#!/bin/sh\necho ran >> '${ran.replaceAll('\\', '/')}'\nexit 1\n`, { mode: 0o755 });
    const input = inputFor(repo);
    expect(await holdBatch(depsFor(), input)).toBe('pushed');
    expect(existsSync(ran)).toBe(false);
    expect(git(bare, 'show', `${heldIn(bare, holdBranch('m1', input.id))}:batch.json`)).toBe(input.batch);
    expect(logged).toEqual([]);
  }, SLOW);

  it('pushes nothing for a repository that left the list', async () => {
    const { bare, repo } = vmWithRemote();
    expect(await holdBatch(depsFor(), inputFor(repo, { allowRepos: ['owner/other'] }))).toBe('skipped');
    expect(git(bare, 'for-each-ref').trim()).toBe('');
    expect(logged).toEqual([]);
  }, SLOW);
});
