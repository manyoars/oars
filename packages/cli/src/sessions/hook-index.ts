// The hook index: a small file written at the end of every deposit so a hook never parses the whole observation log.
// SessionStart reads `projects` (the recurring signatures per project folder); PostToolUse reads `signatures` (sessions and
// what followed, by exact signature). Both are pure functions of the store.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Read } from './read.js';
import { resolveReads } from './recall-pool.js';
import { RECOVERY_FLOOR, positionsOf, recoveryEdgesOf, type Position, type RecoveryEdges } from './recall-next.js';
import { aboveBaseRate, fitReads, PUSH_FLOORS, toolShapeId, type RecallRead } from './recall-reads.js';
import type { SessionObservation } from './schema.js';
import { expandHome } from './allow.js';
import { slugOf, type Store } from './store.js';

const INDEX_FILE = 'hook-index.json';
/** A signature is "recurring" once it has been seen in this many sessions. */
export const RECURRING_SESSIONS = 2;
const PER_PROJECT = 12;
const FOLLOWED = 3;
/** SessionStart ranks by sessions within this many latest sessions of its repository: the `measure --last 300 --repo` window the G1 reading uses. */
export const RECENT_SESSIONS = 300;

export interface IndexedSignature {
  sig: string;
  sessions: number;
  /** Sessions with the signature among the latest `RECENT_SESSIONS` of the session's repository. */
  recent: number;
  /** Tools that most often followed, most common first. */
  followed: Array<[string, number]>;
  harness: string[];
}

export interface HookIndex {
  at: string;
  /** Every `--redact-domain` in force, so a hook masks an error the way the log was masked. */
  redactDomains: string[];
  /** Recurring signatures by project folder name, most recent sessions first. */
  projects: { [project: string]: IndexedSignature[] };
  /** Every signature seen in at least two sessions. */
  signatures: { [sig: string]: { sessions: number; followed: Array<[string, number]> } };
  /** The call shapes over the fit floors and `PUSH_MIN_LIFT`, by read ID. An index a version before this wrote has none, and a pre-tool hook then pushes nothing. */
  fit?: { [readId: string]: RecallRead };
  /**
   * The local pool's recovery edges by `action/errorCode`, only for a failure whose top next step reaches `RECOVERY_FLOOR` (a hook reads this file on every call, so a key it would stay silent on
   * is not carried). An index a version before this wrote has none, and `PostToolUseFailure` then falls back to `signatures`.
   */
  recovery?: RecoveryEdges;
  /** The local pool's split positions (t782's rule), most observed first. */
  positions?: Position[];
}

const topFollowed = (following: { [tool: string]: number }): Array<[string, number]> =>
  Object.entries(following)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, FOLLOWED);

interface Tally {
  sessions: Set<string>;
  following: { [tool: string]: number };
  harness: Set<string>;
}

const tally = (): Tally => ({ sessions: new Set(), following: {}, harness: new Set() });

// The same order `measure` uses, so the window here is the window `measure --last 300 --repo` counts.
const byStart = (a: { tsFirst: string | null; session: string }, b: { tsFirst: string | null; session: string }): number =>
  (a.tsFirst ?? '').localeCompare(b.tsFirst ?? '') || a.session.localeCompare(b.session);

const WORKTREE_SLUG = '--claude-worktrees-';

/**
 * Groups project folder slugs into repositories without knowing any root: a worktree slug folds into its repository's, and a slug that
 * extends another stored slug (a subfolder) joins the shortest one, the same extension rule `belongs` applies at recall time.
 */
const repositoryOf = (projects: readonly string[]): ((project: string) => string) => {
  const baseOf = (project: string): string => project.split(WORKTREE_SLUG)[0] ?? project;
  const bases = [...new Set(projects.map(baseOf))].sort((a, b) => a.length - b.length);
  return (project) => {
    const base = baseOf(project);
    return bases.find((candidate) => base === candidate || base.startsWith(`${candidate}-`)) ?? base;
  };
};

export const buildIndex = (store: Store, redactDomains: readonly string[], at: string, reads: readonly Read[] = []): HookIndex => {
  const projectOf = new Map(store.sessions.map((session) => [session.session, session.project]));
  // The latest 300 of each repository, not of the whole store: another repository's deposits must not move this one's ranking.
  const family = repositoryOf([...new Set(store.sessions.map((session) => session.project))]);
  const byRepository = new Map<string, SessionObservation[]>();
  for (const session of store.sessions) {
    const key = family(session.project);
    const group = byRepository.get(key) ?? [];
    byRepository.set(key, group);
    group.push(session);
  }
  const recentNames = new Set([...byRepository.values()].flatMap((group) => group.sort(byStart).slice(-RECENT_SESSIONS).map((session) => session.session)));
  const overall = new Map<string, Tally>();
  const byProject = new Map<string, Map<string, Tally>>();
  for (const error of store.errors) {
    const project = projectOf.get(error.session);
    const targets = [overall];
    if (project !== undefined) {
      const own = byProject.get(project) ?? new Map<string, Tally>();
      byProject.set(project, own);
      targets.push(own);
    }
    for (const target of targets) {
      const entry = target.get(error.sig) ?? tally();
      target.set(error.sig, entry);
      entry.sessions.add(error.session);
      if (error.harnessVersion !== null) entry.harness.add(error.harnessVersion);
      for (const tool of error.next) entry.following[tool] = (entry.following[tool] ?? 0) + 1;
    }
  }
  const signatures: HookIndex['signatures'] = {};
  for (const [sig, entry] of overall) {
    if (entry.sessions.size >= RECURRING_SESSIONS) signatures[sig] = { sessions: entry.sessions.size, followed: topFollowed(entry.following) };
  }
  const projects: HookIndex['projects'] = {};
  for (const [project, sigs] of byProject) {
    const rows = [...sigs.entries()]
      .filter(([, entry]) => entry.sessions.size >= RECURRING_SESSIONS)
      .map(
        ([sig, entry]): IndexedSignature => ({
          sig,
          sessions: entry.sessions.size,
          recent: [...entry.sessions].filter((name) => recentNames.has(name)).length,
          followed: topFollowed(entry.following),
          harness: [...entry.harness].sort(),
        }),
      )
      .filter((row) => row.recent > 0)
      .sort((a, b) => b.recent - a.recent || b.sessions - a.sessions || a.sig.localeCompare(b.sig))
      .slice(0, PER_PROJECT);
    if (rows.length > 0) projects[project] = rows;
  }
  return {
    at,
    redactDomains: [...redactDomains],
    projects,
    signatures,
    fit: Object.fromEntries(resolveReads(aboveBaseRate(store, fitReads(store, PUSH_FLOORS)), reads).map((read) => [toolShapeId(read.tool, read.keys), read])),
    recovery: recoveryEdgesOf(reads, (followed) => followed >= RECOVERY_FLOOR),
    positions: positionsOf(reads),
  };
};

export const indexPath = (storeDir: string): string => join(storeDir, INDEX_FILE);

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

// The file is ours; these checks guard a torn or foreign file, and the inner rows are trusted as written (as the store's are).
const isIndex = (value: unknown): value is { [key: string]: unknown } & HookIndex =>
  isRecord(value) && isRecord(value.projects) && isRecord(value.signatures) && Array.isArray(value.redactDomains) && typeof value.at === 'string';

/** The index as written, or undefined when there is none (or it is torn): a hook then says nothing. */
export const readIndex = async (storeDir: string): Promise<HookIndex | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(indexPath(storeDir), 'utf8'));
    return isIndex(parsed) ? parsed : undefined;
  } catch {
    // A missing or torn index is "no index".
    return undefined;
  }
};

export interface ContextOptions {
  /** The session's working directory; its repository root selects the project folders. */
  cwd: string;
  harness?: string;
  top: number;
  maxChars: number;
}

/** `<root>/.claude/worktrees/<name>` belongs to `<root>`, so a worktree session sees its repository's history. */
export const repositoryRoot = (cwd: string): string => {
  const marker = /[\\/]\.claude[\\/]worktrees[\\/]/.exec(cwd);
  return marker === null ? cwd : cwd.slice(0, marker.index);
};

/** A project folder belongs to the repository when its slug is the root's slug or extends it (a subfolder or a worktree). */
const belongs = (project: string, rootSlug: string): boolean => project === rootSlug || project.startsWith(`${rootSlug}-`);

/** True when a project folder slug belongs to the repository `root` sits in (a worktree path counts as its repository). */
export const inRepository = (project: string, root: string): boolean => belongs(project, slugOf(repositoryRoot(resolve(expandHome(root)))));

const clip = (text: string, length: number): string => (text.length <= length ? text : `${text.slice(0, length - 1)}…`);

/** The top recurring signatures for the repository, as a short block for injection; undefined when there is nothing to say. */
export const contextBlock = (index: HookIndex, options: ContextOptions): string | undefined => {
  const rootSlug = slugOf(repositoryRoot(options.cwd));
  const merged = new Map<string, IndexedSignature>();
  for (const [project, rows] of Object.entries(index.projects)) {
    if (!belongs(project, rootSlug)) continue;
    for (const row of rows) {
      if (options.harness !== undefined && !row.harness.includes(options.harness)) continue;
      const have = merged.get(row.sig);
      if (have === undefined) {
        merged.set(row.sig, { ...row });
        continue;
      }
      have.sessions += row.sessions;
      have.recent += row.recent;
      const following: { [tool: string]: number } = {};
      for (const [tool, count] of [...have.followed, ...row.followed]) following[tool] = (following[tool] ?? 0) + count;
      have.followed = topFollowed(following);
    }
  }
  const rows = [...merged.values()].sort((a, b) => b.recent - a.recent || b.sessions - a.sessions || a.sig.localeCompare(b.sig)).slice(0, options.top);
  if (rows.length === 0) return undefined;
  const header = `oars recall: errors that recur in this repository's earlier sessions${options.harness === undefined ? '' : ` (Claude Code ${options.harness})`}. Check these before retrying:`;
  const lines = rows.map((row) => {
    const followed = row.followed.map(([tool]) => tool).join(', ');
    return `- ${clip(row.sig, 120)} (${String(row.recent)} sessions in the last ${String(RECENT_SESSIONS)}${followed === '' ? '' : `; next: ${followed}`})`;
  });
  const kept: string[] = [];
  let used = header.length;
  for (const line of lines) {
    if (used + 1 + line.length > options.maxChars) break;
    kept.push(line);
    used += 1 + line.length;
  }
  return kept.length === 0 ? undefined : [header, ...kept].join('\n');
};
