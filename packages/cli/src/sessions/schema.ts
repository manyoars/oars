// The session store's schema, in one file (t689 and t700, T0 of docs/research/2026-11-01-session-commons-direction.md).
//
// Everything here is deterministic and local: no model call, no network. `oars sessions deposit` reads the operator's own Claude Code
// logs (`~/.claude/projects/<path-slug>/*.jsonl` and each session's `subagents/` transcripts, one JSON event per line) and appends
// captured records to `<config>/oars/sessions/observations.jsonl`. The log is append-only: a session whose file changed is deposited
// again under a higher `rev`, and a reader keeps only the highest `rev` of each session.
//
// Store version 4 (CAPTURE 4, t714) keeps version 3's shape and adds to it: `sid` on every capture record, `repo`, `fileHashes`, and `env` on
// the session, `targetBase` on the tool record, `promptFingerprint` in place of `contextFingerprint`, and a 1,000-character cap on an
// error-line's `line`. A version-3 store is read through `upgradeCapture` (store.ts) until each transcript is captured again.
//
// Store version 3 (register A28) splits capture from derivation. Capture writes four record kinds, each stamped `cv` with
// CAPTURE_VERSION: `session` (one per transcript), `user-prompt` (one per prompt), `tool` (one per tool call), and `error-line` (one per
// failed tool result, keyed by `toolUseId`). Derivation (`derive.ts`: signatures, prompt classes, tool-name sequences, recovery pairs,
// and recovery episodes) runs over those records alone, never over raw, and stamps its output `v` with EXTRACTOR_VERSION, so a change to
// a derivation rule re-derives the store without reading a transcript. Version-2 `prompt` and `error` lines (already derived) are still
// read for a session that has no version-3 rev.
//
// Field classes (t711 Section 1.1): `L` local-only, never leaves the machine at any tier; `A` account store, the account's own store only;
// `P` pooled index, names, versions, counts, and day-resolution dates. Each field below names its class in its doc comment, and
// docs/sessions-store.md lists them all. The paragraph after this one is the version-3 wording, kept for the fields it still describes.
//
// The log is the local derived-records tier: redacted text, never raw content, and nothing uploads. Field classes (register D1):
// `local-only` fields stay on this machine whatever later tier is switched on; `shareable` fields are names, versions, counts,
// durations, status, key names, and hashes (the pooled-index list). Each record type below names its local-only fields. The text kept,
// each redacted first and then cut: the first 300 characters of a prompt, the first informative line of a tool error (uncut in the
// `error-line` record, 160 characters in a derived example), TLDR lines (400), Confidence lines (120), and, with no length limit,
// WebSearch queries, fetched URLs, file paths, and git branch names. Also kept as written, not redacted: the project folder slug (it
// holds the username and directory names; the log stays local), skill names, effort values, model names, harness versions, and tool
// names (including MCP server names). `redact` masks secrets by pattern and entropy, emails, and the organization domains the operator
// names. The skeleton holds hashes only.

/** Stamped `cv` on every captured record. Bump it only when the captured field list changes: a bump re-reads every transcript. */
export const CAPTURE_VERSION = '4';

/** Capture versions the reader derives from. A version-3 record is upgraded on read; a newer one is read for the fields this code knows. */
export const OLDEST_READABLE_CAPTURE = 3;

/** Stamped `v` on every derived record. A bump re-derives from the log; no transcript is read. */
export const EXTRACTOR_VERSION = '4';

export const PROMPT_HEAD_CHARS = 300;
export const ERROR_EXAMPLE_CHARS = 160;
/** The reference scripts cut a normalized signature at 110 characters. */
export const SIGNATURE_CHARS = 110;
/** An error-line's `line` is redacted, then cut to this many characters (t711 Section 1.2; version 3 stored it uncut). */
export const ERROR_LINE_CHARS = 1000;

export type PromptClass = 'no-tools' | 'orchestration' | 'research' | 'edit-verify' | 'edit-only' | 'explore-only' | 'shell-only' | 'mixed';

export interface Usage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  thinking: number;
}

/** Where a path target is hashed from (class P): the repository root, or the line's working directory when no repository holds the path. */
export type TargetBase = 'repo' | 'cwd';

/** The environment a transcript was captured in (class P, names and versions only; library versions only when a transcript states them, L6). */
export interface CaptureEnv {
  /** The harness version the transcript's last versioned line names; null when none. */
  harness: string | null;
  /** The oars package version that captured it. */
  oars: string;
  /** The Node.js version that captured it. */
  node: string;
  /** `process.platform` of the capturing machine. */
  os: string;
}

/**
 * One per transcript, captured: the `parse_sessions.py` record, minus anything that is raw content. Classes (t711 Section 1.2):
 * `L` local-only: `project`, `files`. `A` account store: `session`, `parent`, `spawnedBy`, `branches`, `urls`, `searches`, `tldrs`,
 * `confidences`, `promptFingerprint`, `repo`, `fileHashes`, `at`, `tsFirst`, `tsLast`. `P` pooled: `kind`, `cv`, `rev`, `sid`,
 * `agentType`, the counts, `versions`, `models`, `tools`, `env`, `costUsd`, `usage` (`at`, `tsFirst`, and `tsLast` at UTC day).
 */
export interface SessionObservation {
  kind: 'session';
  /** CAPTURE_VERSION (a version-2 line has `v` instead). Class P. */
  cv: string;
  /** The first 8 hex characters of SHA-256 of the salt this record's hashes used; null on a record captured before version 4. Class P. */
  sid: string | null;
  /** The session id, or `<parent>~<path>` for a subagent transcript (`<parent>~agent-x`, `<parent>~wf_y~agent-x`). */
  session: string;
  project: string;
  /** The main session a subagent transcript belongs to; null for a main transcript. */
  parent: string | null;
  /** The subagent type from the transcript's `.meta.json` (`general-purpose`, `Explore`); null for a main transcript. */
  agentType: string | null;
  /** The parent's `Agent` tool call that spawned this subagent (the meta file's `toolUseId`); null for a main transcript. */
  spawnedBy: string | null;
  rev: number;
  /** When this deposit ran (ISO 8601). */
  at: string;
  bytes: number;
  lines: number;
  badLines: number;
  userTurns: number;
  assistantTurns: number;
  tsFirst: string | null;
  tsLast: string | null;
  versions: string[];
  models: { [model: string]: number };
  branches: string[];
  tools: { [tool: string]: number };
  /** Class L: the touched file paths as written, redacted. */
  files: string[];
  /** Class A: the per-account salted hash (16 hex characters) of each touched file, relative to the repository root, sorted. */
  fileHashes: string[];
  /** Class A: the salted hash of the repository root the transcript's working directory sits in; null when none holds it. */
  repo: string | null;
  urls: string[];
  searches: string[];
  bashCmds: number;
  tldrs: string[];
  confidences: string[];
  compactSummaries: number;
  /** Class A: fingerprint of the `prompt_snapshot` attachment when present, else null (version 3's `contextFingerprint` mixed in the environment). */
  promptFingerprint: string | null;
  /** Class P: where and with what this transcript was captured. */
  env: CaptureEnv;
  /** The harness's own `cost-state` totals when the file has one. */
  costUsd: number | null;
  /** Summed assistant usage of the file's own line (a main transcript's sidechain lines are not counted; a subagent transcript is its own line). */
  usage: Usage;
}

/** One per user prompt: the `prompt_graphs.py` and `cost_per_class.py` records joined. */
export interface PromptObservation {
  kind: 'prompt';
  v: string;
  session: string;
  rev: number;
  index: number;
  ts: string | null;
  /** Seconds from the prompt to the last main-line line before the next prompt; null when a timestamp is missing. */
  wallSec: number | null;
  /** The first 300 characters, redacted. */
  head: string;
  cls: PromptClass;
  /** The main-line tool names in order (MCP names shortened). */
  tools: string[];
  /** The run-length shape, for example `Read>Editx2>Bash`. */
  shape: string;
  errors: number;
  thinking: number;
  sideTools: number;
  turns: number;
  model: string;
  efforts: string[];
  skills: string[];
  usage: Usage;
  /** The two tools after the first error of each error run (the recovery pair); empty when no error. */
  recovery: string[];
  explore: number;
  act: number;
  /** Transition bigrams `a>b` of `tools`, with counts. */
  bigrams: { [bigram: string]: number };
  /** Session-level context fingerprint at the time of the prompt, when one had been seen. */
  contextFingerprint: string | null;
}

/** One per tool error: the `error_signatures.py` record. */
export interface ErrorObservation {
  kind: 'error';
  v: string;
  session: string;
  rev: number;
  ts: string | null;
  harnessVersion: string | null;
  tool: string;
  /** `<tool> | <normalized first informative line>`, the reference scripts' key. */
  sig: string;
  /** The first informative line, 160 characters, redacted. */
  example: string;
  /** The next two tool calls after the error (any line, in file order). */
  next: string[];
  /** Whether an Edit, Write, or MultiEdit came within six tool calls. */
  editFollowed: boolean;
  /** The prompt this error happened in (null before the first prompt) and its class. */
  prompt: number | null;
  cls: PromptClass | null;
  /**
   * Set when a subagent made the call: its transcript (`<parent>~agent-x`), local-only. `session` is then the main session that spawned
   * it, and `prompt` and `cls` are the spawning prompt's.
   */
  agent?: string;
}

export type ToolStatus = 'ok' | 'error' | 'none';

/**
 * One per tool call (register A28), captured. Classes: `A` account store: `session`, `parent`, `toolUseId`, `ts`, and a path-form
 * `target` (a salted hash); `P` pooled: `kind`, `cv`, `sid`, `rev`, `agentType`, `n`, `tool`, `status`, `keys`, `durationMs`,
 * `harnessVersion`, `side`, `prompt`, `targetBase`, and a shell-form `target` (program and subcommand).
 */
export interface ToolObservation {
  kind: 'tool';
  cv: string;
  sid: string | null;
  session: string;
  rev: number;
  /** The main session id: the session itself, or the parent of a subagent transcript. */
  parent: string;
  /** The subagent type when the call ran inside one; null on a main transcript. */
  agentType: string | null;
  /** The call's position among the file's tool calls, from 0. */
  n: number;
  ts: string | null;
  tool: string;
  /** The first result's status: `error` when it failed, `ok` when it came back clean, `none` when no result is in the file. */
  status: ToolStatus;
  /**
   * For a call with a path input (`file_path`, `notebook_path`, `path`): a per-account salted SHA-256 (16 hex characters) of the path
   * relative to the repository root of the line's `cwd` (else to the `cwd`: see `targetBase`). For a shell call: its program and subcommand (`shellTarget` in extract.ts, as
   * recovery_episodes.py computes it), redacted. Else null.
   */
  target: string | null;
  /** For a path target: `repo` when it was hashed relative to the repository root, `cwd` when no repository held it; null for any other target. */
  targetBase: TargetBase | null;
  /** The input's key names, sorted. */
  keys: string[];
  /** From the call's line to its first result's line; null when either timestamp is missing or no result is in the file. */
  durationMs: number | null;
  toolUseId: string | null;
  harnessVersion: string | null;
  /** A sidechain line inside a main transcript. */
  side: boolean;
  /** The prompt index the call ran under; null before the first prompt. */
  prompt: number | null;
}

/** One per failed tool result, captured and keyed by `toolUseId`. Classes: `A` account store: `session`, `toolUseId`, `line`
 * (switchable text), `ts`; `P` pooled: `kind`, `cv`, `sid`, `rev`, `tool`, `harnessVersion`, `side`, `prompt`, `after`. */
export interface ErrorLineObservation {
  kind: 'error-line';
  cv: string;
  sid: string | null;
  session: string;
  rev: number;
  toolUseId: string | null;
  /** The name of the call the result answers, `?` when the call is not in the file. */
  tool: string;
  /** The first informative line, redacted, not normalized, then cut to {@link ERROR_LINE_CHARS}. */
  line: string;
  ts: string | null;
  harnessVersion: string | null;
  side: boolean;
  prompt: number | null;
  /** How many tool calls came before this result in the file, so derive can read what followed it. */
  after: number;
}

/**
 * One per user prompt, captured: what the transcript says about a prompt besides its tool calls. Classes: `A` account store: `session`, `head` (switchable text),
 * `ts`, `promptFingerprint`; `P` pooled: `kind`, `cv`, `sid`, `rev`, `index`, `wallSec`, `thinking`, `turns`, `model`, `efforts`, `skills`, `usage`. Derive joins it with the prompt's tool calls and errors into a {@link PromptObservation}.
 */
export interface UserPromptObservation {
  kind: 'user-prompt';
  cv: string;
  sid: string | null;
  session: string;
  rev: number;
  index: number;
  ts: string | null;
  wallSec: number | null;
  head: string;
  thinking: number;
  turns: number;
  model: string;
  efforts: string[];
  skills: string[];
  usage: Usage;
  /** Class A: the session's prompt fingerprint at the time of the prompt, when one had been seen. */
  promptFingerprint: string | null;
}

export type CaptureRecord = SessionObservation | UserPromptObservation | ToolObservation | ErrorLineObservation;

/** What a reader finds in the log: version-3 capture records, or the version-2 derived lines of a session not deposited since. */
export type Observation = CaptureRecord | PromptObservation | ErrorObservation;

/** One recurring-signature record of `derived.json`. */
export interface SignatureRecord {
  v: string;
  sig: string;
  tool: string;
  example: string;
  sessions: number;
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  harnessVersions: string[];
  /** Tools that followed, by count. */
  following: { [tool: string]: number };
  editFollowed: number;
}

export interface DerivedRecords {
  v: string;
  at: string;
  sessions: number;
  signatures: SignatureRecord[];
  /** Transition bigram counts over all prompts. */
  bigrams: { [bigram: string]: number };
  /** Recovery pair counts (`Bash>Write`) over all prompts. */
  recovery: { [pair: string]: number };
  /** Prompts per class and the mean explore-to-act ratio of each class. */
  classes: { [cls: string]: { prompts: number; exploreToAct: number } };
  /** The per-session summaries (the session observations, latest rev). */
  summaries: SessionSummary[];
}

export interface SessionSummary {
  session: string;
  project: string;
  prompts: number;
  errors: number;
  tools: number;
  tsFirst: string | null;
  tsLast: string | null;
  tldrs: number;
}

/** One per line of a session file: ids and structure, with a SHA-256 in place of every content field. */
export interface SkeletonLine {
  n: number;
  type: string | null;
  uuid: string | null;
  parentUuid: string | null;
  ts: string | null;
  /** `user` or `assistant` for a message line. */
  role: string | null;
  tools: Array<{ id: string | null; name: string }>;
  /** The `tool_use_id` of each `tool_result` block. */
  results: Array<string | null>;
  usage: Usage | null;
  /** True when the line reports `output_tokens_details.thinking_tokens` (`usage.thinking` is 0 for a line that does not). */
  hasThinking: boolean;
  model: string | null;
  version: string | null;
  requestId: string | null;
  apiBlockIndex: number | null;
  /** SHA-256 of each content block (its text, or its JSON for a block with no text). */
  hashes: string[];
  /** The harness's `cost-state` totals as read, for the sum invariant. */
  costState: CostState | null;
}

export interface CostState {
  /**
   * The line's `startTime` as an ISO timestamp: the harness process the totals cover began then, so a resumed session's earlier
   * lines are not in them. Null when the line has none.
   */
  since: string | null;
  input: number | null;
  cacheWrite: number | null;
  cacheRead: number | null;
  output: number | null;
  /** The model names in `modelUsage`, sorted: a model no assistant line names is a harness side call. */
  models: string[];
}

export interface Skeleton {
  /** CAPTURE_VERSION: the skeleton is written at capture. */
  v: string;
  session: string;
  project: string;
  /** SHA-256 Merkle root over the SHA-256 of every raw line (an odd node pairs with itself); the leaves are not stored. */
  merkleRoot: string;
  leaves: number;
  lines: SkeletonLine[];
}

/** One MCP recall call, appended to `mcp-calls.jsonl` by the server itself. */
export interface RecallCall {
  at: string;
  query: string;
  matches: number;
}

/** One hook invocation, appended to `hook-calls.jsonl` by the hook itself; `measure` counts these per session. */
export interface HookCall {
  at: string;
  event: 'session-start' | 'post-tool' | 'stop' | 'nightly';
  /** The Claude Code session the hook ran in; null for the nightly run. */
  session: string | null;
  /** Whether the hook had something to say (an injected block, a recall hit, or a session deposited). */
  hit: boolean;
  ms: number;
  /** The failure's first line when the hook failed (it still exits 0); null when it ran clean. */
  error: string | null;
}
