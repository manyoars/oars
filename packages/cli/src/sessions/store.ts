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
import type { GoldEvaluator } from './gold-arms.js';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CliError, ExitCode } from '../errors.js';
import { compileAllow, requireEntries, slugOf } from './allow.js';
import { openCursorStore, type CursorStore } from './cursor.js';
import { buildIndex, indexPath } from './hook-index.js';
import { archiveRaw } from './archive.js';
import { deriveSession, type SessionCapture } from './derive.js';
import { captureRuntime, type CaptureRuntime } from './capture-runtime.js';
import { callPositions, captureSession, type Capture, type SubagentOrigin } from './extract.js';
import { foldToolRows, withoutReplays } from './fold.js';
import { asRepoSize, type RepoSize } from './public-vocabulary.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
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
  /** Cursor's `User` folder (`cursorRoot` in cursor.ts); absent means no Cursor source. `deposit` reads it only when `--allow` names `cursor`. */
  cursorRoot?: string;
  /** Where the account's salt comes from; absent means this machine's own (`localSalt`). The seam an account identity replaces (M4). */
  accountSalt?: (storeDir: string) => Promise<AccountSalt>;
  /** The fresh single-turn reader behind `gold arms`; absent in a run that has none. */
  evaluator?: GoldEvaluator | undefined;
  stdin: NodeJS.ReadableStream;
  stdout: { write: (text: string) => unknown };
}

interface FileState {
  size: number;
  mtimeMs: number;
  rev: number;
  /** The capture version that wrote this file's records; a file recorded under another version is deposited again. */
  v: string;
  /** The `sid` of the salt the file's records were hashed with; a file recorded under another salt is captured again from raw (t711 Section 4). */
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
}

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

export const paths = (storeDir: string) => ({
  observations: join(storeDir, 'observations.jsonl'),
  state: join(storeDir, 'state.json'),
  derived: join(storeDir, 'derived.json'),
  skeletons: join(storeDir, 'skeletons'),
  calls: join(storeDir, 'mcp-calls.jsonl'),
  hookCalls: join(storeDir, 'hook-calls.jsonl'),
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
  /** Of `sessions`, the Cursor composer sessions parsed this run; 0 when the Cursor source is not allowed or absent. */
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

const projectFolders = async (projectsRoot: string): Promise<string[]> => {
  try {
    return (await readdir(projectsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
};

/** What a deposit never reads: project folders that hold transcripts but that no `--allow` entry names (t776). */
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
 * only, never a transcript, so `verify` can say what the store does not hold.
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
  runtime: SessionsRuntime;
  state: State;
  /** The sorted redact-domain set in force. */
  domains: string[];
  redact: ReturnType<typeof makeRedactor>;
  salt: AccountSalt;
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

const contextFor = async (runtime: SessionsRuntime, state: State, now: () => number): Promise<DepositContext> => {
  // Each file records the set it was deposited under. A file whose set differs from the current one is read again, so a domain
  // added while other folders were allowed still masks those folders later. Lines already written stay in the observations file
  // until it is compacted; readers use only the highest rev of each session.
  await mkdir(paths(runtime.storeDir).skeletons, { recursive: true });
  const salt = await (runtime.accountSalt ?? localSalt)(runtime.storeDir);
  let logged: Promise<LoggedSessions> | undefined;
  return {
    runtime,
    state,
    domains: [...state.redactDomains].sort(),
    redact: makeRedactor(state.redactDomains),
    salt,
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
interface Transcript {
  file: string;
  /** `<session>`, or `<parent>~agent-x` / `<parent>~wf_y~agent-x` for a subagent. */
  session: string;
  /** The path under the project folder, the key in `state.json`. */
  relative: string;
  subagent?: SubagentOrigin;
  /** Read from the store's own archive because the harness no longer has the transcript; it is not archived again. */
  fromRaw?: boolean;
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

interface SubagentFile {
  dir: string;
  /** The folders between `subagents` and the file, for example `['workflows', 'wf_x']`. */
  path: string[];
  parent: string;
  name: string;
}

// The subagent transcript files of the given sessions, from folder listings alone:
// <session>/subagents/agent-*.jsonl and <session>/subagents/workflows/wf_*/agent-*.jsonl. No file is opened, so `skippedFolders` can use it on a folder no allow entry names.
const subagentFiles = async (folder: string, sessions: readonly string[]): Promise<SubagentFile[]> => {
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
const subagentTranscripts = async (folder: string, sessions: readonly string[]): Promise<Transcript[]> => {
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
const sessionFolders = async (folder: string): Promise<string[]> => (await listDir(folder)).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

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
  if (transcript.fromRaw !== true) await archiveRaw(file, join(paths(runtime.storeDir).raw, project, ...transcript.relative.split('/')));
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

/**
 * Rewrites `derived.json` (the derive step), then the hook index (the index step), from the whole store. With a trace, a failure of
 * either is recorded on it instead of thrown, so the caller can log the deposit that already wrote its records, then the failed step
 * (spec 3.1: one row per step, a failed derive leaving the index skipped), and rethrow.
 */
export const refresh = async (runtime: SessionsRuntime, redactDomains: readonly string[], at: string, trace?: DepositTrace): Promise<void> => {
  const started = performance.now();
  // The extractor version alone until the store is read: a derive that fails before the high-water mark is known still has a key (spec 4.4).
  let key = digest([EXTRACTOR_VERSION]);
  let store: Store;
  try {
    store = await loadStore(runtime.storeDir);
    // The key is the account's capture high-water mark (the highest rev of each session) and `ev` (spec 4.2); the index shares it.
    const highWater = [...store.sessions, ...store.subagents].map((session) => `${session.session}:${String(session.rev)}`).sort();
    key = digest([EXTRACTOR_VERSION, ...highWater]);
    const derived = derive(store, at);
    await writeAtomic(paths(runtime.storeDir).derived, JSON.stringify(derived));
    if (trace !== undefined) {
      trace.derive = {
        ms: Math.round(performance.now() - started),
        in: { session: store.sessions.length, subagent: store.subagents.length, 'user-prompt': store.prompts.length, tool: store.tools.length },
        out: { signature: derived.signatures.length, summary: derived.summaries.length },
        key,
      };
    }
  } catch (error) {
    if (trace === undefined) throw error;
    trace.deriveFailure = { error, key, ms: Math.round(performance.now() - started) };
    return;
  }
  const indexStarted = performance.now();
  try {
    const index = buildIndex(store, redactDomains, at);
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
    if (trace === undefined) throw error;
    trace.indexFailure = { error, key, ms: Math.round(performance.now() - indexStarted) };
  }
};

/** Appends a capture's records, writes its skeleton, and records the cursor in the state map (the caller writes `state.json`). */
const commitCapture = async (context: DepositContext, key: string, extract: Capture, cursor: { size: number; mtimeMs: number; rev: number }): Promise<void> => {
  const files = paths(context.runtime.storeDir);
  const batch: Observation[] = [extract.session, ...extract.prompts, ...extract.tools, ...extract.errorLines];
  await mkdir(context.runtime.storeDir, { recursive: true });
  await appendFile(files.observations, batch.map((observation) => `${JSON.stringify(observation)}\n`).join(''), { mode: 0o600 });
  await writeAtomic(join(files.skeletons, `${extract.session.session}.json`), JSON.stringify(extract.skeleton));
  context.state.files[key] = { ...cursor, v: CAPTURE_VERSION, s: context.salt.sid, d: context.domains, repoSize: extract.session.frame?.stack.size ?? null };
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
  // A waiter breaks a lock older than `staleMs`, and a full re-capture runs longer than that: the holder keeps its lock young, or a hook
  // would break it and append during the compaction that ends the run.
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lock, now, now).catch(() => undefined);
  }, options.staleMs / 4);
  heartbeat.unref();
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    await rm(lock, { force: true });
  }
};

export const deposit = (runtime: SessionsRuntime, options: DepositOptions, trace?: DepositTrace): Promise<DepositResult> => withLock(runtime.storeDir, () => depositLocked(runtime, options, trace));

const depositLocked = async (runtime: SessionsRuntime, options: DepositOptions, trace?: DepositTrace): Promise<DepositResult> => {
  requireEntries(options.allow);
  const allow = compileAllow(options.allow);
  const folders = await projectFolders(runtime.projectsRoot);
  const allowed = folders.filter((name) => allow.allows(name));
  const missing = allow.unmatched(runtime.cursorRoot === undefined ? folders : [...folders, CURSOR_SOURCE]);
  const state = await readState(runtime.storeDir);
  refuseNewer(state);
  // A log written by a newer oars is refused even when state.json is older or lost; the Stop-hook path reads only state.json.
  const held = (await loadStore(runtime.storeDir)).newerCaptures;
  if (held > 0) throw new CliError(`The log holds captures by a newer oars (sessions: ${String(held)}); upgrade oars.`, ExitCode.UNEXPECTED, 'unexpected');
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
    cursor: 0,
    cursorUnreadable: [],
    cursorUnreadableLogged: [],
    cursorRejected: 0,
    skippedFolders: folders.length - allowed.length,
    folders: allowed,
    missing,
  };
  // A project the harness cleaned up entirely is still visited when the state names it, so its archived transcripts are captured again.
  const stateProjects = Object.keys(state.files).map((key) => key.slice(0, key.indexOf('/'))).filter((name) => name !== CURSOR_SOURCE && allow.allows(name));
  // The same holds for a lost state.json: raw/ still names the projects whose transcripts can be captured again.
  const rawProjects = (await listDir(paths(runtime.storeDir).raw)).filter((entry) => entry.isDirectory() && entry.name !== CURSOR_SOURCE && allow.allows(entry.name)).map((entry) => entry.name);
  for (const project of [...new Set([...allowed, ...stateProjects, ...rawProjects])].sort()) {
    const folder = join(runtime.projectsRoot, project);
    const entries = (await listDir(folder)).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => entry.name).sort();
    const onDisk = [...entries.map((name) => mainTranscript(folder, name)), ...(await subagentTranscripts(folder, await sessionFolders(folder)))];
    const transcripts = [...onDisk, ...(await rawOnlyTranscripts(context, project, new Set(onDisk.map((transcript) => `${project}/${transcript.relative}`))))];
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
      tally(trace, extract, transcript.subagent !== undefined);
    }
  }
  if (runtime.cursorRoot !== undefined && allow.allows(CURSOR_SOURCE)) await readCursor(context, runtime.cursorRoot, result, trace);
  await writeAtomic(paths(runtime.storeDir).state, JSON.stringify(state));
  // Decided by what the log holds, not by what this run captured: a run that died after its re-capture left the copies for this one. The hook
  // path never compacts, since it has seconds. The records are safe by now and an uncompacted log still loads, so a failure here does not fail the deposit.
  await compactLog(runtime.storeDir).catch((error: unknown) => {
    process.stderr.write(`oars: the session log was not compacted, and the next deposit tries again: ${error instanceof Error ? error.message : String(error)}\n`);
  });
  await refresh(runtime, state.redactDomains, context.at, trace);
  return result;
};

/** The source name `--allow` uses for Cursor, and the first segment of its `state.json` keys (`cursor/<composerId>`). */
const CURSOR_SOURCE = 'cursor';

/** Reports an unreadable Cursor store: the full path for the terminal, the base name for the hook-call record. */
const noteUnreadable = (root: string, error: unknown, result: DepositResult): void => {
  const reason = error instanceof Error ? error.message : String(error);
  const file = join(root, 'globalStorage', 'state.vscdb');
  result.cursorUnreadable.push(`${file}: ${reason}`);
  result.cursorUnreadableLogged.push(`${basename(file)}: ${reason}`);
};

/**
 * Deposits the Cursor composer sessions under `root` (t728). A session's cursor is its message count and `lastUpdatedAt`, kept in
 * `state.json` like a file's size and mtime, so a second deposit adds nothing until Cursor writes the session again. The store is opened
 * read-only and a missing one is skipped silently. Nothing is archived: there is no transcript file to link, only the database.
 */
const readCursor = async (context: DepositContext, root: string, result: DepositResult, trace: DepositTrace | undefined): Promise<void> => {
  // The Cursor source fails open per source, and only its own read is guarded: the store's write failures (a full disk) propagate as they
  // do on the Claude Code path instead of blaming the Cursor file.
  let source: CursorStore | undefined;
  try {
    source = await openCursorStore(root);
  } catch (error) {
    noteUnreadable(root, error, result);
    return;
  }
  if (source === undefined) return;
  result.cursorRejected += source.rejected;
  try {
    for (const session of source.sessions) {
      const key = `${CURSOR_SOURCE}/${session.composerId}`;
      const previous = context.state.files[key];
      if (
        previous !== undefined &&
        previous.size === session.messages &&
        previous.mtimeMs === session.lastUpdatedAt &&
        previous.v === CAPTURE_VERSION &&
        previous.s === context.salt.sid &&
        sameSet(previous.d, context.domains)
      ) {
        result.unchanged += 1;
        continue;
      }
      let text: string;
      try {
        text = source.transcript(session);
      } catch (error) {
        noteUnreadable(root, error, result);
        break;
      }
      const rev = Math.max((previous?.rev ?? 0) + 1, context.now());
      const id = `${CURSOR_SOURCE}-${session.composerId}`;
      const extract = captureSession({
        text,
        session: id,
        project: session.folder === null ? CURSOR_SOURCE : slugOf(session.folder),
        rev,
        at: context.at,
        bytes: Buffer.byteLength(text),
        redact: context.redact,
        salt: context.salt.salt,
        sid: context.salt.sid,
        repoRoot: context.repoRoot,
        repoIdentity: context.repoIdentity,
        runtime: context.captureRuntime,
        repoSize: await earlierRepoSize(context, previous, id),
        harness: 'cursor',
      });
      extract.session.harness = 'cursor';
      await commitCapture(context, key, extract, { size: session.messages, mtimeMs: session.lastUpdatedAt, rev });
      tally(trace, extract, false);
      result.sessions += 1;
      result.cursor += 1;
      result.lines += extract.session.lines;
      result.badLines += extract.session.badLines;
      result.observations += 1 + extract.prompts.length + extract.tools.length + extract.errorLines.length;
    }
  } finally {
    source.close();
  }
};

/**
 * The log's lines, a chunk at a time: the log can pass the longest string Node can hold (536,870,888 characters), so it is never one string.
 * It splits on the newline alone, not through `readline`, which also ends a line at U+2028 and U+2029: `JSON.stringify` leaves those raw inside a
 * value. A missing log has no lines, and a last line with no newline is yielded as it stands, for the reader to parse or skip.
 */
const logLines = async function* (file: string): AsyncGenerator<string> {
  let rest = '';
  try {
    for await (const chunk of createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
      const lines = (rest + String(chunk)).split('\n');
      rest = lines.pop() ?? '';
      yield* lines;
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  yield rest;
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
 * Cursor composer from Cursor's store): they can never be captured again, so `verify` counts them `cv-frozen` instead of failing `--strict` over them.
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
  const prefix = `${CURSOR_SOURCE}-`;
  const cursorBehind = behind.filter((entry) => entry.session.startsWith(prefix) && !alive.has(`${entry.project}/${entry.session}`));
  if (cursorBehind.length > 0 && runtime.cursorRoot !== undefined) {
    // A Cursor session has no transcript file: its source is the composer, which the next deposit reads again while Cursor still lists it.
    // An unreadable store counts as alive too, since it may read again once Cursor releases it.
    let listed: ReadonlySet<string> | undefined;
    try {
      const source = await openCursorStore(runtime.cursorRoot);
      listed = new Set((source?.sessions ?? []).map((session) => `${prefix}${session.composerId}`));
      source?.close();
    } catch {
      listed = undefined;
    }
    for (const entry of cursorBehind) if (listed === undefined || listed.has(entry.session)) alive.add(`${entry.project}/${entry.session}`);
  }
  return new Set(behind.filter((entry) => !alive.has(`${entry.project}/${entry.session}`)).map((entry) => entry.session));
};

/**
 * Transcripts the harness no longer has but the raw archive does, whose last capture is behind this code or used another salt: they are
 * captured again from `<store>/raw/` (t711 Section 4, re-capture source). One with neither stays as logged, read through the compatibility reader.
 */
const rawOnlyTranscripts = async (context: DepositContext, project: string, onDisk: ReadonlySet<string>): Promise<Transcript[]> => {
  const { storeDir } = context.runtime;
  const prefix = `${project}/`;
  const root = join(paths(storeDir).raw, project);
  // Listed from raw/ itself, so a lost state.json (no entries to name the files) still finds them; a file with no entry counts as behind.
  const behind = (await rawRelatives(root, [])).filter((relative) => {
    const entry = context.state.files[`${prefix}${relative}`];
    return !onDisk.has(`${prefix}${relative}`) && (entry === undefined || entry.v !== CAPTURE_VERSION || entry.s !== context.salt.sid);
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

const HOOK_LOCK: LockOptions = { waitMs: 3_000, staleMs: 600_000 };

export type SessionDeposit = 'deposited' | 'unchanged' | 'not-allowed' | 'missing';

/**
 * Deposits one transcript, as the SessionEnd hook does: only from a folder that earlier `--allow` entries name, and idempotent by size and
 * mtime. It does not rebuild `derived.json` or the hook index (that is a whole-store pass; the nightly run does it), so it stays fast.
 */
export const depositSession = (runtime: SessionsRuntime, transcript: string, now: () => number, trace?: DepositTrace): Promise<SessionDeposit> =>
  // The hook path gives up after 3 s so a SessionEnd behind the nightly deposit cannot hold session exit past its 5 s budget.
  withLock(runtime.storeDir, () => depositSessionLocked(runtime, transcript, now, trace), HOOK_LOCK);

const depositSessionLocked = async (runtime: SessionsRuntime, transcript: string, now: () => number, trace?: DepositTrace): Promise<SessionDeposit> => {
  const project = basename(dirname(transcript));
  const state = await readState(runtime.storeDir);
  refuseNewer(state);
  if (!compileAllow(state.allow).allows(project)) return 'not-allowed';
  const context = await contextFor(runtime, state, now);
  const folder = dirname(transcript);
  const main = mainTranscript(folder, basename(transcript));
  let wrote: boolean;
  try {
    const extract = await depositFile(context, project, main);
    wrote = extract !== undefined;
    if (extract !== undefined) tally(trace, extract, false);
  } catch (error) {
    if (isMissing(error)) return 'missing';
    throw error;
  }
  // The session's subagents finished before it did, so the Stop deposit takes them too (A24).
  for (const subagent of await subagentTranscripts(folder, [main.session])) {
    const extract = await depositFile(context, project, subagent);
    if (extract !== undefined) tally(trace, extract, true);
    wrote = extract !== undefined || wrote;
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

/**
 * The store as a reader sees it: for each session only the highest `rev`. A version-3 or later session is derived here from its capture records
 * (EXTRACTOR_VERSION rules); a session whose last deposit was version 2 keeps the prompt and error lines that deposit wrote.
 */
export const loadStore = async (storeDir: string): Promise<Store> => {
  const all: Observation[] = [];
  const latest = new Map<string, number>();
  for await (const line of logLines(paths(storeDir).observations)) {
    const observation = observationOf(line);
    if (observation === undefined) continue;
    all.push(observation);
    latest.set(observation.session, Math.max(latest.get(observation.session) ?? 0, observation.rev));
  }
  const store: Store = { sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0 };
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
  for (const { session: written, prompts, tools: writtenTools, errorLines: writtenErrorLines } of captured.values()) {
    if (written === undefined) continue;
    // One tool call is one record: a replay an older capture wrote beside the call is folded here (t762).
    const folded = foldToolRows(writtenTools, writtenErrorLines);
    const session = withoutReplays(written, folded.dropped);
    const { tools, errorLines } = folded;
    if (Number(session.cv) > Number(CAPTURE_VERSION)) store.newerCaptures += 1;
    store.tools.push(...tools);
    if (session.parent !== null) {
      store.subagents.push(session);
      if (isReadable(session.cv)) agents.push({ session, prompts, tools, errorLines, parent: session.parent });
      continue;
    }
    store.sessions.push(session);
    if (!isReadable(session.cv)) continue;
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
export const compactLog = async (storeDir: string, renameWaitMs = LOG_RENAME_WAIT_MS): Promise<void> => {
  const file = paths(storeDir).observations;
  // Under the lock no other compaction is running, so any temp file here is one a crash left.
  for (const entry of await listDir(storeDir)) {
    if (entry.name.startsWith(`${basename(file)}.`) && entry.name.endsWith('.tmp')) await rm(join(storeDir, entry.name), { force: true });
  }
  const size = await stat(file).then((info) => info.size, () => 0);
  const latest = new Map<string, number>();
  let superseded = false;
  for await (const line of logLines(file)) {
    const observation = observationOf(line);
    if (observation === undefined) continue;
    const seen = latest.get(observation.session);
    superseded ||= seen !== undefined && seen !== observation.rev;
    latest.set(observation.session, Math.max(seen ?? 0, observation.rev));
  }
  if (!superseded) return;
  const temp = `${file}.${String(process.pid)}.tmp`;
  try {
    await writeLive(file, temp, latest);
    // The lock holds appends off, so this fires only when a waiter broke the lock (say across a sleeping laptop): the temp file lacks what it wrote.
    if ((await stat(file)).size !== size) throw new Error('the log changed while it was being rewritten');
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
const upgradeTool = (value: ToolObservation): ToolObservation => ({ ...value, sid: orNull(value.sid), targetBase: value.targetBase ?? null });
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
const withCostFields = (skeleton: Skeleton): Skeleton => ({
  ...skeleton,
  lines: skeleton.lines.map((line) => {
    const state: unknown = line.costState;
    if (line.costState === null || !isRecord(state)) return line;
    const since = typeof state.since === 'string' ? state.since : null;
    const models = Array.isArray(state.models) ? state.models.flatMap(costModelOf) : [];
    return { ...line, costState: { ...line.costState, since, models } };
  }),
});

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
    if (isSkeleton(parsed)) skeletons.push(withCostFields(parsed));
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
