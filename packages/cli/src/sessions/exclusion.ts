// The V15 exclusion rule (register A38): a session is excluded if any line of its main or subagent transcript holds a listed term,
// scanned locally before anything is deposited to the pool. A session with no raw to scan is excluded, and so is every session when
// the term file is missing or empty (fail closed). The term list is a local file and never lives in this repository; nothing here
// prints, logs, or returns a term or a line of a transcript, only counts and session ids.
import { createReadStream, type Dirent } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Outcome } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import { loadStore, paths, type SessionsRuntime } from './store.js';

export interface ExclusionPaths {
  /** One term per line, matched without regard to case. */
  terms: string;
  /** Where `oars sessions exclusions` writes the excluded sessions. */
  list: string;
}

/** `OARS_EXCLUSION_TERMS` names the term file; the default sits beside the claude config's other local-only session-commons files. */
export const exclusionPaths = (projectsRoot: string, env: NodeJS.ProcessEnv, out?: string): ExclusionPaths => {
  const commons = join(dirname(projectsRoot), 'session-commons');
  const terms = env.OARS_EXCLUSION_TERMS;
  return { terms: terms === undefined || terms === '' ? join(commons, 'exclusion-terms.txt') : terms, list: out ?? join(commons, 'exclusion-list.jsonl') };
};

/** The terms, lowercased; a missing, unreadable, or undecodable file gives none, which excludes everything. */
export const loadTerms = async (file: string): Promise<string[]> => {
  try {
    const text = await readFile(file, 'utf8');
    // A UTF-16 file (Windows PowerShell 5.1 `>`) decodes to NULs, and other bytes to U+FFFD: terms that never match would read every session as clean.
    if (text.includes('\u0000') || text.includes('\ufffd')) return [];
    return text.split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter((line) => line !== '');
  } catch {
    return [];
  }
};

type Source = 'projects' | 'raw';

interface TranscriptFile {
  path: string;
  /** The path under the project folder, the same in both sources. */
  key: string;
  main: boolean;
  source: Source;
}

export type Reason = 'clean' | 'term' | 'no-terms' | 'no-raw' | 'unreadable';

export interface Verdict {
  excluded: boolean;
  reason: Reason;
  /** The files whose lines held a term. */
  hits: { key: string; main: boolean; source: Source }[];
}

const isAbsent = (error: unknown): boolean => error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

/** A missing folder is empty; any other failure (ENOTDIR for a plain file, EACCES, EPERM, EBUSY) is thrown, so a folder that was not read never reads as clean. */
const entriesOf = async (dir: string) => {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
};

/** What a path must lead to: a directory at a root, a project folder, a session folder, or `subagents`; a file at a main transcript. */
type Kind = 'directory' | 'file';

/**
 * The one rule for a path at any level (V15): a link that leads nowhere, or an entry of the wrong kind (a plain file where a folder belongs, a folder where
 * a transcript belongs), means what is under it was not scanned. Windows reports a listing of a path under a plain file as ENOENT, so the kind is checked here and not left to the listing.
 * An absent path is not one.
 */
const badLink = async (path: string, kind: Kind): Promise<boolean> => {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    return !isAbsent(error);
  }
  try {
    const target = entry.isSymbolicLink() ? await stat(path) : entry;
    return kind === 'directory' ? !target.isDirectory() : !target.isFile();
  } catch {
    return true;
  }
};

/**
 * A link is followed, as the main file's `stat` follows one; a link that leads nowhere or to the wrong kind, or a plain entry named like a transcript that is not a file, is a bad entry, and so is a folder that cannot be listed
 * and a folder reached a second time (a link back into a folder already walked, which would loop and count a transcript once per pass).
 * The walk goes on past every bad entry and `found` holds every transcript it reached, so the verdict does not depend on the listing order (V5); true when any entry was bad.
 * `seen` holds the real path of every folder entered.
 */
const jsonlUnder = async (dir: string, found: string[], seen: Set<string>): Promise<boolean> => {
  let bad = false;
  for (const entry of await entriesOf(dir)) {
    const path = join(dir, entry.name);
    const named = entry.name.endsWith('.jsonl');
    // A plain entry named like a transcript goes through the helper too: a folder or a FIFO there is not a file, and what is under it was not scanned.
    if ((entry.isSymbolicLink() || named) && (await badLink(path, named ? 'file' : 'directory'))) {
      bad = true;
      continue;
    }
    const target = entry.isSymbolicLink() ? await stat(path) : entry;
    if (target.isDirectory()) {
      try {
        const real = await realpath(path);
        if (seen.has(real)) {
          bad = true;
          continue;
        }
        seen.add(real);
        if (await jsonlUnder(path, found, seen)) bad = true;
      } catch {
        bad = true;
      }
    } else if (named) found.push(path);
  }
  return bad;
};

/** A main that is not there is false; any other failure (EACCES, EPERM, ELOOP) is thrown, so a main that was not examined never reads as absent. */
const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isAbsent(error)) return false;
    throw error;
  }
};

/** Adds the transcripts of the session in one source (the main file and everything under `<session>/subagents/`) to `found`; true when a level could not be read. */
const filesIn = async (root: string, source: Source, project: string, session: string, found: TranscriptFile[]): Promise<boolean> => {
  const folder = join(root, project);
  const main = join(folder, `${session}.jsonl`);
  // A link that leads nowhere or a wrong kind of entry reads as an absent one below, so every level is checked first (a directory at the main makes the session unreadable here).
  let unreadable = await badLink(main, 'file');
  for (const path of [folder, join(folder, session), join(folder, session, 'subagents')]) if (await badLink(path, 'directory')) unreadable = true;
  try {
    if (await isFile(main)) found.push({ path: main, key: `${session}.jsonl`, main: true, source });
  } catch {
    unreadable = true;
  }
  const subagents = join(folder, session, 'subagents');
  const agents: string[] = [];
  try {
    // The folder itself is seen first, so a link back to it is a repeat; a folder that is not there has no real path and nothing to walk.
    const seen = new Set<string>();
    seen.add(await realpath(subagents).catch(() => subagents));
    if (await jsonlUnder(subagents, agents, seen)) unreadable = true;
  } catch {
    unreadable = true;
  }
  // Every file the walk reached is scanned, so a hit is counted whatever the listing order.
  for (const path of agents) found.push({ path, key: `${session}/subagents/${path.slice(subagents.length + 1).split('\\').join('/')}`, main: false, source });
  return unreadable;
};

interface SessionFiles {
  files: TranscriptFile[];
  /** A folder of the session could not be listed, so it was not scanned in full. */
  unreadable: boolean;
}

/** Both the harness's folder and oars' raw archive, because either can be the only copy left. */
const filesOf = async (runtime: SessionsRuntime, project: string, session: string): Promise<SessionFiles> => {
  const files: TranscriptFile[] = [];
  const raw = paths(runtime.storeDir).raw;
  // A root that is a link leading nowhere makes `lstat` of everything under it ENOENT, so the roots are checked here.
  let unreadable = false;
  for (const root of [runtime.projectsRoot, runtime.storeDir, raw]) if (await badLink(root, 'directory')) unreadable = true;
  const first = await filesIn(runtime.projectsRoot, 'projects', project, session, files);
  const second = await filesIn(raw, 'raw', project, session, files);
  return { files, unreadable: unreadable || first || second };
};

/** Whether any line of the file holds a term. Streamed, so a large transcript is never held whole. */
const holdsTerm = async (path: string, terms: readonly string[]): Promise<boolean> => {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const lower = line.toLowerCase();
      if (terms.some((term) => lower.includes(term))) return true;
    }
    return false;
  } finally {
    lines.close();
    // `close` leaves the stream open, so a file that returned early on a hit would keep its descriptor.
    stream.destroy();
  }
};

const judge = async (terms: readonly string[], session: SessionFiles): Promise<Verdict> => {
  if (terms.length === 0) return { excluded: true, reason: 'no-terms', hits: [] };
  const { files } = session;
  const hits: Verdict['hits'] = [];
  let unreadable = session.unreadable;
  for (const file of files) {
    try {
      if (await holdsTerm(file.path, terms)) hits.push({ key: file.key, main: file.main, source: file.source });
    } catch {
      unreadable = true;
    }
  }
  if (hits.length > 0) return { excluded: true, reason: 'term', hits };
  // Without the main transcript the session cannot be scanned in full, so it is excluded; its subagent files were scanned above, so a hit there counts.
  if (!files.some((file) => file.main)) return { excluded: true, reason: unreadable ? 'unreadable' : 'no-raw', hits };
  return unreadable ? { excluded: true, reason: 'unreadable', hits } : { excluded: false, reason: 'clean', hits };
};

/**
 * When the newest file of a session was last written, in epoch milliseconds, over the same files the gate scans (the main transcript, its subagents, and oars' raw copies), or 0 when it has none.
 * A transcript that kept growing since the last capture is newer here than in the store, so the deposit command reads it to tell a session still in progress from one that has ended.
 */
export const lastWritten = async (runtime: SessionsRuntime, project: string, session: string): Promise<number> => {
  const { files } = await filesOf(runtime, project, session);
  const times = await Promise.all(files.map(async ({ path }) => (await stat(path)).mtimeMs));
  return Math.max(0, ...times);
};

/** The A38 rule for one session; `extra` adds terms to the file's, but never stands in for it, so a missing or empty term file still excludes everything. */
export const checkSession = async (runtime: SessionsRuntime, termsFile: string, project: string, session: string, extra: readonly string[] = []): Promise<Verdict> => {
  const fromFile = await loadTerms(termsFile);
  return judge(fromFile.length === 0 ? [] : [...fromFile, ...extra.map((term) => term.toLowerCase())], await filesOf(runtime, project, session));
};

interface SourceHits {
  main: number;
  subagent: number;
}

export interface FolderCounts {
  folder: number;
  sessions: number;
  excluded: number;
  /** Files in this folder that held a term, per source. */
  hits: { projects: SourceHits; raw: SourceHits };
}

export interface ExclusionCounts {
  sessions: number;
  excluded: number;
  kept: number;
  reasons: { term: number; noRaw: number; noTerms: number; unreadable: number };
  /** Directories in a project folder that are not sessions (no main transcript, and a name that neither is a session id nor ends in `.jsonl`); in neither the list nor the sessions. */
  notSessions: number;
  /** Distinct transcript files that held a term, across both sources. */
  hitFiles: SourceHits;
  /** The same count per source, because a file in both is counted in each, and the distinct sessions with a hit in that source. */
  bySource: { projects: SourceHits & { sessions: number }; raw: SourceHits & { sessions: number } };
  folders: FolderCounts[];
}

/** The harness names a session folder with a UUID. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A directory, or a link to one; a link that leads nowhere throws, so a folder that was not scanned never reads as clean. */
const leadsToDirectory = async (path: string, entry: Dirent): Promise<boolean> => (entry.isSymbolicLink() ? (await stat(path)).isDirectory() : entry.isDirectory());

/** The sessions of one project folder: every entry named like a main file, and every entry named like a session folder. Other directories are returned apart. */
const sessionIds = async (root: string, project: string): Promise<{ ids: string[]; others: string[] }> => {
  const ids: string[] = [];
  const dirs: string[] = [];
  for (const entry of await entriesOf(join(root, project))) {
    // An entry named like a main file or a session folder is a session whatever it is: `filesIn` reads one of the wrong kind (a link that leads nowhere,
    // a folder named `<id>.jsonl`, a plain file named `<id>`) as unreadable, so the scan lists it as the gate does.
    if (entry.name.endsWith('.jsonl')) ids.push(entry.name.slice(0, -'.jsonl'.length));
    else if (SESSION_ID.test(entry.name) && !entry.isDirectory()) ids.push(entry.name);
    else if (await leadsToDirectory(join(root, project, entry.name), entry)) dirs.push(entry.name);
  }
  return { ids: [...ids, ...dirs.filter((name) => SESSION_ID.test(name))], others: dirs.filter((name) => !SESSION_ID.test(name)) };
};

const emptyHits = (): SourceHits => ({ main: 0, subagent: 0 });

/** Scans every session in the harness's folders, the raw archive, and the store's own log. Returns counts and, apart from them, the excluded sessions. */
export const scanStore = async (runtime: SessionsRuntime, termsFile: string): Promise<{ counts: ExclusionCounts; excluded: { project: string; session: string }[] }> => {
  const terms = await loadTerms(termsFile);
  const raw = paths(runtime.storeDir).raw;
  // A root that is a link leading nowhere, or to a file, lists as empty: stop with no list, naming no path.
  for (const root of [runtime.projectsRoot, runtime.storeDir, raw]) {
    if (await badLink(root, 'directory')) throw new CliError('A folder that holds the projects is a link that could not be followed, so no list was written.', ExitCode.INVALID, 'unreadable');
  }
  // A store log that is a link leading nowhere would load as an empty store, so a logged session would drop out of the list: stop instead.
  if (await badLink(paths(runtime.storeDir).observations, 'file')) throw new CliError('The store log is a link that could not be followed, so no list was written.', ExitCode.INVALID, 'unreadable');
  // A session the store logged stays listed when its raw is gone everywhere: it has nothing to scan, so it is excluded as no raw.
  const logged = new Map<string, Set<string>>();
  for (const session of (await loadStore(runtime.storeDir)).sessions) logged.set(session.project, (logged.get(session.project) ?? new Set<string>()).add(session.session));
  const projects = new Set<string>(logged.keys());
  for (const root of [runtime.projectsRoot, raw]) {
    try {
      for (const entry of await entriesOf(root)) {
        // A project folder that is a link to a file was not scanned: stop, as for one that leads nowhere (`stat` throws).
        if (entry.isSymbolicLink() && (await badLink(join(root, entry.name), 'directory'))) throw new Error('unreadable');
        if (await leadsToDirectory(join(root, entry.name), entry)) projects.add(entry.name);
      }
    } catch {
      throw new CliError('A folder that holds the projects could not be listed, so no list was written.', ExitCode.INVALID, 'unreadable');
    }
  }
  const counts: ExclusionCounts = {
    sessions: 0,
    excluded: 0,
    kept: 0,
    reasons: { term: 0, noRaw: 0, noTerms: 0, unreadable: 0 },
    notSessions: 0,
    hitFiles: emptyHits(),
    bySource: { projects: { ...emptyHits(), sessions: 0 }, raw: { ...emptyHits(), sessions: 0 } },
    folders: [],
  };
  const excluded: { project: string; session: string }[] = [];
  const distinct = new Set<string>();
  for (const [index, project] of [...projects].sort().entries()) {
    // The platform's message carries the path, and a folder name can carry the term (V15): name the ordinal only.
    const listed = async (root: string) => {
      try {
        return await sessionIds(root, project);
      } catch {
        throw new CliError(`Project folder ${String(index + 1)} could not be listed, so it was not scanned and no list was written.`, ExitCode.INVALID, 'unreadable');
      }
    };
    const inProjects = await listed(runtime.projectsRoot);
    const inRaw = await listed(raw);
    const ids = new Set([...inProjects.ids, ...inRaw.ids, ...(logged.get(project) ?? [])]);
    counts.notSessions += new Set([...inProjects.others, ...inRaw.others].filter((name) => !ids.has(name))).size;
    const folder: FolderCounts = { folder: index + 1, sessions: 0, excluded: 0, hits: { projects: emptyHits(), raw: emptyHits() } };
    for (const session of [...ids].sort()) {
      const verdict = await judge(terms, await filesOf(runtime, project, session));
      folder.sessions += 1;
      const sources = new Set<Source>();
      for (const hit of verdict.hits) {
        const kind = hit.main ? 'main' : 'subagent';
        counts.bySource[hit.source][kind] += 1;
        folder.hits[hit.source][kind] += 1;
        sources.add(hit.source);
        const key = `${project}/${hit.key}`;
        if (!distinct.has(key)) {
          distinct.add(key);
          counts.hitFiles[kind] += 1;
        }
      }
      for (const source of sources) counts.bySource[source].sessions += 1;
      if (!verdict.excluded) continue;
      folder.excluded += 1;
      excluded.push({ project, session });
      if (verdict.reason === 'term') counts.reasons.term += 1;
      else if (verdict.reason === 'no-raw') counts.reasons.noRaw += 1;
      else if (verdict.reason === 'no-terms') counts.reasons.noTerms += 1;
      else counts.reasons.unreadable += 1;
    }
    counts.sessions += folder.sessions;
    counts.excluded += folder.excluded;
    counts.folders.push(folder);
  }
  counts.kept = counts.sessions - counts.excluded;
  return { counts, excluded };
};

/** `oars sessions exclusions`: writes the excluded sessions to a local file and prints counts only. */
export const sessionsExclusions = async (runtime: SessionsRuntime, where: ExclusionPaths): Promise<Outcome> => {
  const { counts, excluded } = await scanStore(runtime, where.terms);
  await mkdir(dirname(where.list), { recursive: true });
  // The list holds real folder names, which can carry a term, so it is readable by its owner only (as the store's other local-only files are).
  // Written through a temp file and renamed, as the store does, so a crash mid-write never leaves a short list that reads as complete.
  const temp = `${where.list}.tmp`;
  try {
    await writeFile(temp, excluded.map((entry) => JSON.stringify(entry)).join('\n') + (excluded.length === 0 ? '' : '\n'), { mode: 0o600 });
    await rename(temp, where.list);
  } catch (error) {
    // The temp file holds real folder names, so a failed write or rename never leaves it behind.
    await rm(temp, { force: true });
    throw error;
  }
  // `mode` applies only when the file is created, so a list from an earlier run keeps its old one.
  await chmod(where.list, 0o600);
  const { projects, raw } = counts.bySource;
  const lines = [
    `Scanned ${String(counts.sessions)} sessions in ${String(counts.folders.length)} folders: ${String(counts.excluded)} excluded, ${String(counts.kept)} kept; ${String(counts.notSessions)} directories are not sessions.`,
    `Excluded for a term: ${String(counts.reasons.term)}; no raw to scan: ${String(counts.reasons.noRaw)}; no term file: ${String(counts.reasons.noTerms)}; unreadable: ${String(counts.reasons.unreadable)}.`,
    `Files holding a term: ${String(counts.hitFiles.main)} main, ${String(counts.hitFiles.subagent)} subagent (harness folders ${String(projects.main + projects.subagent)} in ${String(projects.sessions)} sessions, raw archive ${String(raw.main + raw.subagent)} in ${String(raw.sessions)} sessions).`,
    'The excluded list is written to a local file outside the repository.',
  ];
  return { document: { ok: true, ...counts }, text: lines.join('\n') };
};
