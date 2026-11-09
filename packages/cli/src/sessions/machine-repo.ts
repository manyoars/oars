// The repository gate of a machine: a cloud VM, a VPS, or a runner builds a session's deposit only when the repository it ran in is on the operator's list (`OARS_ALLOW_REPOS`, `owner/name`, fixed at enrollment). The repository is read
// from `git remote get-url origin` in the session's folder and normalized to `owner/name`, whatever form the remote takes. A cloud session's `origin` is `https://github.com/<owner>/<name>` (no credential, no `.git`); a VPS clone is as often
// `git@github.com:<owner>/<name>.git`, and git itself rewrites a form through `url.<base>.insteadOf` before this sees it. Only github.com is read: the list names GitHub repositories (their visibility is checked at enrollment), so an
// `owner/name` on another host is a different repository and matches nothing here. A remote this cannot read, a folder with no `origin`, and an empty list all allow nothing.
import type { Git } from './survival.js';

// `user[:token]@` is allowed before the host and is never kept: the match below captures the path only, so a credential in a remote URL cannot reach a log or a result.
const URL_FORM = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/iu;
const SCP_FORM = /^(?:[^@/\s]+@)?github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/iu;

/** `owner/name`, lowercased (GitHub names are case-insensitive), from a GitHub remote URL in any common form; `undefined` for anything else. */
export const repoOf = (url: string): string | undefined => {
  const found = URL_FORM.exec(url.trim()) ?? SCP_FORM.exec(url.trim());
  if (found === null) return undefined;
  const owner = found[1];
  const name = found[2];
  if (owner === undefined || name === undefined || /^\.+$/u.test(owner) || /^\.+$/u.test(name)) return undefined;
  return `${owner}/${name}`.toLowerCase();
};

/** The repository `origin` names in `cwd`, or `undefined` when the folder is not a repository, has no `origin`, or names one this cannot read. The URL itself is never returned or logged. */
export const originRepo = async (git: Git, cwd: string): Promise<string | undefined> => {
  try {
    return repoOf(await git(cwd, ['remote', 'get-url', 'origin']));
  } catch {
    return undefined;
  }
};

/** Whether the session's folder is a repository on the allow list (`MachineConfig.allowRepos`, already lowercased). A session that forwarded no folder, or an empty list, allows nothing. */
export const repoAllowed = async (allowRepos: readonly string[], cwd: string | undefined, git: Git): Promise<boolean> => {
  if (cwd === undefined || allowRepos.length === 0) return false;
  const repo = await originRepo(git, cwd);
  return repo !== undefined && allowRepos.includes(repo);
};
