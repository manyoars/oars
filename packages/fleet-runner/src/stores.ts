// Store folders and the read (spec sections 6 and 7). Each side and arm's valid runs go into their own sessions store, void runs into none, and the
// `real-work-table` read runs over each store with `--min-sessions 3`, its rows saved beside the run book.
//
// A transcript becomes a stored session through `deposit` (`packages/cli/src/sessions/store.ts`), the whole-store pass the `oars` command and the nightly run use:
// it reads every `<projects root>/<project>/<session id>.jsonl` and writes the store folder. Every path is explicit (the store, the projects root, the staging
// folder), so nothing here reads `APPDATA` or the home folder; `stores.test.ts` points both at an empty folder and checks it stays empty.
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { deposit, loadStore, type SessionsRuntime } from '../../cli/src/sessions/store.js';
import { refuseInsideRepository, tableOf, writeJson, type Table } from '../../pool/scripts/real-work-table.js';
import type { RunRequest } from './harness.js';
import type { RunBook } from './runbook.js';

/** The fewest sessions a printed row needs (spec section 5); a server or skill row under it prints thin, a cell row under it is counted as left out. */
export const MIN_SESSIONS = 3;

/** The store folder's name for a run: `<side>-<arm>` for a retest, `<arm>` for a comparison. */
export const folderOf = (side: string | null, arm: string): string => (side === null ? arm : `${side}-${arm}`);

/** What the exclusion gate and owner filter need beside each store: the folder every transcript is filed under must match the owners file's glob. */
const projectOf = (orderId: string): string => `${orderId}-oars`;

export interface Stager {
  /** The `stage` option of `runOrder`: copies the transcript out of the run's temp folder and returns its session id. */
  stage: (request: RunRequest, transcriptPath: string) => Promise<string>;
  /** Where each staged run's copy is, by run id. */
  readonly files: ReadonlyMap<string, { path: string; sessionId: string }>;
  /** Deletes the staging folder. */
  clear: () => Promise<void>;
}

/** The session id a Claude Code transcript carries: the `sessionId` of its first line that has one. Throws when there is none. */
const sessionIdIn = (text: string): string => {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const id: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'sessionId') : undefined;
    if (typeof id === 'string' && /^[0-9A-Za-z][0-9A-Za-z-]{7,}$/.test(id)) return id;
  }
  throw new Error('the transcript has no session id');
};

export const makeStager = (staging: string): Stager => {
  const files = new Map<string, { path: string; sessionId: string }>();
  return {
    files,
    stage: async (request, transcriptPath) => {
      const sessionId = sessionIdIn(await readFile(transcriptPath, 'utf8'));
      await mkdir(staging, { recursive: true });
      const path = join(staging, `${request.runId}.jsonl`);
      await copyFile(transcriptPath, path);
      files.set(request.runId, { path, sessionId });
      return sessionId;
    },
    clear: () => rm(staging, { recursive: true, force: true }),
  };
};

export interface StoreFolder {
  name: string;
  /**
   * The folder a child `oars` process takes as its config folder (`APPDATA` on Windows, `XDG_CONFIG_HOME` elsewhere): the CLI reads its store at `<root>/oars/sessions`, its sign-in
   * file at `<root>/oars/credentials.json`, and (with `CLAUDE_CONFIG_DIR` at `<root>/claude`) its exclusion terms at `<root>/claude/session-commons/exclusion-terms.txt`.
   */
  configRoot: string;
  storeDir: string;
  projectsRoot: string;
  /** The valid runs' session ids filed here, in run order. */
  sessionIds: string[];
}

const NOW = Date.parse('2026-11-16T00:00:00Z');

/**
 * Files each valid run of `book` in its side and arm's own store folder under `<out>/<order id>.stores/`, in run order, and returns the folders in order of first use.
 * A void run is in none (and holds no pool session id). A session that does not come back out of the store throws: the run book must not name a session the store lacks.
 * The staging folder is deleted on every exit, a throw included.
 */
export const buildStores = async (book: RunBook, stager: Stager, out: string): Promise<StoreFolder[]> => {
  refuseInsideRepository(out, 'stores');
  // The staging folder holds full transcript copies: it goes on every exit, a throw included.
  try {
    const base = join(out, `${book.header.orderId}.stores`);
    const folders = new Map<string, StoreFolder>();
    for (const run of book.runs) {
      const staged = stager.files.get(run.runId);
      if (run.void !== null || run.poolSessionId === null) continue;
      if (staged === undefined) throw new Error(`valid run ${run.runId} has a pool session id but was not staged`);
      const name = folderOf(run.side, run.arm);
      const configRoot = join(base, name);
      const folder = folders.get(name) ?? { name, configRoot, storeDir: join(configRoot, 'oars', 'sessions'), projectsRoot: join(configRoot, 'claude', 'projects'), sessionIds: [] };
      folders.set(name, folder);
      const project = join(folder.projectsRoot, projectOf(book.header.orderId));
      await mkdir(project, { recursive: true });
      await copyFile(staged.path, join(project, `${staged.sessionId}.jsonl`));
      folder.sessionIds.push(staged.sessionId);
    }
    for (const folder of folders.values()) {
      const runtime: SessionsRuntime = { storeDir: folder.storeDir, projectsRoot: folder.projectsRoot, sources: [], stdin: process.stdin, stdout: { write: () => true } };
      await deposit(runtime, { allow: [], redactDomains: [], now: () => NOW });
      const stored = new Set((await loadStore(folder.storeDir)).sessions.map((session) => session.session));
      const missing = folder.sessionIds.filter((id) => !stored.has(id));
      if (missing.length > 0) throw new Error(`store folder ${folder.name} lacks ${String(missing.length)} of its ${String(folder.sessionIds.length)} sessions (first: ${missing[0] ?? ''})`);
    }
    return [...folders.values()];
  } finally {
    await stager.clear();
  }
};

export interface ReadOptions {
  /** Where the row files are written: beside the run book. */
  out: string;
  orderId: string;
  /** The exclusion term list (A38) the read applies; a session whose transcript holds a term moves no number. */
  terms: string;
  /** The build date written into each table's header, `YYYY-MM-DD`. */
  date: string;
}

export interface RowFile {
  folder: string;
  file: string;
  table: Table;
}

/** Runs the `real-work-table` read over each store folder with `--min-sessions 3` and saves `<order id>.<folder>.rows.json` beside the run book. */
export const readStores = async (folders: StoreFolder[], options: ReadOptions): Promise<RowFile[]> => {
  refuseInsideRepository(options.out, 'rows');
  const base = join(options.out, `${options.orderId}.stores`);
  const owners = await writeJson(base, 'owners.json', [{ folder: '*-oars*', owner: 'Many Oars Co.', license: 'Apache-2.0' }]);
  const files: RowFile[] = [];
  for (const folder of folders) {
    const runtime: SessionsRuntime = { storeDir: folder.storeDir, projectsRoot: folder.projectsRoot, sources: [], stdin: process.stdin, stdout: { write: () => true } };
    const table = await tableOf(runtime, { terms: options.terms, owners, minSessions: MIN_SESSIONS, date: options.date });
    files.push({ folder: folder.name, file: await writeJson(options.out, `${options.orderId}.${folder.name}.rows.json`, table), table });
  }
  return files;
};
