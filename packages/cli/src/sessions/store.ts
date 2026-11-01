// The on-disk session store and `deposit`. Layout under `<config>/oars/sessions/`:
//   observations.jsonl      append-only; a re-deposited session is appended again under a higher `rev`
//   state.json              per file: size, mtime, and the `rev` last deposited (the idempotency check)
//   derived.json            the derived records, rewritten at the end of every deposit
//   skeletons/<session>.json  one skeleton per session (hashes and ids, no content)
//   mcp-calls.jsonl         one line per recall call the MCP server answered
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CliError, ExitCode } from '../errors.js';
import { extractSession } from './extract.js';
import { makeRedactor } from './redact.js';
import {
  EXTRACTOR_VERSION,
  type DerivedRecords,
  type ErrorObservation,
  type Observation,
  type PromptObservation,
  type RecallCall,
  type SessionObservation,
  type SessionSummary,
  type SignatureRecord,
  type Skeleton,
} from './schema.js';

/** Where the store and the operator's Claude Code logs are; `bin.ts` fills it from the environment. */
export interface SessionsRuntime {
  /** `<config>/oars/sessions`. */
  storeDir: string;
  /** `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`). */
  projectsRoot: string;
  stdin: NodeJS.ReadableStream;
  stdout: { write: (text: string) => unknown };
}

interface FileState {
  size: number;
  mtimeMs: number;
  rev: number;
}

interface State {
  files: { [key: string]: FileState };
  /** Every `--redact-domain` any deposit used, so recall masks a query the same way the log was masked. */
  redactDomains: string[];
}

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

export const paths = (storeDir: string) => ({
  observations: join(storeDir, 'observations.jsonl'),
  state: join(storeDir, 'state.json'),
  derived: join(storeDir, 'derived.json'),
  skeletons: join(storeDir, 'skeletons'),
  calls: join(storeDir, 'mcp-calls.jsonl'),
});

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

const readState = async (storeDir: string): Promise<State> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(paths(storeDir).state, 'utf8'));
    if (isRecord(parsed) && isRecord(parsed.files)) {
      const files: State['files'] = {};
      for (const [key, value] of Object.entries(parsed.files)) {
        if (isRecord(value) && typeof value.size === 'number' && typeof value.mtimeMs === 'number' && typeof value.rev === 'number') {
          files[key] = { size: value.size, mtimeMs: value.mtimeMs, rev: value.rev };
        }
      }
      const domains = Array.isArray(parsed.redactDomains) ? parsed.redactDomains.filter((entry): entry is string => typeof entry === 'string') : [];
      return { files, redactDomains: domains };
    }
  } catch (error) {
    if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
  }
  return { files: {}, redactDomains: [] };
};

export const readRedactDomains = async (storeDir: string): Promise<string[]> => (await readState(storeDir)).redactDomains;

const writeAtomic = async (file: string, text: string): Promise<void> => {
  await mkdir(join(file, '..'), { recursive: true });
  const temp = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, file);
};

/** Claude Code names a project folder after its working directory with every non-alphanumeric character as `-`. */
export const slugOf = (folder: string): string => resolve(folder).replace(/[^A-Za-z0-9]/g, '-');

export interface DepositOptions {
  allow: readonly string[];
  redactDomains: readonly string[];
  now: () => number;
}

export interface DepositResult {
  /** Session files parsed this run. */
  sessions: number;
  /** Session files skipped because size and mtime were unchanged. */
  unchanged: number;
  lines: number;
  badLines: number;
  observations: number;
  /** Project folders under the projects root that are not on the allowlist, so were not opened. */
  skippedFolders: number;
  /** The allowed folders that exist under the projects root. */
  folders: string[];
  /** Allowed names that matched no project folder. */
  missing: string[];
}

const projectFolders = async (projectsRoot: string): Promise<string[]> => {
  try {
    return (await readdir(projectsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
};

export const deposit = async (runtime: SessionsRuntime, options: DepositOptions): Promise<DepositResult> => {
  if (options.allow.length === 0) {
    throw new CliError('Nothing to read: pass at least one --allow <folder>. Nothing is read from a folder you have not named.', ExitCode.USAGE, 'usage');
  }
  // A bare folder name (the slug Claude Code gave the project) matches itself; a path matches its slug.
  const names = new Set(options.allow.flatMap((entry) => [entry, slugOf(entry)]));
  const folders = await projectFolders(runtime.projectsRoot);
  const allowed = folders.filter((name) => names.has(name));
  const matched = new Set(allowed);
  const missing = options.allow.filter((entry) => !matched.has(entry) && !matched.has(slugOf(entry)));
  const state = await readState(runtime.storeDir);
  state.redactDomains = [...new Set([...state.redactDomains, ...options.redactDomains])];
  const redact = makeRedactor(state.redactDomains);
  const files = paths(runtime.storeDir);
  await mkdir(files.skeletons, { recursive: true });
  const at = new Date(options.now()).toISOString();
  const result: DepositResult = {
    sessions: 0,
    unchanged: 0,
    lines: 0,
    badLines: 0,
    observations: 0,
    skippedFolders: folders.length - allowed.length,
    folders: allowed,
    missing,
  };
  for (const project of allowed) {
    const folder = join(runtime.projectsRoot, project);
    const entries = (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => entry.name).sort();
    for (const name of entries) {
      const file = join(folder, name);
      const info = await stat(file);
      const key = `${project}/${name}`;
      const previous = state.files[key];
      if (previous !== undefined && previous.size === info.size && previous.mtimeMs === info.mtimeMs) {
        result.unchanged += 1;
        continue;
      }
      const session = name.slice(0, -'.jsonl'.length);
      const rev = Math.max((previous?.rev ?? 0) + 1, options.now());
      const extract = extractSession({ text: await readFile(file, 'utf8'), session, project, rev, at, bytes: info.size, redact });
      const batch: Observation[] = [extract.session, ...extract.prompts, ...extract.errors];
      await mkdir(runtime.storeDir, { recursive: true });
      await appendFile(files.observations, batch.map((observation) => `${JSON.stringify(observation)}\n`).join(''), { mode: 0o600 });
      await writeAtomic(join(files.skeletons, `${session}.json`), JSON.stringify(extract.skeleton));
      state.files[key] = { size: info.size, mtimeMs: info.mtimeMs, rev };
      result.sessions += 1;
      result.lines += extract.session.lines;
      result.badLines += extract.session.badLines;
      result.observations += batch.length;
    }
  }
  await writeAtomic(files.state, JSON.stringify(state));
  await writeAtomic(files.derived, JSON.stringify(derive(await loadStore(runtime.storeDir), at)));
  return result;
};

export interface Store {
  sessions: SessionObservation[];
  prompts: PromptObservation[];
  errors: ErrorObservation[];
}

/** The store as a reader sees it: for each session only the highest `rev`. */
export const loadStore = async (storeDir: string): Promise<Store> => {
  let text = '';
  try {
    text = await readFile(paths(storeDir).observations, 'utf8');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const all: Observation[] = [];
  const latest = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const observation = asObservation(parsed);
    if (observation === undefined) continue;
    all.push(observation);
    latest.set(observation.session, Math.max(latest.get(observation.session) ?? 0, observation.rev));
  }
  const current = all.filter((observation) => observation.rev === latest.get(observation.session));
  return {
    sessions: current.filter((observation): observation is SessionObservation => observation.kind === 'session'),
    prompts: current.filter((observation): observation is PromptObservation => observation.kind === 'prompt'),
    errors: current.filter((observation): observation is ErrorObservation => observation.kind === 'error'),
  };
};

// The store is ours, so a line with a known `kind`, a session, and a rev is trusted as the type it says.
const asObservation = (value: unknown): Observation | undefined => {
  if (!isRecord(value) || typeof value.session !== 'string' || typeof value.rev !== 'number') return undefined;
  if (value.kind === 'session') return isSession(value) ? value : undefined;
  if (value.kind === 'prompt') return isPrompt(value) ? value : undefined;
  if (value.kind === 'error') return isError(value) ? value : undefined;
  return undefined;
};

const isSession = (value: { [key: string]: unknown }): value is { [key: string]: unknown } & SessionObservation => Array.isArray(value.files) && isRecord(value.usage);
const isPrompt = (value: { [key: string]: unknown }): value is { [key: string]: unknown } & PromptObservation => Array.isArray(value.tools) && isRecord(value.usage);
const isError = (value: { [key: string]: unknown }): value is { [key: string]: unknown } & ErrorObservation => typeof value.sig === 'string' && Array.isArray(value.next);

export const readCalls = async (storeDir: string): Promise<RecallCall[]> => {
  let text = '';
  try {
    text = await readFile(paths(storeDir).calls, 'utf8');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const calls: RecallCall[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed.at === 'string' && typeof parsed.query === 'string' && typeof parsed.matches === 'number') {
        calls.push({ at: parsed.at, query: parsed.query, matches: parsed.matches });
      }
    } catch {
      // A torn last line is skipped.
    }
  }
  return calls;
};

const isSkeleton = (value: unknown): value is { [key: string]: unknown } & Skeleton => isRecord(value) && Array.isArray(value.lines) && typeof value.merkleRoot === 'string';

/** `unreadable` counts skeleton files that are torn, corrupted, or not a skeleton, so verify reports them instead of aborting. */
export const readSkeletons = async (storeDir: string, only?: string): Promise<{ skeletons: Skeleton[]; unreadable: number }> => {
  const folder = paths(storeDir).skeletons;
  let names: string[];
  try {
    names = (await readdir(folder)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (isMissing(error)) return { skeletons: [], unreadable: 0 };
    throw error;
  }
  const skeletons: Skeleton[] = [];
  let unreadable = 0;
  for (const name of names) {
    if (only !== undefined && name !== `${only}.json`) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(folder, name), 'utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (isSkeleton(parsed)) skeletons.push(parsed);
    else unreadable += 1;
  }
  return { skeletons, unreadable };
};

/** The derived records, a pure function of the store. */
export const derive = (store: Store, at: string): DerivedRecords => {
  const bySig = new Map<string, ErrorObservation[]>();
  for (const error of store.errors) bySig.set(error.sig, [...(bySig.get(error.sig) ?? []), error]);
  const signatures: SignatureRecord[] = [...bySig.entries()].map(([sig, list]) => signatureRecord(sig, list));
  signatures.sort((a, b) => b.sessions - a.sessions || b.count - a.count || a.sig.localeCompare(b.sig));
  const bigrams: { [bigram: string]: number } = {};
  const recovery: { [pair: string]: number } = {};
  const classes: { [cls: string]: { prompts: number; exploreToAct: number } } = {};
  const ratio = new Map<string, { explore: number; act: number }>();
  for (const prompt of store.prompts) {
    for (const [pair, count] of Object.entries(prompt.bigrams)) bigrams[pair] = (bigrams[pair] ?? 0) + count;
    if (prompt.recovery.length > 0) {
      const pair = prompt.recovery.slice(0, 2).join('>');
      recovery[pair] = (recovery[pair] ?? 0) + 1;
    }
    const entry = ratio.get(prompt.cls) ?? { explore: 0, act: 0 };
    entry.explore += prompt.explore;
    entry.act += prompt.act;
    ratio.set(prompt.cls, entry);
    classes[prompt.cls] = { prompts: (classes[prompt.cls]?.prompts ?? 0) + 1, exploreToAct: 0 };
  }
  for (const [cls, entry] of ratio) {
    const row = classes[cls];
    if (row !== undefined) row.exploreToAct = Math.round((entry.explore / Math.max(entry.act, 1)) * 100) / 100;
  }
  const promptCount = new Map<string, number>();
  for (const prompt of store.prompts) promptCount.set(prompt.session, (promptCount.get(prompt.session) ?? 0) + 1);
  const errorCount = new Map<string, number>();
  for (const error of store.errors) errorCount.set(error.session, (errorCount.get(error.session) ?? 0) + 1);
  const summaries: SessionSummary[] = store.sessions.map((session) => ({
    session: session.session,
    project: session.project,
    prompts: promptCount.get(session.session) ?? 0,
    errors: errorCount.get(session.session) ?? 0,
    tools: Object.values(session.tools).reduce((sum, count) => sum + count, 0),
    tsFirst: session.tsFirst,
    tsLast: session.tsLast,
    tldrs: session.tldrs.length,
  }));
  return { v: EXTRACTOR_VERSION, at, sessions: store.sessions.length, signatures, bigrams, recovery, classes, summaries };
};

export const signatureRecord = (sig: string, list: readonly ErrorObservation[]): SignatureRecord => {
  const stamps = list.map((error) => error.ts).filter((ts): ts is string => ts !== null).sort();
  const following: { [tool: string]: number } = {};
  for (const error of list) for (const tool of error.next) following[tool] = (following[tool] ?? 0) + 1;
  return {
    v: EXTRACTOR_VERSION,
    sig,
    tool: list[0]?.tool ?? '?',
    example: list[0]?.example ?? '',
    sessions: new Set(list.map((error) => error.session)).size,
    count: list.length,
    firstSeen: stamps[0] ?? null,
    lastSeen: stamps[stamps.length - 1] ?? null,
    harnessVersions: [...new Set(list.map((error) => error.harnessVersion).filter((version): version is string => version !== null))].sort(),
    following,
    editFollowed: list.filter((error) => error.editFollowed).length,
  };
};
