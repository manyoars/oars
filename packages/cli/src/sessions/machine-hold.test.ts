// The hold commit of a machine's batch (`machine-hold.ts`): the terms digest, and the commit made with git plumbing in a real repository in a temp folder. Nothing reads the network or the store.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { holdBranch, holdCommit, termsDigest, type HoldInput } from './machine-hold.js';
import { runGit, type Git } from './survival.js';

// Each case runs a dozen git processes, which a Windows runner starts slowly.
const SLOW = 60_000;

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

/** A repository in a temp folder with one commit, `origin` named as a cloud session shows it, one staged change, and one unstaged edit. */
const repoWithWork = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-machine-hold-'));
  made.push(folder);
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
