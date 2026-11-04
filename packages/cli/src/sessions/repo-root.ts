// The repository root a working directory sits in, for hashing file paths from the repository rather than from wherever the harness ran
// (spec Section 1.1, CAPTURE 4). A linked worktree under `<root>/.claude/worktrees/<name>` resolves to `<root>`, as A9 counted it; any
// other directory resolves to the nearest ancestor holding a `.git` entry (a folder, or the file a linked worktree keeps). The walk
// looks at the file system rather than running `git rev-parse`, so it costs no process per distinct directory and still answers for a
// directory that has since been deleted (it walks up to the nearest ancestor that exists). Absent a repository it answers null.
//
// `makeRepoIdentity` names the repository itself, so two clones of one repository, or one clone on two machines, share a `repo` value:
// the normalized `origin` remote URL read from the repository's `config` (no git process), else the absolute root path.
import { existsSync, readFileSync } from 'node:fs';
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
    // posix.dirname('C:') is '.', which would probe the deposit process's own directory: stop at a drive or filesystem root first.
    for (let dir = start; found === null; ) {
      if (exists(`${dir}/.git`)) found = dir;
      const parent = posix.dirname(dir);
      if (found !== null || parent === '.' || parent === dir) break;
      dir = parent;
    }
    cache.set(start, found);
    return found;
  };
};

/** `https://User:pw@GitHub.com/org/repo.git`, `git@github.com:org/repo.git`, and `ssh://git@github.com/org/repo/` all read `github.com/org/repo`. */
export const normalizeRemote = (url: string): string => {
  const bare = url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/]*@/, '')
    .replace(/^([^/:]+):(?!\d+(?:\/|$))/, '$1/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const slash = bare.indexOf('/');
  return slash < 0 ? bare.toLowerCase() : `${bare.slice(0, slash).toLowerCase()}${bare.slice(slash)}`;
};

/** The `url` of `[remote "origin"]` in a git `config`, or null. */
const originUrl = (config: string): string | null => {
  let inOrigin = false;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[(.*)\]\s*$/.exec(line);
    if (section !== null) inOrigin = /^remote\s+"origin"$/i.test(section[1] ?? '');
    else if (inOrigin) {
      const url = /^\s*url\s*=\s*(.+?)\s*$/i.exec(line);
      if (url !== null) return url[1] ?? null;
    }
  }
  return null;
};

const isAbsolutePath = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:\//.test(path);
const resolveFrom = (base: string, path: string): string => (isAbsolutePath(path) ? path : posix.normalize(`${base}/${path}`));

/** The text of a file, or null when it cannot be read. */
const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/**
 * A resolver from a repository root to its identity string: `origin:<normalized remote>` when the repository's `config` names an
 * `origin`, else `path:<root>`. The `config` is `<root>/.git/config`, or for a linked worktree (`.git` is a file) the common
 * directory's, reached through the file's `gitdir:` line and that directory's `commondir` file. Any step failing falls back to the path.
 */
export const makeRepoIdentity = (read: (path: string) => string | null = readOrNull): ((root: string) => string) => {
  const cache = new Map<string, string>();
  const configOf = (root: string): string | null => {
    const direct = read(`${root}/.git/config`);
    if (direct !== null) return direct;
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(read(`${root}/.git`) ?? '')?.[1];
    if (pointer === undefined) return null;
    const gitdir = resolveFrom(root, pointer);
    const common = read(`${gitdir}/commondir`)?.trim();
    return read(`${common === undefined || common === '' ? gitdir : resolveFrom(gitdir, common)}/config`);
  };
  return (root) => {
    const known = cache.get(root);
    if (known !== undefined) return known;
    const url = originUrl(configOf(root) ?? '');
    const identity = url === null ? `path:${root.toLowerCase()}` : `origin:${normalizeRemote(url)}`;
    cache.set(root, identity);
    return identity;
  };
};
