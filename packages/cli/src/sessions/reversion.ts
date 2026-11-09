// A later reversion of the commits a prompt made, read from the calls alone: a clean `git revert <word>` whose word is a prefix of a commit sha the capture kept, or the other way round.
// The sha is the whole tie. A restored-content edit has no content digest and a `git restore` keeps no path, so neither is read here. The result is descriptive: it says a revert of that
// commit ran later, never that the work was wrong or that the revert was the reason. The original outcome stays as it was and this sits beside it.
import { SHELL } from './extract.js';
import type { Store } from './store.js';

/** Where the nearest later revert ran: in the prompt that made the commit, in a later prompt of that session, or in a later session of the same repository. */
export type Reversion = 'same-prompt' | 'later-prompt' | 'later-session';

const NEAREST_FIRST: readonly Reversion[] = ['same-prompt', 'later-prompt', 'later-session'];

/** The shortest abbreviation git prints, and a full sha. Anything else a revert names (`HEAD`, a branch, a range, a short guess) is not a sha, so it ties to nothing. */
const SHA = /^[0-9a-f]{7,40}$/;

/** The sha-shaped words of a segment that is `git revert <words>`. A bare `git revert` is `--abort`, `--continue`, or `--quit` with the flag dropped, and names nothing. */
const revertWords = (run: string): string[] => (run.startsWith('git revert ') ? run.slice('git revert '.length).split(' ').map((word) => word.toLowerCase()).filter((word) => SHA.test(word)) : []);

interface Placed {
  sha: string;
  session: string;
  n: number;
  ts: string | null;
  prompt: number;
}

const tied = (commit: string, word: string): boolean => commit.startsWith(word) || word.startsWith(commit);

/** Where `revert` ran against `commit`, or null when it is not later. Across sessions the calls are ordered by their time, so a call with none cannot be placed, and both sessions must sit in one known repository. */
const whereOf = (commit: Placed, revert: Placed, repos: ReadonlyMap<string, string | null>): Reversion | null => {
  if (commit.session === revert.session) {
    if (revert.n <= commit.n) return null;
    return revert.prompt === commit.prompt ? 'same-prompt' : 'later-prompt';
  }
  const repo = repos.get(commit.session) ?? null;
  const sameRepo = repo !== null && repo === (repos.get(revert.session) ?? null);
  return sameRepo && commit.ts !== null && revert.ts !== null && revert.ts > commit.ts ? 'later-session' : null;
};

/**
 * Reads every clean main-line shell call once: the commits it made (with a sha) and the revert words its read segments name. A subagent's call is not on the main line, and a segment whose
 * result the call's status does not report (`read` false) could have failed behind another command, so neither is read. Returns the nearest reversion of a prompt's commits, or null for none found.
 */
export const reversionsOf = (store: Store): ((session: string, index: number | null) => Reversion | null) => {
  const repos = new Map(store.sessions.map((session) => [session.session, session.repo]));
  const commits: Placed[] = [];
  const reverts: Placed[] = [];
  for (const tool of store.tools) {
    if (tool.side || tool.prompt === null || tool.status !== 'ok' || !SHELL.has(tool.tool)) continue;
    const at = { session: tool.session, n: tool.n, ts: tool.ts, prompt: tool.prompt };
    for (const sha of tool.commits ?? []) if (sha !== null && SHA.test(sha)) commits.push({ ...at, sha });
    for (const segment of tool.segments ?? []) if (segment.read) for (const word of revertWords(segment.run)) reverts.push({ ...at, sha: word });
  }
  const found = new Map<string, Reversion>();
  for (const commit of commits) {
    for (const revert of reverts) {
      const where = tied(commit.sha, revert.sha) ? whereOf(commit, revert, repos) : null;
      if (where === null) continue;
      const key = `${commit.session}#${String(commit.prompt)}`;
      const held = found.get(key);
      if (held === undefined || NEAREST_FIRST.indexOf(where) < NEAREST_FIRST.indexOf(held)) found.set(key, where);
    }
  }
  return (session, index) => found.get(`${session}#${String(index)}`) ?? null;
};
