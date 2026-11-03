// Commit survival (t746 Item 3, V7): what became of a commit is an observation made later, not a fact of the transcript, so it never
// runs at derive time and never from a hook a session waits on. A manual deposit and the nightly run read the repository of each
// allowlisted folder and append to `commit-survival.jsonl` beside the store, so the log `verify` checks stays untouched.
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { compileAllow, slugOf } from './allow.js';
import { makeRepoRoot } from './repo-root.js';
import { loadStore, paths, type SessionsRuntime, type Store } from './store.js';

/** A commit younger than this has not had time to be reverted or dropped, so it is not read yet. */
export const SURVIVAL_DAYS = 7;

const DAY_MS = 86_400_000;
const GIT_TIMEOUT_MS = 120_000;
/** `rev-list` prints 41 bytes a commit; this holds about 6 million of them. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
/** How far into a transcript to look for its working directory: the harness stamps every line, so a file without one by here has none. */
const CWD_SCAN_LINES = 200;
/** Tried in this order when `origin/HEAD` is not set, which `git clone` sets and `git init` plus `git remote add` does not. */
const DEFAULT_REFS = ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'];

const STATES = ['survived', 'reverted', 'unreachable', 'unknown'] as const;
export type SurvivalState = (typeof STATES)[number];

/** One line of `commit-survival.jsonl`. `sha` as captured (usually short), and a day-resolution date. */
export interface SurvivalObservation {
  sha: string;
  state: SurvivalState;
  day: string;
}

export type SurvivalCounts = { [state in SurvivalState]: number };

/** Runs one read-only git command in a repository and answers its stdout; rejects on any failure. */
export type Git = (root: string, args: readonly string[], stdin?: string) => Promise<string>;

export const survivalFile = (storeDir: string): string => join(storeDir, 'commit-survival.jsonl');

const runGit: Git = (root, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'protocol.allow=never', '-C', root, ...args],
      {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        // A partial clone would fetch a missing object from its remote, and this reads no network: `protocol.allow` refuses it on any git, while `GIT_NO_LAZY_FETCH` needs about 2.45 or later. A `GIT_DIR` inherited from a caller's hook would read some other repository than the one named.
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      },
      (error, stdout) => {
        if (error === null) resolve(stdout);
        else reject(new Error(error.message));
      },
    );
    // A git that exits before reading its stdin raises EPIPE here; its exit status already reports the failure.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(stdin ?? '');
  });

const outputLines = (text: string): string[] => text.split(/\r?\n/).filter((line) => line !== '');

const defaultRef = async (git: Git, root: string): Promise<string | null> => {
  const head = (await git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
  if (head !== '') return head;
  const present = new Set(outputLines(await git(root, ['for-each-ref', '--format=%(refname)', ...DEFAULT_REFS])));
  return DEFAULT_REFS.find((ref) => present.has(ref)) ?? null;
};

const REVERT_RECORD = /^([0-9a-f]{40})\n([\s\S]*)$/;
const REVERTS = /This reverts commit ([0-9a-f]{40})/g;

/**
 * The commits the default branch has undone, from `git revert`'s own message. `git log` runs newest first, so by the time a revert is
 * reached anything that undid it has been seen, and a reverted revert undoes nothing.
 */
const revertedIn = (log: string): Set<string> => {
  const reverted = new Set<string>();
  for (const record of log.split('\0')) {
    const found = REVERT_RECORD.exec(record.trimStart());
    if (found === null || reverted.has(found[1] ?? '')) continue;
    for (const match of (found[2] ?? '').matchAll(REVERTS)) reverted.add(match[1] ?? '');
  }
  return reverted;
};

/** What one repository says of each sha. A sha it does not hold reads `unknown`: the session may have committed in another repository, which a path rule cannot follow. */
const classify = async (git: Git, root: string, shas: readonly string[]): Promise<Map<string, SurvivalState>> => {
  const states = new Map<string, SurvivalState>();
  if ((await git(root, ['rev-parse', '--is-shallow-repository'])).trim() !== 'false') return states;
  const ref = await defaultRef(git, root);
  if (ref === null) return states;
  const reachable = new Set(outputLines(await git(root, ['rev-list', ref])));
  const reverted = revertedIn(await git(root, ['log', ref, '--no-show-signature', '--grep=This reverts commit', '--format=%H%n%B%x00']));
  const resolved = outputLines(await git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${shas.join('\n')}\n`));
  shas.forEach((sha, index) => {
    const [full = '', type] = (resolved[index] ?? '').split(' ');
    if (type !== 'commit') return;
    states.set(sha, reverted.has(full) ? 'reverted' : reachable.has(full) ? 'survived' : 'unreachable');
  });
  return states;
};

interface Due {
  sessions: Set<string>;
  shas: Set<string>;
}

/** The shas old enough to read, per allowlisted project. Main-line calls only: a subagent's commits are not attributed yet. */
const dueByProject = (store: Store, allows: (project: string) => boolean, cutoff: string): Map<string, Due> => {
  const projectOf = new Map(store.sessions.map((session) => [session.session, session.project]));
  const due = new Map<string, Due>();
  for (const tool of store.tools) {
    const project = projectOf.get(tool.session);
    if (project === undefined || !allows(project) || tool.side || tool.ts === null || tool.ts >= cutoff) continue;
    for (const sha of tool.commits ?? []) {
      if (sha === null) continue;
      const entry = due.get(project) ?? { sessions: new Set(), shas: new Set() };
      entry.sessions.add(tool.session);
      entry.shas.add(sha);
      due.set(project, entry);
    }
  }
  return due;
};

const topLevelCwd = (line: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);
    const cwd: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'cwd') : undefined;
    return typeof cwd === 'string' ? cwd : undefined;
  } catch {
    return undefined;
  }
};

/** The transcript's first `cwd` whose slug is the project. A later `cd` moves `cwd`, and a path a transcript merely names must not choose what gets read (V8). */
const cwdIn = async (file: string, project: string): Promise<string | undefined> => {
  const stream = createReadStream(file, { encoding: 'utf8' });
  // An absent file errors here, not in the loop.
  const opened = new Promise<boolean>((resolve) => {
    stream.once('error', () => {
      resolve(false);
    });
    stream.once('open', () => {
      resolve(true);
    });
  });
  if (!(await opened)) return undefined;
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let read = 0;
  try {
    for await (const line of reader) {
      read += 1;
      if (read > CWD_SCAN_LINES) return undefined;
      const cwd = topLevelCwd(line);
      if (cwd !== undefined && slugOf(cwd) === project) return cwd;
    }
    return undefined;
  } finally {
    reader.close();
    stream.destroy();
  }
};

const cwdOfProject = async (runtime: SessionsRuntime, project: string, sessions: ReadonlySet<string>): Promise<string | undefined> => {
  for (const session of sessions) {
    for (const root of [runtime.projectsRoot, paths(runtime.storeDir).raw]) {
      const found = await cwdIn(join(root, project, `${session}.jsonl`), project);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

const isObservation = (value: unknown): value is SurvivalObservation => {
  if (typeof value !== 'object' || value === null) return false;
  const state: unknown = Reflect.get(value, 'state');
  return typeof Reflect.get(value, 'sha') === 'string' && STATES.some((known) => known === state);
};

/** The latest state of each sha. The file only adds to what `books` shows, so a missing or unreadable one reads as nothing observed yet. */
export const readSurvival = async (storeDir: string): Promise<Map<string, SurvivalState>> => {
  const states = new Map<string, SurvivalState>();
  const text = await readFile(survivalFile(storeDir), 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isObservation(parsed)) states.set(parsed.sha, parsed.state);
    } catch {
      // A torn last line from a crashed run: the next run observes that sha again.
    }
  }
  return states;
};

const observe = async (runtime: SessionsRuntime, allowEntries: readonly string[], now: () => number, git: Git): Promise<SurvivalCounts> => {
  const allow = compileAllow(allowEntries);
  const due = dueByProject(await loadStore(runtime.storeDir), allow.allows, new Date(now() - SURVIVAL_DAYS * DAY_MS).toISOString());
  const repoRoot = makeRepoRoot();
  const byRoot = new Map<string, Set<string>>();
  const shas = new Set<string>();
  for (const [project, entry] of due) {
    for (const sha of entry.shas) shas.add(sha);
    const cwd = await cwdOfProject(runtime, project, entry.sessions);
    const root = cwd === undefined ? null : repoRoot(cwd);
    if (root !== null) byRoot.set(root, new Set([...(byRoot.get(root) ?? []), ...entry.shas]));
  }
  const fresh = new Map<string, SurvivalState>();
  for (const [root, wanted] of byRoot) {
    // Fail-open per repository: one that cannot be read leaves its shas unknown and the others are still read.
    const states = await classify(git, root, [...wanted]).catch(() => new Map<string, SurvivalState>());
    for (const [sha, state] of states) fresh.set(sha, state);
  }
  const known = await readSurvival(runtime.storeDir);
  const day = new Date(now()).toISOString().slice(0, 10);
  const counts: SurvivalCounts = { survived: 0, reverted: 0, unreachable: 0, unknown: 0 };
  const appended: SurvivalObservation[] = [];
  for (const sha of shas) {
    const before = known.get(sha);
    // An observation is not undone by a later failure to look: only a state git answered replaces one.
    const state = fresh.get(sha) ?? before ?? 'unknown';
    counts[state] += 1;
    if (state !== before) appended.push({ sha, state, day });
  }
  if (appended.length > 0) await appendFile(survivalFile(runtime.storeDir), appended.map((line) => `${JSON.stringify(line)}\n`).join(''), { mode: 0o600 });
  return counts;
};

/**
 * Observes every commit older than `SURVIVAL_DAYS` in the allowlisted folders. Never rejects, since a deposit that has already succeeded
 * must not fail on what it adds: null when the store could not be read or written, and the next run tries again.
 */
export const recordSurvival = async (runtime: SessionsRuntime, allow: readonly string[], now: () => number, git: Git = runGit): Promise<SurvivalCounts | null> => {
  try {
    return await observe(runtime, allow, now, git);
  } catch {
    return null;
  }
};
