// The holding route of a machine, the VM side: a cloud VM keeps its deposit in its own private repository. Each batch the machine child builds is committed to the branch `oars-hold/<machine>/<id>` with git plumbing
// (`hash-object`, `mktree`, `commit-tree`), so the session's `HEAD`, index, and working tree are never touched, and the commit is pushed from there (`holdBatch`, below). The commit holds three files: `batch.json` (the batch
// as `oars pool outbox` prints it), `stamp` (the client's batch stamp), and `terms` (a keyed digest of the exclusion terms the batch was gated under, so a reader with another list can tell). Admission is the trusted side's.
import { execFile } from 'node:child_process';
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

/** Where a push or a fetch may wait: the cloud proxy answers a push in seconds, and a hung one must not hold the child's lock for good. */
const NET_TIMEOUT_MS = 120_000;

/**
 * Runs one git command that talks to a remote (`push`, `fetch`), with the transports a remote needs (`runGit` allows none) and no terminal prompt, so a missing credential fails the push instead of asking. Rejects on any non-zero exit;
 * the message is kept for the caller's own use and is never logged by this module, since a remote's error text can carry its URL.
 */
export const runNetGit: Git = (root, args) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', root, ...args],
      { encoding: 'utf8', timeout: NET_TIMEOUT_MS, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined } },
      (error, stdout) => {
        if (error === null) resolve(stdout);
        else reject(new Error(error.message));
      },
    );
  });

export interface HoldDeps {
  /** Local plumbing and the `origin` URL read (`runGit`, which allows no transport). */
  git: Git;
  /** Push and fetch (`runNetGit`). */
  net: Git;
  /** One line in the step log, for a push that was refused every time. */
  log: (error: unknown) => Promise<void>;
}

export type HoldResult = 'pushed' | 'refused' | 'skipped';

/** A refused push is tried again on top of the branch's fetched tip, three attempts in all. */
export const HOLD_ATTEMPTS = 3;

/** The branch's last known tip, kept under a private ref that no checkout shows (`git branch` lists `refs/heads` only): the commit this VM pushed last, or the tip a refused push fetched. */
const tipOf = async (git: Git, cwd: string, seen: string): Promise<string | undefined> => (await git(cwd, ['rev-parse', '--verify', '--quiet', `${seen}^{commit}`]).catch(() => '')).trim() || undefined;

/**
 * Commits the batch (`holdCommit`) and pushes it to `oars-hold/<machine>/<id>`. The first push builds on the tip this VM last knew, so a session's later turns are fast-forwards. A refused push is treated as refused whatever the reason, and its message is not read:
 * the child fetches the branch's tip (an earlier VM of the session may have moved it), commits again on top of it, and pushes, up to three attempts in all. A third refusal writes one log row and returns `refused`; the batch stays in the outbox
 * and the next Stop rebuilds the session whole. `skipped` is a repository that is not on the operator's list now, or a session with no folder. Nothing here throws for a refusal.
 */
export const holdBatch = async (deps: HoldDeps, input: HoldInput): Promise<HoldResult> => {
  const cwd = input.cwd;
  if (cwd === undefined) return 'skipped';
  const branch = holdBranch(input.machine, input.id);
  const seen = `refs/oars-hold/${input.machine}/${input.id}`;
  let parent = await tipOf(deps.git, cwd, seen);
  for (let attempt = 1; attempt <= HOLD_ATTEMPTS; attempt += 1) {
    const commit = await holdCommit(deps.git, input, parent);
    if (commit === undefined) return 'skipped';
    // `--no-verify`: the session repository's own `pre-push` hook (husky, or a `core.hooksPath` its install step set) is the project's, not ours, and could run its checks at every Stop under the send lock or refuse every hold push, losing the batch with the VM.
    const accepted = await deps.net(cwd, ['push', '--no-verify', 'origin', `${commit}:refs/heads/${branch}`]).then(() => true, () => false);
    if (accepted) {
      // Bookkeeping only: a failure here must not turn an accepted push into a retry.
      await deps.git(cwd, ['update-ref', seen, commit]).catch(() => undefined);
      return 'pushed';
    }
    if (attempt < HOLD_ATTEMPTS) {
      await deps.net(cwd, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${seen}`]).catch(() => undefined);
      parent = (await tipOf(deps.git, cwd, seen)) ?? parent;
    }
  }
  await deps.log(new Error(`a hold push of ${branch} was refused ${String(HOLD_ATTEMPTS)} times; the batch stays in the outbox`));
  return 'refused';
};
