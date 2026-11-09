// The repository gate of a machine: `origin` in whatever form becomes `owner/name`, and a session builds only for a repository on the list. The real-git cases make a repository in a temp folder and read its `origin` the way the child does
// (`runGit`); nothing here reads the network or the store.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { originRepo, repoAllowed, repoOf } from './machine-repo.js';
import { runGit, type Git } from './survival.js';

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A repository in a temp folder whose `origin` is `remote`. */
const repoWith = (remote: string): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-machine-repo-'));
  made.push(folder);
  mkdirSync(join(folder, 'sub'));
  execFileSync('git', ['init', '-q', folder]);
  execFileSync('git', ['-C', folder, 'remote', 'add', 'origin', remote]);
  return folder;
};

describe('repoOf', () => {
  it.each([
    // The form a cloud session shows (observed): HTTPS, no credential, no `.git`.
    ['https://github.com/owner/name', 'owner/name'],
    ['https://github.com/owner/name.git', 'owner/name'],
    ['https://github.com/owner/name/', 'owner/name'],
    ['https://github.com/owner/name.git/', 'owner/name'],
    ['http://github.com/owner/name', 'owner/name'],
    ['https://GitHub.com/Owner/Name', 'owner/name'],
    ['git@github.com:owner/name.git', 'owner/name'],
    ['git@github.com:owner/name', 'owner/name'],
    ['github.com:owner/name.git', 'owner/name'],
    ['ssh://git@github.com/owner/name.git', 'owner/name'],
    ['ssh://git@github.com:22/owner/name', 'owner/name'],
    ['git://github.com/owner/name.git', 'owner/name'],
    ['https://x-access-token:ghs_abc123@github.com/owner/name.git', 'owner/name'],
    ['https://token@github.com/owner/name', 'owner/name'],
    ['  https://github.com/owner/name.git\n', 'owner/name'],
    ['https://github.com/my-org/my.repo-2_x', 'my-org/my.repo-2_x'],
  ])('reads %s as %s', (url, repo) => {
    expect(repoOf(url)).toBe(repo);
  });

  it.each([
    [''],
    ['https://github.com/owner'],
    ['https://github.com/owner/name/extra'],
    ['https://github.com//name'],
    ['https://gitlab.com/owner/name'],
    ['https://github.com.evil.example/owner/name'],
    ['https://evilgithub.com/owner/name'],
    ['https://example.com/github.com/owner/name'],
    ['git@gitlab.com:owner/name.git'],
    ['/srv/git/owner/name.git'],
    ['file:///srv/git/owner/name'],
    ['https://github.com/../name'],
    ['https://github.com/owner/..'],
  ])('reads %j as no repository', (url) => {
    expect(repoOf(url)).toBeUndefined();
  });

  it('keeps no credential in what it returns', () => {
    expect(repoOf('https://user:s3cr3t-token@github.com/owner/name.git')).toBe('owner/name');
  });
});

describe('originRepo', () => {
  it('asks git for the origin in the session folder and normalizes the answer', async () => {
    const asked: { root: string; args: readonly string[] }[] = [];
    const git: Git = (root, args) => {
      asked.push({ root, args });
      return Promise.resolve('https://github.com/Owner/Name\n');
    };
    expect(await originRepo(git, '/work/repo')).toBe('owner/name');
    expect(asked).toEqual([{ root: '/work/repo', args: ['remote', 'get-url', 'origin'] }]);
  });

  it('answers nothing when git fails (no repository, no origin)', async () => {
    expect(await originRepo(() => Promise.reject(new Error('fatal: not a git repository')), '/work')).toBeUndefined();
  });

  it.each([['https://github.com/owner/name'], ['git@github.com:owner/name.git'], ['ssh://git@github.com/Owner/Name.git']])('reads the real origin %s from a repository, in a subfolder too', async (remote) => {
    const folder = repoWith(remote);
    expect(await originRepo(runGit, folder)).toBe('owner/name');
    expect(await originRepo(runGit, join(folder, 'sub'))).toBe('owner/name');
  });

  it('reads the form git rewrites through insteadOf: the rewritten HTTPS remote, not the stored SSH one', async () => {
    const folder = repoWith('git@github.com:owner/name.git');
    execFileSync('git', ['-C', folder, 'config', 'url.https://github.com/.insteadOf', 'git@github.com:']);
    expect(await originRepo(runGit, folder)).toBe('owner/name');
  });

  it('answers nothing for a folder with no origin, and for a remote on another host', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'oars-machine-repo-'));
    made.push(bare);
    execFileSync('git', ['init', '-q', bare]);
    expect(await originRepo(runGit, bare)).toBeUndefined();
    expect(await originRepo(runGit, repoWith('https://gitlab.com/owner/name'))).toBeUndefined();
  });
});

describe('repoAllowed', () => {
  const git = (url: string): Git => () => Promise.resolve(url);

  it('allows a repository on the list, over HTTPS, SSH, and the observed form', async () => {
    for (const url of ['https://github.com/owner/name', 'git@github.com:owner/name.git', 'ssh://git@github.com/owner/name.git', 'https://github.com/owner/name.git']) {
      expect(await repoAllowed(['other/one', 'owner/name'], '/work', git(url))).toBe(true);
    }
  });

  it('allows nothing off the list, with an empty list, or with no session folder', async () => {
    expect(await repoAllowed(['owner/name'], '/work', git('https://github.com/owner/other'))).toBe(false);
    expect(await repoAllowed(['owner/name'], '/work', git('https://github.com/other/name'))).toBe(false);
    expect(await repoAllowed([], '/work', git('https://github.com/owner/name'))).toBe(false);
    expect(await repoAllowed(['owner/name'], undefined, git('https://github.com/owner/name'))).toBe(false);
    expect(await repoAllowed(['owner/name'], '/work', () => Promise.reject(new Error('no origin')))).toBe(false);
    expect(await repoAllowed(['owner/name'], '/work', git('https://gitlab.com/owner/name'))).toBe(false);
  });
});
