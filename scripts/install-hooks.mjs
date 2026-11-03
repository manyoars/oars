// `just hooks`: points core.hooksPath at the main checkout's .githooks by absolute path. Worktrees share one config, so a relative
// path would resolve inside each worktree and skip the hook on any branch that predates .githooks/.
// Usage: node scripts/install-hooks.mjs [repo dir]   (default: the current directory)
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

/** Sets core.hooksPath for the repository at `cwd` and returns the path it wrote (forward slashes, which Git for Windows reads). */
export const installHooks = (/** @type {string} */ cwd) => {
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const hooks = join(dirname(common), '.githooks').split(String.fromCharCode(92)).join('/');
  git(cwd, ['config', 'core.hooksPath', hooks]);
  return hooks;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`core.hooksPath = ${installHooks(process.argv[2] ?? process.cwd())}\n`);
}
