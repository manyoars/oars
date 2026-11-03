import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each case spawns git and node processes; under load that takes well past vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000 });

const script = fileURLToPath(new URL('./check-private-names.mjs', import.meta.url));
const hooksDir = fileURLToPath(new URL('../.githooks', import.meta.url)).replaceAll('\\', '/');

// Invented terms: nothing here is a real name.
const TERM = 'zorblax';
const OTHER = 'quuxenfrob';

let root: string;
let work: string;
let remote: string;
let env: NodeJS.ProcessEnv;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (file: string, text: string, message = 'add file') => {
  writeFileSync(join(work, file), text);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', message);
  return git(work, 'rev-parse', 'HEAD');
};
const check = (sha: string) => spawnSync('node', [script, sha], { cwd: work, encoding: 'utf8', env });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oars-names-'));
  work = join(root, 'work');
  remote = join(root, 'remote.git');
  mkdirSync(work);
  writeFileSync(join(root, 'terms.txt'), `\n${TERM}\n`);
  writeFileSync(join(root, 'deny.txt'), `${OTHER}\n`);
  writeFileSync(join(root, 'gitconfig'), '[user]\n\tname = T\n\temail = t@example.test\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
  env = { ...process.env, OARS_EXCLUSION_TERMS: join(root, 'terms.txt'), OARS_PUBLIC_DENYLIST: join(root, 'deny.txt'), GIT_CONFIG_GLOBAL: join(root, 'gitconfig') };
  git(root, 'init', '-q', '--bare', remote);
  git(work, 'init', '-q');
  git(work, 'remote', 'add', 'origin', remote);
  commit('a.txt', 'clean\n', 'first');
  git(work, 'push', '-q', 'origin', 'main');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('check-private-names', () => {
  it('blocks a listed term in an added line and prints the commit, file, and line only', () => {
    const sha = commit('b.txt', `ok\nsee ${TERM.toUpperCase()} here\n`);
    const r = check(sha);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${sha.slice(0, 10)} b.txt:2`);
    expect(r.stderr.toLowerCase()).not.toContain(TERM);
    expect(r.stderr).not.toContain('see ');
    expect(r.stdout).toBe('');
  });

  it('reads the second list too', () => {
    const r = check(commit('b.txt', `${OTHER}\n`));
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain(OTHER);
  });

  it('blocks a listed term in a commit message', () => {
    const r = check(commit('b.txt', 'clean\n', `note about ${TERM}`));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('message');
    expect(r.stderr).not.toContain(TERM);
    expect(r.stderr).not.toContain('note about');
  });

  it('passes a commit that only removes the term', () => {
    commit('b.txt', `${TERM}\nkeep\n`);
    git(work, 'push', '-q', 'origin', 'main'); // already public: out of reach, and a later removal must pass
    expect(check(commit('b.txt', 'keep\n', 'drop it')).status).toBe(0);
  });

  it('scans a new branch that origin has never seen', () => {
    git(work, 'checkout', '-q', '-b', 'topic');
    commit('b.txt', 'clean\n', 'clean one');
    const sha = commit('c.txt', `${TERM}\n`, 'second');
    const r = check(sha);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('c.txt:1');
    expect(r.stderr).not.toContain('b.txt');
  });

  it('passes a branch that merges origin/main whose old commits hold the term', () => {
    commit('old.txt', `${TERM}\n`, 'old leak');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', '-b', 'topic', 'HEAD~1');
    commit('t.txt', 'clean\n', 'topic work');
    git(work, 'merge', '-q', '--no-edit', 'origin/main');
    expect(check(git(work, 'rev-parse', 'HEAD')).status).toBe(0);
  });

  it('warns on stderr and passes when a list is missing', () => {
    rmSync(join(root, 'terms.txt'));
    rmSync(join(root, 'deny.txt'));
    const r = check(commit('b.txt', `${TERM}\n`));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('OARS_EXCLUSION_TERMS not found');
    expect(r.stderr).toContain('OARS_PUBLIC_DENYLIST not found');
  });

  it('still enforces the list that exists when the other is missing', () => {
    rmSync(join(root, 'deny.txt'));
    const r = check(commit('b.txt', `${TERM}\n`));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('OARS_PUBLIC_DENYLIST not found');
  });

  it('exits 2 with usage when no sha is given', () => {
    const r = spawnSync('node', [script], { cwd: work, encoding: 'utf8', env });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage');
  });
});

describe('pre-push hook, end to end', () => {
  const push = (...args: string[]) => spawnSync('git', ['push', ...args], { cwd: work, encoding: 'utf8', env });

  beforeEach(() => {
    git(work, 'config', 'core.hooksPath', hooksDir);
  });

  it('refuses a push holding the term, then allows it once the term is gone', () => {
    commit('b.txt', `${TERM}\n`);
    const refused = push('origin', 'main');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('b.txt:1');
    expect(refused.stderr).not.toContain(TERM);
    expect(git(remote, 'rev-parse', 'main')).not.toBe(git(work, 'rev-parse', 'HEAD'));

    git(work, 'reset', '-q', '--hard', 'HEAD~1');
    commit('b.txt', 'clean\n', 'clean version');
    const allowed = push('origin', 'main');
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(git(remote, 'rev-parse', 'main')).toBe(git(work, 'rev-parse', 'HEAD'));
  });

  it('lets a branch delete through', () => {
    git(work, 'branch', 'gone');
    expect(push('origin', 'gone').status).toBe(0);
    const del = push('origin', '--delete', 'gone');
    expect(del.status, del.stderr).toBe(0);
  });
});
