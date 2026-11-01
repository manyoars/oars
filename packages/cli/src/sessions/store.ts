// The on-disk session store and `deposit`. Layout under `<config>/oars/sessions/`:
//   observations.jsonl      append-only; a re-deposited session is appended again under a higher `rev`
//   state.json              per file: size, mtime, the `rev`, extractor version and redact-domain set last deposited
//                           (a file is skipped only when size, mtime, version and domain set all match)
//   derived.json            the derived records, rewritten at the end of every deposit
//   skeletons/<session>.json  one skeleton per session (hashes and ids, no content)
//   mcp-calls.jsonl         one line per recall call the MCP server answered
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { compileAllow, requireEntries, slugOf } from './allow.js';
import { buildIndex, indexPath } from './hook-index.js';
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
  /** The extractor version that wrote this file's records; a file recorded under another version is deposited again. */
  v: string;
  /** The sorted `--redact-domain` set in force when this file was deposited; a file recorded under another set is deposited again. */
  d: string[];
}

interface State {
  files: { [key: string]: FileState };
  /** Every `--redact-domain` any deposit used, so recall masks a query the same way the log was masked. */
  redactDomains: string[];
  /** Every `--allow` entry any deposit used (folders, prefixes, globs): the Stop hook deposits a session only from a folder these name. */
  allow: string[];
}

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

export const paths = (storeDir: string) => ({
  observations: join(storeDir, 'observations.jsonl'),
  state: join(storeDir, 'state.json'),
  derived: join(storeDir, 'derived.json'),
  skeletons: join(storeDir, 'skeletons'),
  calls: join(storeDir, 'mcp-calls.jsonl'),
  hookCalls: join(storeDir, 'hook-calls.jsonl'),
});

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((entry, index) => entry === b[index]);

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

const readState = async (storeDir: string): Promise<State> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(paths(storeDir).state, 'utf8'));
    if (isRecord(parsed) && isRecord(parsed.files)) {
      const files: State['files'] = {};
      for (const [key, value] of Object.entries(parsed.files)) {
        if (isRecord(value) && typeof value.size === 'number' && typeof value.mtimeMs === 'number' && typeof value.rev === 'number') {
          files[key] = {
            size: value.size,
            mtimeMs: value.mtimeMs,
            rev: value.rev,
            v: typeof value.v === 'string' ? value.v : '',
            d: Array.isArray(value.d) ? value.d.filter((entry): entry is string => typeof entry === 'string') : [],
          };
        }
      }
      const domains = Array.isArray(parsed.redactDomains) ? parsed.redactDomains.filter((entry): entry is string => typeof entry === 'string') : [];
      const allow = Array.isArray(parsed.allow) ? parsed.allow.filter((entry): entry is string => typeof entry === 'string') : [];
      return { files, redactDomains: domains, allow };
    }
  } catch (error) {
    if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
  }
  return { files: {}, redactDomains: [], allow: [] };
};

export const readRedactDomains = async (storeDir: string): Promise<string[]> => (await readState(storeDir)).redactDomains;

/** The `--allow` entries and `--redact-domain` set earlier deposits used; the nightly run repeats them. */
export const readSaved = async (storeDir: string): Promise<{ allow: string[]; redactDomains: string[] }> => {
  const { allow, redactDomains } = await readState(storeDir);
  return { allow, redactDomains };
};

const writeAtomic = async (file: string, text: string): Promise<void> => {
  await mkdir(join(file, '..'), { recursive: true });
  const temp = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, file);
};

export { slugOf };

export interface DepositOptions {
  allow: readonly string[];
  redactDomains: readonly string[];
  now: () => number;
}

export interface DepositResult {
  /** Session files parsed this run. */
  sessions: number;
  /** Session files skipped because size, mtime, extractor version, and redact-domain set were all unchanged. */
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

interface DepositContext {
  runtime: SessionsRuntime;
  state: State;
  /** The sorted redact-domain set in force. */
  domains: string[];
  redact: ReturnType<typeof makeRedactor>;
  at: string;
  now: () => number;
}

const contextFor = async (runtime: SessionsRuntime, state: State, now: () => number): Promise<DepositContext> => {
  // Each file records the set it was deposited under. A file whose set differs from the current one is read again, so a domain
  // added while other folders were allowed still masks those folders later. Lines already written stay in the append-only
  // observations file until it is compacted; readers use only the highest rev of each session.
  await mkdir(paths(runtime.storeDir).skeletons, { recursive: true });
  return { runtime, state, domains: [...state.redactDomains].sort(), redact: makeRedactor(state.redactDomains), at: new Date(now()).toISOString(), now };
};

/** Deposits one session file unless its size, mtime, extractor version, and domain set are unchanged; returns what it wrote, or undefined when skipped. */
const depositFile = async (context: DepositContext, project: string, file: string): Promise<ReturnType<typeof extractSession> | undefined> => {
  const { runtime, state } = context;
  const info = await stat(file);
  const name = basename(file);
  const key = `${project}/${name}`;
  const previous = state.files[key];
  if (previous !== undefined && previous.size === info.size && previous.mtimeMs === info.mtimeMs && previous.v === EXTRACTOR_VERSION && sameSet(previous.d, context.domains)) {
    return undefined;
  }
  const files = paths(runtime.storeDir);
  const session = name.slice(0, -'.jsonl'.length);
  const rev = Math.max((previous?.rev ?? 0) + 1, context.now());
  const extract = extractSession({ text: await readFile(file, 'utf8'), session, project, rev, at: context.at, bytes: info.size, redact: context.redact });
  const batch: Observation[] = [extract.session, ...extract.prompts, ...extract.errors];
  await mkdir(runtime.storeDir, { recursive: true });
  await appendFile(files.observations, batch.map((observation) => `${JSON.stringify(observation)}
`).join(''), { mode: 0o600 });
  await writeAtomic(join(files.skeletons, `${session}.json`), JSON.stringify(extract.skeleton));
  state.files[key] = { size: info.size, mtimeMs: info.mtimeMs, rev, v: EXTRACTOR_VERSION, d: context.domains };
  return extract;
};

/** Rewrites `derived.json` and the hook index from the whole store. */
export const refresh = async (runtime: SessionsRuntime, redactDomains: readonly string[], at: string): Promise<void> => {
  const store = await loadStore(runtime.storeDir);
  await writeAtomic(paths(runtime.storeDir).derived, JSON.stringify(derive(store, at)));
  await writeAtomic(indexPath(runtime.storeDir), JSON.stringify(buildIndex(store, redactDomains, at)));
};

export const deposit = async (runtime: SessionsRuntime, options: DepositOptions): Promise<DepositResult> => {
  requireEntries(options.allow);
  const allow = compileAllow(options.allow);
  const folders = await projectFolders(runtime.projectsRoot);
  const allowed = folders.filter((name) => allow.allows(name));
  const missing = allow.unmatched(folders);
  const state = await readState(runtime.storeDir);
  state.redactDomains = [...new Set([...state.redactDomains, ...options.redactDomains])];
  state.allow = [...new Set([...state.allow, ...options.allow])];
  const context = await contextFor(runtime, state, options.now);
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
      const extract = await depositFile(context, project, join(folder, name));
      if (extract === undefined) {
        result.unchanged += 1;
        continue;
      }
      result.sessions += 1;
      result.lines += extract.session.lines;
      result.badLines += extract.session.badLines;
      result.observations += 1 + extract.prompts.length + extract.errors.length;
    }
  }
  await writeAtomic(paths(runtime.storeDir).state, JSON.stringify(state));
  await refresh(runtime, state.redactDomains, context.at);
  return result;
};

export type SessionDeposit = 'deposited' | 'unchanged' | 'not-allowed' | 'missing';

/**
 * Deposits one transcript, as the Stop hook does: only from a folder that earlier `--allow` entries name, and idempotent by size and
 * mtime. It does not rebuild `derived.json` or the hook index (that is a whole-store pass; the nightly run does it), so it stays fast.
 */
export const depositSession = async (runtime: SessionsRuntime, transcript: string, now: () => number): Promise<SessionDeposit> => {
  const project = basename(dirname(transcript));
  const state = await readState(runtime.storeDir);
  if (!compileAllow(state.allow).allows(project)) return 'not-allowed';
  const context = await contextFor(runtime, state, now);
  try {
    if ((await depositFile(context, project, transcript)) === undefined) return 'unchanged';
  } catch (error) {
    if (isMissing(error)) return 'missing';
    throw error;
  }
  await writeAtomic(paths(runtime.storeDir).state, JSON.stringify(state));
  return 'deposited';
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
