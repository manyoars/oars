// A later reversion of the work a prompt did, read from the calls alone. Three ties: a clean `git revert <word>` whose word is a prefix of a commit sha the capture kept (or the other way round); an edit whose old and new text
// are the swap of an earlier edit's on the same path, or a Write that sets the text an earlier Write of that path set after a different Write changed it (both from the digests of the exact text); and a clean `git restore` or
// `git checkout --` that names a path an earlier edit changed. The result is descriptive: it says the work was undone later, never that it was wrong or that undoing it was the reason. The original outcome stays as it was and this sits beside it.
import { EDITS, SHELL } from './extract.js';
import type { Store } from './store.js';

/** Where the nearest later reversion ran: in the prompt that did the work, in a later prompt of that session, or in a later session of the same repository. */
export type Reversion = 'same-prompt' | 'later-prompt' | 'later-session';

const NEAREST_FIRST: readonly Reversion[] = ['same-prompt', 'later-prompt', 'later-session'];

/** The shortest abbreviation git prints, and a full sha. Anything else a revert names (`HEAD`, a branch, a range, a short guess) is not a sha, so it ties to nothing. */
const SHA = /^[0-9a-f]{7,40}$/;

/**
 * The sha-shaped words of a segment that is `git revert <words>`. A bare `git revert` is `--abort`, `--continue`, or `--quit` with the flag dropped, and names nothing. A `--no-commit` revert reads the same as a committed one,
 * because the flag is not kept.
 */
const revertWords = (run: string): string[] => (run.startsWith('git revert ') ? run.slice('git revert '.length).split(' ').map((word) => word.toLowerCase()).filter((word) => SHA.test(word)) : []);

/** Where a call sits: its session, its position there, the position of a pair inside it (a MultiEdit holds several edits in order), its time, and its prompt. */
interface Place {
  session: string;
  n: number;
  k: number;
  ts: string | null;
  prompt: number;
}

interface Placed extends Place {
  sha: string;
}

/** One digest pair of an edit call on a path: `old` is null for a Write, which does not show the text it replaced. */
interface Written extends Place {
  old: string | null;
  now: string;
}

const tied = (commit: string, word: string): boolean => commit.startsWith(word) || word.startsWith(commit);

/** Where `later` ran against `earlier`, or null when it is not later. Across sessions the calls are ordered by their time, so a call with none cannot be placed, and both sessions must sit in one known repository. */
const whereOf = (earlier: Place, later: Place, repos: ReadonlyMap<string, string | null>): Reversion | null => {
  if (earlier.session === later.session) {
    if (later.n < earlier.n || (later.n === earlier.n && later.k <= earlier.k)) return null;
    return later.prompt === earlier.prompt ? 'same-prompt' : 'later-prompt';
  }
  const repo = repos.get(earlier.session) ?? null;
  const sameRepo = repo !== null && repo === (repos.get(later.session) ?? null);
  return sameRepo && earlier.ts !== null && later.ts !== null && later.ts > earlier.ts ? 'later-session' : null;
};

/**
 * Whether a commit kept the edit before the restore ran: a `git restore` returns the file to the last commit, so an edit committed since is what it returns to, not what it undoes. A commit in the restore's own call counts, since
 * the order inside a call is not kept. Across sessions the order of the commits is not known, so a commit of the edit's session after it, or of the restore's session before it, counts.
 */
const keptBy = (committed: ReadonlyMap<string, readonly number[]>, edit: Place, restore: Place): boolean => {
  const before = committed.get(edit.session) ?? [];
  if (edit.session === restore.session) return before.some((n) => n > edit.n && n <= restore.n);
  return before.some((n) => n > edit.n) || (committed.get(restore.session) ?? []).some((n) => n <= restore.n);
};

/**
 * Reads every main-line call once: the clean shell calls' commits, revert words (read segments only, since a segment whose result the call's status does not report (`read` false) could have failed behind another command), and
 * restored paths; and every edit that did not fail, with its digests. A subagent's call is not on the main line, so it is not read. Returns the nearest reversion of a prompt's work, or null for none found.
 */
export const reversionsOf = (store: Store): ((session: string, index: number | null) => Reversion | null) => {
  const repos = new Map(store.sessions.map((session) => [session.session, session.repo]));
  const commits: Placed[] = [];
  const reverts: Placed[] = [];
  const committed = new Map<string, number[]>();
  const edited = new Map<string, Place[]>();
  const written = new Map<string, Written[]>();
  const restored: Array<Place & { target: string }> = [];
  for (const tool of store.tools) {
    if (tool.side || tool.prompt === null) continue;
    const at = { session: tool.session, n: tool.n, k: 0, ts: tool.ts, prompt: tool.prompt };
    if (EDITS.has(tool.tool) && tool.status !== 'error' && tool.target !== null) {
      edited.set(tool.target, [...(edited.get(tool.target) ?? []), at]);
      const pairs = (tool.digests ?? []).map((held, k): Written => ({ ...at, k, old: held.old ?? null, now: held.new }));
      written.set(tool.target, [...(written.get(tool.target) ?? []), ...pairs]);
    }
    if (tool.status !== 'ok' || !SHELL.has(tool.tool)) continue;
    for (const sha of tool.commits ?? []) if (sha !== null && SHA.test(sha)) commits.push({ ...at, sha });
    if ((tool.commits ?? []).length > 0) committed.set(tool.session, [...(committed.get(tool.session) ?? []), tool.n]);
    for (const target of tool.restores ?? []) restored.push({ ...at, target });
    for (const segment of tool.segments ?? []) if (segment.read) for (const word of revertWords(segment.run)) reverts.push({ ...at, sha: word });
  }
  const found = new Map<string, Reversion>();
  const note = (earlier: Place, later: Place): void => {
    const where = whereOf(earlier, later, repos);
    if (where === null) return;
    const key = `${earlier.session}#${String(earlier.prompt)}`;
    const held = found.get(key);
    if (held === undefined || NEAREST_FIRST.indexOf(where) < NEAREST_FIRST.indexOf(held)) found.set(key, where);
  };
  for (const commit of commits) for (const revert of reverts) if (tied(commit.sha, revert.sha)) note(commit, revert);
  for (const pairs of written.values()) {
    for (const later of pairs) {
      for (const earlier of pairs) {
        // An edit that changed nothing (old equals new) is its own swap, so it undoes nothing.
        if (earlier.old !== null && earlier.old !== earlier.now && later.old === earlier.now && later.now === earlier.old) note(earlier, later);
        if (earlier.old !== null || later.old !== null || earlier.now !== later.now) continue;
        // A Write that sets the text an earlier Write set undoes the different Writes between them, not the earlier one.
        for (const between of pairs) {
          if (between.old === null && between.now !== later.now && whereOf(earlier, between, repos) !== null && whereOf(between, later, repos) !== null) note(between, later);
        }
      }
    }
  }
  for (const restore of restored) {
    for (const edit of edited.get(restore.target) ?? []) if (!keptBy(committed, edit, restore)) note(edit, restore);
  }
  return (session, index) => found.get(`${session}#${String(index)}`) ?? null;
};
