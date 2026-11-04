// The session store's schema, in one file (t689 and t700, T0 of docs/research/2026-11-01-session-commons-direction.md).
//
// Everything here is deterministic and local: no model call, no network. `oars sessions deposit` reads the operator's own Claude Code
// logs (`~/.claude/projects/<path-slug>/*.jsonl` and each session's `subagents/` transcripts, one JSON event per line) and appends
// captured records to `<config>/oars/sessions/observations.jsonl`. The log is appended to, and a whole-store deposit drops superseded revs (`compactLog` in `store.ts`): a session whose file changed is deposited
// again under a higher `rev`, and a reader keeps only the highest `rev` of each session.
//
// Version 10 (CAPTURE 10, t768) gives a turn opened by a slash command or a skill a `user-prompt` record, adds `opened` to that record, and moves `skills`
// from class P to class A, since a skill's name can be private. It changed no derivation, so it leaves EXTRACTOR at 9.
//
// Version 11 (CAPTURE 11) redacts the part of an MCP tool name after `mcp__` (Cursor: `mcp_`) wherever it is stored (`tool`, the session's `tools`, an error line's `tool`, the skeleton's tool names),
// reads package-manager and shell forms more exactly (so `pulls`, `segments`, `commits`, and each tool's `steps` change), and opens a typed prompt from a line that only starts with an injected tag's name without closing it.
// EXTRACTOR 10 reads more command forms as a run or a verify (package runners, `unittest`, installs that are not runs, a leading word before a name); no capture record changes.
//
// EXTRACTOR 9 adds motifs, cells, and reads, computed from the capture records and written beside them (`docs/sessions-store.md`), and carries a prompt's
// frame onto its derived record. No capture record changes.
//
// Version 9 (CAPTURE 9, t755) adds `frame` and `frameId` to the session and prompt records and `steps` to the tool record, and moves `tool`, `tools`, and a
// shell-form `target` from class P to class A. It changed no derivation, so it left EXTRACTOR at 8.
//
// Version 8 (CAPTURE 8 and EXTRACTOR 8) writes one `tool` record per tool call. The harness writes
// `api-request-blob` lines, copies of the request body with no cwd, uuid, or timestamp, and capture used to read their blocks as conversation: a second
// record with status `none` (and, with no cwd, another path hash) for 99.8% of calls, plus a second error line, thinking count, and TLDR. Those lines are
// no longer read, and a call a resumed transcript replays under one tool-use id is written once. The skeleton still lists every line. The reader folds
// records already on disk the same way until each transcript is captured again (`fold.ts`).
//
// Store version 5 (CAPTURE 5, t733) keeps version 4's shape and changes one stored value: each `models` entry of the skeleton's cost state names
// the usage keys it reported, which `verify` uses to class a side call. A version-4 skeleton reads with no keys until it is captured again.
//
// Store version 4 (CAPTURE 4, t714) keeps version 3's shape and adds to it: `sid` on every capture record, `repo`, `fileHashes`, and `env` on
// the session, `targetBase` on the tool record, `promptFingerprint` in place of `contextFingerprint`, and a 1,000-character cap on an
// error-line's `line`. A version-3 store is read through the compatibility reader (`upgradeSession` and its siblings in store.ts) until each transcript is captured again.
//
// Store version 3 (register A28) splits capture from derivation. Capture writes four record kinds, each stamped `cv` with
// CAPTURE_VERSION: `session` (one per transcript), `user-prompt` (one per prompt), `tool` (one per tool call), and `error-line` (one per
// failed tool result, keyed by `toolUseId`). Derivation (`derive.ts`: signatures, prompt classes, tool-name sequences, recovery pairs,
// and recovery episodes) runs over those records alone, never over raw, and stamps its output `v` with EXTRACTOR_VERSION, so a change to
// a derivation rule re-derives the store without reading a transcript. Version-2 `prompt` and `error` lines (already derived) are still
// read for a session that has no version-3 rev.
//
// Field classes (t711 Section 1.1): `L` local-only, never leaves the machine at any tier; `A` account store, the account's own store only;
// `P` pooled index, names, versions, counts, and day-resolution dates. The session, prompt, tool, error, and error-line records name
// each field's class in a doc comment; the skeleton and the two call logs carry theirs on the type, and docs/sessions-store.md lists
// them all. The log is the local derived-records tier: redacted text, never raw content, and nothing uploads.
//
// The text kept, each redacted first and then cut: the first 300 characters of a prompt, the first informative line of a tool error (cut
// to 1,000 characters in the `error-line` record, 160 characters in a derived example), TLDR lines (400), Confidence lines (120), and,
// with no length limit, WebSearch queries, fetched URLs, file paths, and git branch names. Also kept as written, not redacted: the
// project folder slug (it holds the username and directory names; the log stays local), skill names, effort values, model names,
// harness versions, and tool names (including MCP server names). `redact` masks secrets by pattern and entropy, emails, and the
// organization domains the operator names. The skeleton holds hashes only.

import type { CanonicalAction } from './actions.js';
import type { RepoSize } from './public-vocabulary.js';

/** Stamped `cv` on every captured record. Bump it when the captured field list changes or a stored value of an existing captured record or skeleton changes: a bump re-reads every transcript. */
export const CAPTURE_VERSION = '11';

/** Capture versions the reader derives from. A version-3 record is upgraded on read; a newer one is read for the fields this code knows. */
export const OLDEST_READABLE_CAPTURE = 3;

/** Stamped `v` on every derived record. A bump re-derives from the log; no transcript is read. */
export const EXTRACTOR_VERSION = '10';

export const PROMPT_HEAD_CHARS = 300;
export const ERROR_EXAMPLE_CHARS = 160;
/** The reference scripts cut a normalized signature at 110 characters. */
export const SIGNATURE_CHARS = 110;
/** An error-line's `line` is redacted, then cut to this many characters (t711 Section 1.2; version 3 stored it uncut). */
export const ERROR_LINE_CHARS = 1000;
/** Per-session cap on `files` and `fileHashes` (L3): the hand run on the copy store had p99 61 and max 209 files per session; 100 is the round number above p99. */
export const FILES_PER_SESSION_MAX = 100;

export const PROMPT_CLASSES = ['no-tools', 'orchestration', 'research', 'edit-verify', 'edit-only', 'explore-only', 'shell-only', 'mixed'] as const;
export type PromptClass = (typeof PROMPT_CLASSES)[number];

export interface Usage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  thinking: number;
}

export type Harness = 'claude-code' | 'cursor' | 'codex' | 'copilot' | 'grok';

/** The harness a session record came from; a record that does not name one is Claude Code's. */
export const harnessOf = (session: { harness?: Harness }): Harness => session.harness ?? 'claude-code';

/** Where a path target is hashed from (class P): the repository root, or the line's working directory when no repository holds the path. */
export type TargetBase = 'repo' | 'cwd';

/** The closed vocabulary of a repository: languages, framework names, and a size bucket (D13). Class P. */
export interface FrameStack {
  languages: string[];
  frameworks: string[];
  size: RepoSize | null;
}

/**
 * Where and when something ran (recall spec Section 2.1): the coordinate every comparison uses. Class P: every field is a public name, a
 * UTC day, or null, and it is never served below the cell floor, because a set of tools can fingerprint an account. Its `shell` and `stack`
 * belong to the file at this `rev`, so capturing a transcript that has grown can change the `frameId` of its earlier prompts.
 */
export interface Frame {
  harness: Harness;
  /** The version the prompt's own lines name, else the transcript's last. */
  harnessVersion: string | null;
  /** The prompt's majority model. */
  model: string | null;
  /** The prompt's majority effort. */
  effort: string | null;
  /** The UTC day of the prompt (D1 pools `ts` at a UTC day); the first timestamp of the file on a session's own frame. */
  day: string | null;
  /** `process.platform` of the capturing machine. */
  platform: string;
  /** The file's majority shell tool; null when it ran none, or when the harness does not name its shell. */
  shell: string | null;
  stack: FrameStack;
}

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
 * `L` local-only: `project`, `files`. `A` account store: `session`, `parent`, `spawnedBy`, `spawnedIn`, `branches`, `urls`, `searches`, `tldrs`,
 * `confidences`, `promptFingerprint`, `repo`, `fileHashes`, `tools`, `at`, `tsFirst`, `tsLast`. `P` pooled: `kind`, `cv`, `rev`, `sid`,
 * `agentType`, the counts, `versions`, `models`, `env`, `costUsd`, `usage`, `frame`, `frameId` (`at`, `tsFirst`, and `tsLast` at UTC day).
 */
export interface SessionObservation {
  kind: 'session';
  /**
   * The tool the transcript came from (t728, class P). Only a non-default source writes it: absent reads as `claude-code` (`harnessOf`), so
   * the Claude Code path's records and CAPTURE_VERSION are unchanged and an older oars reads a Cursor session as a session with no harness version.
   */
  harness?: Harness;
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
  /** The transcript holding that call, so `parent` and `spawned` on this transcript's steps have an address: the main session or a sibling subagent's id; null when not known. */
  spawnedIn: string | null;
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
  /** Class A: the salted hash of the repository identity (normalized `origin` remote, else the root path) the transcript's working directory sits in; null when none holds it. */
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
  /** The frame of a call before the file's first prompt; absent on a record captured before this field existed. Class P. */
  frame?: Frame;
  /** The hash of `frame`. Class P. */
  frameId?: string;
  /** The harness's own `cost-state` totals when the file has one. */
  costUsd: number | null;
  /** Summed assistant usage of the file's own line (a main transcript's sidechain lines are not counted; a subagent transcript is its own line). */
  usage: Usage;
}

/**
 * What the last build or test runner after a prompt's last edit returned: `passed` and `failed` when the call's status reads that runner,
 * `masked` when a pipe or a later command hides its exit, `none` when no runner ran or its call has no result, `na` when the prompt edited nothing.
 */
export type PromptVerify = 'passed' | 'failed' | 'masked' | 'none' | 'na';

/** How the operator cut a prompt short: Esc or a new message (`interrupt`), or declining a tool call (`rejected`). */
export type PromptStop = 'interrupt' | 'rejected';

/**
 * One per user prompt: the `prompt_graphs.py` and `cost_per_class.py` records joined. Derived. Classes: `session`,
 * `contextFingerprint`, `head`, `ts`, `skills`, `verify`, `stopped`, `commits`, and `redo` (A); `kind`, `v`, `rev`, `index`, `wallSec`, `cls`, `tools`,
 * `shape`, `errors`, `thinking`, `sideTools`, `turns`, `model`, `efforts`, `usage`, `recovery`, `explore`, `act`, and `bigrams` (P).
 */
export interface PromptObservation {
  kind: 'prompt';
  /** Where and when the prompt ran, from its capture record; absent on a record captured before frames existed. Class P. */
  frame?: Frame;
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
  /** The session's prompt fingerprint at the time of the prompt (kept under this name on the derived record), when one had been seen. */
  contextFingerprint: string | null;
  // The outcome signals (t747), kept separate on purpose: no composite. Optional because a version-2 line, read as written, predates them.
  /** Exit status of a build or test runner, not its coverage. Undefined when a shell call after the edit was captured before `segments` (CAPTURE 6), which cannot say what ran. */
  verify?: PromptVerify;
  stopped?: PromptStop | null;
  /** Commits the prompt's shell calls made, from the captured `commits`. A record captured before CAPTURE 6 counts only a first-line `git commit`. */
  commits?: number;
  /** A later prompt edited a path this one edited, within `REDO_WINDOW` prompts, with no commit `commits` can see between them. */
  redo?: boolean;
}

/**
 * One per tool error: the `error_signatures.py` record. Derived. Classes: `session`, `agent`, `ts`, `sig`, `example` (A); `kind`, `v`,
 * `rev`, `tool`, `harnessVersion`, `editFollowed`, `next`, `prompt`, `cls` (P).
 */
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
  /** The call this result answers, class A (a join id): an uncaptured store keeps a replayed result's line beside the first, so one call is one id. Absent on a version-2 deposit. */
  toolUseId?: string | null;
  /** The next two tool calls after the error (any line, in file order). */
  next: string[];
  /** Whether an Edit, Write, or MultiEdit came within six tool calls. */
  editFollowed: boolean;
  /** The prompt this error happened in (null before the first prompt) and its class. */
  prompt: number | null;
  cls: PromptClass | null;
  /**
   * Set when a subagent made the call: its transcript (`<parent>~agent-x`), class A (a join id). `session` is then the main session that spawned
   * it, and `prompt` and `cls` are the spawning prompt's.
   */
  agent?: string;
}

export type ToolStatus = 'ok' | 'error' | 'none';

/** A package a shell step pulled, in public names (`<literal>` outside the allowlist). */
export interface PullIdentity {
  registry: string;
  name: string;
  /** Null when the command stated none. */
  version: string | null;
}

/** A shell step: its program, subcommand, and flag names, sorted and single. Never a flag's value. */
export interface ShellIdentity {
  program: string;
  sub: string | null;
  flags: string[];
  /** Absent when the command pulled nothing. */
  pulls?: PullIdentity[];
}

export type StepIdentity = ShellIdentity | { server: string; tool: string } | { skill: string } | { host: string | null } | null;

export interface StepCost {
  /** The output tokens of the call's response, shared evenly among that response's calls; null when it reported none. */
  tokens: number | null;
  durationMs: number | null;
}

/**
 * How a step came about (recall spec Section 2.3), naming the step it came from by position. `next`: order within a prompt's line of work.
 * `spawned`: the call that started this subagent, in the transcript its session record names as `spawnedIn`. `retried`: the same native name and the same redacted command or target, after that one failed.
 * `after-error`: the call before this one failed.
 */
export interface StepEdge {
  kind: 'next' | 'spawned' | 'retried' | 'after-error';
  n: number;
  seg: number;
}

/** One observed event in the canonical vocabulary of any harness (recall spec Section 2.2). Class P: it holds only positions, public names, and a frame hash. */
export interface StepObservation {
  /** The `n` of the tool call this step came from. */
  n: number;
  /** Its position among that call's steps, from 0. */
  seg: number;
  action: CanonicalAction;
  /** The harness's own name for the tool when the action table lists it or every name it holds is public, else `<literal>` (the tool record keeps it, class A). */
  native: string;
  /** What the step acted on, in public names only; null for an action that has none (a file's path never appears here). */
  identity: StepIdentity;
  /** The call's status when it reports this segment; `none` for a segment it does not, such as one a pipe hides. */
  status: ToolStatus;
  /** Held on the first segment of a call; a later segment has nulls. */
  cost: StepCost;
  /** On a subagent's step, the `n` of the call that spawned it, in the transcript its session record names as `spawnedIn`; null otherwise or when that call is not known. */
  parent: number | null;
  /** The edges that arrive at this step. */
  edges: StepEdge[];
  /** The frame of the call's prompt, or the session's own frame before the first prompt. */
  frameId: string;
}

/**
 * One per tool call (register A28), captured. Classes: `A` account store: `session`, `parent`, `toolUseId`, `ts`, `tool`, and `target`
 * in either form (a salted hash, or a program and subcommand); `P` pooled: `kind`, `cv`, `sid`, `rev`, `agentType`, `n`, `status`, `keys`,
 * `durationMs`, `harnessVersion`, `side`, `prompt`, `targetBase`, and `steps`. `tool` and a shell-form `target` moved to `A` at CAPTURE 9: an MCP
 * tool name holds a private server's name and a shell word can be anything, and `steps` carries the public reading of both. `segments`, `pulls`,
 * and `commits` are `A`: a plain word, a private package name, and a sha can each identify private work.
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
  /** What the call was in the canonical vocabulary; absent on a record captured before this field existed. Class P. */
  steps?: StepObservation[];
  /** Each command of a shell call, in order (CAPTURE 6); on every shell call and no other. Absent on a record captured earlier. */
  segments?: ShellSegment[];
  /** What the call pulled (CAPTURE 6). Absent when it pulled nothing. */
  pulls?: ToolPull[];
  /** One entry per commit a clean shell call made, in order: the sha its result names, or null when it names none (CAPTURE 6). Absent when it made none. */
  commits?: Array<string | null>;
}

/** One command of a shell call. */
export interface ShellSegment {
  /** The program's basename and its plain words: no flags, paths, variables, or quoted text; redacted. */
  run: string;
  /** Whether the call's status reports this command: false when a pipe follows it, a later `;`, `&`, newline, or `||` overrides it, or it runs in the background. */
  read: boolean;
}

export type PullEcosystem = 'npm' | 'pypi' | 'cargo' | 'go' | 'gem' | 'brew' | 'skill' | 'plugin' | 'mcp';

/** One package, MCP server, plugin, or skill a call names as pulled. No registry is asked, so the name is what the command says, redacted. */
export interface ToolPull {
  ecosystem: PullEcosystem;
  name: string;
  /** The version as stated, with its comparator unless that is `==`; null when none is stated. */
  version: string | null;
}

/** One per failed tool result, captured and keyed by `toolUseId`. Classes: `A` account store: `session`, `toolUseId`, `tool`, `line`
 * (switchable text), `ts`; `P` pooled: `kind`, `cv`, `sid`, `rev`, `harnessVersion`, `side`, `prompt`, `after`. */
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

/** How a prompt opened: `typed`, the operator's own line, or `command`, a slash command or a skill. Closed: it never names the command. Class P. */
export type PromptOpened = 'typed' | 'command';

/**
 * One per user prompt, captured: what the transcript says about a prompt besides its tool calls. Classes: `A` account store: `session`, `head` (switchable text),
 * `ts`, `promptFingerprint`, `skills` (a skill's name can be private); `P` pooled: `kind`, `cv`, `sid`, `rev`, `index`, `wallSec`, `thinking`, `turns`, `model`, `efforts`, `usage`, `opened`. Derive joins it with the prompt's tool calls and errors into a {@link PromptObservation}.
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
  /** Absent on a record captured before CAPTURE 10, when only a typed line opened a prompt. */
  opened?: PromptOpened;
  thinking: number;
  turns: number;
  model: string;
  efforts: string[];
  skills: string[];
  usage: Usage;
  /** Class A: the session's prompt fingerprint at the time of the prompt, when one had been seen. */
  promptFingerprint: string | null;
  /** Where and when this prompt ran; absent on a record captured before this field existed. Class P. */
  frame?: Frame;
  /** The hash of `frame` (`frameIdOf`). Class P. */
  frameId?: string;
}

export type CaptureRecord = SessionObservation | UserPromptObservation | ToolObservation | ErrorLineObservation;

/** What a reader finds in the log: version-3 or later capture records, or the version-2 derived lines of a session not deposited since. */
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

/** One per line of a session file: ids and structure, with a SHA-256 in place of every content field. Class A (a pool would hold only the skeleton's `merkleRoot` and `leaves`). */
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
  /**
   * The models in `modelUsage`, sorted by name, each with the usage keys its entry reported a nonzero amount on: a model no assistant line names
   * is a harness side call, and only on a key it reported a nonzero amount on. A skeleton written before the keys were recorded reads with `[]`.
   */
  models: CostModel[];
}

/** One `modelUsage` entry: the model's name and which of the four usage keys it reported a nonzero amount on (the transcript writes zeros for the rest). */
export interface CostModel {
  model: string;
  keys: UsageKey[];
}

export type UsageKey = 'input' | 'cacheWrite' | 'cacheRead' | 'output';

/** The per-session skeleton in `skeletons/<session>.json`. `lines` is class A; a pool would hold only `merkleRoot` and `leaves`. */
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

/** One MCP recall call, appended to `mcp-calls.jsonl` by the server itself. Class A: `query` and `at`; L: `cwd`; P: `matches`. */
export interface RecallCall {
  at: string;
  query: string;
  matches: number;
  /** Class L: the server's working directory, unhashed; `measure --repo` scopes calls by it. Calls written before it existed have none and count for every repository. */
  cwd?: string;
}

/** One hook invocation, appended to `hook-calls.jsonl` by the hook itself; `measure` counts these per session. Class A: `session`, `at`, `error`; P: `event`, `hit`, `ms`, `startMs`. */
export interface HookCall {
  at: string;
  event: 'session-start' | 'pre-tool' | 'post-tool' | 'stop' | 'nightly';
  /** The Claude Code session the hook ran in; null for the nightly run. */
  session: string | null;
  /** Whether the hook had something to say (an injected block, a recall hit, or a session deposited). */
  hit: boolean;
  /** In-process work: from the start of `runHook` to the row. */
  ms: number;
  /** The process time before `runHook` began (node start, module load, and the stdin read); `startMs + ms` is the field figure. Calls written before it existed have none. */
  startMs?: number;
  /** The failure's first informative line, redacted and cut to 300 characters, when the hook failed (it still exits 0); null when it ran clean. */
  error: string | null;
}

/** The pipeline steps the log names (runtime-commons pipeline spec 3.1); `label` is the local labeler step (A5) that no command runs yet; `index` is the hook-index write the nightly and manual runs log. */
export const STEPS = ['deposit', 'verify', 'derive', 'label', 'index', 'recall', 'read'] as const;
export type Step = (typeof STEPS)[number];

/** The trigger names of spec 4.1 (the ones nothing local starts are in the schema only: `weekly` (A21) and the hosted `sync`, `cron`, `release`, `run-end`, and `run-start`). The SessionEnd hook is `stop`, never `session-end`. */
export const TRIGGERS = ['session-start', 'pre-tool', 'post-tool', 'stop', 'nightly', 'manual', 'weekly', 'sync', 'cron', 'release', 'run-end', 'run-start'] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const STEP_STATUSES = ['ok', 'error', 'skipped'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** Counts by record kind or type (`{"session": 1, "tool": 212}`). */
export interface StepCounts {
  [kind: string]: number;
}

/**
 * One run of one pipeline step, appended to `pipeline-runs.jsonl` when the step ends (spec 3.1). A store-level file beside
 * `hook-calls.jsonl`, so it carries no capture `cv` of its own. Classes: `A` account store: `run`, `key`, `error`, `at` (a pool would
 * keep the UTC day); `P` pooled: `trigger`, `step`, `status`, `ms`, `in`, `out`, `cv`, `ev`, `lv`.
 */
export interface StepRow {
  at: string;
  /** A local run id; the steps of one nightly run share it. */
  run: string;
  trigger: Trigger;
  step: Step;
  status: StepStatus;
  ms: number;
  in: StepCounts;
  out: StepCounts;
  /** The CAPTURE_VERSION and EXTRACTOR_VERSION the step ran at. */
  cv: string;
  ev: string;
  /** The labeler stamp, on `label` rows only. */
  lv?: string;
  /** The step's idempotency key (spec 4.2), a hash, so a repeat is visible; null when the step was skipped before it had one. */
  key: string | null;
  /** The first informative line of the failure, redacted; null when `ok`. */
  error: string | null;
}

const isObject = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

const countsOf = (value: unknown): StepCounts | undefined => {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, count]) => typeof count === 'number' && Number.isFinite(count)) ? Object.fromEntries(entries.map(([kind, count]) => [kind, Number(count)])) : undefined;
};

const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((entry) => entry === value);

/** Reads one line of `pipeline-runs.jsonl`; undefined when any key is missing or mistyped, so a torn or foreign line is never counted. */
export const parseStepRow = (value: unknown): StepRow | undefined => {
  if (!isObject(value)) return undefined;
  const trigger = oneOf(TRIGGERS, value.trigger);
  const step = oneOf(STEPS, value.step);
  const status = oneOf(STEP_STATUSES, value.status);
  const input = countsOf(value.in);
  const output = countsOf(value.out);
  if (trigger === undefined || step === undefined || status === undefined || input === undefined || output === undefined) return undefined;
  const { at, run, ms, cv, ev, lv, key, error } = value;
  if (typeof at !== 'string' || typeof run !== 'string' || typeof ms !== 'number' || typeof cv !== 'string' || typeof ev !== 'string') return undefined;
  if (!(key === null || typeof key === 'string') || !(error === null || typeof error === 'string')) return undefined;
  // `lv` is the labeler stamp: spec 3.1 puts it on `label` rows only.
  if (lv !== undefined && (typeof lv !== 'string' || step !== 'label')) return undefined;
  if (step === 'label' && lv === undefined) return undefined;
  // Spec 3.1: `error` is null when the step is `ok`.
  if (status === 'ok' && error !== null) return undefined;
  return { at, run, trigger, step, status, ms, in: input, out: output, cv, ev, ...(lv === undefined ? {} : { lv }), key, error };
};
