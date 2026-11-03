import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each case spawns git and node processes; under load that takes well past vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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

  it('does not read an added line that starts with the file-header marker as a header', () => {
    const r = check(commit('b.txt', `++ b/${TERM}\n`));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('b.txt:1');
    expect(r.stderr).not.toContain(TERM);
  });

  it('names the file for a non-ASCII name, a later file, a name with a space, and diff.noprefix', () => {
    git(work, 'config', 'diff.noprefix', 'true');
    writeFileSync(join(work, 'a.txt'), 'clean\nmore\n');
    writeFileSync(join(work, 'é.txt'), 'clean\n');
    writeFileSync(join(work, 'my file.txt'), `${TERM}\n`);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'several files');
    const r = check(git(work, 'rev-parse', 'HEAD'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ my file\.txt:1\n/);
    expect(r.stderr).not.toContain('a.txt');
    const second = commit('é2.txt', `${TERM}\n`, 'non-ascii');
    expect(check(second).stderr).toContain(' é2.txt:1\n');
  });

  it('withholds a file path that holds a listed term', () => {
    const r = check(commit(`${TERM}2.txt`, `${TERM}\n`));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('<path withheld>:1');
    expect(r.stderr.toLowerCase()).not.toContain(TERM);
  });

  it('fails closed on a list that is not UTF-8', () => {
    writeFileSync(join(root, 'terms.txt'), Buffer.from(`\ufeff${TERM}\n`, 'utf16le'));
    const r = check(commit('b.txt', `${TERM}\n`));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('OARS_EXCLUSION_TERMS is not UTF-8');
  });

  it('warns when a list exists but holds no terms', () => {
    writeFileSync(join(root, 'terms.txt'), '\n  \n');
    const r = check(commit('b.txt', 'clean\n'));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('OARS_EXCLUSION_TERMS is empty');
  });

  it('finds the default lists under CLAUDE_CONFIG_DIR', () => {
    const dir = join(root, 'cfg');
    mkdirSync(join(dir, 'session-commons'), { recursive: true });
    writeFileSync(join(dir, 'session-commons', 'exclusion-terms.txt'), `${TERM}\n`);
    const own: NodeJS.ProcessEnv = { ...env, CLAUDE_CONFIG_DIR: dir };
    delete own.OARS_EXCLUSION_TERMS;
    delete own.OARS_PUBLIC_DENYLIST;
    const sha = commit('b.txt', `${TERM}\n`);
    const r = spawnSync('node', [script, sha], { cwd: work, encoding: 'utf8', env: own });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain('OARS_EXCLUSION_TERMS not found');
  });

  it('blocks a conflict resolution that adds the term, and names its line', () => {
    git(work, 'checkout', '-q', '-b', 'topic');
    commit('a.txt', 'topic\n', 'topic edit');
    git(work, 'checkout', '-q', 'main');
    commit('a.txt', 'main\n', 'main edit');
    spawnSync('git', ['merge', 'topic'], { cwd: work, encoding: 'utf8', env });
    writeFileSync(join(work, 'a.txt'), `main\n${TERM}\n`);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'resolve');
    const r = check(git(work, 'rev-parse', 'HEAD'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('a.txt:2');
    expect(r.stderr).not.toContain(TERM);
  });

  it('blocks a file added inside a merge commit', () => {
    git(work, 'checkout', '-q', '-b', 'topic');
    commit('t.txt', 'clean\n', 'topic work');
    git(work, 'checkout', '-q', 'main');
    commit('m.txt', 'clean\n', 'main work');
    git(work, 'merge', '-q', '--no-commit', '--no-ff', 'topic');
    writeFileSync(join(work, 'new.txt'), `${TERM}\n`);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'merge with an extra file');
    const r = check(git(work, 'rev-parse', 'HEAD'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('new.txt:1');
  });

  it('reports the real line when a hunk header carries function context holding a plus-number', () => {
    git(work, 'config', 'diff.default.xfuncname', '^(int.*)$');
    writeFileSync(join(work, '.gitattributes'), '*.c diff=default\n');
    // The line chosen as the hunk header's function context holds " +99 @@", which a greedy match would take as the new line.
    commit('f.c', 'int a; /* +99 @@ */\nx\nx\nx\n', 'base c');
    commit('f.c', `int a; /* +99 @@ */\nx\nx\nx\n${TERM}\n`, 'edit c');
    const r = check(git(work, 'rev-parse', 'HEAD'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('f.c:5');
    expect(r.stderr).not.toContain('f.c:99');
  });

  it('withholds the path when git quotes it (a tab in the name) and never names the file listed before it', () => {
    // Git for Windows refuses a tab in a path, so the tree is built with plumbing (mktree -z takes any name).
    const blobOf = (text: string) => spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: work, encoding: 'utf8', env, input: text }).stdout.trim();
    const entries = [`100644 blob ${blobOf('clean\n')}\tother.txt`, `100644 blob ${blobOf(`${TERM}\n`)}\ttab\there.txt`];
    const tree = spawnSync('git', ['mktree', '-z'], { cwd: work, encoding: 'utf8', env, input: entries.map((e) => `${e}\0`).join('') }).stdout.trim();
    const sha = git(work, 'commit-tree', tree, '-p', 'HEAD', '-m', 'tabbed name');
    const r = check(sha);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('<path withheld>:1');
    expect(r.stderr).not.toContain('other.txt');
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

  it('checks every pushed ref, not only the first', () => {
    git(work, 'checkout', '-q', '-b', 'c1');
    commit('c1.txt', 'clean\n', 'clean ref');
    git(work, 'checkout', '-q', '-b', 'c2', 'main');
    commit('c2.txt', `${TERM}\n`, 'ref with the term');
    const r = push('origin', 'c1', 'c2');
    expect(r.status).not.toBe(0);
    const heads = spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/c2'], { cwd: remote });
    expect(heads.status).not.toBe(0);
  });

  it('lets a branch delete through', () => {
    git(work, 'branch', 'gone');
    expect(push('origin', 'gone').status).toBe(0);
    const del = push('origin', '--delete', 'gone');
    expect(del.status, del.stderr).toBe(0);
  });
});
