import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHooks } from './install-hooks.mjs';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;
const saved: NodeJS.ProcessEnv = {};
const GIT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];

// A run under a hook or `git rebase --exec` inherits these, and they would send every git call to the real repository.
beforeAll(() => {
  for (const k of GIT_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const k of GIT_VARS) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
  }
});
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'oars-hooks-')));
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
});
