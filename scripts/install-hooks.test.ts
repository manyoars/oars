import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHooks } from './install-hooks.mjs';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const script = fileURLToPath(new URL('./install-hooks.mjs', import.meta.url));

let root: string;
const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE, index: process.env.GIT_INDEX_FILE };

// A run under a hook or `git rebase --exec` inherits these, and they would send every git call to the real repository.
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
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

beforeEach(() => {
  // `.native` because the runner's temp folder arrives as an 8.3 short name (C:/Users/RUNNER~1) that plain realpathSync keeps and git expands.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'oars-hooks-')));
  git(root, 'init', '-q', 'main');
  git(join(root, 'main'), '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'first');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('installHooks', () => {
  it('writes the main checkout path, also when run from a linked worktree', () => {
    const main = join(root, 'main');
    const expected = main.split(String.fromCharCode(92)).join('/') + '/.githooks';
    git(main, 'worktree', 'add', '-q', join(root, 'wt'), '-b', 'topic');
    expect(installHooks(join(root, 'wt'))).toBe(expected);
    expect(git(main, 'config', 'core.hooksPath')).toBe(expected);
    expect(git(join(root, 'wt'), 'config', 'core.hooksPath')).toBe(expected);
  });

  it('runs the way `just hooks` runs it: prints the path it wrote, for a folder argument and for the current directory', () => {
    const main = join(root, 'main');
    const expected = main.split(String.fromCharCode(92)).join('/') + '/.githooks';
    git(main, 'worktree', 'add', '-q', join(root, 'wt'), '-b', 'topic');
    // `root` is no repository, so only the argument can name the one to configure.
    const withFolder = spawnSync('node', [script, join(root, 'wt')], { cwd: root, encoding: 'utf8' });
    expect(withFolder.status, withFolder.stderr).toBe(0);
    expect(withFolder.stdout).toBe(`core.hooksPath = ${expected}\n`);
    expect(git(main, 'config', 'core.hooksPath')).toBe(expected);
    git(main, 'config', '--unset', 'core.hooksPath');
    const fromHere = spawnSync('node', [script], { cwd: join(root, 'wt'), encoding: 'utf8' });
    expect(fromHere.status, fromHere.stderr).toBe(0);
    expect(fromHere.stdout).toBe(`core.hooksPath = ${expected}\n`);
    expect(git(main, 'config', 'core.hooksPath')).toBe(expected);
  });
});
