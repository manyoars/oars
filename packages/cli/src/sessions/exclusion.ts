// The V15 exclusion rule (register A38): a session is excluded if any line of its main or subagent transcript holds a listed term,
// scanned locally before anything is deposited to the pool. A session with no raw to scan is excluded, and so is every session when
// the term file is missing or empty (fail closed). The term list is a local file and never lives in this repository; nothing here
// prints, logs, or returns a term or a line of a transcript, only counts and session ids.
import { createReadStream, type Dirent } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

/** A missing folder is empty; any other failure (EACCES, EPERM, EBUSY) is thrown, so a folder that was not read never reads as clean. */
const entriesOf = async (dir: string) => {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
};

/** A link is followed, as the main file's `stat` follows one; a link that leads nowhere throws, so it is unreadable. */
const jsonlUnder = async (dir: string): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of await entriesOf(dir)) {
    const path = join(dir, entry.name);
    // `stat` follows a link and throws on a broken one, which the caller counts as unreadable.
    const target = entry.isSymbolicLink() ? await stat(path) : entry;
    const named = entry.name.endsWith('.jsonl');
    // A link to the wrong kind of entry was not scanned: a file not named .jsonl, a directory named .jsonl, or anything that is neither.
    if (entry.isSymbolicLink() && (target.isFile() ? !named : target.isDirectory() ? named : true)) throw new Error('unreadable');
    if (target.isDirectory()) found.push(...(await jsonlUnder(path)));
    else if (named && target.isFile()) found.push(path);
  }
  return found;
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

/** What a path must lead to: a directory at a root, a project folder, a session folder, or `subagents`; a file at a main transcript. */
type Kind = 'directory' | 'file';

/**
 * The one rule for a link at any level (V15): a link that leads nowhere, or to the wrong kind of entry, means what is under it was not scanned.
 * An absent path is not one, and a path that is not a link is read as it is.
 */
const badLink = async (path: string, kind: Kind): Promise<boolean> => {
  let link: boolean;
  try {
    link = (await lstat(path)).isSymbolicLink();
  } catch (error) {
    return !isAbsent(error);
  }
  if (!link) return false;
  try {
    const target = await stat(path);
    return kind === 'directory' ? !target.isDirectory() : !target.isFile();
  } catch {
    return true;
  }
};

/** Adds the transcripts of the session in one source (the main file and everything under `<session>/subagents/`) to `found`; true when a level could not be read. */
const filesIn = async (root: string, source: Source, project: string, session: string, found: TranscriptFile[]): Promise<boolean> => {
  const folder = join(root, project);
  const main = join(folder, `${session}.jsonl`);
  // A link that leads nowhere reads as an absent entry below, so every level is checked first.
  let unreadable = await badLink(main, 'file');
  for (const path of [folder, join(folder, session), join(folder, session, 'subagents')]) if (await badLink(path, 'directory')) unreadable = true;
  try {
    if (await isFile(main)) found.push({ path: main, key: `${session}.jsonl`, main: true, source });
  } catch {
    unreadable = true;
  }
  const subagents = join(folder, session, 'subagents');
  try {
    for (const path of await jsonlUnder(subagents)) found.push({ path, key: `${session}/subagents/${path.slice(subagents.length + 1).split('\\').join('/')}`, main: false, source });
  } catch {
    return true;
  }
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

/** The A38 rule for one session. */
export const checkSession = async (runtime: SessionsRuntime, termsFile: string, project: string, session: string): Promise<Verdict> =>
  judge(await loadTerms(termsFile), await filesOf(runtime, project, session));

/** The gate the pool's deposit calls before anything leaves: an excluded session is refused. */
export const assertDepositable = async (runtime: SessionsRuntime, termsFile: string, project: string, session: string): Promise<void> => {
  const verdict = await checkSession(runtime, termsFile, project, session);
  if (verdict.excluded) throw new CliError(`Session ${session} is excluded from the pool by the V15 rule (${verdict.reason}).`, ExitCode.INVALID, 'excluded');
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
  /** Directories in a project folder that are not sessions (no main transcript, and a name that is not a session id); in neither the list nor the sessions. */
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

/** The sessions of one project folder: every main file, and every directory named like a session. Other directories are returned apart. */
const sessionIds = async (root: string, project: string): Promise<{ ids: string[]; others: string[] }> => {
  const ids: string[] = [];
  const dirs: string[] = [];
  for (const entry of await entriesOf(join(root, project))) {
    // A link is a session too, whatever it leads to: `filesIn` follows it, and one that leads nowhere or to the wrong kind reads unreadable.
    if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.jsonl')) ids.push(entry.name.slice(0, -'.jsonl'.length));
    else if (entry.isSymbolicLink() && SESSION_ID.test(entry.name)) ids.push(entry.name);
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
