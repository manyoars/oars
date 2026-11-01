// The on-disk session store and `deposit`. Layout under `<config>/oars/sessions/`:
//   observations.jsonl      append-only; a re-deposited session is appended again under a higher `rev`
//                           version 3 writes capture records only (session, user-prompt, tool, error-line; CAPTURE_VERSION);
//                           signatures, prompt classes, and episodes are derived from them at read time (derive.ts,
//                           EXTRACTOR_VERSION), so a rule change re-derives without reading any raw transcript
//   state.json              per file: size, mtime, the `rev`, capture version and redact-domain set last deposited
//                           (a file is skipped only when size, mtime, version and domain set all match)
//   salt                    the per-account salt path targets are hashed with (local-only, never shared)
//   raw/<project>/<path>    every deposited transcript, hard-linked (copied across volumes) so the raw outlives the
//                           harness's cleanup; local-only (archive.ts)
//   derived.json            the derived records, rewritten at the end of every deposit
//   skeletons/<session>.json  one skeleton per session (hashes and ids, no content)
//   mcp-calls.jsonl         one line per recall call the MCP server answered
//   hook-calls.jsonl        one line per hook invocation (event, session, hit, milliseconds)
//   hook-index.json         the recurring signatures per project and overall, for the hooks
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { CliError, ExitCode } from '../errors.js';
import { compileAllow, requireEntries, slugOf } from './allow.js';
import { buildIndex, indexPath } from './hook-index.js';
import { archiveRaw } from './archive.js';
import { deriveSession, type SessionCapture } from './derive.js';
import { captureSession, type Capture, type SubagentOrigin } from './extract.js';
import { makeRedactor, type Redactor } from './redact.js';
import {
  CAPTURE_VERSION,
  EXTRACTOR_VERSION,
  type DerivedRecords,
  type ErrorLineObservation,
  type ErrorObservation,
  type Observation,
  type PromptObservation,
  type RecallCall,
  type SessionObservation,
  type SessionSummary,
  type SignatureRecord,
  type Skeleton,
  type ToolObservation,
  type UserPromptObservation,
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
  /** The capture version that wrote this file's records; a file recorded under another version is deposited again. */
  v: string;
  /** The sorted `--redact-domain` set in force when this file was deposited; a file recorded under another set is deposited again. */
  d: string[];
}

interface State {
  files: { [key: string]: FileState };
  /** Every `--redact-domain` any deposit used, so recall masks a query the same way the log was masked. */
  redactDomains: string[];
  /** Every `--allow` entry any deposit used (folders, prefixes, globs): the SessionEnd hook deposits a session only from a folder these name. */
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
  salt: join(storeDir, 'salt'),
  raw: join(storeDir, 'raw'),
});

/** The store's per-account salt, created on first use: path targets are hashed with it so they join inside one account only. */
const saltOf = async (storeDir: string): Promise<string> => {
  const file = paths(storeDir).salt;
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const salt = randomBytes(16).toString('hex');
  await writeFile(file, salt, { mode: 0o600 });
  return salt;
};

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
  /** Subagent transcripts parsed this run (A24); not counted in `sessions`, so per-session denominators stay main sessions. */
  subagents: number;
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
  salt: string;
  at: string;
  now: () => number;
}

const contextFor = async (runtime: SessionsRuntime, state: State, now: () => number): Promise<DepositContext> => {
  // Each file records the set it was deposited under. A file whose set differs from the current one is read again, so a domain
  // added while other folders were allowed still masks those folders later. Lines already written stay in the append-only
  // observations file until it is compacted; readers use only the highest rev of each session.
  await mkdir(paths(runtime.storeDir).skeletons, { recursive: true });
  const salt = await saltOf(runtime.storeDir);
  return { runtime, state, domains: [...state.redactDomains].sort(), redact: makeRedactor(state.redactDomains), salt, at: new Date(now()).toISOString(), now };
};

/** A transcript to deposit: a main session file, or a subagent's under `<session>/subagents/` (register A24). */
interface Transcript {
  file: string;
  /** `<session>`, or `<parent>~agent-x` / `<parent>~wf_y~agent-x` for a subagent. */
  session: string;
  /** The path under the project folder, the key in `state.json`. */
  relative: string;
  subagent?: SubagentOrigin;
}

const mainTranscript = (folder: string, name: string): Transcript => ({ file: join(folder, name), session: name.slice(0, -'.jsonl'.length), relative: name });

const listDir = async (dir: string) => {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
};

/** The subagent's type and the parent's spawning tool call, from its `.meta.json`; null when the file is missing or says nothing. */
const readMeta = async (file: string): Promise<{ agentType: string | null; toolUseId: string | null }> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (isRecord(parsed)) {
      return { agentType: typeof parsed.agentType === 'string' ? parsed.agentType : null, toolUseId: typeof parsed.toolUseId === 'string' ? parsed.toolUseId : null };
    }
  } catch (error) {
    if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
  }
  return { agentType: null, toolUseId: null };
};

// The subagent transcripts of the given sessions: <session>/subagents/agent-*.jsonl and <session>/subagents/workflows/wf_*/agent-*.jsonl.
const subagentTranscripts = async (folder: string, sessions: readonly string[]): Promise<Transcript[]> => {
  const found: Transcript[] = [];
  for (const parent of sessions) {
    const root = join(folder, parent, 'subagents');
    const dirs: { dir: string; path: string[] }[] = [{ dir: root, path: [] }];
    for (const entry of await listDir(join(root, 'workflows'))) {
      if (entry.isDirectory() && entry.name.startsWith('wf_')) dirs.push({ dir: join(root, 'workflows', entry.name), path: ['workflows', entry.name] });
    }
    for (const { dir, path } of dirs) {
      for (const entry of await listDir(dir)) {
        if (!entry.isFile() || !entry.name.startsWith('agent-') || !entry.name.endsWith('.jsonl')) continue;
        const agent = entry.name.slice(0, -'.jsonl'.length);
        const meta = await readMeta(join(dir, `${agent}.meta.json`));
        found.push({
          file: join(dir, entry.name),
          session: [parent, ...path.filter((part) => part !== 'workflows'), agent].join('~'),
          relative: [parent, 'subagents', ...path, entry.name].join('/'),
          subagent: { parent, agentType: meta.agentType, spawnedBy: meta.toolUseId },
        });
      }
    }
  }
  return found;
};

/** The session folders under a project folder: each may hold subagent transcripts, even when its main transcript is gone. */
const sessionFolders = async (folder: string): Promise<string[]> => (await listDir(folder)).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

/** Deposits one transcript unless its size, mtime, capture version, and domain set are unchanged; returns what it wrote, or undefined when skipped. */
const depositFile = async (context: DepositContext, project: string, transcript: Transcript): Promise<Capture | undefined> => {
  const { runtime, state } = context;
  const { file, session, subagent } = transcript;
  const info = await stat(file);
  // Archived before the unchanged check, so a store deposited before the archive existed fills it on its next run.
  await archiveRaw(file, join(paths(runtime.storeDir).raw, project, ...transcript.relative.split('/')));
  const key = `${project}/${transcript.relative}`;
  const previous = state.files[key];
  if (previous !== undefined && previous.size === info.size && previous.mtimeMs === info.mtimeMs && previous.v === CAPTURE_VERSION && sameSet(previous.d, context.domains)) {
    return undefined;
  }
  const files = paths(runtime.storeDir);
  const rev = Math.max((previous?.rev ?? 0) + 1, context.now());
  const extract = captureSession({ text: await readFile(file, 'utf8'), session, project, rev, at: context.at, bytes: info.size, redact: context.redact, salt: context.salt, subagent });
  const batch: Observation[] = [extract.session, ...extract.prompts, ...extract.tools, ...extract.errorLines];
  await mkdir(runtime.storeDir, { recursive: true });
  await appendFile(files.observations, batch.map((observation) => `${JSON.stringify(observation)}\n`).join(''), { mode: 0o600 });
  await writeAtomic(join(files.skeletons, `${session}.json`), JSON.stringify(extract.skeleton));
  state.files[key] = { size: info.size, mtimeMs: info.mtimeMs, rev, v: CAPTURE_VERSION, d: context.domains };
  return extract;
};

/** Rewrites `derived.json` and the hook index from the whole store. */
export const refresh = async (runtime: SessionsRuntime, redactDomains: readonly string[], at: string): Promise<void> => {
  const store = await loadStore(runtime.storeDir);
  await writeAtomic(paths(runtime.storeDir).derived, JSON.stringify(derive(store, at)));
  await writeAtomic(indexPath(runtime.storeDir), JSON.stringify(buildIndex(store, redactDomains, at)));
};

interface LockOptions {
  /** How long to wait for a holder before giving up. */
  waitMs: number;
  /** A lock file older than this belongs to a process that died; it is broken. */
  staleMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const isCode = (error: unknown, ...codes: string[]): boolean => error instanceof Error && 'code' in error && typeof error.code === 'string' && codes.includes(error.code);

/**
 * Creates `file` only if absent. False when it exists; EPERM or EACCES is Windows saying the previous holder's delete has not
 * finished, so it is returned (not thrown) and `withLock` rethrows it when the wait runs out with no lock file standing.
 */
const claim = async (file: string): Promise<boolean | Error> => {
  try {
    await writeFile(file, String(process.pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (isCode(error, 'EEXIST')) return false;
    if (isCode(error, 'EPERM', 'EACCES') && error instanceof Error) return error;
    throw error;
  }
};

/**
 * Breaks `lock` when it is older than `staleMs`. Only one waiter at a time may judge and remove it (a second `store.lock.break` claim),
 * and the age is read again inside that claim, so a waiter that lost the race finds the winner's fresh lock and leaves it.
 */
const breakStale = async (lock: string, staleMs: number): Promise<void> => {
  const guard = `${lock}.break`;
  if ((await claim(guard)) !== true) {
    const guardAge = await stat(guard).then((info) => Date.now() - info.mtimeMs, () => 0);
    if (guardAge > staleMs) await rm(guard, { force: true });
    return;
  }
  try {
    const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
    if (age > staleMs) await rm(lock, { force: true });
  } finally {
    await rm(guard, { force: true });
  }
};

/**
 * Runs `work` as the only writer of `state.json` and the observations file. The SessionEnd hooks of parallel sessions and the nightly
 * run each read, extract, and rewrite `state.json`; without this one's `files` and `allow` entries are lost to another's write.
 */
export const withLock = async <T>(storeDir: string, work: () => Promise<T>, options: LockOptions = { waitMs: 10_000, staleMs: 600_000 }): Promise<T> => {
  const lock = join(storeDir, 'store.lock');
  await mkdir(storeDir, { recursive: true });
  const started = Date.now();
  let claimed = await claim(lock);
  while (claimed !== true) {
    await breakStale(lock, options.staleMs);
    if (Date.now() - started >= options.waitMs) {
      if (claimed instanceof Error && !(await stat(lock).then(() => true, (error: unknown) => !isCode(error, 'ENOENT')))) throw claimed;
      throw new CliError('The store is locked by another deposit; try again shortly.', ExitCode.UNEXPECTED, 'unexpected');
    }
    await sleep(25);
    claimed = await claim(lock);
  }
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
};

export const deposit = (runtime: SessionsRuntime, options: DepositOptions): Promise<DepositResult> => withLock(runtime.storeDir, () => depositLocked(runtime, options));

const depositLocked = async (runtime: SessionsRuntime, options: DepositOptions): Promise<DepositResult> => {
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
    subagents: 0,
    skippedFolders: folders.length - allowed.length,
    folders: allowed,
    missing,
  };
  for (const project of allowed) {
    const folder = join(runtime.projectsRoot, project);
    const entries = (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => entry.name).sort();
    const transcripts = [...entries.map((name) => mainTranscript(folder, name)), ...(await subagentTranscripts(folder, await sessionFolders(folder)))];
    for (const transcript of transcripts) {
      const extract = await depositFile(context, project, transcript);
      if (extract === undefined) {
        result.unchanged += 1;
        continue;
      }
      if (transcript.subagent === undefined) result.sessions += 1;
      else result.subagents += 1;
      result.lines += extract.session.lines;
      result.badLines += extract.session.badLines;
      result.observations += 1 + extract.prompts.length + extract.tools.length + extract.errorLines.length;
    }
  }
  await writeAtomic(paths(runtime.storeDir).state, JSON.stringify(state));
  await refresh(runtime, state.redactDomains, context.at);
  return result;
};

const HOOK_LOCK: LockOptions = { waitMs: 3_000, staleMs: 600_000 };

export type SessionDeposit = 'deposited' | 'unchanged' | 'not-allowed' | 'missing';

/**
 * Deposits one transcript, as the SessionEnd hook does: only from a folder that earlier `--allow` entries name, and idempotent by size and
 * mtime. It does not rebuild `derived.json` or the hook index (that is a whole-store pass; the nightly run does it), so it stays fast.
 */
export const depositSession = (runtime: SessionsRuntime, transcript: string, now: () => number): Promise<SessionDeposit> =>
  // The hook path gives up after 3 s so a SessionEnd behind the nightly deposit cannot hold session exit past its 5 s budget.
  withLock(runtime.storeDir, () => depositSessionLocked(runtime, transcript, now), HOOK_LOCK);

const depositSessionLocked = async (runtime: SessionsRuntime, transcript: string, now: () => number): Promise<SessionDeposit> => {
  const project = basename(dirname(transcript));
  const state = await readState(runtime.storeDir);
  if (!compileAllow(state.allow).allows(project)) return 'not-allowed';
  const context = await contextFor(runtime, state, now);
  const folder = dirname(transcript);
  const main = mainTranscript(folder, basename(transcript));
  let wrote: boolean;
  try {
    wrote = (await depositFile(context, project, main)) !== undefined;
  } catch (error) {
    if (isMissing(error)) return 'missing';
    throw error;
  }
  // The session's subagents finished before it did, so the Stop deposit takes them too (A24).
  for (const subagent of await subagentTranscripts(folder, [main.session])) {
    wrote = (await depositFile(context, project, subagent)) !== undefined || wrote;
  }
  if (!wrote) return 'unchanged';
  await writeAtomic(paths(runtime.storeDir).state, JSON.stringify(state));
  return 'deposited';
};

export interface Store {
  /** Main transcripts only, so session counts and per-session denominators are unchanged by subagent deposits. */
  sessions: SessionObservation[];
  prompts: PromptObservation[];
  errors: ErrorObservation[];
  /** Subagent transcripts (A24), kept apart from `sessions` so G1 denominators stay main sessions. */
  subagents: SessionObservation[];
  /** The tool calls of every version-3 transcript, main and subagent. */
  tools: ToolObservation[];
}

interface Captured {
  session?: SessionObservation;
  prompts: UserPromptObservation[];
  tools: ToolObservation[];
  errorLines: ErrorLineObservation[];
}

/**
 * The store as a reader sees it: for each session only the highest `rev`. A version-3 session is derived here from its capture records
 * (EXTRACTOR_VERSION rules); a session whose last deposit was version 2 keeps the prompt and error lines that deposit wrote.
 */
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
  const store: Store = { sessions: [], prompts: [], errors: [], subagents: [], tools: [] };
  const captured = new Map<string, Captured>();
  const of = (session: string): Captured => {
    const found = captured.get(session) ?? { prompts: [], tools: [], errorLines: [] };
    captured.set(session, found);
    return found;
  };
  for (const observation of all) {
    if (observation.rev !== latest.get(observation.session)) continue;
    if (observation.kind === 'session') of(observation.session).session = observation;
    else if (observation.kind === 'user-prompt') of(observation.session).prompts.push(observation);
    else if (observation.kind === 'tool') of(observation.session).tools.push(observation);
    else if (observation.kind === 'error-line') of(observation.session).errorLines.push(observation);
    else if (observation.kind === 'prompt') store.prompts.push(observation);
    else store.errors.push(observation);
  }
  const redact = makeRedactor((await readState(storeDir)).redactDomains);
  const agents: (SessionCapture & { parent: string })[] = [];
  for (const { session, prompts, tools, errorLines } of captured.values()) {
    if (session === undefined) continue;
    store.tools.push(...tools);
    if (session.parent !== null) {
      store.subagents.push(session);
      if (session.cv === CAPTURE_VERSION) agents.push({ session, prompts, tools, errorLines, parent: session.parent });
      continue;
    }
    store.sessions.push(session);
    if (session.cv !== CAPTURE_VERSION) continue;
    const derived = deriveSession({ session, prompts, tools, errorLines }, redact);
    store.prompts.push(...derived.prompts);
    store.errors.push(...derived.errors);
  }
  store.errors.push(...agentErrors(store, agents, redact));
  return store;
};

/**
 * A subagent's errors are the fleet's work too (A24), so they join `store.errors` under the main session that spawned the agent,
 * with the agent's transcript in `agent`: every count by session (signature sessions, measure's recurrence, the hook index) then
 * counts the parent once, and G1's denominators stay main sessions. `prompt` and `cls` are the spawning prompt's (null when the
 * spawning call is not in the parent), as books attributes the agent's tokens.
 */
const agentErrors = (store: Store, agents: readonly (SessionCapture & { parent: string })[], redact: Redactor): ErrorObservation[] => {
  const classOf = new Map(store.prompts.map((prompt) => [`${prompt.session}#${String(prompt.index)}`, prompt.cls]));
  const promptOf = new Map<string, number>();
  for (const tool of store.tools) if (tool.toolUseId !== null && tool.prompt !== null) promptOf.set(`${tool.session} ${tool.toolUseId}`, tool.prompt);
  const errors: ErrorObservation[] = [];
  for (const capture of agents) {
    const { parent } = capture;
    const prompt = promptOf.get(`${parent} ${String(capture.session.spawnedBy)}`) ?? null;
    const cls = prompt === null ? null : (classOf.get(`${parent}#${String(prompt)}`) ?? null);
    for (const error of deriveSession(capture, redact).errors) errors.push({ ...error, session: parent, agent: capture.session.session, prompt, cls });
  }
  return errors;
};

// The store is ours, so a line with a known `kind`, a session, and a rev is trusted as the type it says.
const asObservation = (value: unknown): Observation | undefined => {
  if (!isRecord(value) || typeof value.session !== 'string' || typeof value.rev !== 'number') return undefined;
  if (value.kind === 'session') return isSession(value) ? asSession(value) : undefined;
  if (value.kind === 'prompt') return isPrompt(value) ? value : undefined;
  if (value.kind === 'error') return isError(value) ? value : undefined;
  if (value.kind === 'user-prompt') return isUserPrompt(value) ? value : undefined;
  if (value.kind === 'tool') return isTool(value) ? value : undefined;
  if (value.kind === 'error-line') return isErrorLine(value) ? value : undefined;
  return undefined;
};

/** A version-2 session line has `v` and no `cv`, `parent`, or agent fields: it reads as a main transcript of that version. */
const asSession = (value: { [key: string]: unknown } & SessionObservation): SessionObservation => ({
  ...value,
  cv: typeof value.cv === 'string' ? value.cv : String(value.v),
  parent: typeof value.parent === 'string' ? value.parent : null,
  agentType: typeof value.agentType === 'string' ? value.agentType : null,
  spawnedBy: typeof value.spawnedBy === 'string' ? value.spawnedBy : null,
});

type Line = { [key: string]: unknown };
const isSession = (value: Line): value is Line & SessionObservation => Array.isArray(value.files) && isRecord(value.usage);
const isPrompt = (value: Line): value is Line & PromptObservation => Array.isArray(value.tools) && isRecord(value.usage);
const isError = (value: Line): value is Line & ErrorObservation => typeof value.sig === 'string' && Array.isArray(value.next);
const isUserPrompt = (value: Line): value is Line & UserPromptObservation => typeof value.index === 'number' && isRecord(value.usage);
const isTool = (value: Line): value is Line & ToolObservation => typeof value.tool === 'string' && typeof value.n === 'number';
const isErrorLine = (value: Line): value is Line & ErrorLineObservation => typeof value.line === 'string' && typeof value.after === 'number';

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
