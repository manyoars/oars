// The on-disk session store and `deposit`. Layout under `<config>/oars/sessions/`:
//   observations.jsonl      appended to; a re-deposited session is appended again under a higher `rev`, and a whole-store deposit
//                           then drops the superseded revs (compactLog)
//                           versions 3 and later write capture records only (session, user-prompt, tool, error-line; CAPTURE_VERSION);
//                           signatures, prompt classes, and episodes are derived from them at read time (derive.ts,
//                           EXTRACTOR_VERSION), so a rule change re-derives without reading any raw transcript
//   state.json              per file: size, mtime, the `rev`, capture version, `sid`, and redact-domain set last deposited
//                           (a file is skipped only when size, mtime, version, sid, and domain set all match)
//   salt                    the per-account salt path targets are hashed with (local-only, never shared); its `sid` (first 8 hex
//                           of SHA-256) is stamped on every capture record
//   raw/<project>/<path>    every deposited transcript, hard-linked (copied across volumes) so the raw outlives the
//                           harness's cleanup; local-only (archive.ts)
//   derived.json            the derived records, rewritten at the end of every deposit
//   skeletons/<session>.json  one skeleton per session (hashes and ids, no content)
//   mcp-calls.jsonl         one line per recall call the MCP server answered
//   hook-calls.jsonl        one line per hook invocation (event, session, hit, milliseconds)
//   hook-index.json         the recurring signatures per project and overall, for the hooks
//   pipeline-runs.jsonl     the step log: one line per run of a pipeline step, appended when the step ends (steps.ts)
//   pending/<hash>.<uuid>.json  one file per Stop deposit the store lock refused: the transcript path only, taken by the next deposit (pending.ts)
import type { GoldEvaluator } from './gold-arms.js';
import { derivedSalt } from './machine-ids.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CliError, ExitCode } from '../errors.js';
import { compileAllow, mergeAllow, runAllow, slugOf } from './allow.js';
import { SOURCES, type Source, type SourceStore } from './sources.js';
import { buildIndex, indexPath } from './hook-index.js';
import { archiveRaw } from './archive.js';
import { deferSession, failPending, listPending, PENDING_HOOK_CAP, PENDING_MAX_FAILURES, removePending, sweepPendingTemps, type PendingEntry } from './pending.js';
import { deriveSession, type SessionCapture } from './derive.js';
import { captureRuntime, type CaptureRuntime } from './capture-runtime.js';
import { callPositions, captureSession, type Capture, type SubagentOrigin } from './extract.js';
import { foldToolRows, withoutReplays } from './fold.js';
import { asRepoSize, type RepoSize } from './public-vocabulary.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import { mkdirOwnerOnly } from './owner-only.js';
import type { PoolFold, PoolFolds } from './pool-fold.js';
import type { ReadFolds } from './read-folds.js';
import type { ReversionIndex } from './reversion.js';
import { makeRedactor, type Redactor } from './redact.js';
import {
  CAPTURE_VERSION,
  EXTRACTOR_VERSION,
  OLDEST_READABLE_CAPTURE,
  type DerivedRecords,
  type ErrorLineObservation,
  type CostModel,
  type ErrorObservation,
  type Observation,
  type PromptObservation,
  type RecallCall,
  type SessionObservation,
  type ShellSegment,
  type SessionSummary,
  type SignatureRecord,
  type StepCounts,
  type Skeleton,
  type ToolObservation,
  type UsageKey,
  type UserPromptObservation,
} from './schema.js';

/** Where the store and the operator's Claude Code logs are; `bin.ts` fills it from the environment. */
export interface SessionsRuntime {
  /** `<config>/oars/sessions`. */
  storeDir: string;
  /** `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`). */
  projectsRoot: string;
  /** Cursor's `User` folder (`cursorRoot` in cursor.ts), kept as the alias of `sourceRoots.cursor`; absent means no Cursor source. */
  cursorRoot?: string;
  /** Where each non-Claude source's store lives, by `Source.name` (sources.ts); a source with no root is not read; one with a root is read unless the allowlist names other entries only or denies it. */
  sourceRoots?: { [source: string]: string };
  /** The source table; absent means `SOURCES`. The seam a test uses to prove an entry needs no other wiring. */
  sources?: readonly Source[];
  /** Where the account's salt comes from; absent means this machine's own (`localSalt`). The seam an account identity replaces (M4). */
  accountSalt?: (storeDir: string) => Promise<AccountSalt>;
  /** The salt repository keys are hashed under; a machine takes it from its enrollment (`OARS_REPO_SALT`). Absent means the one derived from the account salt, as the trusted machine computes it. */
  repoSalt?: string;
  /** The fresh single-turn reader behind `gold arms`; absent in a run that has none. */
  evaluator?: GoldEvaluator | undefined;
  stdin: NodeJS.ReadableStream;
  stdout: { write: (text: string) => unknown };
  /** Only its `isTTY` is read: the covenant screen is written to stderr, so a person is at a terminal only when stderr is one too. */
  stderr?: { isTTY?: boolean | undefined } | undefined;
  /** A seam for tests: awaited right after a build's scan of the log and before any session is loaded, so a test can change the log in exactly that window. */
  afterScan?: () => Promise<void>;
  /** How many sessions (with their subagents) `refresh` loads and folds at a time; absent means `REFRESH_RUN`. */
  refreshRun?: number;
  /** A seam for tests and proofs: told once what a refresh folded, after its last run. `reversions` is the size of the matching's index. */
  refreshed?: (folded: { runs: number; reversions: number }) => void;
  /** A seam for proofs: told as `refresh` passes the end of its scan, its last run, the pool fold's finish, and the pool step, so a proof can read the heap at each. */
  refreshStep?: (step: 'scan' | 'runs' | 'finish' | 'pool') => void;
}

interface FileState {
  size: number;
  mtimeMs: number;
  rev: number;
  /** The capture version that wrote this file's records; a file recorded under another version is deposited again. */
  v: string;
  /** The `sid` of the salt the file's records were hashed with; a file recorded under another salt is captured again from raw (spec Section 4). */
  s?: string;
  /** The sorted `--redact-domain` set in force when this file was deposited; a file recorded under another set is deposited again. */
  d: string[];
  /**
   * The repository size bucket this file's first frame read, so a later capture's frame does not follow the repository. Held here as well as
   * in the log because the SessionEnd hook has seconds to run and the log can run to hundreds of MB; absent on a file captured before frames.
   */
  repoSize?: RepoSize | null;
}

export interface State {
  files: { [key: string]: FileState };
  /** Every `--redact-domain` any deposit used, so recall masks a query the same way the log was masked. */
  redactDomains: string[];
  /** Every `--allow` entry any deposit used (folders, prefixes, globs): the SessionEnd hook deposits a session only from a folder these name. */
  allow: string[];
  /** What the person chose about sending to a pool: the raw-copy consent and the folders switched down. Never read by capture. */
  pool: PoolChoices;
}

/**
 * The answer to the raw-copy prompt (`granted`, `declined`, or not asked yet) and the per-folder switches (an `--allow`-style entry mapped to what it may send).
 * A yes carries the covenant version in force when it was given, because the prompt names the sale and training use that covenant states. A yes with no version predates that wording and reads as not asked.
 */
export interface PoolChoices {
  rawConsent: 'granted' | 'declined' | null;
  rawConsentVersion: string | null;
  /** True from a typed no that the pool was not told, while this machine held a yes, until the pool hears the withdrawal or a new yes is typed: the pool may still hold the yes, so a rerun of the no must not read the local `declined` as nothing to tell. */
  withdrawalPending: boolean;
  folders: { [entry: string]: FolderSend };
  /** The answer to the join's region question (in the EU, the EEA, or the UK), kept so a run stopped between that question and the covenant screen does not ask it again. Null until asked. */
  euEeaUk: 'yes' | 'no' | null;
}
export type FolderSend = 'skeleton' | 'off';

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

export const paths = (storeDir: string) => ({
  observations: join(storeDir, 'observations.jsonl'),
  state: join(storeDir, 'state.json'),
  derived: join(storeDir, 'derived.json'),
  skeletons: join(storeDir, 'skeletons'),
  calls: join(storeDir, 'mcp-calls.jsonl'),
  hookCalls: join(storeDir, 'hook-calls.jsonl'),
  hookRows: join(storeDir, 'hook-rows.jsonl'),
  pipelineRuns: join(storeDir, 'pipeline-runs.jsonl'),
  salt: join(storeDir, 'salt'),
  raw: join(storeDir, 'raw'),
});

/** The salt every path hash in a store uses, and its `sid`: the first 8 hex characters of SHA-256(salt), stamped on each capture record. */
export interface AccountSalt {
  salt: string;
  sid: string;
}

export const sidOf = (salt: string): string => createHash('sha256').update(salt).digest('hex').slice(0, 8);

/**
 * This machine's salt, created on first use: path targets hashed with it join inside this store only. This is the one seam where the
 * account's salt replaces the machine's (`SessionsRuntime.accountSalt`, Open question M4): a store whose `sid` then changes captures its
 * files again from raw at the next deposit, and nothing else moves.
 */
export const localSalt = async (storeDir: string): Promise<AccountSalt> => {
  const file = paths(storeDir).salt;
  let salt: string | undefined;
  try {
    salt = (await readFile(file, 'utf8')).trim();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (salt === undefined) {
    salt = randomBytes(16).toString('hex');
    await writeFile(file, salt, { mode: 0o600 });
  }
  return { salt, sid: sidOf(salt) };
};

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((entry, index) => entry === b[index]);

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

export const readState = async (storeDir: string): Promise<State> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(paths(storeDir).state, 'utf8'));
    if (isRecord(parsed) && isRecord(parsed.files)) {
      const files: State['files'] = {};
      for (const [key, value] of Object.entries(parsed.files)) {
        if (isRecord(value) && typeof value.size === 'number' && typeof value.mtimeMs === 'number' && typeof value.rev === 'number') {
          const repoSize = asRepoSize(value.repoSize);
          files[key] = {
            size: value.size,
            mtimeMs: value.mtimeMs,
            rev: value.rev,
            v: typeof value.v === 'string' ? value.v : '',
            ...(typeof value.s === 'string' ? { s: value.s } : {}),
            d: Array.isArray(value.d) ? value.d.filter((entry): entry is string => typeof entry === 'string') : [],
            ...(repoSize === undefined ? {} : { repoSize }),
          };
        }
      }
      const domains = Array.isArray(parsed.redactDomains) ? parsed.redactDomains.filter((entry): entry is string => typeof entry === 'string') : [];
      const allow = Array.isArray(parsed.allow) ? parsed.allow.filter((entry): entry is string => typeof entry === 'string') : [];
      const pool = isRecord(parsed.pool) ? parsed.pool : {};
      const folders: PoolChoices['folders'] = {};
      if (isRecord(pool.folders)) for (const [entry, mode] of Object.entries(pool.folders)) if (mode === 'skeleton' || mode === 'off') folders[entry] = mode;
      const yesVersion = typeof pool.rawConsentVersion === 'string' && pool.rawConsentVersion !== '' ? pool.rawConsentVersion : null;
      const granted = pool.rawConsent === 'granted' && yesVersion !== null;
      return { files, redactDomains: domains, allow, pool: { rawConsent: granted ? 'granted' : pool.rawConsent === 'declined' ? 'declined' : null, rawConsentVersion: granted ? yesVersion : null, withdrawalPending: pool.withdrawalPending === true && !granted, folders, euEeaUk: pool.euEeaUk === 'yes' || pool.euEeaUk === 'no' ? pool.euEeaUk : null } };
    }
  } catch (error) {
    if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
  }
  return { files: {}, redactDomains: [], allow: [], pool: { rawConsent: null, rawConsentVersion: null, withdrawalPending: false, folders: {}, euEeaUk: null } };
};

/** Changes the pool choices under the store lock, so a deposit running at the same time keeps them (it writes the state it read). */
export const updatePoolChoices = (storeDir: string, change: (choices: PoolChoices) => void): Promise<PoolChoices> =>
  withLock(storeDir, async (held) => {
    const state = await readState(storeDir);
    change(state.pool);
    if (!(await held())) throw new StoreLockLostError();
    await writeAtomic(paths(storeDir).state, JSON.stringify(state));
    return state.pool;
  });

export const readRedactDomains = async (storeDir: string): Promise<string[]> => (await readState(storeDir)).redactDomains;

/** The `--allow` entries and `--redact-domain` set earlier deposits used; the nightly run repeats them. */
export const readSaved = async (storeDir: string): Promise<{ allow: string[]; redactDomains: string[] }> => {
  const { allow, redactDomains } = await readState(storeDir);
  return { allow, redactDomains };
};

export const writeAtomic = async (file: string, text: string): Promise<void> => {
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

/** What one deposit run read from one source. */
export interface SourceTally {
  /** Of `sessions`, the ones this source supplied. */
  read: number;
  /** Why the store (or a file in it) could not be read: the full path for the terminal. */
  unreadable: string[];
  /** The same reasons with the file reduced to its base name: the hook-call record (class A) must not carry the user name in a path. */
  unreadableLogged: string[];
  /** Sessions skipped because their id is not a safe file name. */
  rejected: number;
}

export interface DepositResult {
  /** Session files parsed this run. */
  sessions: number;
  /** Session files skipped because size, mtime, capture version, salt, and redact-domain set were all unchanged. */
  unchanged: number;
  lines: number;
  badLines: number;
  observations: number;
  /** Subagent transcripts parsed this run (A24); not counted in `sessions`, so per-session denominators stay main sessions. */
  subagents: number;
  /** Per source name (sources.ts): what this run read from it. A source that was not allowed or has no store has no entry. */
  sources: { [source: string]: SourceTally };
  /** Of `sessions`, the Cursor composer sessions parsed this run; 0 when the Cursor source is not allowed or absent. Alias of `sources.cursor`. */
  cursor: number;
  /** Why the Cursor store could not be read this run (locked, corrupt, or from a Cursor version this reader does not know); empty when it was read or absent. */
  cursorUnreadable: string[];
  /** The same reasons with the store file reduced to its base name: the hook-call record (class A) must not carry the user name in a path. */
  cursorUnreadableLogged: string[];
  /** Cursor composers skipped this run because their id is not a safe file name. */
  cursorRejected: number;
  /** Project folders under the projects root that are not on the allowlist, so were not opened. */
  skippedFolders: number;
  /** The allowed folders that exist under the projects root. */
  folders: string[];
  /** Allowed names that matched no project folder. */
  missing: string[];
}

export const projectFolders = async (projectsRoot: string): Promise<string[]> => {
  try {
    return (await readdir(projectsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
};

/** What a deposit never reads: project folders that hold transcripts but that no `--allow` entry names. */
export interface SkippedScope {
  folders: number;
  /** Main transcripts in those folders; subagent transcripts are not counted, as everywhere else. */
  transcripts: number;
  /** The folder names, sorted. */
  names: string[];
}

/**
 * The scan rule is the allowlist (`depositLocked`, `depositSessionLocked`): a folder no entry names is not opened, by design, so
 * a worktree folder of an allowed repository is skipped when only the repository's own folder is named. This reads folder listings
 * only, never a transcript, so `verify` and `books` can say what the store does not hold.
 */
export const skippedFolders = async (runtime: SessionsRuntime): Promise<SkippedScope> => {
  const allow = compileAllow((await readState(runtime.storeDir)).allow);
  const names: string[] = [];
  let transcripts = 0;
  for (const name of (await projectFolders(runtime.projectsRoot)).filter((folder) => !allow.allows(folder))) {
    const folder = join(runtime.projectsRoot, name);
    let held = 0;
    let anyTranscript: boolean;
    try {
      held = (await listDir(folder)).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).length;
      // A deposit would also take the subagent transcripts of a session folder whose main transcript is gone (`depositLocked`).
      anyTranscript = held > 0 || (await subagentFiles(folder, await sessionFolders(folder))).length > 0;
    } catch {
      // Scope is not a failure: a folder this process cannot list is named with no count rather than failing `verify`.
      anyTranscript = true;
    }
    if (!anyTranscript) continue;
    names.push(name);
    transcripts += held;
  }
  return { folders: names.length, transcripts, names };
};

interface DepositContext {
  held: LockHold;
  runtime: SessionsRuntime;
  state: State;
  /** The sorted redact-domain set in force. */
  domains: string[];
  redact: ReturnType<typeof makeRedactor>;
  salt: AccountSalt;
  /** The salt a repository's key is hashed under. */
  repoSalt: string;
  repoRoot: (cwd: string) => string | null;
  repoIdentity: (root: string) => string;
  /** This process's versions, read once per deposit (it parses package.json). */
  captureRuntime: CaptureRuntime;
  /** What the log says about each transcript, read at most once per deposit and only when a raw-only subagent or a lost state file needs it. */
  logged: () => Promise<LoggedSessions>;
  /** The state file held no entries when this deposit began, so a transcript with no entry may still have been captured before. */
  stateLost: boolean;
  /** The call positions of each parent transcript a subagent of this deposit named, read at most once. */
  parentCalls: Map<string, Promise<Map<string, number>>>;
  /** The same for the subagent transcripts under each parent, read at most once and only when a spawning call is not in the parent. */
  siblingCalls: Map<string, Promise<Sibling[]>>;
  at: string;
  now: () => number;
}

const contextFor = async (runtime: SessionsRuntime, state: State, now: () => number, held: LockHold): Promise<DepositContext> => {
  // Each file records the set it was deposited under. A file whose set differs from the current one is read again, so a domain
  // added while other folders were allowed still masks those folders later. Lines already written stay in the observations file
  // until it is compacted; readers use only the highest rev of each session.
  await mkdir(paths(runtime.storeDir).skeletons, { recursive: true });
  const salt = await (runtime.accountSalt ?? localSalt)(runtime.storeDir);
  let logged: Promise<LoggedSessions> | undefined;
  return {
    held,
    runtime,
    state,
    domains: [...state.redactDomains].sort(),
    redact: makeRedactor(state.redactDomains),
    salt,
    repoSalt: runtime.repoSalt ?? derivedSalt(salt.salt, 'repoKey/1'),
    repoRoot: makeRepoRoot(),
    repoIdentity: makeRepoIdentity(),
    captureRuntime: captureRuntime(),
    logged: () => (logged ??= loggedSessions(runtime.storeDir)),
    stateLost: Object.keys(state.files).length === 0,
    parentCalls: new Map(),
    siblingCalls: new Map(),
    at: new Date(now()).toISOString(),
    now,
  };
};

/** A subagent transcript's call positions, for finding the call that spawned another subagent. */
interface Sibling {
  session: string;
  calls: Map<string, number>;
}

/** Where a subagent was spawned: the call's `n`, in which transcript. */
interface SpawnPoint {
  n: number;
  session: string;
}

/** A transcript to deposit: a main session file, or a subagent's under `<session>/subagents/` (register A24). */
export interface Transcript {
  file: string;
  /** `<session>`, or `<parent>~agent-x` / `<parent>~wf_y~agent-x` for a subagent. */
  session: string;
  /** The path under the project folder, the key in `state.json`. */
  relative: string;
  subagent?: SubagentOrigin;
  /** Read from the store's own archive because the harness no longer has the transcript; it is not archived again. */
  fromRaw?: boolean;
}

export const mainTranscript = (folder: string, name: string): Transcript => ({ file: join(folder, name), session: name.slice(0, -'.jsonl'.length), relative: name });

export const listDir = async (dir: string) => {
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

interface SubagentFile {
  dir: string;
  /** The folders between `subagents` and the file, for example `['workflows', 'wf_x']`. */
  path: string[];
  parent: string;
  name: string;
}

// The subagent transcript files of the given sessions, from folder listings alone:
// <session>/subagents/agent-*.jsonl and <session>/subagents/workflows/wf_*/agent-*.jsonl. No file is opened, so `skippedFolders` can use it on a folder no allow entry names.
export const subagentFiles = async (folder: string, sessions: readonly string[]): Promise<SubagentFile[]> => {
  const found: SubagentFile[] = [];
  for (const parent of sessions) {
    const root = join(folder, parent, 'subagents');
    const dirs: { dir: string; path: string[] }[] = [{ dir: root, path: [] }];
    for (const entry of await listDir(join(root, 'workflows'))) {
      if (entry.isDirectory() && entry.name.startsWith('wf_')) dirs.push({ dir: join(root, 'workflows', entry.name), path: ['workflows', entry.name] });
    }
    for (const { dir, path } of dirs) {
      for (const entry of await listDir(dir)) {
        if (entry.isFile() && entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')) found.push({ dir, path, parent, name: entry.name });
      }
    }
  }
  return found;
};

// The subagent transcripts of the given sessions, each with its `.meta.json` read.
export const subagentTranscripts = async (folder: string, sessions: readonly string[]): Promise<Transcript[]> => {
  const found: Transcript[] = [];
  for (const { dir, path, parent, name } of await subagentFiles(folder, sessions)) {
    const agent = name.slice(0, -'.jsonl'.length);
    const meta = await readMeta(join(dir, `${agent}.meta.json`));
    found.push({
      file: join(dir, name),
      session: [parent, ...path.filter((part) => part !== 'workflows'), agent].join('~'),
      relative: [parent, 'subagents', ...path, name].join('/'),
      subagent: { parent, agentType: meta.agentType, spawnedBy: meta.toolUseId },
    });
  }
  return found;
};

/** The session folders under a project folder: each may hold subagent transcripts, even when its main transcript is gone. */
export const sessionFolders = async (folder: string): Promise<string[]> => (await listDir(folder)).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

/** Refuses a state file recorded at a newer capture version before anything is appended, so a refused run leaves the log as it was. */
const refuseNewer = (state: State): void => {
  const newer = Object.entries(state.files).find(([, entry]) => Number(entry.v) > Number(CAPTURE_VERSION));
  if (newer !== undefined) {
    throw new CliError(`${newer[0]} was captured by a newer oars (capture version ${newer[1].v}, this is ${CAPTURE_VERSION}); upgrade oars.`, ExitCode.UNEXPECTED, 'unexpected');
  }
};

/** The parent transcript's call positions, from the harness's copy or else the archive; empty when neither holds it. */
const readParentCalls = async (candidates: readonly string[]): Promise<Map<string, number>> => {
  for (const candidate of candidates) {
    try {
      return callPositions(await readFile(candidate, 'utf8'));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return new Map();
};

/** The transcripts under one main session, each with its call positions: from the harness's folder, then whatever only the archive still holds. */
const readSiblings = async (folders: readonly string[], parent: string): Promise<Sibling[]> => {
  const siblings = new Map<string, Sibling>();
  for (const folder of folders) {
    for (const { session, file } of await subagentTranscripts(folder, [parent])) {
      if (!siblings.has(session)) siblings.set(session, { session, calls: await readParentCalls([file]) });
    }
  }
  // Sorted, so which copy of a repeated call wins does not depend on the order a directory lists in.
  return [...siblings.values()].sort((one, two) => one.session.localeCompare(two.session));
};

/**
 * The call that spawned a subagent, in its main transcript or else in a sibling subagent's (a subagent can spawn another); null when its
 * origin names no call or no transcript holds that call. A sibling is read only on a miss, so the common case costs one parent read.
 */
const spawnPointOf = async (context: DepositContext, project: string, transcript: Transcript, origin: SubagentOrigin): Promise<SpawnPoint | null> => {
  const id = origin.spawnedBy;
  if (id === null) return null;
  const name = `${origin.parent}.jsonl`;
  const key = `${project}/${origin.parent}`;
  // The project folder holds the transcript at `relative`, whether that folder is the harness's or the archive's.
  const folder = resolve(transcript.file, ...transcript.relative.split('/').map(() => '..'));
  const archive = join(paths(context.runtime.storeDir).raw, project);
  const calls = context.parentCalls.get(key) ?? readParentCalls([join(folder, name), join(archive, name)]);
  context.parentCalls.set(key, calls);
  const inParent = (await calls).get(id);
  if (inParent !== undefined) return { n: inParent, session: origin.parent };
  const siblings = context.siblingCalls.get(key) ?? readSiblings([folder, archive], origin.parent);
  context.siblingCalls.set(key, siblings);
  for (const { session, calls: held } of await siblings) {
    const n = session === transcript.session ? undefined : held.get(id);
    if (n !== undefined) return { n, session };
  }
  return null;
};

/** A subagent transcript's origin with where it was spawned, as far as the transcripts in reach say. */
const originOf = async (context: DepositContext, project: string, transcript: Transcript): Promise<SubagentOrigin | undefined> => {
  const { subagent } = transcript;
  if (subagent === undefined) return undefined;
  const point = await spawnPointOf(context, project, transcript, subagent);
  return { ...subagent, spawnedAt: point?.n ?? null, spawnedIn: point?.session ?? null };
};

/** The size bucket an earlier capture of this transcript read; undefined when there was none, so this capture reads the repository. */
const earlierRepoSize = async (context: DepositContext, previous: FileState | undefined, session: string): Promise<RepoSize | null | undefined> => {
  if (previous !== undefined) return previous.repoSize;
  return context.stateLost ? (await context.logged()).repoSizes.get(session) : undefined;
};

/** Deposits one transcript unless its size, mtime, capture version, salt, and domain set are unchanged; returns what it wrote, or undefined when skipped. */
const depositFile = async (context: DepositContext, project: string, transcript: Transcript): Promise<Capture | undefined> => {
  const { runtime, state } = context;
  const { file, session } = transcript;
  const info = await stat(file);
  // Archived before the unchanged check, so a store deposited before the archive existed fills it on its next run.
  if (transcript.fromRaw !== true) {
    await requireHold(context.held);
    await archiveRaw(file, join(paths(runtime.storeDir).raw, project, ...transcript.relative.split('/')));
  }
  const key = `${project}/${transcript.relative}`;
  const previous = state.files[key];
  if (
    previous !== undefined &&
    previous.size === info.size &&
    previous.mtimeMs === info.mtimeMs &&
    previous.v === CAPTURE_VERSION &&
    previous.s === context.salt.sid &&
    sameSet(previous.d, context.domains)
  ) {
    return undefined;
  }
  const rev = Math.max((previous?.rev ?? 0) + 1, context.now());
  const extract = captureSession({
    text: await readFile(file, 'utf8'),
    session,
    project,
    rev,
    at: context.at,
    bytes: info.size,
    redact: context.redact,
    salt: context.salt.salt,
    repoSalt: context.repoSalt,
    sid: context.salt.sid,
    repoRoot: context.repoRoot,
    repoIdentity: context.repoIdentity,
    runtime: context.captureRuntime,
    repoSize: await earlierRepoSize(context, previous, session),
    subagent: await originOf(context, project, transcript),
  });
  await commitCapture(context, key, extract, { size: info.size, mtimeMs: info.mtimeMs, rev });
  return extract;
};

/** What a derive pass read and wrote, for the step log (spec 3.1 `in` and `out`, 4.2 `key`). */
export interface DeriveTrace {
  ms: number;
  in: StepCounts;
  out: StepCounts;
  key: string;
}

/** What a deposit wrote, filled in by the caller's trace so `DepositResult` and the `--json` document keep their shape. */
export interface DepositTrace {
  /** Records written, by kind: `session` (main), `subagent`, `user-prompt`, `tool`, `error-line`. */
  kinds: StepCounts;
  /** Pending sessions this deposit took before its own, as step-row `in` counts: `pending` found, `pendingDropped` (transcript gone, folder no longer allowed, not an entry, or removed at `PENDING_MAX_FAILURES` failures), `pendingKept` (failed, or an unreadable file; left for the next run). */
  pending?: StepCounts;
  /** Set to the refusal's first line when the Stop hook found the store locked and recorded its session in the pending list instead of depositing: the caller logs a `deferred` row, not an `error` one. */
  deferred?: string;
  /** The derive pass a whole-store deposit ends with (the index pass follows it: `index`). */
  derive?: DeriveTrace;
  /** A derive pass that failed after the deposit's records and `state.json` were written: the caller logs `deposit` ok and `derive` error, then rethrows. */
  deriveFailure?: { error: unknown; key: string; ms: number };
  /** The index pass after a derive that succeeded: its own step (spec 3.1), run at the nightly and manual runs. */
  index?: DeriveTrace;
  /** An index pass that failed after the derive was written: the caller logs `derive` ok and `index` error, then rethrows. */
  indexFailure?: { error: unknown; key: string; ms: number };
}

export const newTrace = (): DepositTrace => ({ kinds: {} });

// A subagent transcript's prompts, tools, and error lines are counted under the same kinds as a main session's; only the transcript itself
// is counted apart (`subagent`). Spec 3.2's "by kind, main and subagent" is read as that split of the transcripts.
const tally = (trace: DepositTrace | undefined, extract: Capture, subagent: boolean): void => {
  if (trace === undefined) return;
  const add = (kind: string, count: number): void => {
    trace.kinds[kind] = (trace.kinds[kind] ?? 0) + count;
  };
  add(subagent ? 'subagent' : 'session', 1);
  add('user-prompt', extract.prompts.length);
  add('tool', extract.tools.length);
  add('error-line', extract.errorLines.length);
};

export const digest = (parts: readonly string[]): string => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);

/** Sessions a refresh loads and folds at a time. Peak memory is the sessions of a run plus what the folds keep (spec 3 option A), so this is the knob between the heap and the number of seeks. */
const REFRESH_RUN = 100;

interface Folded {
  /** Sessions, subagents, and errors in the order a whole read holds them; no prompts or tools. */
  store: Store;
  /** The pool step's input, or why it could not be folded: the pool is optional to a deposit, so a failure there is reported by `currentPool`, not thrown. */
  folds: PoolFolds | Error;
  derive: DeriveFold;
  /** The index's own read fold: added on every run, so a pool that fails costs the index only its fit reads' read IDs (the shapes come from the always-on read fold). */
  reads: ReadFolds;
  counts: { prompts: number; tools: number };
}

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/** The one place a pool fold's failure is caught: its result, or the error, so a step of the pool never stops a deposit. */
const attempt = <T>(step: () => T): T | Error => {
  try {
    return step();
  } catch (error) {
    return asError(error);
  }
};

/** The pool fold settled after the last run, or the error that stopped it. */
const finished = (pool: PoolFold | Error, runtime: SessionsRuntime, runs: number): PoolFolds | Error => {
  if (pool instanceof Error) return pool;
  return attempt(() => {
    const folds = pool.finish();
    runtime.refreshStep?.('finish');
    runtime.refreshed?.({ runs, reversions: reversionEntries(pool.index) });
    return folds;
  });
};

const reversionEntries = (index: ReversionIndex): number => {
  const lists = [...index.committed.values(), ...index.edited.values(), ...index.written.values()];
  return index.commits.length + index.reverts.length + index.restored.length + lists.reduce((sum, list) => sum + list.length, 0);
};

/**
 * `loadStore` and the folds over the whole store, one run of sessions at a time (t1243): the log is scanned once with spans, then each run of `runOrder` is read by seeking, folded, and let go. A subagent's parent
 * outside its run is read as context for the agent's errors and folded in its own run only. Sessions and errors are held with their place in the whole read and put back in that order, which is the only order anything
 * written depends on.
 */
const foldRuns = async (runtime: SessionsRuntime): Promise<Folded> => {
  const scan = await scanLog(paths(runtime.storeDir).observations, undefined, true);
  await runtime.afterScan?.();
  runtime.refreshStep?.('scan');
  const order = runOrder(scan);
  const size = Math.max(1, Math.floor(runtime.refreshRun ?? REFRESH_RUN));
  // Loaded here, not at the top: the pool imports every read family, and a lookup hook never reaches this step. A failure to load or fold costs the index only its fit reads' read IDs (the shapes come from the always-on read fold), as a failure of `currentPool` does.
  let pool: PoolFold | Error;
  try {
    const { poolFold } = await import('./pool-fold.js');
    const { readRecalls } = await import('./recall-object.js');
    pool = poolFold(await readRecalls(runtime.storeDir));
  } catch (error) {
    pool = asError(error);
  }
  const derive = deriveFold();
  // Also loaded here: it reaches the read families a lookup hook must not load.
  const readFolding = (await import('./read-folds.js')).readFold();
  const counts = { prompts: 0, tools: 0 };
  const start = (session: string): number => scan.spans?.get(session)?.[0] ?? Number.MAX_SAFE_INTEGER;
  const sessions: { at: number; record: SessionObservation }[] = [];
  const subagents: { at: number; record: SessionObservation }[] = [];
  // Version 2 error rows come first in a whole read, then each readable session's in its place, then the agents' last.
  const errors: { group: number; at: number; record: ErrorObservation }[] = [];
  let runs = 0;
  for (let from = 0; from < order.length; from += size) {
    const own = new Set(order.slice(from, from + size));
    const wanted = new Set(own);
    for (const id of own) {
      const parent = scan.parents.get(id);
      if (parent !== undefined) wanted.add(parent);
    }
    const loaded = await loadStore(runtime.storeDir, undefined, { only: wanted, latest: scan.latest, spans: scan.spans, identity: scan.identity });
    const run: Store = {
      sessions: loaded.sessions.filter(({ session }) => own.has(session)),
      subagents: loaded.subagents.filter(({ session }) => own.has(session)),
      prompts: loaded.prompts.filter(({ session }) => own.has(session)),
      tools: loaded.tools.filter(({ session }) => own.has(session)),
      errors: loaded.errors.filter(({ session, agent }) => own.has(agent ?? session)),
      newerCaptures: 0,
    };
    runs += 1;
    derive.add(run.prompts);
    readFolding.add(run);
    counts.prompts += run.prompts.length;
    counts.tools += run.tools.length;
    for (const record of run.sessions) sessions.push({ at: start(record.session), record });
    for (const record of run.subagents) subagents.push({ at: start(record.session), record });
    for (const record of run.errors) {
      const unreadable = !isReadable(scan.cvs.get(record.session) ?? '0');
      errors.push(record.agent === undefined ? { group: unreadable ? 0 : 1, at: start(record.session), record } : { group: 2, at: start(record.agent), record });
    }
    if (!(pool instanceof Error)) {
      const open = pool;
      const failed = attempt(() => {
        open.add(run);
      });
      if (failed instanceof Error) pool = failed;
    }
  }
  runtime.refreshStep?.('runs');
  const byPlace = <T extends { at: number }>(list: T[]): T[] => list.sort((a, b) => a.at - b.at);
  const store: Store = {
    sessions: byPlace(sessions).map(({ record }) => record),
    subagents: byPlace(subagents).map(({ record }) => record),
    errors: errors.sort((a, b) => a.group - b.group || a.at - b.at).map(({ record }) => record),
    prompts: [],
    tools: [],
    newerCaptures: scan.newerCaptures,
  };
  return { store, folds: finished(pool, runtime, runs), derive, reads: readFolding.finish(), counts };
};

/**
 * Rewrites `derived.json` (the derive step), then the hook index (the index step), from the whole store. With a trace, a failure of
 * either is recorded on it instead of thrown, so the caller can log the deposit that already wrote its records, then the failed step
 * (spec 3.1: one row per step, a failed derive leaving the index skipped), and rethrow.
 */
export const refresh = async (runtime: SessionsRuntime, redactDomains: readonly string[], at: string, trace?: DepositTrace, held: LockHold = () => Promise.resolve(true)): Promise<void> => {
  const started = performance.now();
  // The extractor version alone until the store is read: a derive that fails before the high-water mark is known still has a key (spec 4.4).
  let key = digest([EXTRACTOR_VERSION]);
  let store: Store;
  let folds: PoolFolds | Error;
  let readFolds: ReadFolds;
  try {
    const folded = await foldRuns(runtime);
    ({ store, folds, reads: readFolds } = folded);
    // The key is the account's capture high-water mark (the highest rev of each session) and `ev` (spec 4.2); the index shares it.
    const highWater = [...store.sessions, ...store.subagents].map((session) => `${session.session}:${String(session.rev)}`).sort();
    key = digest([EXTRACTOR_VERSION, ...highWater]);
    const derived = folded.derive.finish(store, at);
    await requireHold(held);
    await writeAtomic(paths(runtime.storeDir).derived, JSON.stringify(derived));
    if (trace !== undefined) {
      trace.derive = {
        ms: Math.round(performance.now() - started),
        in: { session: store.sessions.length, subagent: store.subagents.length, 'user-prompt': folded.counts.prompts, tool: folded.counts.tools },
        out: { signature: derived.signatures.length, summary: derived.summaries.length },
        key,
      };
    }
  } catch (error) {
    if (error instanceof StoreLockLostError || trace === undefined) throw error;
    trace.deriveFailure = { error, key, ms: Math.round(performance.now() - started) };
    return;
  }
  // The pool is derived for the index's fit reads only: one that cannot be read or written costs the index those, never the index itself (`currentPool` says so on stderr). Loaded here, not at the top: the pool imports every read family, and a lookup hook never reaches this step. It runs before the clock starts, so the index's `ms` is the index and not the derive (the first pool run takes 12 to 17 s on a store copy).
  // A module that will not load costs the index the same fit reads, with one line on stderr, as `currentPool` does when the pool cannot be built.
  const current = await import('./pool.js').then(
    async ({ currentPool }) => currentPool(runtime.storeDir, store, folds),
    (error: unknown) => {
      process.stderr.write(`oars: the read pool module could not be loaded, and the index keeps no fit reads: ${error instanceof Error ? error.message : String(error)}
`);
      return undefined;
    },
  );
  runtime.refreshStep?.('pool');
  const reads = current?.reads ?? [];
  const indexStarted = performance.now();
  try {
    // The next-node reads for each harness and version, derived over the same pool; a deposit that has no pool leaves the index without them.
    const next = current === undefined ? undefined : (await import('./recall-frames.js')).nextByFrame(current.pool, store);
    const index = buildIndex(store, redactDomains, at, reads, next, readFolds);
    await requireHold(held);
    await writeAtomic(indexPath(runtime.storeDir), JSON.stringify(index));
    if (trace !== undefined) {
      trace.index = {
        ms: Math.round(performance.now() - indexStarted),
        in: { session: store.sessions.length, subagent: store.subagents.length, error: store.errors.length },
        out: { signature: Object.keys(index.signatures).length, project: Object.keys(index.projects).length },
        key,
      };
    }
  } catch (error) {
    if (error instanceof StoreLockLostError || trace === undefined) throw error;
    trace.indexFailure = { error, key, ms: Math.round(performance.now() - indexStarted) };
  }
};

/** Appends a capture's records, writes its skeleton, and records the cursor in the state map (the caller writes `state.json`). */
const commitCapture = async (context: DepositContext, key: string, extract: Capture, cursor: { size: number; mtimeMs: number; rev: number }): Promise<void> => {
  const files = paths(context.runtime.storeDir);
  const batch: Observation[] = [extract.session, ...extract.prompts, ...extract.tools, ...extract.errorLines];
  await mkdir(context.runtime.storeDir, { recursive: true });
  await requireHold(context.held);
  await appendFile(files.observations, batch.map((observation) => `${JSON.stringify(observation)}\n`).join(''), { mode: 0o600 });
  await requireHold(context.held);
  await writeAtomic(join(files.skeletons, `${extract.session.session}.json`), JSON.stringify(extract.skeleton));
  context.state.files[key] = { ...cursor, v: CAPTURE_VERSION, s: context.salt.sid, d: context.domains, repoSize: extract.session.frame?.stack.size ?? null };
};

/**
 * Records that a session is superseded: its capture of no turns, marked with the session that holds them now, appended as the next rev (the log is never edited), and its
 * skeleton removed, since a skeleton is derived and a reader of skeletons would count the session. The cursor records it, so a repeat deposit adds nothing. The nested agents of the
 * session are read again, since their parent is now the merged session.
 */
const commitSupersede = async (context: DepositContext, key: string, extract: Capture, by: string, cursor: { size: number; mtimeMs: number; rev: number }): Promise<void> => {
  const files = paths(context.runtime.storeDir);
  extract.session.supersededBy = by;
  await requireHold(context.held);
  await appendFile(files.observations, `${JSON.stringify(extract.session)}\n`, { mode: 0o600 });
  await requireHold(context.held);
  await rm(join(files.skeletons, `${extract.session.session}.json`), { force: true });
  context.state.files[key] = { ...cursor, v: CAPTURE_VERSION, s: context.salt.sid, d: context.domains, repoSize: null };
  // A nested agent's id is `<trace>-<span>`, so it stays when its parent moves to the merged session, and its spans may not change: stale its cursor so the next read names the new parent.
  for (const [other, entry] of Object.entries(context.state.files)) if (other.startsWith(`${key}-`)) entry.v = '';
};

/** Another deposit holds the store lock and the wait ran out: the one failure the Stop hook defers instead of counting as a failed run. */
export class StoreLockedError extends CliError {
  constructor() {
    super('The store is locked by another deposit; try again shortly.', ExitCode.UNEXPECTED, 'unexpected');
    this.name = 'StoreLockedError';
  }
}

interface LockOptions {
  /** How long to wait for a holder before giving up. */
  waitMs: number;
  /** A lock file older than this belongs to a process that died or passed `holdMs`; it is broken. */
  staleMs: number;
  /**
   * The longest a holder keeps its lock refreshed; default six times `staleMs` (an hour). Past it the heartbeat stops, so a holder that
   * hangs while its process lives ages out like a dead one and the next waiter breaks it, rather than every deposit waiting on it for good.
   */
  holdMs?: number;
}

/** What `withLock` gives its work: whether this run's lock file is still the one standing. */
export type LockHold = () => Promise<boolean>;

/** The store lock was broken and taken by another run while this one worked: it writes nothing more. */
export class StoreLockLostError extends CliError {
  constructor() {
    super('This run lost the store lock to another deposit while it worked, so it wrote no more; its captures are redone by the next deposit. Rerun it.', ExitCode.UNEXPECTED, 'unexpected');
    this.name = 'StoreLockLostError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const isCode = (error: unknown, ...codes: string[]): boolean => error instanceof Error && 'code' in error && typeof error.code === 'string' && codes.includes(error.code);

/**
 * Creates `file` only if absent. False when it exists; EPERM or EACCES is Windows saying the previous holder's delete has not
 * finished, so it is returned (not thrown) and `withLock` rethrows it when the wait runs out with no lock file standing.
 */
const claim = async (file: string, token: string = String(process.pid)): Promise<boolean | Error> => {
  try {
    await writeFile(file, token, { flag: 'wx', mode: 0o600 });
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
    if (age > staleMs) {
      const holder = ((await readFile(lock, 'utf8').catch(() => '')).trim().split(' ')[0]) ?? '';
      await rm(lock, { force: true });
      process.stderr.write(`oars: broke the store lock held by pid ${holder === '' ? 'unknown' : holder}, not refreshed for over ${String(staleMs)} ms\n`);
    }
  } finally {
    await rm(guard, { force: true });
  }
};

/**
 * What a command a person typed waits for the store lock (`deposit --deny`, the pool choices). The background sweep starts after any command and its deposit
 * holds the lock for the whole run, which a full re-capture stretches past 10 minutes, so a short wait made `--deny` fail right when the hold window
 * wants it to work; two minutes is the wait the send lock gives. The hook path keeps `HOOK_LOCK`: a hook must not block a session.
 */
const FOREGROUND_LOCK: LockOptions = { waitMs: 120_000, staleMs: 600_000 };

/**
 * Runs `work` as the only writer of `state.json` and the observations file. The SessionEnd hooks of parallel sessions and the nightly
 * run each read, extract, and rewrite `state.json`; without this one's `files` and `allow` entries are lost to another's write.
 */
export const withLock = async <T>(storeDir: string, work: (held: LockHold) => Promise<T>, options: LockOptions = FOREGROUND_LOCK): Promise<T> => {
  const lock = join(storeDir, 'store.lock');
  await mkdirOwnerOnly(storeDir);
  const started = Date.now();
  // The token names this claim, so a holder whose lock was broken cannot delete the next holder's lock when it ends.
  const token = `${String(process.pid)} ${randomUUID()}`;
  let claimed = await claim(lock, token);
  while (claimed !== true) {
    await breakStale(lock, options.staleMs);
    if (Date.now() - started >= options.waitMs) {
      if (claimed instanceof Error && !(await stat(lock).then(() => true, (error: unknown) => !isCode(error, 'ENOENT')))) throw claimed;
      throw new StoreLockedError();
    }
    await sleep(25);
    claimed = await claim(lock, token);
  }
  // A waiter breaks a lock older than `staleMs`, and a full re-capture runs longer than that: the holder keeps its lock young, or a hook
  // would break it and append during the compaction that ends the run.
  const holdMs = options.holdMs ?? options.staleMs * 6;
  // Beats are counted, not timed: a suspended machine fires one tick on wake, and elapsed time would read that as a hung holder.
  let beats = 0;
  const heartbeat = setInterval(() => {
    if (++beats * (options.staleMs / 4) >= holdMs) {
      clearInterval(heartbeat);
      process.stderr.write(`oars: this run held the store lock past ${String(holdMs)} ms and may lose it; rerun it when it ends\n`);
      return;
    }
    const now = new Date();
    void utimes(lock, now, now).catch(() => undefined);
  }, options.staleMs / 4);
  heartbeat.unref();
  // The heartbeat stops at the hold cap but the work does not, so a waiter can break the lock and a second run take it while this one is still
  // going. This run then must not write what it read at the start (`state.json`'s `allow` and `redactDomains`, the log's rename) over the second
  // run's. A refused read counts as ours, as it does in the release below.
  const held: LockHold = async () => (await readFile(lock, 'utf8').catch((error: unknown) => (isCode(error, 'ENOENT') ? '' : token))) === token;
  try {
    return await work(held);
  } finally {
    clearInterval(heartbeat);
    // A refused read (an antivirus share violation) counts as ours, so the lock is not left standing for the stale window; `rm` retries a share violation, and a refusal that outlasts the retries is swallowed so the finished work's result is not lost (the stale window then clears the lock).
    if ((await readFile(lock, 'utf8').catch(() => token)) === token) await rm(lock, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
  }
};

export const deposit = (runtime: SessionsRuntime, options: DepositOptions, trace?: DepositTrace): Promise<DepositResult> => withLock(runtime.storeDir, (holds) => depositLocked(runtime, options, holds, trace));

/** Throws `StoreLockLostError` when this run's token no longer stands. */
const requireHold = async (held: LockHold): Promise<void> => {
  if (!(await held())) throw new StoreLockLostError();
};

/** Writes `state.json` only while this run holds the lock; a run that lost it throws before the write, so the holder that took over keeps its entries. */
const writeStateHeld = async (runtime: SessionsRuntime, state: State, held: LockHold): Promise<void> => {
  await requireHold(held);
  await writeAtomic(paths(runtime.storeDir).state, JSON.stringify(state));
};

const depositLocked = async (runtime: SessionsRuntime, options: DepositOptions, holds: LockHold, trace?: DepositTrace): Promise<DepositResult> => {
  const state = await readState(runtime.storeDir);
  const entries = runAllow(state.allow, options.allow);
  const allow = compileAllow(entries);
  const folders = await projectFolders(runtime.projectsRoot);
  const allowed = folders.filter((name) => allow.allows(name));
  const roots = sourceRoots(runtime);
  const table = sourcesOf(runtime);
  const missing = allow.unmatched([...folders, ...table.filter((source) => roots.has(source.name)).map((source) => source.name)]);
  refuseNewer(state);
  // A log written by a newer oars is refused even when state.json is older or lost; the Stop-hook path reads only state.json.
  const held = (await scanLog(paths(runtime.storeDir).observations)).newerCaptures;
  if (held > 0) throw new CliError(`The log holds captures by a newer oars (sessions: ${String(held)}); upgrade oars.`, ExitCode.UNEXPECTED, 'unexpected');
  state.redactDomains = [...new Set([...state.redactDomains, ...options.redactDomains])];
  state.allow = mergeAllow(state.allow, options.allow);
  const context = await contextFor(runtime, state, options.now, holds);
  const result: DepositResult = {
    sessions: 0,
    unchanged: 0,
    lines: 0,
    badLines: 0,
    observations: 0,
    subagents: 0,
    sources: {},
    cursor: 0,
    cursorUnreadable: [],
    cursorUnreadableLogged: [],
    cursorRejected: 0,
    skippedFolders: folders.length - allowed.length,
    folders: allowed,
    missing,
  };
  const record = (extract: Capture, subagent: boolean): void => {
    if (subagent) result.subagents += 1;
    else result.sessions += 1;
    result.lines += extract.session.lines;
    result.badLines += extract.session.badLines;
    result.observations += 1 + extract.prompts.length + extract.tools.length + extract.errorLines.length;
  };
  // Sessions a Stop hook deferred come first, then this run's own walk; their entries go once `state.json` is written below. What the drain
  // deposited is in the result, and the walk finds those files current without counting them as unchanged.
  const drainedKeys = new Set<string>();
  const drained = await drainPending(context, state, runtime.storeDir, Number.POSITIVE_INFINITY, trace, (extract, subagent, key) => {
    drainedKeys.add(key);
    record(extract, subagent);
  });
  await requireHold(context.held);
  await sweepPendingTemps(runtime.storeDir, HOOK_LOCK.staleMs);
  // A project the harness cleaned up entirely is still visited when the state names it, so its archived transcripts are captured again.
  const stateProjects = Object.keys(state.files).map((key) => key.slice(0, key.indexOf('/'))).filter((name) => !isSource(table, name) && allow.allows(name));
  // The same holds for a lost state.json: raw/ still names the projects whose transcripts can be captured again.
  const rawProjects = (await listDir(paths(runtime.storeDir).raw)).filter((entry) => entry.isDirectory() && !isSource(table, entry.name) && allow.allows(entry.name)).map((entry) => entry.name);
  for (const project of [...new Set([...allowed, ...stateProjects, ...rawProjects])].sort()) {
    const folder = join(runtime.projectsRoot, project);
    const entries = (await listDir(folder)).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => entry.name).sort();
    const onDisk = [...entries.map((name) => mainTranscript(folder, name)), ...(await subagentTranscripts(folder, await sessionFolders(folder)))];
    const transcripts = [...onDisk, ...(await rawOnlyTranscripts(context, project, new Set(onDisk.map((transcript) => `${project}/${transcript.relative}`))))];
    for (const transcript of transcripts) {
      const extract = await depositFile(context, project, transcript);
      if (extract === undefined) {
        if (!drainedKeys.has(`${project}/${transcript.relative}`)) result.unchanged += 1;
        continue;
      }
      record(extract, transcript.subagent !== undefined);
      tally(trace, extract, transcript.subagent !== undefined);
    }
  }
  for (const source of table) {
    const root = roots.get(source.name);
    if (root !== undefined && allow.allows(source.name)) await readSource(context, source, root, result, trace);
  }
  const cursor = result.sources.cursor;
  if (cursor !== undefined) {
    result.cursor = cursor.read;
    result.cursorUnreadable = cursor.unreadable;
    result.cursorUnreadableLogged = cursor.unreadableLogged;
    result.cursorRejected = cursor.rejected;
  }
  await writeStateHeld(runtime, state, holds);
  await requireHold(context.held);
  await removePending(runtime.storeDir, drained.settled);
  // Decided by what the log holds, not by what this run captured: a run that died after its re-capture left the copies for this one. The hook
  // path never compacts, since it has seconds. The records are safe by now and an uncompacted log still loads, so a failure here does not fail the deposit.
  await compactLog(runtime.storeDir, LOG_RENAME_WAIT_MS, holds).catch((error: unknown) => {
    if (error instanceof StoreLockLostError) throw error;
    process.stderr.write(`oars: the session log was not compacted, and the next deposit tries again: ${error instanceof Error ? error.message : String(error)}\n`);
  });
  await refresh(runtime, state.redactDomains, context.at, trace, holds);
  return result;
};

/** The table in force: the runtime's own (a test's), else every source. */
export const sourcesOf = (runtime: SessionsRuntime): readonly Source[] => runtime.sources ?? SOURCES;

/** A source's name is the first `state.json` key segment, and no project folder uses it, so the Claude Code walk skips it. */
const isSource = (table: readonly Source[], name: string): boolean => table.some((source) => source.name === name);

/** The roots the runtime names, by source name; `cursorRoot` stays the alias of the Cursor entry. */
export const sourceRoots = (runtime: SessionsRuntime): Map<string, string> =>
  new Map(Object.entries({ ...(runtime.cursorRoot === undefined ? {} : { cursor: runtime.cursorRoot }), ...runtime.sourceRoots }));

/** Reports an unreadable source store or file, once per reason: the full path for the terminal, the base name for the hook-call record. */
const noteReason = (counts: SourceTally, file: string, reason: string): void => {
  const line = `${file}: ${reason}`;
  if (counts.unreadable.includes(line)) return;
  counts.unreadable.push(line);
  counts.unreadableLogged.push(`${basename(file)}: ${reason}`);
};

const noteUnreadable = (counts: SourceTally, file: string, error: unknown): void => {
  noteReason(counts, file, error instanceof Error ? error.message : String(error));
};

/**
 * Deposits the sessions of one non-Claude source under `root`. A session's cursor is its size and
 * mtime (for Cursor, its message count and `lastUpdatedAt`), kept in `state.json` like a transcript file's, so a second deposit adds nothing
 * until the harness writes the session again. The store is opened read-only and a missing one is skipped silently. Nothing is archived: a
 * source keeps its own history, and this store never copies it.
 */
const readSource = async (context: DepositContext, source: Source, root: string, result: DepositResult, trace: DepositTrace | undefined): Promise<void> => {
  const counts: SourceTally = { read: 0, unreadable: [], unreadableLogged: [], rejected: 0 };
  // A source fails open on its own: only its read is guarded, and the store's write failures (a full disk) propagate as they do on the
  // Claude Code path instead of blaming the source's file.
  let store: SourceStore | undefined;
  try {
    store = await source.open(root);
  } catch (error) {
    noteUnreadable(counts, source.storeFile(root), error);
    result.sources[source.name] = counts;
    return;
  }
  if (store === undefined) return;
  result.sources[source.name] = counts;
  counts.rejected += store.rejected;
  for (const entry of store.unreadable) noteReason(counts, entry.file, entry.reason);
  try {
    // The superseded sessions first: committing one stales the cursors of its nested agents, which are then read in this same deposit.
    const ordered = [...store.sessions.filter((session) => session.supersededBy !== undefined), ...store.sessions.filter((session) => session.supersededBy === undefined)];
    for (const session of ordered) {
      const key = `${source.name}/${session.id}`;
      const previous = context.state.files[key];
      // A session this store never held has nothing to supersede.
      if (session.supersededBy !== undefined && previous === undefined) continue;
      if (
        previous !== undefined &&
        previous.size === session.size &&
        previous.mtimeMs === session.mtimeMs &&
        previous.v === CAPTURE_VERSION &&
        previous.s === context.salt.sid &&
        sameSet(previous.d, context.domains)
      ) {
        // A superseded session is recorded once and is no file of its own, so it is not one more file left unchanged.
        if (session.supersededBy === undefined) result.unchanged += 1;
        continue;
      }
      let text: string;
      try {
        text = await store.transcript(session);
      } catch (error) {
        noteUnreadable(counts, store.where(session), error);
        if (source.stopOnTranscriptError === true) break;
        continue;
      }
      const rev = Math.max((previous?.rev ?? 0) + 1, context.now());
      const id = `${source.name}-${session.id}`;
      const extract = captureSession({
        text,
        session: id,
        project: session.folder === null ? source.name : slugOf(session.folder),
        rev,
        at: context.at,
        bytes: Buffer.byteLength(text),
        redact: context.redact,
        salt: context.salt.salt,
        repoSalt: context.repoSalt,
        sid: context.salt.sid,
        repoRoot: context.repoRoot,
        repoIdentity: context.repoIdentity,
        runtime: context.captureRuntime,
        subagent: session.subagent,
        repoSize: await earlierRepoSize(context, previous, id),
        harness: source.harness,
      });
      // The input names the frame and the action table; the session record carries the harness for `harnessOf`, `books --by harness`, and `measure`.
      extract.session.harness = source.harness;
      if (session.supersededBy !== undefined) {
        await commitSupersede(context, key, extract, `${source.name}-${session.supersededBy}`, { size: session.size, mtimeMs: session.mtimeMs, rev });
        continue;
      }
      await commitCapture(context, key, extract, { size: session.size, mtimeMs: session.mtimeMs, rev });
      tally(trace, extract, session.subagent !== undefined);
      if (session.subagent === undefined) {
        result.sessions += 1;
        counts.read += 1;
      } else result.subagents += 1;
      result.lines += extract.session.lines;
      result.badLines += extract.session.badLines;
      result.observations += 1 + extract.prompts.length + extract.tools.length + extract.errorLines.length;
    }
  } finally {
    store.close();
  }
};

/**
 * The log's lines, a chunk at a time: the log can pass the longest string Node can hold (536,870,888 characters), so it is never one string.
 * It splits on the newline alone, not through `readline`, which also ends a line at U+2028 and U+2029: `JSON.stringify` leaves those raw inside a
 * value. A missing log has no lines, and a last line with no newline is yielded as it stands, for the reader to parse or skip.
 */
export const logLines = async function* (file: string, held?: FileHandle): AsyncGenerator<string> {
  let rest = '';
  try {
    // From a handle, each call reads from byte 0 of the same open file, which a compaction's rename leaves as it was; `autoClose` is off so the caller closes it.
    const stream = held === undefined ? createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 }) : held.createReadStream({ encoding: 'utf8', highWaterMark: 1 << 20, start: 0, autoClose: false });
    for await (const chunk of stream) {
      const lines = (rest + String(chunk)).split('\n');
      rest = lines.pop() ?? '';
      yield* lines;
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  yield rest;
};

/** The log opened for reading, or undefined when there is none. A reader that makes more than one pass holds this open across them (`loadStore`). */
const openLog = async (file: string): Promise<FileHandle | undefined> => {
  try {
    return await open(file, 'r');
  } catch (error) {
    if (!isMissing(error)) throw error;
    return undefined;
  }
};

/** What an earlier deposit logged about each transcript. */
interface LoggedSessions {
  /** Each subagent transcript's origin, since its `.meta.json` is not archived. */
  origins: Map<string, SubagentOrigin>;
  /** The size bucket of each transcript's earliest logged frame. */
  repoSizes: Map<string, RepoSize | null>;
}

const loggedSessions = async (storeDir: string): Promise<LoggedSessions> => {
  const origins = new Map<string, SubagentOrigin>();
  const repoSizes = new Map<string, RepoSize | null>();
  for await (const line of logLines(paths(storeDir).observations)) {
    if (!line.includes('"kind":"session"')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed) || parsed.kind !== 'session' || typeof parsed.session !== 'string') continue;
      if (typeof parsed.parent === 'string') {
        origins.set(parsed.session, {
          parent: parsed.parent,
          agentType: typeof parsed.agentType === 'string' ? parsed.agentType : null,
          spawnedBy: typeof parsed.spawnedBy === 'string' ? parsed.spawnedBy : null,
        });
      }
      const size = isRecord(parsed.frame) && isRecord(parsed.frame.stack) ? asRepoSize(parsed.frame.stack.size) : undefined;
      if (size !== undefined && !repoSizes.has(parsed.session)) repoSizes.set(parsed.session, size);
    } catch {
      // A torn line is skipped.
    }
  }
  return { origins, repoSizes };
};

/** The session id of a transcript's path under its project folder: `<id>.jsonl`, or `<parent>~<path>~agent-x` for a subagent transcript. */
const sessionOfRelative = (relative: string): string => {
  const parts = relative.split('/');
  const agent = (parts[parts.length - 1] ?? '').slice(0, -'.jsonl'.length);
  return parts.length === 1 ? agent : [parts[0] ?? '', ...parts.slice(2, -1).filter((part) => part !== 'workflows'), agent].join('~');
};

/** The inverse of `sessionOfRelative`: `<id>.jsonl`, or `<parent>/subagents/[workflows/<wf>/]<agent>.jsonl` for a `<parent>~[<wf>~]agent-x` id. */
export const relativeOfSession = (session: string): string[] => {
  const [parent = '', ...rest] = session.split('~');
  if (rest.length === 0) return [`${session}.jsonl`];
  const agent = rest[rest.length - 1] ?? '';
  const workflow = rest.slice(0, -1);
  return [parent, 'subagents', ...(workflow.length === 0 ? [] : ['workflows', ...workflow]), `${agent}.jsonl`];
};

/**
 * The sessions of `behind` (captured before the current version) whose source is gone (the transcript from both the harness and `raw/`, or the
 * session from its source's store, such as a Cursor composer): they can never be captured again, so `verify` counts them `cv-frozen` instead of failing `--strict` over them.
 */
export const frozenSessions = async (runtime: SessionsRuntime, behind: readonly { project: string; session: string }[]): Promise<Set<string>> => {
  const wanted = new Set(behind.map((entry) => `${entry.project}/${entry.session}`));
  if (wanted.size === 0) return new Set<string>();
  const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);
  const alive = new Set<string>();
  for (const key of Object.keys((await readState(runtime.storeDir)).files)) {
    const [project = '', ...rest] = key.split('/');
    const id = `${project}/${sessionOfRelative(rest.join('/'))}`;
    if (wanted.has(id) && !alive.has(id) && ((await exists(join(runtime.projectsRoot, key))) || (await exists(join(paths(runtime.storeDir).raw, key))))) alive.add(id);
  }
  // A lost or unreadable state.json lists no files, so a transcript is also looked up by the path its session id implies.
  for (const entry of behind) {
    const id = `${entry.project}/${entry.session}`;
    const relative = join(entry.project, ...relativeOfSession(entry.session));
    if (!alive.has(id) && ((await exists(join(runtime.projectsRoot, relative))) || (await exists(join(paths(runtime.storeDir).raw, relative))))) alive.add(id);
  }
  const roots = sourceRoots(runtime);
  for (const source of sourcesOf(runtime)) {
    const prefix = `${source.name}-`;
    const pending = behind.filter((entry) => entry.session.startsWith(prefix) && !alive.has(`${entry.project}/${entry.session}`));
    const root = roots.get(source.name);
    if (pending.length === 0 || root === undefined) continue;
    // A source session has no transcript file here: its origin is the source's own store, which the next deposit reads again while the
    // harness still lists it. An unreadable store counts as alive too, since it may read again once the harness releases it.
    let listed: ReadonlySet<string> | undefined;
    try {
      const store = await source.open(root);
      listed = store !== undefined && store.unreadable.length > 0 ? undefined : new Set((store?.sessions ?? []).map((session) => `${prefix}${session.id}`));
      store?.close();
    } catch {
      listed = undefined;
    }
    for (const entry of pending) if (listed === undefined || listed.has(entry.session)) alive.add(`${entry.project}/${entry.session}`);
  }
  return new Set(behind.filter((entry) => !alive.has(`${entry.project}/${entry.session}`)).map((entry) => entry.session));
};

/**
 * Transcripts the harness no longer has but the raw archive does, whose last capture is behind this code or used another salt: they are
 * captured again from `<store>/raw/` (spec Section 4, re-capture source). One with neither stays as logged, read through the compatibility reader.
 */
const rawOnlyTranscripts = async (context: DepositContext, project: string, onDisk: ReadonlySet<string>): Promise<Transcript[]> => {
  const { storeDir } = context.runtime;
  const prefix = `${project}/`;
  const root = join(paths(storeDir).raw, project);
  // Listed from raw/ itself, so a lost state.json (no entries to name the files) still finds them; a file with no entry counts as behind.
  const behind = (await rawRelatives(root, [])).filter((relative) => {
    const entry = context.state.files[`${prefix}${relative}`];
    // A domain named after the capture changes what the redactor masks, so a file recorded under another domain set is behind too.
    return !onDisk.has(`${prefix}${relative}`) && (entry === undefined || entry.v !== CAPTURE_VERSION || entry.s !== context.salt.sid || !sameSet(entry.d, context.domains));
  });
  const found: Transcript[] = [];
  for (const relative of behind) {
    const file = join(root, ...relative.split('/'));
    const parts = relative.split('/');
    if (parts.length === 1) {
      found.push({ ...mainTranscript(dirname(file), relative), fromRaw: true });
      continue;
    }
    const { origins } = await context.logged();
    const session = sessionOfRelative(relative);
    const origin = origins.get(session) ?? { parent: parts[0] ?? '', agentType: null, spawnedBy: null };
    found.push({ file, session, relative, subagent: origin, fromRaw: true });
  }
  return found;
};

/** The `.jsonl` files under a `raw/<project>/` folder, as paths relative to it. */
const rawRelatives = async (dir: string, path: string[]): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of await listDir(dir)) {
    if (entry.isDirectory()) found.push(...(await rawRelatives(join(dir, entry.name), [...path, entry.name])));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push([...path, entry.name].join('/'));
  }
  return found.sort();
};

export const HOOK_LOCK: LockOptions = { waitMs: 500, staleMs: 600_000 };

export type SessionDeposit = 'deposited' | 'unchanged' | 'not-allowed' | 'missing' | 'deferred';

/**
 * Deposits one transcript, as the SessionEnd hook does: only from a folder that earlier `--allow` entries name, and idempotent by size and
 * mtime. It does not rebuild `derived.json` or the hook index (that is a whole-store pass; the nightly run does it), so it stays fast.
 * Under the lock it first takes up to `PENDING_HOOK_CAP` sessions an earlier hook deferred, then its own. If the lock is still held after the
 * wait it records the session in the pending list, which needs no lock, and returns `deferred`: the next deposit of any kind takes it.
 */
export const depositSession = async (runtime: SessionsRuntime, transcript: string, now: () => number, trace?: DepositTrace): Promise<SessionDeposit> => {
  try {
    // The hook path waits under a second for the lock, well under the harness's 30 s ceiling on the hook (install.ts), so a SessionEnd behind the sender's sweep cannot hold session exit; `deferSession` covers a lock still held.
    return await withLock(runtime.storeDir, (held) => depositSessionLocked(runtime, transcript, now, held, trace), HOOK_LOCK);
  } catch (error) {
    if (!(error instanceof StoreLockedError)) throw error;
    try {
      // The allowlist holds without the lock: a session no `--allow` names writes nothing, not even a pending entry.
      if (!compileAllow((await readState(runtime.storeDir)).allow).allows(basename(dirname(transcript)))) return 'not-allowed';
      await deferSession(runtime.storeDir, transcript);
    } catch {
      // A pending entry that cannot be written (or a state that cannot be read) leaves the refusal what it was before: a failed deposit, with the lock's message.
      throw error;
    }
    if (trace !== undefined) trace.deferred = error.message;
    return 'deferred';
  }
};

/** What one transcript's deposit did to `state`: the outcome, and whether `state.json` needs writing. */
interface SessionInto {
  result: Exclude<SessionDeposit, 'deferred'>;
  wrote: boolean;
}

/** Told of each capture a deposit of a pending session wrote, so a whole-store run counts it: the capture, whether it is a subagent, and the state key. */
type Taken = (extract: Capture, subagent: boolean, key: string) => void;

/** Deposits one transcript and its subagents into `state` in memory; the caller writes `state.json`. */
const depositSessionInto = async (context: DepositContext, state: State, transcript: string, trace?: DepositTrace, taken?: Taken): Promise<SessionInto> => {
  const project = basename(dirname(transcript));
  if (!compileAllow(state.allow).allows(project)) return { result: 'not-allowed', wrote: false };
  const folder = dirname(transcript);
  const main = mainTranscript(folder, basename(transcript));
  let wrote: boolean;
  try {
    const extract = await depositFile(context, project, main);
    wrote = extract !== undefined;
    if (extract !== undefined) {
      tally(trace, extract, false);
      taken?.(extract, false, `${project}/${main.relative}`);
    }
  } catch (error) {
    if (isMissing(error)) return { result: 'missing', wrote: false };
    throw error;
  }
  // The session's subagents finished before it did, so the Stop deposit takes them too (A24).
  for (const subagent of await subagentTranscripts(folder, [main.session])) {
    const extract = await depositFile(context, project, subagent);
    if (extract !== undefined) {
      tally(trace, extract, true);
      taken?.(extract, true, `${project}/${subagent.relative}`);
    }
    wrote = extract !== undefined || wrote;
  }
  return { result: wrote ? 'deposited' : 'unchanged', wrote };
};

const bump = (trace: DepositTrace | undefined, kind: string): void => {
  if (trace === undefined) return;
  trace.pending ??= {};
  trace.pending[kind] = (trace.pending[kind] ?? 0) + 1;
};

interface Drained {
  /** Entries to remove once `state.json` is written. */
  settled: PendingEntry[];
  wrote: boolean;
}

/**
 * Deposits up to `limit` pending sessions into `state`, before the caller's own work, under the store lock. An entry is settled (and removed by the
 * caller after `state.json` is written, so a crash leaves it for the next run) when its transcript was deposited, was already current, is gone, or
 * is in a folder no `--allow` names now; one that fails to deposit stays, is counted, and does not stop the rest.
 */
const drainPending = async (context: DepositContext, state: State, storeDir: string, limit: number, trace?: DepositTrace, taken?: Taken): Promise<Drained> => {
  const drained: Drained = { settled: [], wrote: false };
  for (const entry of await listPending(storeDir, limit)) {
    bump(trace, 'pending');
    if (entry.unreadable) {
      bump(trace, 'pendingKept');
      process.stderr.write('oars: a pending entry could not be read and stays where it is\n');
      continue;
    }
    try {
      const into = entry.transcript === undefined ? undefined : await depositSessionInto(context, state, entry.transcript, trace, taken);
      drained.wrote ||= into?.wrote === true;
      drained.settled.push(entry);
      if (into === undefined || into.result === 'missing' || into.result === 'not-allowed') bump(trace, 'pendingDropped');
    } catch (error) {
      if (error instanceof StoreLockLostError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      // An entry that keeps failing is not retried forever: a whole-store walk still reaches any transcript on the allowlist, so dropping it loses nothing.
      if (entry.failures + 1 >= PENDING_MAX_FAILURES) {
        drained.settled.push(entry);
        bump(trace, 'pendingDropped');
        process.stderr.write(`oars: a pending session failed ${String(PENDING_MAX_FAILURES)} times and was dropped: ${message}\n`);
      } else {
        await requireHold(context.held);
        await failPending(storeDir, entry);
        bump(trace, 'pendingKept');
        process.stderr.write(`oars: a pending session was not deposited and stays pending: ${message}\n`);
      }
    }
  }
  return drained;
};

const depositSessionLocked = async (runtime: SessionsRuntime, transcript: string, now: () => number, held: LockHold, trace?: DepositTrace): Promise<SessionDeposit> => {
  const state = await readState(runtime.storeDir);
  refuseNewer(state);
  // A session no `--allow` names costs nothing when nothing is pending: no salt, no skeletons folder, no context.
  if (!compileAllow(state.allow).allows(basename(dirname(transcript))) && (await listPending(runtime.storeDir, 1)).length === 0) return 'not-allowed';
  const context = await contextFor(runtime, state, now, held);
  const drained = await drainPending(context, state, runtime.storeDir, PENDING_HOOK_CAP, trace);
  const own = await depositSessionInto(context, state, transcript, trace);
  if (drained.wrote || own.wrote) await writeStateHeld(runtime, state, held);
  await requireHold(context.held);
  await removePending(runtime.storeDir, drained.settled);
  return own.result;
};

export interface Store {
  /** Main transcripts only, so session counts and per-session denominators are unchanged by subagent deposits. */
  sessions: SessionObservation[];
  prompts: PromptObservation[];
  errors: ErrorObservation[];
  /** Subagent transcripts (A24), kept apart from `sessions` so G1 denominators stay main sessions. */
  subagents: SessionObservation[];
  /** The tool calls of every version-3 or later transcript, main and subagent. */
  tools: ToolObservation[];
  /** Sessions whose capture records a newer oars wrote: read for the fields known here, and reported by the commands that print the store. Set by `loadStore` only. */
  newerCaptures: number;
}

interface Captured {
  session?: SessionObservation;
  prompts: UserPromptObservation[];
  tools: ToolObservation[];
  errorLines: ErrorLineObservation[];
}

/** What one pass over the log keeps: a number or two per session, never the records. */
export interface LogScan {
  /** Each session's highest rev, over every kind of record. */
  latest: Map<string, number>;
  /** True when some session has a record below its highest rev, which a compaction would drop. */
  superseded: boolean;
  /** Sessions whose newest capture record was written by a newer oars, counted as `loadStore` counts them. */
  newerCaptures: number;
  /** Each subagent's parent, from its session record at its highest rev (a main session has none). */
  parents: Map<string, string>;
  /** Each session's `cv` at its highest rev. */
  cvs: Map<string, string>;
  /** Set when asked for: each session's record lines at its highest rev as flat `[start, length, ...]` byte pairs (the newline included). Only lines this scan saw are in it, so a row appended after the scan is never read through it. */
  spans?: Map<string, number[]>;
  /** With `spans`: the file the scan read (device, inode, and size from `stat` on the handle it read), so a load uses the spans only on that same file. */
  identity?: LogIdentity;
}

/** Which file a scan read: a compaction renames a new file into place, which changes the inode; an append only grows the size. */
interface LogIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
}

/** The log's lines with the byte range each takes (its newline included), read as bytes so an offset is a file position. The same split as `logLines`: on 0x0a alone. */
const logSpans = async function* (file: string, held?: FileHandle): AsyncGenerator<{ line: string; start: number; length: number }> {
  let rest = Buffer.alloc(0);
  let at = 0;
  try {
    const stream = held === undefined ? createReadStream(file, { highWaterMark: 1 << 20 }) : held.createReadStream({ highWaterMark: 1 << 20, start: 0, autoClose: false });
    const chunks: AsyncIterable<Buffer> = stream;
    for await (const chunk of chunks) {
      let buffer = Buffer.concat([rest, chunk]);
      let from = 0;
      for (let end = buffer.indexOf(10, from); end !== -1; end = buffer.indexOf(10, from)) {
        yield { line: buffer.toString('utf8', from, end), start: at + from, length: end + 1 - from };
        from = end + 1;
      }
      buffer = buffer.subarray(from);
      at += from;
      rest = buffer;
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  yield { line: rest.toString('utf8'), start: at, length: rest.length };
};

export const scanLog = async (file: string, held?: FileHandle, withSpans = false): Promise<LogScan> => {
  // Spans are byte offsets into one file: read it through a handle, and stat that handle, so the identity is the file the offsets belong to.
  const own = withSpans && held === undefined ? await openLog(file) : undefined;
  try {
    return await scanHandle(file, held ?? own, withSpans);
  } finally {
    await own?.close();
  }
};

const scanHandle = async (file: string, held: FileHandle | undefined, withSpans: boolean): Promise<LogScan> => {
  const latest = new Map<string, number>();
  const cvAt = new Map<string, { rev: number; cv: string; parent: string | null }>();
  // Every rev's lines are noted as `[start, length, rev, ...]` triples, then thinned to the highest rev once it is known.
  const seen = withSpans ? new Map<string, number[]>() : undefined;
  const info = withSpans && held !== undefined ? await held.stat({ bigint: true }) : undefined;
  let superseded = false;
  for await (const { line, start, length } of withSpans ? logSpans(file, held) : plainLines(file, held)) {
    const observation = observationOf(line);
    if (observation === undefined) continue;
    if (seen !== undefined) {
      const own = seen.get(observation.session) ?? [];
      own.push(start, length, observation.rev);
      seen.set(observation.session, own);
    }
    const before = latest.get(observation.session);
    superseded ||= before !== undefined && before !== observation.rev;
    latest.set(observation.session, Math.max(before ?? 0, observation.rev));
    // The last session record at the highest rev is the one `loadStore` reads.
    if (observation.kind === 'session' && observation.rev >= (cvAt.get(observation.session)?.rev ?? 0)) cvAt.set(observation.session, { rev: observation.rev, cv: observation.cv, parent: observation.parent });
  }
  let newerCaptures = 0;
  const parents = new Map<string, string>();
  const cvs = new Map<string, string>();
  for (const [session, held] of cvAt) {
    if (held.rev !== latest.get(session)) continue;
    cvs.set(session, held.cv);
    if (held.parent !== null) parents.set(session, held.parent);
    if (Number(held.cv) > Number(CAPTURE_VERSION)) newerCaptures += 1;
  }
  if (seen === undefined) return { latest, superseded, newerCaptures, parents, cvs };
  // A superseded line is never read by a chunk load, so the index keeps only each session's lines at its highest rev.
  const spans = new Map<string, number[]>();
  for (const [session, triples] of seen) {
    const kept: number[] = [];
    for (let n = 0; n < triples.length; n += 3) if (triples[n + 2] === latest.get(session)) kept.push(triples[n] ?? 0, triples[n + 1] ?? 0);
    spans.set(session, kept);
  }
  return info === undefined ? { latest, superseded, newerCaptures, parents, cvs, spans } : { latest, superseded, newerCaptures, parents, cvs, spans, identity: { dev: info.dev, ino: info.ino, size: info.size } };
};

/**
 * The order `loadStore` visits sessions in, as one list: the sessions whose capture version cannot be read (version 2, whose prompts and errors the log holds as rows) first, then the rest, each group by where
 * the session's first line at its highest rev starts in the log, subagents and mains alike. Needs a scan made with spans. A run is a contiguous slice of this list.
 */
export const runOrder = (scan: LogScan): string[] => {
  // Every key of `spans` holds at least one pair, so the fallback is never taken; it only satisfies the indexed read's type.
  const start = (session: string): number => scan.spans?.get(session)?.[0] ?? Number.MAX_SAFE_INTEGER;
  const sessions = [...(scan.spans?.keys() ?? [])];
  const unreadable = (session: string): boolean => !isReadable(scan.cvs.get(session) ?? '0');
  return sessions.sort((a, b) => Number(unreadable(b)) - Number(unreadable(a)) || start(a) - start(b));
};

const plainLines = async function* (file: string, held?: FileHandle): AsyncGenerator<{ line: string; start: number; length: number }> {
  for await (const line of logLines(file, held)) yield { line, start: 0, length: 0 };
};

/** Returns the first copy it was given of each string, so the strings a log repeats are held once. */
const interner = (): ((value: string) => string) => {
  const seen = new Map<string, string>();
  return (value) => {
    const held = seen.get(value);
    if (held !== undefined) return held;
    seen.set(value, value);
    return value;
  };
};

/**
 * Every tool row carries the session id, the tool name, and its key names, and `JSON.parse` makes a new string of each: a log of a million rows
 * held a million copies of a few thousand strings. The row is the same value with the strings shared.
 */
const internTool = (tool: ToolObservation, intern: (value: string) => string): ToolObservation => ({
  ...tool,
  cv: intern(tool.cv),
  session: intern(tool.session),
  parent: intern(tool.parent),
  tool: intern(tool.tool),
  keys: tool.keys.map(intern),
  sid: tool.sid === null ? null : intern(tool.sid),
  agentType: tool.agentType === null ? null : intern(tool.agentType),
  harnessVersion: tool.harnessVersion === null ? null : intern(tool.harnessVersion),
  target: tool.target === null ? null : intern(tool.target),
  ...(tool.segments === undefined ? {} : { segments: tool.segments.map((segment) => ({ ...segment, run: intern(segment.run) })) }),
});

const SESSION_FIELD = /"session":"((?:[^"\\]|\\.)*)"/g;

/** True when the line carries a `"session":"<id>"` field of one of `ids`. The writer emits compact JSON, so the field of the line's own session is always found; a nested match only keeps the line for the parse to decide. */
export const namesAny = (line: string, ids: ReadonlySet<string>): boolean => {
  for (const match of line.matchAll(SESSION_FIELD)) {
    const value = match[1] ?? '';
    // An id that JSON escaped (a quote or a backslash in it) is not the raw id: keep the line and let the parse decide.
    if (value.includes('\\') || ids.has(value)) return true;
  }
  return false;
};

/** What a read keeps beyond the default. */
export type LoadOptions = {
  /** Keep each session's `messageUsage` entries. Nothing in the store reads them yet, and on a large store they are a third more heap, so a read holds them only when asked. */
  messageUsage?: boolean;
  /** Read only these sessions' rows (main and subagent ids): a build that handles a chunk at a time holds that chunk, not the history. */
  only?: ReadonlySet<string>;
  /** Keep the session records alone, with no prompt, tool, or error rows: enough to gate and place a session without holding its content. */
  sessionsOnly?: boolean;
  /** The revs of an earlier `scanLog`: the read skips its own first pass. A build that reads chunk after chunk scans once; a row written after that scan is not seen, like a session that began after the build did. */
  latest?: ReadonlyMap<string, number>;
  /** With `only`: the byte spans of an earlier `scanLog(file, held, true)`. The read seeks to the lines of the wanted sessions instead of streaming the whole log; a log that is no longer the scanned file is streamed instead, and a torn or short line is skipped, never misread. */
  spans?: ReadonlyMap<string, readonly number[]>;
  /** With `spans`: the scan's `identity`. The spans are used only when the log opened for this read is that file, grown or not; any other file (a compaction renamed one into place) is streamed, as without spans. */
  identity?: LogIdentity;
  /** A seam: called once for every log line the read looks at. */
  lineRead?: () => void;
};

/** True when `held` is the file `identity` describes and has not shrunk: only an append can have happened since. */
const sameFile = async (held: FileHandle, identity: LogIdentity): Promise<boolean> => {
  const now = await held.stat({ bigint: true });
  return now.dev === identity.dev && now.ino === identity.ino && now.size >= identity.size;
};

/** The wanted sessions' lines, in file order, read by seeking: adjacent spans are one read. */
const spanLines = async function* (held: FileHandle, spans: ReadonlyMap<string, readonly number[]>, ids: ReadonlySet<string>): AsyncGenerator<string> {
  const wanted: { start: number; length: number }[] = [];
  for (const id of ids) {
    const own = spans.get(id) ?? [];
    for (let n = 0; n < own.length; n += 2) wanted.push({ start: own[n] ?? 0, length: own[n + 1] ?? 0 });
  }
  wanted.sort((a, b) => a.start - b.start);
  for (let n = 0; n < wanted.length; ) {
    const first = wanted[n] ?? { start: 0, length: 0 };
    let end = first.start + first.length;
    n += 1;
    for (let next = wanted[n]; next !== undefined && next.start === end; next = wanted[n]) {
      end += next.length;
      n += 1;
    }
    const buffer = Buffer.alloc(end - first.start);
    const { bytesRead } = await held.read(buffer, 0, buffer.length, first.start);
    // A short read (the log shrank) yields what is there; a torn last line fails its parse and is skipped.
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) if (line !== '') yield line;
  }
};

const withoutMessageUsage = (session: SessionObservation): SessionObservation => {
  if (session.messageUsage === undefined) return session;
  const rest = { ...session };
  Reflect.deleteProperty(rest, 'messageUsage');
  return rest;
};

/**
 * The store as a reader sees it: for each session only the highest `rev`. A version-3 or later session is derived here from its capture records
 * (EXTRACTOR_VERSION rules); a session whose last deposit was version 2 keeps the prompt and error lines that deposit wrote.
 * `afterFirstPass` runs between the two passes over the log: a seam for the test that compacts the log there.
 * `options.messageUsage` keeps the per-message usage entries on each session record; without it they are dropped as the record is read.
 */
export const loadStore = async (storeDir: string, afterFirstPass?: () => Promise<void>, options: LoadOptions = {}): Promise<Store> => {
  // Two passes, so a superseded record is never held: the first keeps one number per session, the second keeps only the records at that rev.
  // A re-capture leaves the old copies in the log until a compaction, and holding them as well doubled the heap of every read.
  // Both passes read one open file: a lock-free reader can meet a compaction between them, and a second open would see the compacted log, where
  // a session recaptured in that window fails the rev match and drops out of this read.
  const file = paths(storeDir).observations;
  const store: Store = { sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0 };
  const intern = interner();
  const captured = new Map<string, Captured>();
  const of = (session: string): Captured => {
    const found = captured.get(session) ?? { prompts: [], tools: [], errorLines: [] };
    captured.set(session, found);
    return found;
  };
  const held = await openLog(file);
  try {
    const latest = options.latest ?? (await scanLog(file, held)).latest;
    await afterFirstPass?.();
    const { only, spans, identity } = options;
    const seek = held !== undefined && only !== undefined && spans !== undefined && identity !== undefined && (await sameFile(held, identity));
    for await (const line of seek ? spanLines(held, spans, only) : logLines(file, held)) {
      options.lineRead?.();
      // A read of a few sessions skips the JSON parse of every other line: the cheap check can only keep a line, never drop one that names a wanted session.
      if (options.only !== undefined && !namesAny(line, options.only)) continue;
      const observation = observationOf(line);
      if (observation === undefined || observation.rev !== latest.get(observation.session)) continue;
      if (options.only !== undefined && !options.only.has(observation.session)) continue;
      if (options.sessionsOnly === true && observation.kind !== 'session') continue;
      if (observation.kind === 'session') of(observation.session).session = options.messageUsage === true ? observation : withoutMessageUsage(observation);
      else if (observation.kind === 'user-prompt') of(observation.session).prompts.push(observation);
      else if (observation.kind === 'tool') of(observation.session).tools.push(internTool(observation, intern));
      else if (observation.kind === 'error-line') of(observation.session).errorLines.push(observation);
      else if (observation.kind === 'prompt') store.prompts.push(observation);
      else store.errors.push(observation);
    }
  } finally {
    await held?.close();
  }
  const redact = makeRedactor((await readState(storeDir)).redactDomains);
  const agents: (SessionCapture & { parent: string })[] = [];
  for (const { session: written, prompts, tools: writtenTools, errorLines: writtenErrorLines } of captured.values()) {
    // A superseded session holds no turns: the session that folded it in holds them.
    if (written === undefined || written.supersededBy !== undefined) continue;
    // One tool call is one record: a replay an older capture wrote beside the call is folded here.
    const folded = foldToolRows(writtenTools, writtenErrorLines);
    const session = withoutReplays(written, folded.dropped);
    const { tools, errorLines } = folded;
    if (Number(session.cv) > Number(CAPTURE_VERSION)) store.newerCaptures += 1;
    store.tools.push(...tools);
    if (session.parent !== null) {
      store.subagents.push(session);
      if (isReadable(session.cv) && options.sessionsOnly !== true) agents.push({ session, prompts, tools, errorLines, parent: session.parent });
      continue;
    }
    store.sessions.push(session);
    if (!isReadable(session.cv) || options.sessionsOnly === true) continue;
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

/** How long a compaction waits for a reader to let go of the log; Windows refuses to rename over a file another process has open. */
const LOG_RENAME_WAIT_MS = 30_000;

const renameWhenFree = async (from: string, to: string, waitMs: number): Promise<void> => {
  const started = Date.now();
  for (;;) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!isCode(error, 'EPERM', 'EACCES', 'EBUSY') || Date.now() - started >= waitMs) throw error;
      await sleep(100);
    }
  }
};

/** Writes to `temp` every line of the log but the superseded ones and blanks, flushed to disk so a rename can never expose an unwritten file. */
const writeLive = async (file: string, temp: string, latest: ReadonlyMap<string, number>): Promise<void> => {
  const out = await open(temp, 'w', 0o600);
  try {
    let batch = '';
    for await (const line of logLines(file)) {
      if (line === '') continue;
      const observation = observationOf(line);
      if (observation !== undefined && observation.rev !== latest.get(observation.session)) continue;
      batch += `${line}\n`;
      if (batch.length < 1 << 20) continue;
      await out.appendFile(batch);
      batch = '';
    }
    await out.appendFile(batch);
    await out.sync();
  } finally {
    await out.close();
  }
};

/**
 * Drops the superseded revs from the log, so a re-capture does not leave a full copy of every session behind. The caller holds the store lock,
 * the same one every append takes. Only a line a higher rev of its session replaces goes: a line this version cannot read stays, since a later
 * oars may read it, and a kept line is written back byte for byte. A crash before the rename leaves the old log whole and a temp file that no
 * reader opens and the next compaction removes. Throws, with the log as it was, when the rewrite cannot finish.
 */
export const compactLog = async (storeDir: string, renameWaitMs = LOG_RENAME_WAIT_MS, held: LockHold = () => Promise.resolve(true)): Promise<void> => {
  const file = paths(storeDir).observations;
  // A run that lost the lock must not sweep a temp file the later holder is writing.
  await requireHold(held);
  // Under the lock no other compaction is running, so any temp file here is one a crash left.
  for (const entry of await listDir(storeDir)) {
    if (entry.name.startsWith(`${basename(file)}.`) && entry.name.endsWith('.tmp')) await rm(join(storeDir, entry.name), { force: true });
  }
  const size = await stat(file).then((info) => info.size, () => 0);
  const { latest, superseded } = await scanLog(file);
  if (!superseded) return;
  const temp = `${file}.${String(process.pid)}.tmp`;
  try {
    await writeLive(file, temp, latest);
    // The lock holds appends off, so this fires only when a waiter broke the lock (say across a sleeping laptop): the temp file lacks what it wrote.
    if ((await stat(file)).size !== size) throw new Error('the log changed while it was being rewritten');
    // The size check cannot see a run that took a broken lock and has not appended yet; its token can.
    await requireHold(held);
    await renameWhenFree(temp, file, renameWaitMs);
  } finally {
    await rm(temp, { force: true });
  }
};

/** A capture record this code derives from: version 3 (upgraded on read) through the current one, and newer ones for the fields known here. */
const isReadable = (cv: string): boolean => Number(cv) >= OLDEST_READABLE_CAPTURE;

/** A log line as a record, or undefined when a reader skips it: a blank, torn, or unparsable line, or one of no known shape. */
const observationOf = (line: string): Observation | undefined => {
  try {
    return asObservation(JSON.parse(line));
  } catch {
    return undefined;
  }
};

// The store is ours, so a line with a known `kind`, a session, and a rev is trusted as the type it says.
const asObservation = (value: unknown): Observation | undefined => {
  if (!isRecord(value) || typeof value.session !== 'string' || typeof value.rev !== 'number') return undefined;
  if (value.kind === 'session') return isSession(value) ? upgradeSession(asSession(value)) : undefined;
  if (value.kind === 'prompt') return isPrompt(value) ? value : undefined;
  if (value.kind === 'error') return isError(value) ? value : undefined;
  if (value.kind === 'user-prompt') return isUserPrompt(value) ? upgradeUserPrompt(value) : undefined;
  if (value.kind === 'tool') return isTool(value) ? upgradeTool(value) : undefined;
  if (value.kind === 'error-line') return isErrorLine(value) ? upgradeErrorLine(value) : undefined;
  return undefined;
};

// The compatibility reader for version-3 (and version-2 session) lines: a field CAPTURE 4 added reads as unknown, and
// `contextFingerprint` reads as `promptFingerprint`. Nothing is rewritten; the next deposit captures the transcript again at the current capture version.
const orNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
/** A version-3 `contextFingerprint` is `<prompt|->.<environment|->`: only the prompt half survives, and `-` reads as none. */
export const promptHalf = (contextFingerprint: unknown): string | null => {
  const first = orNull(contextFingerprint)?.split('.')[0];
  return first === undefined || first === '-' || first === '' ? null : first;
};
const upgradeSession = (value: SessionObservation & { contextFingerprint?: unknown }): SessionObservation => {
  const { contextFingerprint, ...rest } = value;
  return {
    ...rest,
    sid: orNull(value.sid),
    repo: orNull(value.repo),
    fileHashes: Array.isArray(value.fileHashes) ? value.fileHashes : [],
    promptFingerprint: value.promptFingerprint ?? promptHalf(contextFingerprint),
    env: isRecord(value.env) ? value.env : { harness: null, oars: 'unknown', node: 'unknown', os: 'unknown' },
  };
};
const upgradeUserPrompt = (value: UserPromptObservation & { contextFingerprint?: unknown }): UserPromptObservation => {
  const { contextFingerprint, ...rest } = value;
  return { ...rest, sid: orNull(value.sid), promptFingerprint: value.promptFingerprint ?? promptHalf(contextFingerprint) };
};
/**
 * `isTool` admits a row by its tool name and position alone, and derive reads `keys` and `segments` as lists: a row whose `keys` is not a list reads
 * as having none, a `segments` that is not a list reads as a record captured before `segments`, and a segment without a text `run` is dropped.
 * Capture never writes these shapes; one hand-edited or foreign row must not abort every reader.
 */
const upgradeTool = (value: ToolObservation): ToolObservation => {
  const { segments, ...rest } = value;
  const readable: unknown = segments;
  return {
    ...rest,
    sid: orNull(value.sid),
    targetBase: value.targetBase ?? null,
    keys: Array.isArray(value.keys) ? value.keys : [],
    ...(Array.isArray(readable) ? { segments: readable.filter(isSegment) } : {}),
  };
};
const isSegment = (value: unknown): value is ShellSegment => isRecord(value) && typeof value.run === 'string';
const upgradeErrorLine = (value: ErrorLineObservation): ErrorLineObservation => ({ ...value, sid: orNull(value.sid) });

/** A version-2 session line has `v` and no `cv`, `parent`, or agent fields: it reads as a main transcript of that version. */
const asSession = (value: { [key: string]: unknown } & SessionObservation): SessionObservation => ({
  ...value,
  cv: typeof value.cv === 'string' ? value.cv : String(value.v),
  parent: typeof value.parent === 'string' ? value.parent : null,
  agentType: typeof value.agentType === 'string' ? value.agentType : null,
  spawnedBy: typeof value.spawnedBy === 'string' ? value.spawnedBy : null,
  spawnedIn: typeof value.spawnedIn === 'string' ? value.spawnedIn : null,
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
        calls.push({ at: parsed.at, query: parsed.query, matches: parsed.matches, ...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}) });
      }
    } catch {
      // A torn last line is skipped.
    }
  }
  return calls;
};

const isSkeleton = (value: unknown): value is { [key: string]: unknown } & Skeleton => isRecord(value) && Array.isArray(value.lines) && typeof value.merkleRoot === 'string';

const USAGE_KEYS: readonly UsageKey[] = ['input', 'cacheWrite', 'cacheRead', 'output'];

/** A `models` entry written as a bare name (before the keys were recorded) reads with no keys, so its excess falls under `other`. */
const costModelOf = (entry: unknown): CostModel[] => {
  if (typeof entry === 'string') return [{ model: entry, keys: [] }];
  if (!isRecord(entry) || typeof entry.model !== 'string') return [];
  const reported: unknown = entry.keys;
  const keys = Array.isArray(reported) ? USAGE_KEYS.filter((key) => reported.includes(key)) : [];
  return [{ model: entry.model, keys }];
};

/** A skeleton written before `since` (version 2), `models` (early version 3), or the model keys existed reads with them empty, as the check expects. */
const withCostFields = (skeleton: Skeleton, lean: boolean): Skeleton => ({
  ...skeleton,
  lines: skeleton.lines.map((read) => {
    // The content hashes are a skeleton's bulk (a 64-character string per block) and no invariant reads them, so a lean read does not keep them.
    const line = lean ? { ...read, hashes: [] } : read;
    const state: unknown = line.costState;
    if (line.costState === null || !isRecord(state)) return line;
    const since = typeof state.since === 'string' ? state.since : null;
    const models = Array.isArray(state.models) ? state.models.flatMap(costModelOf) : [];
    return { ...line, costState: { ...line.costState, since, models } };
  }),
});

/**
 * `unreadable` counts skeleton files that are torn, corrupted, or not a skeleton, so verify reports them instead of aborting. With `lean`, each
 * line's `hashes` read as empty: `verify` holds every skeleton at once and checks structure, never content.
 */
export const readSkeletons = async (storeDir: string, only?: string, lean = false): Promise<{ skeletons: Skeleton[]; unreadable: number }> => {
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
    if (isSkeleton(parsed)) skeletons.push(withCostFields(parsed, lean));
    else unreadable += 1;
  }
  return { skeletons, unreadable };
};

/** `derive`'s prompt sums, folded run by run: the prompts of each run in turn give the same sums, in the same key order, as the prompts of the whole store. */
export interface DeriveFold {
  add: (prompts: readonly PromptObservation[]) => void;
  /** The error and session parts, which need every error and session record at once, then the whole record. */
  finish: (store: Pick<Store, 'sessions' | 'errors'>, at: string) => DerivedRecords;
}

export const deriveFold = (): DeriveFold => {
  const bigrams: { [bigram: string]: number } = {};
  const recovery: { [pair: string]: number } = {};
  const classes: { [cls: string]: { prompts: number; exploreToAct: number } } = {};
  const ratio = new Map<string, { explore: number; act: number }>();
  const promptCount = new Map<string, number>();
  return {
    add: (prompts) => {
      for (const prompt of prompts) {
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
        promptCount.set(prompt.session, (promptCount.get(prompt.session) ?? 0) + 1);
      }
    },
    finish: (store, at) => {
      const bySig = new Map<string, ErrorObservation[]>();
      for (const error of store.errors) bySig.set(error.sig, [...(bySig.get(error.sig) ?? []), error]);
      const signatures: SignatureRecord[] = [...bySig.entries()].map(([sig, list]) => signatureRecord(sig, list));
      signatures.sort((a, b) => b.sessions - a.sessions || b.count - a.count || a.sig.localeCompare(b.sig));
      for (const [cls, entry] of ratio) {
        const row = classes[cls];
        if (row !== undefined) row.exploreToAct = Math.round((entry.explore / Math.max(entry.act, 1)) * 100) / 100;
      }
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
    },
  };
};

/** The derived records, a pure function of the store. */
export const derive = (store: Store, at: string): DerivedRecords => {
  const fold = deriveFold();
  fold.add(store.prompts);
  return fold.finish(store, at);
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
