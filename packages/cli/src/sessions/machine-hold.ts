// The holding route of a machine, the VM side: a cloud VM keeps its deposit in its own private repository. Each batch the machine child builds is committed to the branch `oars-hold/<machine>/<id>` with git plumbing
// (`hash-object`, `mktree`, `commit-tree`), so the session's `HEAD`, index, and working tree are never touched, and the commit is pushed from there (`holdBatch`, below). The commit holds three files: `batch.json` (the batch
// as `oars pool outbox` prints it), `stamp` (the client's batch stamp), and `terms` (a keyed digest of the exclusion terms the batch was gated under, so a reader with another list can tell). Admission is the trusted side's.
import { createHmac } from 'node:crypto';
import { repoAllowed } from './machine-repo.js';
import type { Git } from './survival.js';

/** What one commit needs: the folder the session ran in and the operator's list (the repository is checked again here), the branch's two names, the three files' contents, and the salt the terms digest is keyed with. */
export interface HoldInput {
  cwd: string | undefined;
  allowRepos: readonly string[];
  machine: string;
  id: string;
  /** The batch's bytes, as the outbox holds them. */
  batch: string;
  stamp: string;
  /** The term list the batch was gated under, as the term file holds it. */
  terms: readonly string[];
  /** `OARS_SESSION_SALT`. */
  salt: string;
}

/** The branch a session's batch is held on. The proxy of a cloud session takes branches only, so the namespace is a branch prefix. */
export const holdBranch = (machine: string, id: string): string => `oars-hold/${machine}/${id}`;

/**
 * `HMAC-SHA-256(salt, list)` in hex, where the list is the terms trimmed and lowercased (as `loadTerms` reads them), blanks dropped, then deduped, sorted, and joined with newlines: one list gives one digest in any order, case, or
 * blank lines. It is keyed so that a reader of the branch cannot test a guessed term against it; it detects a stale list, not a forged one, since the VM holds the salt and the list both.
 */
export const termsDigest = (salt: string, terms: readonly string[]): string => {
  const list = [...new Set(terms.map((term) => term.trim().toLowerCase()).filter((term) => term !== ''))].sort().join('\n');
  return createHmac('sha256', salt).update(list).digest('hex');
};

// A hold commit is made by oars, not by the person: its own identity, and no signing, so a VM with no `user.name` or a signing key set globally still commits.
const IDENTITY = ['-c', 'user.name=oars', '-c', 'user.email=oars@users.noreply.github.com', '-c', 'commit.gpgsign=false'];

/** Writes `content` as a blob exactly as given: `--no-filters`, so a repository's line-ending settings cannot change the batch's bytes. */
const blobOf = async (git: Git, cwd: string, content: string): Promise<string> => (await git(cwd, ['hash-object', '-w', '--no-filters', '--stdin'], content)).trim();

/**
 * Commits the batch to a tree of its own and returns the commit's sha, or `undefined` when the repository is not on the operator's list now: a batch whose repository left `OARS_ALLOW_REPOS` after it was built is not committed.
 * Nothing but objects is written (no ref, no `HEAD`, no index, no file), and the commit's message says `[skip ci]`, so a hold push starts no workflow. `parent` is the branch's tip when it has one.
 */
export const holdCommit = async (git: Git, input: HoldInput, parent?: string): Promise<string | undefined> => {
  if (input.cwd === undefined || !(await repoAllowed(input.allowRepos, input.cwd, git))) return undefined;
  const files = [
    ['batch.json', input.batch],
    ['stamp', `${input.stamp}\n`],
    ['terms', `${termsDigest(input.salt, input.terms)}\n`],
  ] as const;
  const entries: string[] = [];
  for (const [name, content] of files) entries.push(`100644 blob ${await blobOf(git, input.cwd, content)}\t${name}\n`);
  const tree = (await git(input.cwd, ['mktree'], entries.join(''))).trim();
  const message = `oars hold ${input.id} [skip ci]`;
  return (await git(input.cwd, [...IDENTITY, 'commit-tree', tree, ...(parent === undefined ? [] : ['-p', parent]), '-m', message])).trim();
};
