// The scopes a name is new in: the whole record (fleet), one repository, and one session. A repository is named by the slug Claude Code gives its project folder, with a
// worktree counted as its repository, so a replay (which reads project folders) and a hook (which is handed a working directory) name the same repository the same way.
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { slugOf } from '../sessions/allow.js';

/** Claude Code names a worktree's folder `<repository>--claude-worktrees-<name>`, and a worktree is its repository. */
export const repositoryOf = (project: string): string => project.replace(/--claude-worktrees-.*$/, '');

const WORKTREE_FOLDER = /[\\/]\.claude[\\/]worktrees[\\/].*$/;
const LEVELS = 12;

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * The repository a working directory is in: its nearest ancestor holding `.git` (a file in a worktree), after a worktree folder is taken off. The hook is handed
 * where the session is now, which can be a subfolder; a few `stat` calls are all it costs.
 */
export const repositoryOfCwd = async (cwd: string): Promise<string> => {
  const base = cwd.replace(WORKTREE_FOLDER, '');
  let folder = base;
  for (let level = 0; level < LEVELS; level += 1) {
    if (await exists(join(folder, '.git'))) return repositoryOf(slugOf(folder));
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return repositoryOf(slugOf(base));
};
