// The repository root a working directory sits in, for hashing file paths from the repository rather than from wherever the harness ran
// (t711 Section 1.1, CAPTURE 4). A linked worktree under `<root>/.claude/worktrees/<name>` resolves to `<root>`, as A9 counted it; any
// other directory resolves to the nearest ancestor holding a `.git` entry (a folder, or the file a linked worktree keeps). The walk
// looks at the file system rather than running `git rev-parse`, so it costs no process per distinct directory and still answers for a
// directory that has since been deleted (it walks up to the nearest ancestor that exists). Absent a repository it answers null.
import { existsSync } from 'node:fs';
import { posix } from 'node:path';

const WORKTREE = /^(.+?)\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/;

/** A resolver for working directories; answers are cached, since a transcript repeats a handful of directories thousands of times. */
export const makeRepoRoot = (exists: (path: string) => boolean = existsSync): ((cwd: string) => string | null) => {
  const cache = new Map<string, string | null>();
  return (cwd) => {
    const start = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    const known = cache.get(start);
    if (known !== undefined) return known;
    const linked = WORKTREE.exec(start);
    let found: string | null = linked?.[1] ?? null;
    for (let dir = start; found === null; dir = posix.dirname(dir)) {
      if (exists(`${dir}/.git`)) found = dir;
      else if (posix.dirname(dir) === dir) break;
    }
    cache.set(start, found);
    return found;
  };
};
