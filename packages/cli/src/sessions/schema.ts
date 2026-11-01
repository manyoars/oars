// The session store's schema, in one file (t689, T0 of docs/research/2026-11-01-session-commons-direction.md).
//
// Everything here is deterministic and local: no model call, no network. `oars sessions deposit` reads the operator's own Claude Code
// logs (`~/.claude/projects/<path-slug>/*.jsonl`, one JSON event per line) and appends observations to
// `<config>/oars/sessions/observations.jsonl`. The log is append-only: a session whose file changed is deposited again under a higher
// `rev`, and a reader keeps only the highest `rev` of each session. `derived.json` and `skeletons/<session>.json` sit beside it.
//
// The log is the local derived-records tier: redacted text, never raw content, and nothing uploads. The text it keeps, each redacted
// first and then cut: the first 300 characters of a prompt, the first informative line of a tool error (160), TLDR lines (400),
// Confidence lines (120), and, with no length limit, WebSearch queries, fetched URLs, file paths, and git branch names. Also kept as
// written, not redacted: the project folder slug (it holds the username and directory names; the log stays local), skill names, effort
// values, model names, harness versions, and tool names (including MCP server names). `redact` masks secrets by pattern and
// entropy, emails, and the organization domains the operator names. The skeleton holds hashes only. Subagent transcripts
// (`<project>/<session>/subagents/`) are not deposited yet.

/** Stamped on every observation, derived record, and skeleton, so a later extractor can tell what produced it. */
export const EXTRACTOR_VERSION = '2';

export const PROMPT_HEAD_CHARS = 300;
export const ERROR_EXAMPLE_CHARS = 160;
/** The reference scripts cut a normalized signature at 110 characters. */
export const SIGNATURE_CHARS = 110;

export type PromptClass = 'no-tools' | 'orchestration' | 'research' | 'edit-verify' | 'edit-only' | 'explore-only' | 'shell-only' | 'mixed';

export interface Usage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  thinking: number;
}

/** One per session file: the `parse_sessions.py` record, minus anything that is raw content. */
export interface SessionObservation {
  kind: 'session';
  v: string;
  session: string;
  project: string;
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
  files: string[];
  urls: string[];
  searches: string[];
  bashCmds: number;
  tldrs: string[];
  confidences: string[];
  compactSummaries: number;
  /** Fingerprint of the `prompt_snapshot` and `environment` attachments when present, else null. */
  contextFingerprint: string | null;
  /** The harness's own `cost-state` totals when the file has one. */
  costUsd: number | null;
  /** Summed assistant usage of the main line (sidechain lines are separate files' business). */
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
}

export type Observation = SessionObservation | PromptObservation | ErrorObservation;

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
  input: number | null;
  cacheWrite: number | null;
  cacheRead: number | null;
  output: number | null;
}

export interface Skeleton {
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
}
