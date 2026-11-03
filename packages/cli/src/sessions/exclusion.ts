// The V15 exclusion rule (register A38): a session is excluded if any line of its main or subagent transcript holds a listed term,
// scanned locally before anything is deposited to the pool. A session with no raw to scan is excluded, and so is every session when
// the term file is missing or empty (fail closed). The term list is a local file and never lives in this repository; nothing here
// prints, logs, or returns a term or a line of a transcript, only counts and session ids.
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Outcome } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import { paths, type SessionsRuntime } from './store.js';

export interface ExclusionPaths {
  /** One term per line, matched without regard to case. */
  terms: string;
  /** Where `oars sessions exclusions` writes the excluded sessions. */
  list: string;
}

/** `OARS_EXCLUSION_TERMS` names the term file; the default sits beside the claude config's other local-only session-commons files. */
export const exclusionPaths = (projectsRoot: string, env: NodeJS.ProcessEnv, out?: string): ExclusionPaths => {
  const commons = join(projectsRoot === '' ? join(homedir(), '.claude') : dirname(projectsRoot), 'session-commons');
  const terms = env.OARS_EXCLUSION_TERMS;
  return { terms: terms === undefined || terms === '' ? join(commons, 'exclusion-terms.txt') : terms, list: out ?? join(commons, 'exclusion-list.jsonl') };
};

/** The terms, lowercased; a missing or unreadable file gives none, which excludes everything. */
export const loadTerms = async (file: string): Promise<string[]> => {
  try {
    return (await readFile(file, 'utf8')).split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter((line) => line !== '');
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

const entriesOf = async (dir: string) => {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const jsonlUnder = async (dir: string): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of await entriesOf(dir)) {
    if (entry.isDirectory()) found.push(...(await jsonlUnder(join(dir, entry.name))));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(join(dir, entry.name));
  }
  return found;
};

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/** Every transcript of the session in one source: the main file and everything under `<session>/subagents/`. */
const filesIn = async (root: string, source: Source, project: string, session: string): Promise<TranscriptFile[]> => {
  const folder = join(root, project);
  const found: TranscriptFile[] = [];
  const main = join(folder, `${session}.jsonl`);
  if (await isFile(main)) found.push({ path: main, key: `${session}.jsonl`, main: true, source });
  const subagents = join(folder, session, 'subagents');
  for (const path of await jsonlUnder(subagents)) found.push({ path, key: `${session}/subagents/${path.slice(subagents.length + 1).split('\\').join('/')}`, main: false, source });
  return found;
};

/** Both the harness's folder and oars' raw archive, because either can be the only copy left. */
const filesOf = async (runtime: SessionsRuntime, project: string, session: string): Promise<TranscriptFile[]> => [
  ...(await filesIn(runtime.projectsRoot, 'projects', project, session)),
  ...(await filesIn(paths(runtime.storeDir).raw, 'raw', project, session)),
];

/** Whether any line of the file holds a term. Streamed, so a large transcript is never held whole. */
const holdsTerm = async (path: string, terms: readonly string[]): Promise<boolean> => {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const lower = line.toLowerCase();
      if (terms.some((term) => lower.includes(term))) return true;
    }
    return false;
  } finally {
    lines.close();
  }
};

const judge = async (terms: readonly string[], files: readonly TranscriptFile[]): Promise<Verdict> => {
  if (terms.length === 0) return { excluded: true, reason: 'no-terms', hits: [] };
  // Without the main transcript the session cannot be scanned in full, so it is excluded.
  if (!files.some((file) => file.main)) return { excluded: true, reason: 'no-raw', hits: [] };
  const hits: Verdict['hits'] = [];
  let unreadable = false;
  for (const file of files) {
    try {
      if (await holdsTerm(file.path, terms)) hits.push({ key: file.key, main: file.main, source: file.source });
    } catch {
      unreadable = true;
    }
  }
  if (hits.length > 0) return { excluded: true, reason: 'term', hits };
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

export interface FolderCounts {
  folder: number;
  sessions: number;
  excluded: number;
}

export interface ExclusionCounts {
  sessions: number;
  excluded: number;
  kept: number;
  reasons: { term: number; noRaw: number; noTerms: number; unreadable: number };
  /** Distinct transcript files that held a term, across both sources. */
  hitFiles: { main: number; subagent: number };
  /** The same count per source, because a file in both is counted in each. */
  bySource: { projects: { main: number; subagent: number }; raw: { main: number; subagent: number } };
  folders: FolderCounts[];
}

const sessionIds = async (root: string, project: string): Promise<string[]> => {
  const ids: string[] = [];
  for (const entry of await entriesOf(join(root, project))) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) ids.push(entry.name.slice(0, -'.jsonl'.length));
    else if (entry.isDirectory()) ids.push(entry.name);
  }
  return ids;
};

/** Scans every session in the harness's folders and the raw archive. Returns counts and, apart from them, the excluded sessions. */
export const scanStore = async (runtime: SessionsRuntime, termsFile: string): Promise<{ counts: ExclusionCounts; excluded: { project: string; session: string }[] }> => {
  const terms = await loadTerms(termsFile);
  const raw = paths(runtime.storeDir).raw;
  const projects = new Set<string>();
  for (const root of [runtime.projectsRoot, raw]) {
    for (const entry of await entriesOf(root)) if (entry.isDirectory()) projects.add(entry.name);
  }
  const counts: ExclusionCounts = {
    sessions: 0,
    excluded: 0,
    kept: 0,
    reasons: { term: 0, noRaw: 0, noTerms: 0, unreadable: 0 },
    hitFiles: { main: 0, subagent: 0 },
    bySource: { projects: { main: 0, subagent: 0 }, raw: { main: 0, subagent: 0 } },
    folders: [],
  };
  const excluded: { project: string; session: string }[] = [];
  const distinct = new Set<string>();
  for (const [index, project] of [...projects].sort().entries()) {
    const sessions = [...new Set([...(await sessionIds(runtime.projectsRoot, project)), ...(await sessionIds(raw, project))])].sort();
    const folder: FolderCounts = { folder: index + 1, sessions: 0, excluded: 0 };
    for (const session of sessions) {
      const verdict = await judge(terms, await filesOf(runtime, project, session));
      folder.sessions += 1;
      for (const hit of verdict.hits) {
        counts.bySource[hit.source][hit.main ? 'main' : 'subagent'] += 1;
        const key = `${project}/${hit.key}`;
        if (!distinct.has(key)) {
          distinct.add(key);
          counts.hitFiles[hit.main ? 'main' : 'subagent'] += 1;
        }
      }
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
  await writeFile(where.list, excluded.map((entry) => JSON.stringify(entry)).join('\n') + (excluded.length === 0 ? '' : '\n'));
  const lines = [
    `Scanned ${String(counts.sessions)} sessions in ${String(counts.folders.length)} folders: ${String(counts.excluded)} excluded, ${String(counts.kept)} kept.`,
    `Excluded for a term: ${String(counts.reasons.term)}; no raw to scan: ${String(counts.reasons.noRaw)}; no term file: ${String(counts.reasons.noTerms)}; unreadable: ${String(counts.reasons.unreadable)}.`,
    `Files holding a term: ${String(counts.hitFiles.main)} main, ${String(counts.hitFiles.subagent)} subagent (harness folders ${String(counts.bySource.projects.main + counts.bySource.projects.subagent)}, raw archive ${String(counts.bySource.raw.main + counts.bySource.raw.subagent)}).`,
    'The excluded list is written to a local file outside the repository.',
  ];
  return { document: { ok: true, ...counts }, text: lines.join('\n') };
};
