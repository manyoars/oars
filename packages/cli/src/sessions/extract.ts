// Capture: turns one transcript's text into its capture records and a skeleton in a single pass (derivation is `derive.ts`). The
// parsing rules are ported from the reference scripts in docs/research/2026-11-01-session-commons/ (parse_sessions.py, error_signatures.py, prompt_graphs.py,
// cost_per_class.py) so the counts agree: same normalization and class rule (prompt boundaries differ from the scripts: see `promptOpening`). Where two scripts
// read a thing differently the comment says which rule is used.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { ACTION_TABLES, actionOf, shellOf, type ActionTable, type CanonicalAction } from './actions.js';
import { exploreCount, strataOf } from './strata.js';
import { closedFrame, frameIdOf, repoFilesFromIndex, repoSizeOf, stackOf, utcDay } from './frame.js';
import { argClassOf, argFeaturesOf, argNamesOf, argValuesOf, changeKindOf, targetClassOf, variableOf, type CommandWords, type ComparedCall } from './call-shape.js';
import { CLOSED_ARG_VALUES, LITERAL, type RepoSize } from './public-vocabulary.js';
import { linkSteps } from './graph.js';
import { callIdentity, shellIdentity, UNREAD_SHELL, type WordOfCommand } from './identity.js';
import type { Redactor } from './redact.js';
import { manifestDelta, manifestFileOf, manifestNames, packagesOf, type ManifestFile } from './package-resolve.js';
import { createShape, DECLINED_RE, INTERRUPT_MARKER } from './session-shape.js';
import {
  CAPTURE_VERSION,
  ERROR_LINE_CHARS,
  FILES_PER_SESSION_MAX,
  type HARNESS_ERROR_CLASSES,
  HTTP_STATUSES,
  PROMPT_HEAD_CHARS,
  SIGNATURE_CHARS,
  type CostState,
  type ErrorLineObservation,
  type Frame,
  type Harness,
  type PromptClass,
  type PromptOpened,
  type PullEcosystem,
  type SessionObservation,
  type ShellIdentity,
  type ShellSegment,
  type Skeleton,
  type SkeletonLine,
  type StepIdentity,
  type TargetBase,
  type ToolManifest,
  type ToolObservation,
  type ToolPull,
  USAGE_FIELDS,
  type MessageUsage,
  type PlanWindow,
  type Usage,
  type UsageField,
  type UsageKey,
  type UserPromptObservation,
} from './schema.js';

export interface Obj {
  [key: string]: unknown;
}

export const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** Python slices by code point; JavaScript by UTF-16 unit. */
export const cut = (text: string, length: number): string => Array.from(text).slice(0, length).join('');

/** Python truthiness of a JSON value. */
const truthy = (value: unknown): boolean => value !== undefined && value !== null && value !== false && value !== 0 && value !== '';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export const EXPLORE = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch', 'LSP']);
export const ACT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']);
const COORD = new Set(['Agent', 'SendMessage', 'Monitor', 'TaskStop', 'Skill', 'ScheduleWakeup', 'ListAgents', 'Workflow']);
export const EDITS = new Set(['Edit', 'Write', 'MultiEdit']);
export const SHELL = new Set(['Bash', 'PowerShell']);
const PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const TLDR_RE = /^\s*\**\s*(?:TL;?DR|TLDR)\s*:?\**\s*:?\s*(.+?)\s*$/gim;
const CONF_RE = /^\s*\**\s*Confidence\s*:?\**\s*:?\s*(.+?)\s*$/gim;
const EXIT_RE = /^Exit code (\d+)/;

// error_signatures.py NORM, in order. Divergence: JS `\d`, `\s`, `\b`, and `trim()` are ASCII/ECMAScript-defined while Python's `re` and
// `str.strip()` are Unicode-aware, so a signature with non-ASCII digits or separators normalizes differently from the script.
// The reference corpus has none; the divergence is accepted, not matched.
const NORM: ReadonlyArray<readonly [RegExp, string]> = [
  [/[A-Za-z]:\\[^\s'"]+|\/[^\s'"]+/g, '<path>'],
  [/\b[0-9a-f]{7,}\b/g, '<hex>'],
  [/\d+/g, '<n>'],
  [/'[^']*'|"[^"]*"/g, '<q>'],
  [/\s+/g, ' '],
];

/** The normalized form of one line: paths, hex, numbers, and quoted strings replaced, cut at 110 characters. */
export const normalize = (line: string): string => {
  let out = line.trim();
  for (const [pattern, replacement] of NORM) out = out.replace(pattern, replacement);
  return cut(out, SIGNATURE_CHARS);
};

const LINE_BREAK = new RegExp(['\\r\\n', '[\\n\\r\\v\\f\\x1c-\\x1e\\x85\\u2028\\u2029]'].join('|'));
const splitLines = (text: string): string[] => {
  const lines = text.split(LINE_BREAK);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** The first informative line of a tool result: skips blanks, markup lines, "Only you see", and the `Exit code` line. */
export const firstInformative = (text: string): string => {
  const lines = splitLines(text);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('<') || trimmed.toLowerCase().startsWith('only you see')) continue;
    if (EXIT_RE.test(trimmed)) continue;
    return trimmed;
  }
  const whole = text.trim();
  return whole === '' ? '' : (splitLines(whole)[0] ?? '');
};

/**
 * The key an error is matched on, by deposit and by recall alike: redact, take the first informative line, normalize, redact again. Redacting
 * first keeps a secret or an email whole before normalize turns its digits into `<n>`; the second pass catches what only the cut form shows.
 */
export const errorKey = (text: string, redact: Redactor): string => redact(normalize(redact(firstInformative(text))));

/** The signature of an error: `<tool> | <errorKey>`. */
export const signatureOf = (tool: string, text: string, redact: Redactor): string => `${tool} | ${errorKey(text, redact)}`;

export const resultText = (block: Obj): string => {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is Obj => isObj(part) && part.type === 'text')
      .map((part) => str(part.text) ?? '')
      .join('\n');
  }
  return '';
};

export const isErrorResult = (block: Obj, text: string): boolean => {
  if (truthy(block.is_error)) return true;
  const exit = EXIT_RE.exec(text.trim());
  return exit !== null && exit[1] !== '0';
};

/** What an Edit, MultiEdit, or Write shows of a manifest: the names it adds and removes (an edit), or lists (a write). Undefined when it shows none. */
const manifestOfInput = (file: ManifestFile, tool: string, input: Obj, redact: Redactor): ToolManifest | undefined => {
  if (tool === 'Write') {
    const seen = manifestNames(file, str(input.content) ?? '', redact);
    return seen.length === 0 ? undefined : { file, seen, added: [], removed: [] };
  }
  const edits = tool === 'MultiEdit' && Array.isArray(input.edits) ? input.edits.filter(isObj) : tool === 'Edit' ? [input] : [];
  const { added, removed } = manifestDelta(file, edits.map((edit) => str(edit.old_string) ?? '').join('\n'), edits.map((edit) => str(edit.new_string) ?? '').join('\n'), redact);
  return added.length === 0 && removed.length === 0 ? undefined : { file, seen: [], added, removed };
};

const EXIT_CODE_RE = /^Exit code:? (-?\d+)/;
/** The harness's own refusals, most specific first: each names a class, and the match never leaves this table (the text is not kept). */
const HARNESS_ERROR_PATTERNS: ReadonlyArray<readonly [RegExp, (typeof HARNESS_ERROR_CLASSES)[number]]> = [
  [/^\[Request interrupted by user/, 'interrupted'],
  // Claude Code's text, then the refusal sentences Codex (`rejected by user`, written by its adapter and by events.rs:456) and Gemini (an abort `User cancelled tool execution`; a confirmation-prompt denial `Reason: User denied execution.`, `User cancelled operation`, or `Operation cancelled by user`) write.
  // The Codex and Gemini alternatives are `DECLINED_RE`'s own source, so the error code and the `user-stop` bucket read one pattern.
  [new RegExp(`The user doesn't want to proceed with this tool use|The tool use was rejected|${DECLINED_RE.source}`), 'user-rejected'],
  [/Permission to use [^\n]* has been denied/, 'permission-denied'],
  [/InputValidationError/, 'input-validation'],
  [/<tool_use_error>/, 'tool-use-error'],
  [/\btimed out\b/i, 'timeout'],
];
const HTTP_STATUS_RE = /(?:status(?: code)?|HTTP\/?[\d.]*|returned error:?)\s*:?\s*([1-5]\d\d)\b/i;

const exitClass = (code: number): string => {
  if (code === 0 || code === 1 || code === 2 || code === 126 || code === 127) return String(code);
  // 128 + n for the signals n = 1 to 64 a shell reports; 255 is the usual spawn or ssh failure and stays `other`.
  return code > 128 && code <= 192 ? 'signal' : 'other';
};

/**
 * The `errorCode` of a failed result (spec Section 1.2): an exit-code class from a leading `Exit code N` line, else the harness error class its text
 * names, else an HTTP status, else `other`. The result is always a member of `ERROR_CODES`, picked by a table, so no word of the error text is kept. A
 * harness that reports no exit code (a Cursor non-shell call, a Codex call with no status) reaches `other` unless its text names a class.
 */
export const errorCodeOf = (text: string): string => {
  const exit = EXIT_CODE_RE.exec(text.trim());
  if (exit !== null) return exitClass(Number(exit[1]));
  const harness = HARNESS_ERROR_PATTERNS.find(([pattern]) => pattern.test(text));
  if (harness !== undefined) return harness[1];
  const status = HTTP_STATUS_RE.exec(text)?.[1];
  return HTTP_STATUSES.find((listed) => listed === status) ?? 'other';
};

export const shortName = (name: string): string => {
  if (name.startsWith('mcp__claude-in-chrome__')) return 'chrome';
  if (name.startsWith('mcp__')) return `mcp:${(name.split('__')[1] ?? '').slice(0, 10)}`;
  return name;
};

export const compress = (sequence: readonly string[]): string => {
  const runs: Array<[string, number]> = [];
  for (const tool of sequence) {
    const last = runs[runs.length - 1];
    if (last?.[0] === tool) last[1] += 1;
    else runs.push([tool, 1]);
  }
  return runs.map(([tool, count]) => (count > 1 ? `${tool}x${String(count)}` : tool)).join('>');
};

/** The prompt class rule shared by prompt_graphs.py and cost_per_class.py. */
export const classify = (sequence: readonly string[]): PromptClass => {
  if (sequence.length === 0) return 'no-tools';
  const set = new Set(sequence);
  const web = sequence.filter((tool) => tool === 'WebFetch' || tool === 'WebSearch').length;
  const coord = sequence.filter((tool) => COORD.has(tool)).length;
  if (coord >= 2) return 'orchestration';
  if (web >= 2) return 'research';
  if ([...set].some((tool) => EDITS.has(tool))) {
    let seen = false;
    for (const tool of sequence) {
      if (EDITS.has(tool)) seen = true;
      else if (seen && SHELL.has(tool)) return 'edit-verify';
    }
    return 'edit-only';
  }
  if ([...set].every((tool) => EXPLORE.has(tool))) return 'explore-only';
  if ([...set].every((tool) => SHELL.has(tool))) return 'shell-only';
  return 'mixed';
};

export const emptyUsage = (): Usage => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 });

/** Register A22: one API response spans several assistant lines that repeat its usage, so each response counts once, keyed by request id then message id. */
const responseKey = (line: Obj, message: Obj): string | undefined => (str(line.requestId) || undefined) ?? (str(message.id) || undefined);

const addUsage = (total: Usage, line: Usage): void => {
  total.input += line.input;
  total.cacheWrite += line.cacheWrite;
  total.cacheRead += line.cacheRead;
  total.output += line.output;
  total.thinking += line.thinking;
};

interface LineUsage {
  usage: Usage;
  hasThinking: boolean;
  /** The categories this line's source reported as numbers; the rest of `usage` is a placeholder zero. */
  observed: UsageField[];
}

/** What a running total rests on: the categories any counted response reported, and how many responses did. */
interface UsageCoverage {
  observed: Set<UsageField>;
  responses: number;
}

const emptyCoverage = (): UsageCoverage => ({ observed: new Set(), responses: 0 });

const addCoverage = (coverage: UsageCoverage, line: LineUsage): void => {
  coverage.responses += 1;
  for (const field of line.observed) coverage.observed.add(field);
};

/** The record fields for a total: the observed categories in the fixed order, and the responses that reported. */
const coverageFields = (coverage: UsageCoverage): { usageObserved: UsageField[]; usageResponses: number } => ({
  usageObserved: USAGE_FIELDS.filter((field) => coverage.observed.has(field)),
  usageResponses: coverage.responses,
});

/** cost_per_class.py: only numeric fields count; thinking comes from `output_tokens_details`. */
const readUsage = (message: Obj): LineUsage | undefined => {
  const raw = message.usage;
  if (!isObj(raw)) return undefined;
  const details = isObj(raw.output_tokens_details) ? raw.output_tokens_details : {};
  const thinking = num(details.thinking_tokens);
  const input = num(raw.input_tokens);
  const cacheWrite = num(raw.cache_creation_input_tokens);
  const cacheRead = num(raw.cache_read_input_tokens);
  const output = num(raw.output_tokens);
  const reported: Array<[UsageField, number | undefined]> = [['input', input], ['cacheWrite', cacheWrite], ['cacheRead', cacheRead], ['output', output], ['thinking', thinking]];
  return {
    usage: { input: input ?? 0, cacheWrite: cacheWrite ?? 0, cacheRead: cacheRead ?? 0, output: output ?? 0, thinking: thinking ?? 0 },
    hasThinking: thinking !== undefined,
    observed: reported.filter(([, value]) => value !== undefined).map(([field]) => field),
  };
};

/** The usage categories a line reported, as the fields of a `MessageUsage`; a category the source left out is not written. */
const reportedUsage = (line: LineUsage): Pick<MessageUsage, 'input' | 'cacheWrite' | 'cacheRead' | 'output' | 'thinking'> => {
  const fields: Pick<MessageUsage, 'input' | 'cacheWrite' | 'cacheRead' | 'output' | 'thinking'> = {};
  for (const field of USAGE_FIELDS) if (line.observed.includes(field)) fields[field] = line.usage[field];
  return fields;
};

const planWindowOf = (raw: unknown): PlanWindow | undefined => {
  if (!isObj(raw)) return undefined;
  const usedPercent = num(raw.usedPercent);
  const windowMinutes = num(raw.windowMinutes);
  return usedPercent === undefined ? undefined : { usedPercent, ...(windowMinutes === undefined ? {} : { windowMinutes }) };
};

/** The plan share a Codex line carries (`rateLimits`, written by `rolloutLines`), or undefined when it carries none. */
const planOf = (line: Obj): MessageUsage['plan'] => {
  const limits = isObj(line.rateLimits) ? line.rateLimits : undefined;
  const primary = planWindowOf(limits?.primary);
  const secondary = planWindowOf(limits?.secondary);
  return primary === undefined && secondary === undefined ? undefined : { ...(primary === undefined ? {} : { primary }), ...(secondary === undefined ? {} : { secondary }) };
};

const toSeconds = (timestamp: string | undefined): number | undefined => {
  if (timestamp === undefined) return undefined;
  const millis = Date.parse(timestamp);
  return Number.isNaN(millis) ? undefined : millis / 1000;
};

/** A `cost-state` line's `startTime` (epoch milliseconds) as an ISO timestamp. */
const isoOfMillis = (value: unknown): string | null => {
  const millis = num(value);
  return millis === undefined || !Number.isFinite(new Date(millis).getTime()) ? null : new Date(millis).toISOString();
};

const sumModelUsage = (value: unknown, startTime: unknown): CostState | null => {
  if (!isObj(value)) return null;
  const names: ReadonlyArray<readonly [UsageKey, ...string[]]> = [
    ['input', 'inputTokens', 'input_tokens'],
    ['cacheWrite', 'cacheCreationInputTokens', 'cache_creation_input_tokens'],
    ['cacheRead', 'cacheReadInputTokens', 'cache_read_input_tokens'],
    ['output', 'outputTokens', 'output_tokens'],
  ];
  const totals: CostState = { since: isoOfMillis(startTime), input: null, cacheWrite: null, cacheRead: null, output: null, models: [] };
  for (const model of Object.keys(value).sort()) {
    const entry = value[model];
    const keys: UsageKey[] = [];
    for (const [key, ...aliases] of names) {
      for (const alias of aliases) {
        const amount = isObj(entry) ? num(entry[alias]) : undefined;
        if (amount === undefined) continue;
        totals[key] = (totals[key] ?? 0) + amount;
        if (amount > 0 && !keys.includes(key)) keys.push(key);
      }
    }
    totals.models.push({ model, keys });
  }
  return [totals.input, totals.cacheWrite, totals.cacheRead, totals.output].some((total) => total !== null) ? totals : null;
};

const merkleRoot = (leaves: readonly string[]): string => {
  if (leaves.length === 0) return sha256('');
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index] ?? '';
      next.push(sha256(left + (level[index + 1] ?? left)));
    }
    level = next;
  }
  return level[0] ?? sha256('');
};

const contentHashes = (content: unknown): string[] => {
  if (typeof content === 'string') return [sha256(content)];
  if (!Array.isArray(content)) return [];
  return content.map((block: unknown) => {
    if (isObj(block)) return sha256(str(block.text) ?? str(block.thinking) ?? JSON.stringify(block));
    return sha256(JSON.stringify(block));
  });
};

/** Where a subagent transcript came from: its `.meta.json` and the folder it sits in. */
export interface SubagentOrigin {
  parent: string;
  agentType: string | null;
  spawnedBy: string | null;
  /** The `n` of the `spawnedBy` call in the transcript that holds it, when the deposit could read it. */
  spawnedAt?: number | null;
  /** The session id of that transcript: the main session, or a sibling subagent's. */
  spawnedIn?: string | null;
}

export interface ExtractInput {
  text: string;
  session: string;
  project: string;
  rev: number;
  at: string;
  bytes: number;
  redact: Redactor;
  /** The per-account salt for path targets; the store keeps it beside the log. */
  salt?: string;
  /** The salt's `sid` (first 8 hex of its SHA-256), stamped on every capture record; null when no salt is in play. */
  sid?: string | null;
  /** The repository root holding a working directory (worktree segments already stripped), or null; absent means no repository is known. */
  repoRoot?: (cwd: string) => string | null;
  /** The identity string of a repository root (`makeRepoIdentity`); absent means the lower-cased root path. */
  repoIdentity?: (root: string) => string;
  /** The oars package, Node.js, and OS this capture ran under; absent reads as `0.0.0` and this process. */
  runtime?: { oars: string; node: string; os: string };
  /** The harness this transcript came from; absent means Claude Code. It names the frame and picks the action table. */
  harness?: Harness;
  /** How many files a repository root holds; absent reads the root's git index. */
  repoFiles?: (root: string) => number | null;
  /** The size bucket an earlier capture of this transcript read, null included; absent on the first capture, which reads it through `repoFiles`. */
  repoSize?: RepoSize | null;
  /** Set for a subagent transcript: every line is the agent's own line, so none is read as a sidechain. */
  subagent?: SubagentOrigin;
}

/** What capture writes for one transcript, before any derivation. */
export interface Capture {
  session: SessionObservation;
  prompts: UserPromptObservation[];
  tools: ToolObservation[];
  errorLines: ErrorLineObservation[];
  skeleton: Skeleton;
}

interface Current {
  index: number;
  ts: string | undefined;
  t0: number | undefined;
  t1: number | undefined;
  head: string;
  thinking: number;
  models: Map<string, number>;
  efforts: Set<string>;
  skills: Set<string>;
  usage: Usage;
  coverage: UsageCoverage;
  turns: number;
  opened: PromptOpened;
  /** The last harness version the prompt's lines name. */
  version: string | undefined;
  effortCounts: Map<string, number>;
  /** `message.model` per line, for a transcript whose lines name no requested model. */
  messageModels: Map<string, number>;
}

/** What one prompt adds to the frame; the file-wide fields join it once the whole file has been read. */
interface PromptFrameParts {
  version: string | undefined;
  model: string | null;
  effort: string | null;
  ts: string | undefined;
}

const hasToolResult = (content: unknown): boolean => Array.isArray(content) && content.some((block: unknown) => isObj(block) && block.type === 'tool_result');

const hasImage = (content: unknown): boolean => Array.isArray(content) && content.some((block: unknown) => isObj(block) && block.type === 'image');

// The tags a local command (a slash command the harness ran itself) leaves as user lines. A model's answer to a command makes it a prompt, and that case never reaches
// the run: a tag listed here that is still on a line there was not answered.
const LOCAL_COMMAND_TAGS: ReadonlySet<string> = new Set(['command-name', 'command-message', 'local-command-stdout', 'local-command-stderr', 'local-command-caveat']);

const firstTextBlock = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content) if (isObj(block) && block.type === 'text') return str(block.text) ?? '';
  return '';
};

// What the harness writes as a user line and the operator did not ask. A full re-capture checked this: the only leading tag left on a `typed` row is
// the paste wrapper. `local-command-stderr` is here as the sibling of `local-command-stdout`. The set is closed on purpose: anything else with a leading `<` was
// typed, or pasted. A `teammate-message` is another agent speaking to a teammate, so a teammate's turns after one stay in its prompt before, or outside any.
export const INJECTED_TAGS: ReadonlySet<string> = new Set([
  'bash-input',
  'bash-stderr',
  'bash-stdout',
  'local-command-caveat',
  'local-command-stderr',
  'local-command-stdout',
  'scheduled-task',
  'system-reminder',
  'task-notification',
  'teammate-message',
]);
export const LEADING_TAG = /^<([a-zA-Z][\w:-]*)[\s>/]/;

/** What the operator asked, with the wrapper removed: the command's name and its arguments, as they typed them. Either element can come first. */
const commandAsked = (text: string): string => {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1] ?? '';
  const args = /<command-args>([\s\S]*)<\/command-args>/.exec(text)?.[1] ?? '';
  return `${name} ${args}`.trim();
};

/**
 * Whether a model answers a command: the next main-line thing after it is an assistant turn. A meta line (a skill's body, a caveat), a tool result, and an
 * attachment do not decide it. A later user line does: it opens that turn itself, and when it is a local command's output the command was local. A synthetic
 * line is the harness speaking, so `/clear` followed by one has still had no turn.
 */
const answeredByModel = (lines: readonly string[], from: number, subagent: boolean): boolean => {
  for (let at = from; at < lines.length; at += 1) {
    let line: unknown;
    try {
      line = JSON.parse(lines[at] ?? '');
    } catch {
      continue;
    }
    if (!isObj(line) || !isObj(line.message) || (!subagent && truthy(line.isSidechain))) continue;
    const { content, model, role } = line.message;
    if (line.type === 'assistant' && role === 'assistant' && model !== '<synthetic>') return true;
    if (line.type !== 'user' || role !== 'user' || line.isMeta === true) continue;
    if (firstTextBlock(content) !== '' && !hasToolResult(content)) return false;
  }
  return false;
};

export interface PromptOpening {
  opened: PromptOpened;
  /** What the operator asked: the line as written, or a command's name and arguments. Not yet redacted. */
  request: string;
}

/**
 * Whether a main-line user line with text and no tool result opens a prompt in a Claude Code transcript, and how. Capture and the gold reader both number
 * prompts by this, so a gold entry's index is a capture index. `lines` is the whole transcript and `position` this line's place in it.
 */
export const promptOpening = (text: string, lines: readonly string[], position: number, subagent = false): PromptOpening | undefined => {
  const leading = LEADING_TAG.exec(text.trimStart())?.[1];
  // A tag name with no closing tag is the operator's own words ("<system-reminder> keeps showing, why?"), not the harness's wrapper.
  const tag = leading !== undefined && text.includes(`</${leading}>`) ? leading : undefined;
  if (tag === 'command-name' || tag === 'command-message') {
    const request = commandAsked(text);
    return request !== '' && answeredByModel(lines, position + 1, subagent) ? { opened: 'command', request } : undefined;
  }
  return tag !== undefined && INJECTED_TAGS.has(tag) ? undefined : { opened: 'typed', request: text };
};

// parse_sessions.py first_text: the first text block that is not empty.
const firstNonEmptyText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content) if (isObj(block) && block.type === 'text' && (str(block.text) ?? '') !== '') return str(block.text) ?? '';
  return '';
};

const majority = (counts: ReadonlyMap<string, number>): string => {
  let best = '?';
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
};

/** The majority of `counts`, or null when it is empty. */
const majorityOrNull = (counts: ReadonlyMap<string, number>): string | null => (counts.size === 0 ? null : majority(counts));

const bump = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const;

const toForward = (path: string): string => path.replace(/\\/g, '/');
// `~/x` is the home directory, never the cwd: joined to a cwd it would hash per cwd and could read as inside the repository.
const isAbsolute = (path: string): boolean => path.startsWith('/') || path.startsWith('~/') || /^[A-Za-z]:\//.test(path);

/** A base directory as `pathKey` compares it: normalized like the path (`posix.normalize` turns a UNC `//` into `/`), no trailing slash. */
const baseOf = (base: string): string => posix.normalize(toForward(base)).replace(/\/+$/, '');

/** `path` below `base` (compared without case, as Windows paths are), or undefined when it lies elsewhere. */
const below = (path: string, base: string): string | undefined => {
  const trimmed = baseOf(base);
  return path.toLowerCase().startsWith(`${trimmed.toLowerCase()}/`) ? path.slice(trimmed.length + 1) : undefined;
};

/** A linked worktree of the repository (`.claude/worktrees/<name>/`) is the same tree as the root: A9 counted one file from many of them. At any depth, for a cwd above the repository. */
const WORKTREE_SEGMENT = /(^|\/)\.claude\/worktrees\/[^/]+(?:\/|$)/;

/**
 * What a path is hashed as, and from where. Under the repository root of the line's `cwd` it is relative to that root, with a linked
 * worktree's segment stripped, so one file reads alike from every subdirectory and worktree (base `repo`). A path no repository holds
 * keeps the version-3 rule: relative to `cwd` when it lies under it, else as written (base `cwd`). A relative path is read from `cwd` first.
 */
export const pathKey = (path: string, cwd: string | undefined, root: string | null): { key: string; base: TargetBase } => {
  const given = toForward(path);
  const joined = isAbsolute(given) || cwd === undefined ? given : `${toForward(cwd).replace(/\/+$/, '')}/${given}`;
  // `../`, `./`, and a trailing slash must not split one file into several hashes, nor hide that it lies outside the repository.
  const absolute = posix.normalize(joined).replace(/(.)\/+$/, '$1');
  // The root itself (a Grep or Glob `path` at the repository root) is key `.`, as is a bare worktree root.
  const fromRoot = root === null ? undefined : below(absolute, root) ?? (absolute.toLowerCase() === baseOf(root).toLowerCase() ? '' : undefined);
  if (fromRoot !== undefined) return { key: fromRoot.replace(WORKTREE_SEGMENT, '$1').replace(/\/+$/, '') || '.', base: 'repo' };
  const fromCwd = cwd === undefined ? undefined : below(absolute, cwd);
  return { key: fromCwd ?? absolute, base: 'cwd' };
};

/** The per-account salted hash of a file path (16 hex characters, class A). */
export const hashPath = (path: string, cwd: string | undefined, root: string | null, salt: string): { hash: string; base: TargetBase; key: string } => {
  const { key, base } = pathKey(path, cwd, root);
  return { hash: sha256(`${salt}\n${key}`).slice(0, 16), base, key };
};

/** A leading `cd <dir> &&` or `cd <dir>;` hop: the target is the command that ran after it. */
const CD_HOP = /^\s*(?:cd|Set-Location|pushd)\s+\S+\s*(?:&&|;)\s*/;
/** Leading tokens that only set up the command: an environment assignment, `sudo`, `env`, PowerShell's `&`, and `.`. */
const PRELUDE = /^(?:[A-Za-z_][A-Za-z0-9_]*=.*|sudo|env|&|\.)$/;
const SEPARATORS = new Set(['&&', '|', ';']);

/**
 * A shell call's program and subcommand from its first line (`git push`, `just build`, `npm`), as recovery_episodes.py's
 * `shell_target` computes it, so a retry of `git push` after a failed `git push` is the same target and `git status` is not.
 * The program is a basename, lowercased, without `.exe`; the subcommand is the first later token that is not a flag, a path, or
 * a variable, cut to 30 characters, and there is none when a separator comes first. Empty when the line holds no command.
 */
export const shellTarget = (command: string): string => {
  let line = command.trim() === '' ? '' : (command.split(/\r?\n/)[0] ?? '');
  for (let hop = CD_HOP.exec(line); hop !== null; hop = CD_HOP.exec(line)) line = line.slice(hop[0].length);
  const tokens = line
    .split(/\s+/)
    .filter((token) => token !== '')
    .map((token) => token.replace(/^['"]+|['"]+$/g, ''));
  while (tokens.length > 0 && PRELUDE.test(tokens[0] ?? '')) tokens.shift();
  const [head, ...rest] = tokens;
  if (head === undefined) return '';
  const program = (head.replace(/\\/g, '/').split('/').pop() ?? head).toLowerCase().replace(/\.exe$/, '');
  for (const token of rest) {
    if (SEPARATORS.has(token)) break;
    if (!/^[-$]/.test(token) && !/[\\/]/.test(token)) return `${program} ${token.slice(0, 30)}`;
  }
  return program;
};

// The captured reading of a shell command (CAPTURE 6). `shellTarget` above stays the retry identity; this reads every line and every
// segment, because most commits and pulls sit behind another command. It is a reading, not a parser: a torn or exotic command yields
// fewer facts, never a throw.

/** Keeps a record bounded on a generated script; the last commands are the ones the call's status can report. */
const SEGMENTS_PER_CALL_MAX = 50;
const RUN_WORDS_MAX = 12;
const RUN_WORD_CHARS = 30;

type ShellWord = WordOfCommand;
type ShellOp = '&&' | '||' | '|' | ';' | '&' | '\n' | 'open' | 'close';
type ShellToken = ShellWord | ShellOp;
type ShellLink = 'and' | 'pipe' | 'break' | 'end';

/** One simple command, after its prelude. */
export interface ShellCommand {
  program: string;
  args: ShellWord[];
  /** The words before the program (assignments, wrappers, block words) and the program's own word, as written: the name read takes variable names from them. */
  before: ShellWord[];
  head: ShellWord;
  read: boolean;
  /** How the next command joins this one. */
  link: ShellLink;
  /** A pipe follows the group this command sits in, so its status is hidden whatever its own link says. */
  hidden: boolean;
}

/** One command of a shell call, as its step reads. `run` compares a retry and is not kept. */
export interface ShellStepRead {
  identity: ShellIdentity;
  read: boolean;
  run: string;
}

/** One `git commit` a command holds. */
export interface PlannedCommit {
  quiet: boolean;
  /** A later command of the same list reads this commit back, so the result can name its sha. */
  readBack: boolean;
}

export interface ShellRead {
  /** Every command's words, for the name read (`argNamesOf`). */
  words: CommandWords[];
  segments: ShellSegment[];
  /** The same commands as `segments`, in public names, apart from a pull's package name, which is kept as it is after redaction, with the redacted text they compare by. */
  steps: ShellStepRead[];
  pulls: ToolPull[];
  commitPlan: PlannedCommit[];
}

const HEREDOC = /(?<!<)<<-?\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][\w.-]*))/g;
// The `@` opens a here-string only at the start of a line or after whitespace, `=`, or `(`: `echo "me@"` ends in `@"` and opens nothing.
const HERE_STRING = /(?<=^|[\s=(])@(['"])\s*$/;

/**
 * Whether each character of a line sits in literal quoted text, where a `<<` opens no heredoc: `git commit -m "x << y"`. A `$(` inside
 * double quotes is code again, so `"$(cat <<'EOF'` still opens one. A line is read alone, so a quote left open on an earlier line is not seen.
 */
const literalMask = (line: string): boolean[] => {
  const literal: boolean[] = [];
  const stack: string[] = [];
  for (let at = 0; at < line.length; at += 1) {
    const char = line.charAt(at);
    const top = stack.at(-1);
    literal[at] = top === "'" || top === '"';
    if (top === "'") {
      if (char === "'") stack.pop();
    } else if (char === '\\') {
      literal[at + 1] = top === '"';
      at += 1;
    } else if (char === '"') {
      if (top === '"') stack.pop();
      else stack.push('"');
    } else if (char === "'" && top !== '"') stack.push("'");
    else if (char === '$' && line.charAt(at + 1) === '(') {
      stack.push('(');
      literal[at + 1] = false;
      at += 1;
    } else if (char === ')' && top === '(') stack.pop();
  }
  return literal;
};

/** A heredoc or here-string body is data, and it may hold a whole script, so it goes before anything reads the command. */
const dropBodies = (command: string): string => {
  const kept: string[] = [];
  let tag: string | null = null;
  let closer: string | null = null;
  for (const line of command.split(/\r?\n/)) {
    if (tag !== null) {
      if (line.trim() === tag) tag = null;
      continue;
    }
    if (closer !== null) {
      if (!line.startsWith(closer)) continue;
      // What follows the closer belongs to the opening line: `@'...'@ | git commit -F -`.
      kept[kept.length - 1] = `${kept[kept.length - 1] ?? ''}${line.slice(closer.length)}`;
      closer = null;
      continue;
    }
    const hereString = HERE_STRING.exec(line);
    if (hereString !== null) {
      kept.push(line.slice(0, hereString.index));
      closer = `${hereString[1] ?? ''}@`;
      continue;
    }
    kept.push(line);
    // Two heredocs on a line close in order, so reading to the last tag drops both bodies.
    const literal = literalMask(line);
    const last = [...line.matchAll(HEREDOC)].filter((match) => literal[match.index] !== true).at(-1);
    if (last !== undefined) tag = last[1] ?? last[2] ?? last[3] ?? null;
  }
  return kept.join('\n');
};

/** Stands in for the `@` of a version while the redactor runs. A private-use character, so no command holds it. */
const VERSION_AT = String.fromCharCode(0xe000);
const VERSIONED = /^(@?[^@:\s]+)@(?!\d+\.\d+\.\d+\.\d+$)(v?\d+(?:\.(?:\d+|x|\*))+(?:[-+][0-9A-Za-z.+-]*)?)$/;

/** `foo@1.2.3` reads as an email to the redactor. No mail domain is all numbers, while an IP address is a real host, so only a version is shielded. */
const redactCommand = (command: string, redact: Redactor): string =>
  redact(command.replace(/[^\s"'`]+/g, (word) => word.replace(VERSIONED, `$1${VERSION_AT}$2`))).replaceAll(VERSION_AT, '@');

const MASK = /^<(?:secret|email|org-domain)>/;
const ONLY_MASKS = /^(?:<(?:secret|email|org-domain)>)+$/;

/** Where the single-quoted text that opens at `open` ends: the closing quote, or the end of the text. Bash's ANSI-C string (`$'it\'s'`) honors a backslash, so its `\'` is inside it; any other single-quoted text ends at the next `'`. */
const singleQuotedEnd = (text: string, open: number, ansiC = true): number => {
  const ansi = ansiC && text.charAt(open - 1) === '$';
  let end = open + 1;
  while (end < text.length && text.charAt(end) !== "'") end += ansi && text.charAt(end) === '\\' ? 2 : 1;
  return Math.min(end, text.length);
};

/** What closes each opener that can hold quotes of its own inside a double-quoted piece: a command substitution (`$(`, a backtick) or a parameter expansion (`${x:-"a b"}`). */
const CLOSERS: ReadonlyMap<string, string> = new Map([
  ['$(', ')'],
  ['${', '}'],
  ['`', '`'],
]);

/**
 * Where the substitution or expansion that began just before `from`, closed by `first`, ends: past its closing character, or -1 when it never closes (PowerShell's backtick is an escape, not an opener, and a torn command has no end).
 * Whatever quoting it holds is its own: a quote inside it never ends the double-quoted piece that carries it, so a quote cannot move the reader's state. An explicit stack keeps a crafted command that nests without end from
 * overflowing the call stack, and `budget` (characters left to scan across one read) keeps one that opens thousands of them from costing a scan to the end of the text each.
 */
const substitutionEnd = (text: string, from: number, first: string, budget: { left: number }, powershell: boolean): number => {
  const stack: string[] = [first];
  let at = from;
  // PowerShell's escape is the backtick, and a backslash is an ordinary character there.
  const escape = powershell ? '`' : '\\';
  // Inside a double-quoted piece or an expansion a single quote and a bare parenthesis are text; inside a substitution they quote and group.
  while (at < text.length && stack.length > 0 && budget.left > 0) {
    budget.left -= 1;
    const char = text.charAt(at);
    const top = stack.at(-1);
    const opener = CLOSERS.get(char === '$' ? char + text.charAt(at + 1) : char);
    at += 1;
    if (char === escape) at += 1;
    else if (char === top) stack.pop();
    else if (opener !== undefined) {
      stack.push(opener);
      at += char === '$' ? 1 : 0;
    } else if (char === '"') stack.push('"');
    else if (char === "'" && (top === ')' || top === '`')) at = singleQuotedEnd(text, at - 1, !powershell) + 1;
    else if (char === '(' && (top === ')' || top === '`')) stack.push(')');
  }
  return stack.length === 0 ? at : -1;
};

/**
 * The first single quote or heredoc marker of a command. An unexpanded `$name` can only come from single-quoted text or a heredoc body, so a word that starts before this point is read as the shell reads it, and every
 * word at or after it is opaque: it holds no variable and no flag value, whatever the reader made of the quotes before it. A true reference after the point sends no name, which sends less and never more.
 */
const OPAQUE_POINT = /'|<</;
/**
 * PowerShell reads more forms as literal text: the typographic single and double quotes (U+2018 to U+201E) are quotes, `<#` opens a block comment, and `--%` makes the rest of the line literal. Each is a point as `'` and `<<` are.
 */
const POWERSHELL_POINT = /['‘-„]|<<|<#|--%/;

/** The shell a command is written for: a call whose tool the harness's `shells` table maps to `powershell` (Claude Code's `PowerShell`, and the `powershell` that Copilot, Pi, and Gemini name) reads its escapes by PowerShell's rules, every other call by POSIX's. */
type ShellDialect = 'posix' | 'powershell';

const pointOf = (dialect: ShellDialect): RegExp => (dialect === 'powershell' ? POWERSHELL_POINT : OPAQUE_POINT);

/**
 * `opaqueFrom` is where that point sits in `text` (-1 for none, 0 for a text that is opaque throughout, as a word an opaque word holds is); left out, it is the first point of the dialect. A substitution opened inside double quotes
 * lowers it to where it opens, since its end is read by a scan that can close early: every word that starts after it is opaque.
 */
const tokenize = (text: string, opaqueFrom?: number, dialect: ShellDialect = 'posix'): ShellToken[] => {
  let opaque = opaqueFrom ?? text.search(pointOf(dialect));
  const tokens: ShellToken[] = [];
  // PowerShell's escape is the backtick, a backslash is an ordinary character in and out of quotes, `$'` is no ANSI-C string, and a backtick opens no substitution.
  const powershell = dialect === 'powershell';
  const escape = powershell ? '`' : '\\';
  let word = '';
  let quoted = false;
  let started = false;
  let redirected = false;
  let at = 0;
  // Where the word's raw source starts in `text`: a word that is exactly one variable reference carries that variable, and any other word carries none, whatever its quotes and `$` marks hold.
  let start = -1;
  const budget = { left: 16 * text.length + 1024 };
  const flush = (): void => {
    if (started && redirected) redirected = false;
    else if (started && !quoted && (word === '{' || word === '}')) tokens.push(word === '{' ? 'open' : 'close');
    else if (started) {
      const held: ShellWord = { text: word, quoted };
      if (opaque >= 0 && start >= opaque) held.opaque = true;
      else {
        const variable = variableOf(text.slice(start, at));
        if (variable !== undefined) held.variable = variable;
      }
      tokens.push(held);
    }
    word = '';
    quoted = false;
    started = false;
    start = -1;
  };
  const op = (token: ShellOp): void => {
    flush();
    redirected = false;
    const last = tokens.at(-1);
    // A line that ends in an operator continues on the next one.
    if (token === '\n' && (last === undefined || last === '&&' || last === '||' || last === '|' || last === '\n')) return;
    tokens.push(token);
  };
  while (at < text.length) {
    const char = text.charAt(at);
    const next = text.charAt(at + 1);
    const here = at;
    if (char === "'") {
      const stop = singleQuotedEnd(text, at, !powershell);
      word += text.slice(at + 1, stop);
      quoted = true;
      started = true;
      at = stop + 1;
    } else if (char === '"') {
      quoted = true;
      started = true;
      at += 1;
      while (at < text.length && text.charAt(at) !== '"') {
        const inner = text.charAt(at);
        const after = text.charAt(at + 1);
        const opener = inner === '$' ? inner + after : inner;
        const closer = powershell && inner === '`' ? undefined : CLOSERS.get(opener);
        if (closer === ')' || closer === '`') opaque = opaque < 0 ? at : Math.min(opaque, at);
        const end = closer === undefined ? -1 : substitutionEnd(text, at + opener.length, closer, budget, powershell);
        if (inner === escape && (after === escape || after === '$' || after === '`')) {
          // A backslash pair is one escaped backslash, so the second never escapes the quote after it; an escaped dollar or backtick opens nothing.
          word += inner + after;
          at += 2;
        } else if (inner === escape && after === '\n') {
          at += 2;
        } else if (inner === escape && after === '"') {
          word += '"';
          at += 2;
        } else if (end >= 0) {
          // A command substitution stays whole in this word: a quote inside it is its own, and never closes this piece. One that never closes is read as the text it is.
          word += text.slice(at, end);
          at = end;
        } else {
          word += inner;
          at += 1;
        }
      }
      at += 1;
    } else if (!powershell && char === '\\' && next === '\\') {
      word += '\\\\';
      started = true;
      at += 2;
    } else if ((char === escape || char === '`') && next === '\n') {
      at += 2;
    } else if (char === escape && next !== '' && (powershell || /[\s&|;()<>'"]/.test(next))) {
      word += next;
      started = true;
      at += 2;
    } else if (char === '#' && !started) {
      const end = text.indexOf('\n', at);
      at = end < 0 ? text.length : end;
    } else if (char === '\n') {
      op('\n');
      at += 1;
    } else if (/\s/.test(char)) {
      flush();
      at += 1;
    } else if (char === '<' && MASK.test(text.slice(at, at + 12))) {
      const mask = MASK.exec(text.slice(at, at + 12))?.[0] ?? '';
      word += mask;
      started = true;
      at += mask.length;
    } else if (char === '>' || char === '<' || (char === '&' && next === '>')) {
      // A file descriptor number belongs to the redirect, and so does the word after it.
      if (started && !quoted && /^\d+$/.test(word)) {
        word = '';
        started = false;
      }
      flush();
      at += 1;
      while (at < text.length && /[<>&]/.test(text.charAt(at))) at += 1;
      redirected = true;
    } else if (char === '&' && next === '&') {
      op('&&');
      at += 2;
    } else if (char === '|' && next === '|') {
      op('||');
      at += 2;
    } else if (char === '|') {
      op('|');
      at += next === '&' ? 2 : 1;
    } else if (char === ';') {
      op(';');
      at += next === ';' ? 2 : 1;
    } else if (char === '&') {
      op('&');
      at += 1;
    } else if (char === '(' || char === ')') {
      op(char === '(' ? 'open' : 'close');
      at += 1;
    } else {
      word += char;
      started = true;
      at += 1;
    }
    if (started && start < 0) start = here;
  }
  flush();
  return tokens;
};

/** A block keyword names no program, and its condition or body is the command. `for` stays: its words say what it walks. */
const BLOCK_WORDS = new Set(['if', 'then', 'elif', 'else', 'elseif', 'do', 'while', 'until', 'fi', 'done', 'esac', 'try', 'finally', '!']);
const WRAPPERS = new Set(['sudo', 'env', '.', 'command', 'exec', 'nohup', 'nice', 'time', 'call']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** The flags of a wrapper that own the next word: `sudo -u root npm i`, `env -u X`, `nice -n 5`, `timeout -k 5 60`. */
const WRAPPER_VALUE_FLAGS: ReadonlyMap<string, readonly string[]> = new Map([
  ['sudo', ['-u', '-g']],
  ['env', ['-u']],
  ['nice', ['-n']],
  ['timeout', ['-k', '-s']],
]);
const POWERSHELL_VARIABLE = /^\$[A-Za-z_]\w*$/;
const COMMAND_START = /^[A-Za-z_.\\/~]/;

/** A PowerShell `$name = <command>` at `at`: the variable and the `=` hold no program, and the command after them is the real one. A quoted or numeric value is no command. */
const assignsCommand = (words: readonly ShellWord[], at: number): boolean => {
  const [name, equals, value] = [words[at], words[at + 1], words[at + 2]];
  return name !== undefined && !name.quoted && POWERSHELL_VARIABLE.test(name.text) && equals?.text === '=' && !equals.quoted && value !== undefined && !value.quoted && COMMAND_START.test(value.text);
};

/**
 * The words from the command's real program on. A block word is known by its word in any case (`IF`), and a wrapper by its program name as `programOf`
 * reads it: `TIMEOUT 5` and `/usr/bin/timeout 5` are the wrapper they spell. A shell keyword is never written with a path, so `./do` and `./done` are
 * programs. The private program behind a block word or wrapper is the one read (register row A53).
 */
const afterPrelude = (words: readonly ShellWord[]): readonly ShellWord[] => {
  let at = 0;
  for (;;) {
    const word = words[at];
    if (word === undefined) return [];
    if (word.quoted) return words.slice(at);
    const name = programOf(word) ?? word.text;
    if (BLOCK_WORDS.has(word.text.toLowerCase()) || ASSIGNMENT.test(word.text)) at += 1;
    else if (assignsCommand(words, at)) at += 2;
    else if (WRAPPERS.has(name) || name === 'timeout') {
      const isTimeout = name === 'timeout';
      const owning = WRAPPER_VALUE_FLAGS.get(name) ?? [];
      at += 1;
      while (words[at]?.text.startsWith('-') === true) at += owning.includes(words[at]?.text ?? '') ? 2 : 1;
      if (isTimeout && /^\d+(?:\.\d+)?[smhd]?$/.test(words[at]?.text ?? '')) at += 1;
    } else return words.slice(at);
  }
};

/** The program's basename, or null when the word names none: a variable, a flag, or a quoted sentence. */
const programOf = (word: ShellWord): string | null => {
  const { text } = word;
  if (text === '' || text.includes('$') || text.startsWith('-')) return null;
  if (word.quoted && /\s/.test(text) && !/[\\/]/.test(text)) return null;
  const base = text.replace(/\\/g, '/').split('/').pop() ?? '';
  const program = base.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');
  return program === '' ? null : cut(program, RUN_WORD_CHARS);
};

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell', 'cmd']);
const COMMAND_FLAG = /^(?:-[a-z]*c|-command|\/c)$/i;

/** PowerShell takes any prefix of `-Command` (`-c`, `-com`), so a flag that merely ends in `c`, like `-Exec`, is not the command flag; the other shells end theirs in `c`. */
const isCommandFlag = (program: string, text: string): boolean =>
  program === 'pwsh' || program === 'powershell' ? /^[-/]/.test(text) && text.length >= 2 && '-command'.startsWith(`-${text.slice(1).toLowerCase()}`) : COMMAND_FLAG.test(text);

/** The shells that run every word after the flag as the command. `bash -c npm test` runs `npm` with `test` as `$0`, so bash and its kin take one word. */
const JOINING_SHELLS = new Set(['pwsh', 'powershell', 'cmd']);

/**
 * The command a shell is told to run: `bash -lc "..."`, `pwsh -NoProfile -Command "..."`, `cmd /c ...`. A joining shell's unquoted words pass as
 * they are, not joined into text and read again, so a quoted `-m "a && b"` stays an argument.
 */
const shellArgument = (program: string, args: readonly ShellWord[]): readonly ShellToken[] | null => {
  if (!SHELLS.has(program)) return null;
  const flag = args.findIndex((word) => !word.quoted && isCommandFlag(program, word.text));
  const first = flag < 0 ? undefined : args[flag + 1];
  if (first === undefined) return null;
  // The argument's own text is read for its own first quote or marker, unless the word is opaque already: then nothing in it is read.
  return JOINING_SHELLS.has(program) && !first.quoted ? args.slice(flag + 1) : tokenize(first.text, first.opaque === true ? 0 : undefined);
};

/** How many shells deep a command is read. Real commands nest two or three; the cap keeps a torn or hostile one from exhausting the stack. */
const SHELL_DEPTH_MAX = 8;

const linkOf = (ops: readonly ShellOp[]): ShellLink => {
  if (ops.some((op) => op === ';' || op === '&' || op === '||' || op === '\n')) return 'break';
  return ops.includes('|') ? 'pipe' : 'and';
};

/** Every simple command in order, with whether the call's status reports it. A shell's argument takes the place of the shell, under the shell's own read. */
const readCommands = (tokens: readonly ShellToken[], depth = 0): ShellCommand[] => {
  const commands: ShellCommand[] = [];
  let pending: ShellOp[] = [];
  let words: ShellWord[] = [];
  // The index of the first command of each group still open.
  const opened: number[] = [];
  // Where an `open` in `pending` follows a command's own words (`pytest $(a)`), the group's first command is that command, not the next one.
  const owned = new Map<number, number>();
  const close = (): void => {
    const real = afterPrelude(words);
    const before = words.slice(0, words.length - real.length);
    words = [];
    const [head, ...args] = real;
    const program = head === undefined ? null : programOf(head);
    if (program === null || head === undefined) return;
    const previous = commands.at(-1);
    if (previous !== undefined) previous.link = linkOf(pending);
    // The tokens say which way each group goes, so they are walked in order: an open pushes, a close pops, and a pipe after that close hides the group.
    // A group that holds no program (`{ echo $f }` after `if ($y)`) therefore pops its own open, never an outer one.
    pending.forEach((op, at) => {
      if (op === 'open') opened.push(owned.get(at) ?? commands.length);
      else if (op === 'close') {
        const start = opened.pop();
        if (start !== undefined && pending.includes('|', at + 1)) for (const held of commands.slice(start)) held.hidden = true;
      }
    });
    owned.clear();
    pending = [];
    commands.push({ program, args, before, head, read: true, link: 'end', hidden: false });
  };
  for (const token of tokens) {
    if (typeof token === 'string') {
      const behindWords = token === 'open' && words.length > 0;
      const before = commands.length;
      close();
      if (behindWords && commands.length > before) owned.set(pending.length, before);
      pending.push(token);
    } else words.push(token);
  }
  close();
  // Walking back, a later `;`, `&`, newline, or `||` means the status is no longer this command's; a pipe hides the command it follows and every command of a group closed before it.
  let overridden = pending.includes('&');
  for (const command of commands.toReversed()) {
    if (command.link === 'break') overridden = true;
    command.read = !overridden && command.link !== 'pipe' && !command.hidden;
  }
  return commands.flatMap((command) => {
    // Past the cap a shell is a plain command: `'pwsh -c '.repeat(5000)` would otherwise recurse once per word and overflow the stack.
    const argument = depth >= SHELL_DEPTH_MAX ? null : shellArgument(command.program, command.args);
    if (argument === null) return [command];
    const inner = readCommands(argument, depth + 1);
    if (inner.length === 0) return [command];
    for (const held of inner) held.read &&= command.read;
    const last = inner.at(-1);
    if (last !== undefined) last.link = command.link;
    return inner;
  });
};

const isPlainWord = (word: ShellWord): boolean => !word.quoted && word.text !== '' && !/^-|\$|[\\/]/.test(word.text);

/**
 * The program and its plain words, joined by one space. A basename that holds whitespace (`"/opt/my tools/git push"`) would read back as a program and a
 * word, so capture stores `<literal>` in its place: the boundary a `run` cannot carry, and no part of that name is kept (register row A53).
 */
const runOf = (command: ShellCommand): string =>
  [/\s/.test(command.program) ? LITERAL : command.program, ...command.args.filter(isPlainWord).map((word) => cut(word.text, RUN_WORD_CHARS))].slice(0, RUN_WORDS_MAX).join(' ');

/** Positional words and flag values. A flag in `takesValue` owns the next word, which is therefore not a name. */
const parseArgs = (args: readonly ShellWord[], takesValue: ReadonlySet<string>): { names: string[]; flags: Map<string, string>; nameAt: number[] } => {
  const names: string[] = [];
  const nameAt: number[] = [];
  const flags = new Map<string, string>();
  for (let at = 0; at < args.length; at += 1) {
    const text = args[at]?.text ?? '';
    if (!text.startsWith('-')) {
      names.push(text);
      nameAt.push(at);
    } else if (text.includes('=')) flags.set(text.slice(0, text.indexOf('=')), text.slice(text.indexOf('=') + 1));
    else if (takesValue.has(text)) {
      flags.set(text, args[at + 1]?.text ?? '');
      at += 1;
    }
  }
  return { names, flags, nameAt };
};

// `-w` and `-s` are left out: `-w` owns a value only on npm (`--workspace`; on pnpm it means the workspace root) and `-s` only for `skills add` (on npm it is silent).
const NODE_VALUE_FLAGS = new Set(['--workspace', '--registry', '--prefix', '--filter', '-F', '-C', '--dir', '--cache', '--tag', '--cwd', '--loglevel', '--userconfig', '-p', '--package', '-c', '--call', '--omit', '--include', '--save-prefix', '--skill']);
const NPM_VALUE_FLAGS = new Set([...NODE_VALUE_FLAGS, '-w']);
const SKILLS_VALUE_FLAGS = new Set(['-s']);
const nodeFlags = (program: string): ReadonlySet<string> => (program === 'npm' || program === 'npx' ? NPM_VALUE_FLAGS : NODE_VALUE_FLAGS);
const PYTHON_VALUE_FLAGS = new Set(['-r', '--requirement', '-e', '--editable', '-c', '--constraint', '-i', '--index-url', '--extra-index-url', '--index', '--default-index', '-t', '--target', '-f', '--find-links', '--python', '-p', '--from', '--with', '--prefix', '--root', '--group', '--extra', '--only-binary', '--no-binary', '--trusted-host', '--proxy', '--cache-dir', '--timeout', '--suffix', '--pip-args', '--spec']);
const CARGO_VALUE_FLAGS = new Set(['--path', '--git', '--branch', '--tag', '--rev', '--root', '--features', '-F', '--target', '--registry', '--index', '-j', '--jobs', '--profile', '--bin', '--example', '--package', '-p', '--rename', '--manifest-path', '--version', '--vers', '--target-dir', '--config']);
const GO_VALUE_FLAGS = new Set(['-o', '-tags', '-modfile', '-C', '-ldflags', '-gcflags', '-mod', '-p']);
const GEM_VALUE_FLAGS = new Set(['-v', '--version', '-i', '--install-dir', '-n', '--bindir', '-s', '--source', '--platform']);
const PLUGIN_VALUE_FLAGS = new Set(['--scope', '-s']);
const NO_VALUE_FLAGS: ReadonlySet<string> = new Set<string>();

const LOCAL_SPEC = /^(?:\.{1,2}$|\.{0,2}[\\/]|~|[A-Za-z]:[\\/]|file:|link:|workspace:|portal:)/;
const ARCHIVE = /\.(?:whl|tgz|zip|tar\.gz)$/;
const isUrl = (text: string): boolean => text.includes('://');
const namesNothing = (text: string): boolean => text === '' || text.includes('$') || /^%.*%$/.test(text) || ONLY_MASKS.test(text);
const HOLDS_MASK = /<(?:secret|email|org-domain)>/;
/** A version with a mask inside says only that something was masked: `alias@npm:foo@1.2.3-beta.1` reads as `npm:<email>`. It is no version. */
const versionOf = (text: string): string | null => (text === '' || text.includes('$') || HOLDS_MASK.test(text) ? null : text);

/** `name@version`, keeping a leading `@` with the name. */
const atVersion = (ecosystem: PullEcosystem, text: string): ToolPull | null => {
  const at = text.lastIndexOf('@');
  const name = at > 0 ? text.slice(0, at) : text;
  const version = at > 0 ? text.slice(at + 1) : '';
  // A name that starts with a mask is not a package: `git@github.com:org/repo.git` reads as `<email>:org/repo.git`. A Go module path may start with `<org-domain>`.
  if (namesNothing(name) || (ecosystem !== 'go' && MASK.test(name))) return null;
  return { ecosystem, name, version: versionOf(version) };
};

const wholeName = (ecosystem: PullEcosystem, text: string): ToolPull | null => (namesNothing(text) ? null : { ecosystem, name: text, version: null });

// `alias@npm:real@1.0.0` and a leading `npm:real` install the package `real`: the pick is the real name, never the alias spelling.
const NPM_ALIAS = /^(?:(?:@[^@/\s]+\/)?[^@/\s]+@)?npm:(.+)$/;

const nodeSpec = (spec: string): ToolPull | null => {
  const text = NPM_ALIAS.exec(spec)?.[1] ?? spec;
  if (isUrl(text)) return wholeName('npm', text);
  if (LOCAL_SPEC.test(text) || ARCHIVE.test(text)) return null;
  // One slash is a scoped name or a GitHub shorthand; more is a folder.
  if (text.split('/').length > 2 || text.includes('\\')) return null;
  return atVersion('npm', text);
};

const PYTHON_SPEC = /^([A-Za-z0-9._-]+)(?:\[[^\]]*\])?(===?|~=|!=|>=|<=|<|>|@)?(.*)$/;

const pythonSpec = (text: string): ToolPull | null => {
  if (isUrl(text)) return wholeName('pypi', text);
  if (LOCAL_SPEC.test(text) || ARCHIVE.test(text) || /[\\/]/.test(text)) return null;
  const match = PYTHON_SPEC.exec(text);
  if (match === null) return null;
  const operator = match[2] ?? '';
  const stated = match[3] ?? '';
  const version = versionOf(operator === '==' || operator === '===' || operator === '@' ? stated : stated === '' ? '' : `${operator}${stated}`);
  return { ecosystem: 'pypi', name: match[1] ?? '', version };
};

/** A module path's first element has a dot; `fmt`, `cmd/x`, and `all` are not downloads. */
const goSpec = (text: string): ToolPull | null => (/^(?:<org-domain>|[A-Za-z0-9-]+\.[^/\\]+)\//.test(text) ? atVersion('go', text) : null);

const localOr = (ecosystem: PullEcosystem, text: string): ToolPull | null => (LOCAL_SPEC.test(text) ? null : atVersion(ecosystem, text));

const present = (pull: ToolPull | null): pull is ToolPull => pull !== null;

/** `npx`, `bunx`, and `dlx` run one package: a `--package` flag names it, else the first word. `skills add` installs a skill rather than running a tool. */
const runnerPulls = (args: readonly ShellWord[], valueFlags: ReadonlySet<string>, outer: ReadonlyMap<string, string> = new Map()): Array<ToolPull | null> => {
  let { names, flags } = parseArgs(args, valueFlags);
  const [first, sub] = names;
  const skills = first !== undefined && atVersion('npm', first)?.name === 'skills' && sub === 'add';
  // `-s` names a skill there, so it owns the next word: `npx skills add -s one owner/repo`.
  if (skills) ({ names, flags } = parseArgs(args, new Set([...valueFlags, ...SKILLS_VALUE_FLAGS])));
  const source = names[2];
  if (skills && source !== undefined) return [LOCAL_SPEC.test(source) ? null : wholeName('skill', source)];
  const packaged = flags.get('-p') ?? flags.get('--package') ?? outer.get('-p') ?? outer.get('--package');
  if (packaged !== undefined) return [nodeSpec(packaged)];
  return first === undefined ? [] : [nodeSpec(first)];
};

const nodePulls = (program: string, args: readonly ShellWord[]): Array<ToolPull | null> => {
  const valueFlags = nodeFlags(program);
  const { names, flags, nameAt } = parseArgs(args, valueFlags);
  // `global` and `workspace <name>` only say where the install goes.
  const lead = names[0] === 'global' ? 1 : names[0] === 'workspace' ? 2 : 0;
  const [sub, ...specs] = names.slice(lead);
  // The words after the `dlx` name, found by its place in the parse rather than by its text, since a flag's value can read `dlx` too; a flag before it (pnpm's `--package=foo dlx bar`) still counts.
  if (sub === 'dlx') return runnerPulls(args.slice((nameAt[lead] ?? 0) + 1), valueFlags, flags);
  return sub === 'add' || sub === 'install' || sub === 'i' ? specs.map(nodeSpec) : [];
};

const pipPulls = (args: readonly ShellWord[]): Array<ToolPull | null> => {
  const { names } = parseArgs(args, PYTHON_VALUE_FLAGS);
  return names[0] === 'install' ? names.slice(1).map(pythonSpec) : [];
};

const uvxPulls = (args: readonly ShellWord[]): Array<ToolPull | null> => {
  const { names, flags } = parseArgs(args, PYTHON_VALUE_FLAGS);
  const named = flags.get('--from') ?? names[0];
  return named === undefined ? [] : [pythonSpec(named)];
};

const uvPulls = (args: readonly ShellWord[]): Array<ToolPull | null> => {
  const { names } = parseArgs(args, PYTHON_VALUE_FLAGS);
  if (names[0] === 'add') return names.slice(1).map(pythonSpec);
  if ((names[0] === 'pip' || names[0] === 'tool') && names[1] === 'install') return names.slice(2).map(pythonSpec);
  return [];
};

const pipxPulls = (args: readonly ShellWord[]): Array<ToolPull | null> => {
  const { names, flags } = parseArgs(args, PYTHON_VALUE_FLAGS);
  if (names[0] === 'install') return names.slice(1).map(pythonSpec);
  const named = flags.get('--spec') ?? names[1];
  return names[0] === 'run' && named !== undefined ? [pythonSpec(named)] : [];
};

/** A name's version from its own `@`, else from a version flag. */
const versionedPulls = (ecosystem: PullEcosystem, names: readonly string[], stated: string | undefined): Array<ToolPull | null> =>
  names
    .map((name) => localOr(ecosystem, name))
    .map((pull) => (pull !== null && pull.version === null && stated !== undefined && versionOf(stated) !== null ? { ...pull, version: stated } : pull));

const pullsOfCommand = (program: string, args: readonly ShellWord[]): Array<ToolPull | null> => {
  if (program === 'npm' || program === 'pnpm' || program === 'yarn' || program === 'bun') return nodePulls(program, args);
  if (program === 'npx' || program === 'bunx') return runnerPulls(args, nodeFlags(program));
  if (/^pip[\d.]*$/.test(program)) return pipPulls(args);
  if (/^(?:python[\d.]*|py)$/.test(program)) {
    const module = args.findIndex((word) => word.text === '-m');
    return module >= 0 && /^pip[\d.]*$/.test(args[module + 1]?.text ?? '') ? pipPulls(args.slice(module + 2)) : [];
  }
  if (program === 'uv') return uvPulls(args);
  if (program === 'uvx') return uvxPulls(args);
  if (program === 'pipx') return pipxPulls(args);
  if (program === 'cargo') {
    // A leading `+toolchain` word picks the compiler and is no subcommand.
    const { names, flags } = parseArgs(args[0]?.text.startsWith('+') === true ? args.slice(1) : args, CARGO_VALUE_FLAGS);
    if (names[0] !== 'add' && names[0] !== 'install') return [];
    const git = flags.get('--git');
    // With no name, `--git` is the thing pulled.
    if (names.length === 1 && git !== undefined) return [LOCAL_SPEC.test(git) ? null : wholeName('cargo', git)];
    return versionedPulls('cargo', names.slice(1), flags.get('--version') ?? flags.get('--vers'));
  }
  if (program === 'go') {
    const { names } = parseArgs(args, GO_VALUE_FLAGS);
    return names[0] === 'get' || names[0] === 'install' ? names.slice(1).map(goSpec) : [];
  }
  if (program === 'gem') {
    const { names, flags } = parseArgs(args, GEM_VALUE_FLAGS);
    return names[0] === 'install' ? versionedPulls('gem', names.slice(1), flags.get('-v') ?? flags.get('--version')) : [];
  }
  if (program === 'brew') {
    const { names } = parseArgs(args, NO_VALUE_FLAGS);
    return names[0] === 'install' ? versionedPulls('brew', names.slice(1), undefined) : [];
  }
  if (program === 'claude' || program === 'codex') {
    // `foo@market` names a marketplace, not a version, so the name stays whole.
    const { names } = parseArgs(args, PLUGIN_VALUE_FLAGS);
    const verb = program === 'claude' ? 'install' : 'add';
    return names[0] === 'plugin' && names[1] === verb ? names.slice(2).map((name) => wholeName('plugin', name)) : [];
  }
  return [];
};

interface GitCall {
  sub: string;
  args: readonly ShellWord[];
  /** The repository flag, so a read of another repository is not a read of this commit. */
  scope: string;
}

const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const GIT_SCOPE_EQUALS = /^--(?:git-dir|work-tree|namespace)=/;

const gitCall = (command: ShellCommand): GitCall | null => {
  if (command.program !== 'git') return null;
  let scope = '';
  for (let at = 0; at < command.args.length; at += 1) {
    const text = command.args[at]?.text ?? '';
    if (GIT_VALUE_FLAGS.has(text)) {
      if (text !== '-c') scope += `${text} ${command.args[at + 1]?.text ?? ''};`;
      at += 1;
    } else if (GIT_SCOPE_EQUALS.test(text)) {
      // The `--git-dir=/a` form names the repository like `--git-dir /a`, so it is the same scope.
      scope += `${text.slice(0, text.indexOf('='))} ${text.slice(text.indexOf('=') + 1)};`;
    } else if (!text.startsWith('-')) return { sub: text, args: command.args.slice(at + 1), scope };
  }
  return null;
};

const NOT_A_COMMIT = /^(?:--dry-run|-h|--help|--porcelain|--short|--long)$/;
const QUIET = /^(?:--quiet|-[a-zA-Z]*q[a-zA-Z]*)$/;
const MOVES_HEAD = new Set(['checkout', 'switch', 'pull', 'merge', 'rebase', 'reset', 'cherry-pick', 'revert', 'am', 'commit']);
export const CHANGES_FOLDER: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd', 'set-location', 'sl', 'chdir']);
const LOG_ONE = /^(?:-1|-n1|--max-count=1)$/;
const LOG_FILTER = /^--(?:grep|author|committer|since|until|after|before|all|branches|remotes|tags|skip|reverse)(?:=|$)/;
const LOG_FORMAT = /^--(?:format|pretty)=/;

/** A read of the commit just made: `rev-parse [--short] HEAD`, or a one-commit `log` of HEAD whose format prints a hash. */
const readsHead = (git: GitCall): boolean => {
  const words = git.args.map((word) => word.text);
  if (git.sub === 'rev-parse') {
    // `--abbrev-ref` and `--symbolic` print a branch or a ref, never a sha.
    if (words.some((word) => word.startsWith('--abbrev-ref') || word.startsWith('--symbolic'))) return false;
    const refs = words.filter((word) => !word.startsWith('-'));
    return refs.length === 1 && refs[0] === 'HEAD';
  }
  if (git.sub !== 'log') return false;
  const count = words.indexOf('-n');
  const one = words.some((word) => LOG_ONE.test(word)) || (count >= 0 && words[count + 1] === '1');
  if (!one || words.includes('--') || words.some((word) => LOG_FILTER.test(word))) return false;
  const format = words.find((word) => LOG_FORMAT.test(word));
  if (format?.includes('%') === true && !/%[hH]/.test(format)) return false;
  return words.every((word, at) => word.startsWith('-') || word === 'HEAD' || (at === count + 1 && count >= 0));
};

/** Whether the call's final command reads this commit back. `commitsRead` takes the result's last hash-shaped line, and only the final command is sure to have printed it. */
const isReadBack = (commands: readonly ShellCommand[], from: number, scope: string): boolean => {
  for (let at = from; at + 1 < commands.length; at += 1) {
    // Behind `;` the commit may have failed, and the read names an older commit.
    if (commands[at]?.link === 'break') return false;
    const next = commands[at + 1];
    if (next === undefined || CHANGES_FOLDER.has(next.program)) return false;
    const git = gitCall(next);
    if (git !== null && MOVES_HEAD.has(git.sub)) return false;
    if (git?.scope === scope && readsHead(git)) return at + 2 === commands.length;
  }
  return false;
};

const commitPlanOf = (commands: readonly ShellCommand[]): PlannedCommit[] =>
  commands.flatMap((command, at) => {
    const git = gitCall(command);
    if (git === null || git.sub !== 'commit' || git.args.some((word) => !word.quoted && NOT_A_COMMIT.test(word.text))) return [];
    return [{ quiet: git.args.some((word) => !word.quoted && QUIET.test(word.text)), readBack: isReadBack(commands, at, git.scope) }];
  });

/** Every simple command of a shell call, in order, after the bodies are dropped and the command is redacted. Capture passes the dialect of the tool; `gate/checks.ts:524` and `projection.ts:95` call it with the POSIX default. */
export const shellCommands = (command: string, redact: Redactor, dialect: ShellDialect = 'posix'): ShellCommand[] => {
  const whole = command.replace(/\r\n/g, '\n');
  const kept = dropBodies(whole);
  const text = redactCommand(kept, redact);
  // The opaque point is the whole command's first single quote or heredoc marker. Dropping a body or redacting can remove it and leave a later one in its place, and the words between would read as before it: when the first point
  // moved or a point is gone, the whole text is opaque.
  const point = pointOf(dialect);
  const points = (held: string): number => held.match(new RegExp(point.source, 'g'))?.length ?? 0;
  const moved = kept.search(point) !== whole.search(point) || points(text) !== points(kept);
  return readCommands(tokenize(text, moved ? 0 : undefined, dialect));
};

/** A shell call's segments, pulls, and the commits it holds, from the command alone. The command is redacted before anything is kept. */
export const readShell = (command: string, redact: Redactor, dialect: ShellDialect = 'posix'): ShellRead => {
  const commands = shellCommands(command, redact, dialect);
  const kept = commands.slice(-SEGMENTS_PER_CALL_MAX);
  const pulls = new Map<string, ToolPull>();
  for (const { program, args } of commands) {
    for (const pull of pullsOfCommand(program, args).filter(present)) pulls.set(JSON.stringify(pull), pull);
  }
  return {
    words: commands.map(({ before, head, args }) => ({ before, head, args })),
    segments: kept.map((held) => ({ run: runOf(held), read: held.read })),
    steps: kept.map((held) => ({ identity: shellIdentity(held.program, held.args, pullsOfCommand(held.program, held.args).filter(present), redact), read: held.read, run: runOf(held) })),
    pulls: [...pulls.values()],
    commitPlan: commitPlanOf(commands),
  };
};

const COMMIT_LINE = /^\[[^\]\n]* ([0-9a-f]{7,40})\]/gm;
const COMMIT_REFUSED = /^(?:nothing to commit|nothing added to commit|no changes added to commit|fatal: |error: )/gm;
const HASH_LINE = /^(?:commit )?([0-9a-f]{7,40})(?=\s|$)/gm;

/**
 * What a clean result says about the planned commits: one entry per commit made, the sha when its `[branch sha]` line or a read-back
 * names it, else null, since a count may stand without a sha. A refused commit makes no entry: the call can be clean behind `; echo done`.
 */
export const commitsRead = (plan: readonly PlannedCommit[], result: string): Array<string | null> => {
  const lines = [...result.matchAll(COMMIT_LINE)].map((match) => match[1] ?? '');
  let refused = result.match(COMMIT_REFUSED)?.length ?? 0;
  const hash = [...result.matchAll(HASH_LINE)].at(-1)?.[1] ?? null;
  const commits: Array<string | null> = [];
  for (const planned of plan) {
    const line = planned.quiet ? undefined : lines.shift();
    if (line !== undefined) commits.push(line);
    else if (refused > 0) refused -= 1;
    else commits.push(planned.readBack ? hash : null);
  }
  return commits;
};

/** The longest MCP name tail masked slice by slice. A tool name is capped near 64 characters and a server name near that, so a longer tail is not a name. */
const MCP_TAIL_MAX = 192;

/**
 * The pattern rules of the redactor that can match across a `_`, and so across half of a separator: a class that allows `_` (`sk-`, `AIza`,
 * `github_pat_`, `eyJ`), and a NAME=value rule, whose value takes anything. `sk-` is the shape the rule is for (`sk-ant-`, 16 characters of the
 * class before any `_`, or a capital and a digit anywhere in the slice), so `sk-learn` and `task-sk-tools` are not taken for a key.
 */
const UNDERSCORE_TOKEN = /\b(?:sk-(?:ant-|[A-Za-z0-9-]{16}|(?=[\w-]*[A-Z])(?=[\w-]*\d))|AIza|github_pat_|eyJ)|[=:]/;

/** The pattern rules a Cursor name can hold across a `_`: a prefix that ends in `_`, plus the `UNDERSCORE_TOKEN` rules, since it has no `__` to cut at. */
const CURSOR_TOKEN = /\b(?:sk-(?:ant-|[A-Za-z0-9-]{16}|(?=[\w-]*[A-Z])(?=[\w-]*\d))|[srp]k_(?:live|test)_|AIza|github_pat_|gh[pousr]_|whsec_|eyJ)|[=:]/;

/**
 * What follows `mcp__` (or the Cursor `mcp_`) with every secret masked. A token is matched only at a word boundary and `_` is a word character, so
 * the redactor is run over every slice of the tail that starts at 0 or right after a `_` and ends at the end or right before a `_`. That
 * finds a token behind a `_`, in front of one, and one that holds `__` (`sk-`, `AIza`, `github_pat_`, and `eyJ` allow it). The slices are
 * quadratic in the number of underscores, so a tail past `MCP_TAIL_MAX` characters (which bounds that number) is stored as `<oversized>`.
 * The tool part comes from the operator's config as much as the server part does. A slice that holds `__`, or starts or ends at a `_` (it holds
 * half of a separator), is run through the redactor only when it holds one of the `UNDERSCORE_TOKEN` rules: otherwise the entropy rule reads two
 * harmless parts (`Context7__resolve-library-id`) as one random token, or eats the separator, and the server loses its name. A Cursor name has
 * no `__` to tell server from tool, so any slice that holds a `_` is run only for a `CURSOR_TOKEN` rule. Limits, each on the side of the secret
 * or an accepted miss: a public name that starts like a pattern rule (`sk-ant-tools`, `github_pat_helper`) loses its server, since it cannot be
 * told from a token that holds `__` (`sk-learn__PCA2Transform` and `task-sk-tools__Get2Items` are masked, since a tool part supplies the capital
 * and the digit); an `sk-` key with neither that holds a `_` before 16 characters, `mcp_sk-abc_defghijklmnopqrstuvwxyz_find`, is stored raw, since it
 * cannot be told from `mcp_sk-learn_fit_transform`; a name that holds `:` or `=` (`mcp__ns:Context7__resolve-library-id`,
 * `mcp__ns=Context7__resolve-library-id`) opens a NAME=value slice, so its parts are read as one token and the server is lost (no harness is known to
 * write such a name); a tool part of 24 characters or more with a capital and a digit is masked, since it cannot be told from a token; a token right
 * behind a Slack-shaped run keeps what that run's match leaves (`mcp_xoxb-1234567890-ghp_...` stores `mcp_<secret>_...`, `mcp__xoxb-a-eyJ...` keeps
 * the JWT's other segments), since no earlier start exists to finish it; and a random token with no pattern rule whose every part is under 24
 * characters (`TOKEN`'s minimum) cannot be told from two ordinary parts and is not found.
 */
const redactedMcpTail = (tail: string, redact: Redactor, cursor: boolean): string => {
  if (tail.length > MCP_TAIL_MAX) return '<oversized>';
  let out = tail;
  const starts = [0];
  for (let at = tail.indexOf('_'); at !== -1; at = tail.indexOf('_', at + 1)) starts.push(at + 1);
  // Last start first, so an edit never moves a start still to come; the longest slice first, so a token that holds a `_` is cut whole.
  for (const start of starts.toReversed()) {
    const ends = [out.length];
    for (let at = out.indexOf('_', start); at !== -1; at = out.indexOf('_', at + 1)) ends.push(at);
    for (const end of ends.toSorted((left, right) => right - left)) {
      const slice = out.slice(start, end);
      if (/__|^_|_$/.test(slice) && !UNDERSCORE_TOKEN.test(slice)) continue;
      if (cursor && slice.includes('_') && !CURSOR_TOKEN.test(slice)) continue;
      const masked = redact(slice);
      if (masked === slice) continue;
      out = out.slice(0, start) + masked + out.slice(end);
      break;
    }
  }
  // A Slack token stops at a `_`, but the redactor backtracks to its `-`, so the rest of the token follows the mask: it goes with the mask.
  // It goes last, since a later slice has to read a token that rest opens.
  return out.replace(/<secret>[A-Za-z0-9]+(?=_)/g, '<secret>');
};

/**
 * The tool name as a record stores it. An MCP name is `mcp__<server>__<tool>` (Cursor: `mcp_<server>_<tool>`) and the server comes from the
 * operator's config, where a token can sit, so everything after the prefix is redacted wherever the name is kept (the call, its error line,
 * the skeleton line, and the session's count).
 */
export const storedToolName = (name: string, redact: Redactor): string => {
  const prefix = name.startsWith('mcp__') ? 'mcp__' : name.startsWith('mcp_') ? 'mcp_' : null;
  if (prefix === null || name.length === prefix.length) return name;
  return `${prefix}${redactedMcpTail(name.slice(prefix.length), redact, prefix === 'mcp_')}`;
};

/** An MCP call's full server name, which `shortName` cuts for the tool sequence, redacted because a harness takes it from the operator's config. */
export const pullsOfTool = (name: string, redact: Redactor): ToolPull[] => {
  if (!name.startsWith('mcp__')) return [];
  const pull = wholeName('mcp', redactedMcpTail(name.slice('mcp__'.length), redact, false).split('__')[0] ?? '');
  return pull === null ? [] : [pull];
};

/** One step before its call's result is known. `rawKey` tells two calls with one masked identity apart, for a retry; it is never stored. */
interface StepDraft {
  action: CanonicalAction;
  native: string;
  identity: StepIdentity;
  read: boolean;
  rawKey: string;
}

/** A call's steps: one per command of a shell call, else one. */
const draftsOf = (table: ActionTable, named: { action: CanonicalAction; native: string }, native: string, shell: ShellRead | undefined, target: string | null, input: Obj, redact: Redactor): StepDraft[] => {
  const { action } = named;
  if (action === 'shell.exec') {
    const read = shell?.steps ?? [];
    if (read.length === 0) return [{ action, native: named.native, identity: UNREAD_SHELL, read: true, rawKey: `${native}\n${str(input.command) ?? ''}` }];
    return read.map((held) => ({ action, native: named.native, identity: held.identity, read: held.read, rawKey: `${native}\n${held.run}` }));
  }
  const url = str(input.url);
  const skill = str(input.skill);
  return [{ action, ...callIdentity(table, action, native, named.native, { skill, url, redact }), read: true, rawKey: `${native}\n${target ?? url ?? skill ?? ''}` }];
};

/** The `target` of a tool call (see {@link ToolObservation.target}). A path target also returns the `key` it was hashed on, read for its class and then dropped, never stored. */
export const targetOf = (
  tool: string,
  input: Obj,
  cwd: string | undefined,
  salt: string,
  redact: Redactor,
  root: string | null = null,
): { target: string | null; base: TargetBase | null; key?: string } => {
  for (const key of PATH_KEYS) {
    const value = str(input[key]);
    if (value !== undefined && value !== '') {
      const { hash, base, key: hashedKey } = hashPath(value, cwd, root, salt);
      return { target: hash, base, key: hashedKey };
    }
  }
  if (!SHELL.has(tool)) return { target: null, base: null };
  const target = shellTarget(str(input.command) ?? '');
  return { target: target === '' ? null : redact(target), base: null };
};

/** The `n` capture gives each call of a transcript, by tool-use id, the first copy of a repeated id winning; a subagent's steps name their parent by it without capturing the parent again. */
export const callPositions = (text: string): Map<string, number> => {
  const positions = new Map<string, number>();
  let n = 0;
  for (const raw of splitLines(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const content = isObj(parsed) && isObj(parsed.message) && parsed.type !== 'api-request-blob' ? parsed.message.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObj(block) || block.type !== 'tool_use') continue;
      const id = str(block.id);
      // Capture writes a replayed call once, so a replay takes no number here either.
      if (id !== undefined && positions.has(id)) continue;
      if (id !== undefined) positions.set(id, n);
      n += 1;
    }
  }
  return positions;
};

/** One pass over a transcript into its capture records and skeleton. Never throws on a malformed line: it counts it and goes on. */
export const captureSession = (input: ExtractInput): Capture => {
  const { redact } = input;
  const salt = input.salt ?? '';
  const sid = input.sid ?? null;
  const rootOf = input.repoRoot ?? ((): null => null);
  const identityOf = input.repoIdentity ?? ((root: string): string => `path:${toForward(root).toLowerCase()}`);
  const runtime = input.runtime ?? { oars: '0.0.0', node: process.version, os: process.platform };
  const origin = input.subagent;
  const harness: Harness = input.harness ?? 'claude-code';
  const actions = ACTION_TABLES[harness];
  const rawLines = input.text.split(/\r\n|\n|\r/);
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const session: SessionObservation = {
    kind: 'session',
    cv: CAPTURE_VERSION,
    sid,
    session: input.session,
    project: input.project,
    parent: origin?.parent ?? null,
    agentType: origin?.agentType ?? null,
    spawnedBy: origin?.spawnedBy ?? null,
    spawnedIn: origin?.spawnedIn ?? null,
    rev: input.rev,
    at: input.at,
    bytes: input.bytes,
    lines: rawLines.length,
    badLines: 0,
    userTurns: 0,
    assistantTurns: 0,
    tsFirst: null,
    tsLast: null,
    versions: [],
    models: {},
    branches: [],
    tools: {},
    files: [],
    fileHashes: [],
    repo: null,
    urls: [],
    searches: [],
    bashCmds: 0,
    tldrs: [],
    confidences: [],
    compactSummaries: 0,
    promptFingerprint: null,
    env: { harness: null, oars: runtime.oars, node: runtime.node, os: runtime.os },
    costUsd: null,
    usage: emptyUsage(),
  };
  const sessionCoverage = emptyCoverage();
  const versions = new Set<string>();
  const branches = new Set<string>();
  const files = new Set<string>();
  /** Redacted path to its salted hash, so `files` and `fileHashes` are cut from one set of paths. */
  const fileHashes = new Map<string, Set<string>>();
  let sessionRoot: string | null = null;
  const urls = new Set<string>();
  const searches = new Set<string>();

  const prompts: UserPromptObservation[] = [];
  const tools: ToolObservation[] = [];
  const errorLines: ErrorLineObservation[] = [];
  const skeletonLines: SkeletonLine[] = [];
  const toolById = new Map<string | undefined, string>();
  const callById = new Map<string, { call: ToolObservation; at: number | undefined; plan: readonly PlannedCommit[] }>();
  // The last call of each tool in each prompt, so the next one states what changed. Its raw input is held only while this transcript is read.
  const lastCall = new Map<string, ComparedCall>();
  // Packages named so far in this file, by package and version, so a call's `first` mark is true once per version.
  const seenPackages = new Set<string>();
  // A Read of a manifest shows its names in the result, so the call waits here for it, by tool_use id.
  const manifestReads = new Map<string, ManifestFile>();
  // The evidence for the frame: read across the whole file, so one session's prompts share a stack and a shell, and held only until the frame is built.
  const framePaths: string[] = [];
  const framePrograms = new Set<string>();
  const frameShells = new Map<string, number>();
  const fileEfforts = new Map<string, number>();
  const fileModels = new Map<string, number>();
  const fileMessageModels = new Map<string, number>();
  const promptFrames: PromptFrameParts[] = [];
  /** The steps of each call, by `n`, until its result is in. */
  const drafts: StepDraft[][] = [];
  const responseOfCall: Array<string | undefined> = [];
  const callsPerResponse = new Map<string, number>();
  const outputPerResponse = new Map<string, number>();
  const seenResponses = new Set<string>();
  /** The distinct messages that reported usage, by message key, and the tool-use ids each made (kept apart so a call on a line before the first usage line is still tied). */
  const messageGroups = new Map<string, MessageUsage>();
  const callsOfMessage = new Map<string, string[]>();
  let promptFingerprint: string | null = null;
  let cur: Current | undefined;
  // The setup, funnel, and trust shape. A subagent's run is the parent's, so it has no run of its own alone.
  const shape = createShape(harness, (tool) => storedToolName(tool, redact), { timing: origin === undefined });

  const finish = (): void => {
    if (cur === undefined) return;
    const wall = cur.t0 !== undefined && cur.t1 !== undefined && cur.t1 >= cur.t0 ? cur.t1 - cur.t0 : null;
    prompts.push({
      kind: 'user-prompt',
      cv: CAPTURE_VERSION,
      sid,
      session: input.session,
      rev: input.rev,
      index: cur.index,
      ts: cur.ts ?? null,
      wallSec: wall,
      head: cur.head,
      opened: cur.opened,
      thinking: cur.thinking,
      turns: cur.turns,
      model: majority(cur.models),
      efforts: [...cur.efforts].sort(),
      skills: [...cur.skills].sort(),
      usage: cur.usage,
      ...coverageFields(cur.coverage),
      promptFingerprint,
    });
    promptFrames.push({ version: cur.version, model: majorityOrNull(cur.models) ?? majorityOrNull(cur.messageModels), effort: majorityOrNull(cur.effortCounts), ts: cur.ts });
  };

  for (const [position, raw] of rawLines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      session.badLines += 1;
      continue;
    }
    if (!isObj(parsed)) {
      session.badLines += 1;
      continue;
    }
    const o = parsed;
    const type = str(o.type);
    const ts = str(o.timestamp);
    // A subagent transcript marks every line a sidechain; there they are the agent's own line.
    const side = origin === undefined && truthy(o.isSidechain);
    const message = isObj(o.message) ? o.message : undefined;
    const role = message === undefined ? undefined : str(message.role);
    const content = message?.content;

    // parse_sessions.py: session-level fields from every line.
    if (ts !== undefined && ts !== '') {
      if (session.tsFirst === null || ts < session.tsFirst) session.tsFirst = ts;
      if (session.tsLast === null || ts > session.tsLast) session.tsLast = ts;
    }
    const version = str(o.version);
    if (version !== undefined && version !== '') {
      versions.add(version);
      session.env.harness = version;
    }
    const lineCwd = str(o.cwd);
    if (sessionRoot === null && lineCwd !== undefined && lineCwd !== '') sessionRoot = rootOf(lineCwd);
    const branch = str(o.gitBranch);
    if (branch !== undefined && branch !== '') branches.add(redact(branch));
    const requested = str(o.requestedModel);
    if (requested !== undefined && requested !== '') {
      session.models[requested] = (session.models[requested] ?? 0) + 1;
      bump(fileModels, requested);
    }
    // A synthetic line is the harness speaking, not a model.
    const messageModel = message === undefined || type !== 'assistant' ? undefined : str(message.model);
    const realMessageModel = messageModel === undefined || messageModel === '' || messageModel === '<synthetic>' ? undefined : messageModel;
    if (realMessageModel !== undefined) bump(fileMessageModels, realMessageModel);
    if (truthy(o.effort)) bump(fileEfforts, String(o.effort));
    if (type === 'cost-state') {
      const cost = num(o.totalCostUSD);
      session.costUsd = cost ?? session.costUsd;
    }
    if (o.isCompactSummary === true) session.compactSummaries += 1;

    // Skeleton line: ids and structure, hashes in place of content.
    const lineUsage = message === undefined ? undefined : readUsage(message);
    const key = message === undefined ? undefined : responseKey(o, message);
    const firstOfResponse = key === undefined || !seenResponses.has(key);
    if (key !== undefined) seenResponses.add(key);
    const response = key ?? `line ${String(position)}`;
    if (lineUsage !== undefined && firstOfResponse) outputPerResponse.set(response, lineUsage.usage.output);
    const blocks = Array.isArray(content) ? content.filter(isObj) : [];
    skeletonLines.push({
      n: position + 1,
      type: type ?? null,
      uuid: str(o.uuid) ?? null,
      parentUuid: str(o.parentUuid) ?? null,
      ts: ts ?? null,
      role: role ?? null,
      tools: blocks.filter((block) => block.type === 'tool_use').map((block) => ({ id: str(block.id) ?? null, name: storedToolName(str(block.name) ?? '?', redact) })),
      results: blocks.filter((block) => block.type === 'tool_result').map((block) => str(block.tool_use_id) ?? null),
      usage: lineUsage?.usage ?? null,
      hasThinking: lineUsage?.hasThinking ?? false,
      model: (message === undefined ? undefined : str(message.model)) ?? requested ?? null,
      version: version ?? null,
      requestId: str(o.requestId) || null,
      apiBlockIndex: num(o.apiBlockIndex) ?? null,
      hashes: contentHashes(content),
      costState: type === 'cost-state' ? sumModelUsage(o.modelUsage, o.startTime) : null,
    });

    shape.read(o, { side, prompt: cur?.index ?? null });
    if (type === 'attachment') {
      const attachment = isObj(o.attachment) ? o.attachment : undefined;
      if (attachment?.type === 'prompt_snapshot' && attachment.systemPrompt !== undefined) promptFingerprint = sha256(JSON.stringify(attachment.systemPrompt)).slice(0, 12);
      session.promptFingerprint = promptFingerprint;
      continue;
    }
    // The harness's own copy of the request body: assistant and user messages with no cwd, uuid, or timestamp, repeating blocks the real lines
    // above already hold. Reading its tool_use, tool_result, thinking, and text blocks wrote a second row for 99.8% of calls, and a second error line,
    // thinking count, and TLDR for the same ones. The skeleton above still lists the line, so the counts and the root bind.
    if (message === undefined || type === 'api-request-blob') continue;

    if (type === 'user' && role === 'user' && o.isMeta !== true) {
      const text = firstNonEmptyText(content);
      if (text !== '' && !side) {
        session.userTurns += 1;
      }
    }
    // A message is the unit usage belongs to: the same id on every content-block line is one message, and a replayed line is the same one again.
    // Only Claude Code and Codex report per-message counts; another harness's totals are not a message's, and a synthetic line is the harness speaking.
    const messageKey = (harness === 'claude-code' || harness === 'codex') && messageModel !== '<synthetic>' && type === 'assistant' && role === 'assistant' ? str(message.id) || str(o.requestId) || `line ${String(position)}` : undefined;
    if (messageKey !== undefined && lineUsage !== undefined && !messageGroups.has(messageKey)) {
      const plan = planOf(o);
      messageGroups.set(messageKey, { id: str(message.id) || str(o.requestId) || null, calls: [], ...(side ? { side: true } : {}), ...reportedUsage(lineUsage), ...(plan === undefined ? {} : { plan }) });
    }
    if (type === 'assistant' && role === 'assistant') {
      session.assistantTurns += 1;
      if (!side && lineUsage !== undefined && firstOfResponse) {
        addUsage(session.usage, lineUsage.usage);
        addCoverage(sessionCoverage, lineUsage);
      }
    }

    // prompt_graphs.py and cost_per_class.py: a prompt is a main-line user line with text and no tool result. They also dropped any leading "<", which lost
    // every turn a command or a skill opened; that is now `promptOpening`'s call. A line from any other harness keeps the old rule.
    // A `!` shell command the operator typed, or an image they pasted with no words: neither opens a prompt (the tag is injected, the image has no text), but
    // both are the operator's turn. A line the agent did not write (a meta line, a local command, a synthetic reply) is neither the operator nor the agent.
    let operatorTurn = false;
    let harnessLine = type === 'assistant' && messageModel === '<synthetic>';
    if (type === 'user' && role === 'user' && !side && !hasToolResult(content)) {
      const leading = LEADING_TAG.exec(firstTextBlock(content).trimStart())?.[1];
      harnessLine = o.isMeta === true || (leading !== undefined && LOCAL_COMMAND_TAGS.has(leading));
      // `promptOpening` is Claude Code's alone: a prompt from any other harness that starts with `<` gets no opening below, yet it is still the operator typing, except the output of a `!` command, which is the harness's own line (an agent turn, as under Claude Code).
      operatorTurn = o.isMeta !== true && (leading === 'bash-input' || hasImage(content) || (harness !== 'claude-code' && leading !== 'bash-stdout' && leading !== 'bash-stderr' && firstTextBlock(content).startsWith('<')));
    }
    if (type === 'user' && role === 'user' && o.isMeta !== true && !side) {
      const text = firstTextBlock(content);
      const opening =
        text === '' || hasToolResult(content)
          ? undefined
          : harness === 'claude-code'
            ? promptOpening(text, rawLines, position, origin !== undefined)
            : text.startsWith('<')
              ? undefined
              : ({ opened: 'typed', request: text } satisfies PromptOpening);
      if (opening !== undefined) {
        // The harness's interrupt marker is a line it wrote after the operator pressed Esc, not a turn the operator took.
        // A compaction summary is the harness writing the session's history back, so the agent is still working through it.
        shape.turn(text.startsWith(INTERRUPT_MARKER) ? 'none' : o.isCompactSummary === true ? 'agent' : 'human', toSeconds(ts), str(o.uuid));
        finish();
        cur = {
          index: prompts.length,
          ts,
          t0: toSeconds(ts),
          t1: undefined,
          head: cut(redact(opening.request), PROMPT_HEAD_CHARS), // redact first: a key straddling the limit would otherwise lose its tail and slip past the patterns
          opened: opening.opened,
          thinking: 0,
          models: new Map(),
          efforts: new Set(),
          skills: new Set(),
          usage: emptyUsage(),
          coverage: emptyCoverage(),
          turns: 0,
          version: version !== undefined && version !== '' ? version : undefined,
          effortCounts: new Map(),
          messageModels: new Map(),
        };
        continue;
      }
    }

    // Anything else on the main line is the agent at work, an automated turn included: only the operator's own turn ends a run alone. A line the agent did not
    // write is skipped, since it would stretch the run to a time the agent never worked until.
    if (!side && (type === 'assistant' || type === 'user')) shape.turn(harnessLine ? 'none' : operatorTurn ? 'human' : 'agent', toSeconds(ts), str(o.uuid));
    if (cur !== undefined) {
      // cost_per_class.py reads wall time, turns, model, and tokens from main-line lines only.
      if (!side) {
        const seconds = toSeconds(ts);
        if (ts !== undefined && ts !== '' && seconds !== undefined) cur.t1 = seconds;
        if (version !== undefined && version !== '') cur.version = version;
        if (type === 'assistant') {
          cur.turns += 1;
          if (requested !== undefined && requested !== '') cur.models.set(requested, (cur.models.get(requested) ?? 0) + 1);
          if (realMessageModel !== undefined) bump(cur.messageModels, realMessageModel);
          if (lineUsage !== undefined && firstOfResponse) {
            addUsage(cur.usage, lineUsage.usage);
            addCoverage(cur.coverage, lineUsage);
          }
        }
      }
      // prompt_graphs.py reads efforts and skills from every line.
      if (truthy(o.effort)) {
        cur.efforts.add(String(o.effort));
        if (!side) bump(cur.effortCounts, String(o.effort));
      }
      if (truthy(o.attributionSkill)) cur.skills.add(String(o.attributionSkill));
    }

    if (!Array.isArray(content)) continue;
    const lineSeconds = toSeconds(ts);
    for (const block of content) {
      if (!isObj(block)) continue;
      const blockType = block.type;
      if (blockType === 'thinking' && cur !== undefined) cur.thinking += 1;
      if (blockType === 'text' && role === 'assistant') {
        const text = str(block.text) ?? '';
        for (const match of text.matchAll(TLDR_RE)) session.tldrs.push(cut(redact(match[1] ?? ''), 400));
        for (const match of text.matchAll(CONF_RE)) session.confidences.push(cut(redact(match[1] ?? ''), 120));
      } else if (blockType === 'tool_use') {
        const name = str(block.name) ?? '?';
        const id = str(block.id);
        // A resumed session replays earlier lines, so the same tool_use id comes again, often from another cwd (so a different path hash).
        // The first copy is the call and already holds the result; a replay would be a second row with status none. The skeleton
        // still lists every line, and a replayed failure stays an error line, as derive.ts counts it.
        if (id !== undefined && callById.has(id)) continue;
        const stored = storedToolName(name, redact);
        session.tools[stored] = (session.tools[stored] ?? 0) + 1;
        toolById.set(id, stored);
        const toolInput = isObj(block.input) ? block.input : {};
        // An adapter that renames its tools for the extractor keeps the harness's own name in `native`.
        const native = str(block.native) ?? name;
        const named = actionOf(actions, native);
        const shellName = shellOf(actions, native);
        if (shellName !== null) bump(frameShells, shellName);
        const filePath = str(toolInput.file_path);
        const lineRoot = lineCwd === undefined || lineCwd === '' ? null : rootOf(lineCwd);
        if (PATH_TOOLS.has(name) && filePath !== undefined && filePath !== '') {
          const redacted = redact(filePath);
          framePaths.push(filePath);
          files.add(redacted);
          // One redacted path can name several files (a relative path read from two repositories), so it keeps every hash.
          fileHashes.set(redacted, (fileHashes.get(redacted) ?? new Set<string>()).add(hashPath(filePath, lineCwd, lineRoot, salt).hash));
        } else if (name === 'WebFetch' && str(toolInput.url) !== undefined && str(toolInput.url) !== '') urls.add(redact(str(toolInput.url) ?? ''));
        else if (name === 'WebSearch' && str(toolInput.query) !== undefined && str(toolInput.query) !== '') searches.add(redact(str(toolInput.query) ?? ''));
        else if (SHELL.has(name)) session.bashCmds += 1;
        const aimed = targetOf(name, toolInput, lineCwd, salt, redact, lineRoot);
        const shell = SHELL.has(name) || named.action === 'shell.exec' ? readShell(str(toolInput.command) ?? '', redact, shellName === 'powershell' ? 'powershell' : 'posix') : undefined;
        for (const held of shell?.steps ?? []) framePrograms.add(held.identity.program);
        drafts.push(draftsOf(actions, named, native, shell, aimed.target, toolInput, redact));
        responseOfCall.push(response);
        callsPerResponse.set(response, (callsPerResponse.get(response) ?? 0) + 1);
        const manifestFile = PATH_TOOLS.has(name) && filePath !== undefined ? manifestFileOf(filePath) : null;
        const manifest = manifestFile === null ? undefined : manifestOfInput(manifestFile, name, toolInput, redact);
        if (manifestFile !== null && name === 'Read' && id !== undefined) manifestReads.set(id, manifestFile);
        const pulls = shell?.pulls ?? pullsOfTool(name, redact);
        const packages = packagesOf(pulls, seenPackages);
        // Who made the call, from its own line: the model is not the prompt's majority, and a line inside a skill's run names the skill (the first line after the run does not).
        const callModel = requested !== undefined && requested !== '' ? requested : realMessageModel;
        const callSkill = truthy(o.attributionSkill) ? String(o.attributionSkill) : undefined;
        // Depth reads below the repository root, else the working folder, as the target's hash does; a relative value is taken from the working folder first.
        const argFeatures = argFeaturesOf(native, toolInput, lineRoot ?? lineCwd, lineCwd);
        const argValues = argValuesOf(native, toolInput, CLOSED_ARG_VALUES);
        // A name is stored as the line's text is: masked at capture, so a credential-shaped folder or file name never reaches the store. The mask has no name shape, so the wire still drops it and counts it.
        const names = argNamesOf(native, toolInput, lineRoot ?? lineCwd, lineCwd, shell?.words ?? [], CLOSED_ARG_VALUES).map(({ kind, name }) => ({ kind, name: redact(name) }));
        const compared: ComparedCall = { input: toolInput, target: aimed.target, features: argFeatures, values: argValues };
        const lastKey = `${String(cur?.index ?? null)}\n${String(side)}\n${stored}`;
        const before = lastCall.get(lastKey);
        lastCall.set(lastKey, compared);
        const call: ToolObservation = {
          kind: 'tool',
          cv: CAPTURE_VERSION,
          sid,
          session: input.session,
          rev: input.rev,
          parent: origin?.parent ?? input.session,
          agentType: origin?.agentType ?? null,
          n: tools.length,
          ts: ts ?? null,
          tool: stored,
          status: 'none',
          target: aimed.target,
          targetBase: aimed.base,
          keys: Object.keys(toolInput).sort(),
          // The class reads the key the target is hashed on (relative to the repository or the cwd), never the absolute path: the folders above a repository say nothing about the file.
          targetClass: targetClassOf(aimed.key, aimed.base),
          argClass: argClassOf(toolInput),
          argFeatures,
          ...(argValues.length === 0 ? {} : { argValues }),
          ...(names.length === 0 ? {} : { names }),
          ...(before === undefined ? {} : { changeKind: changeKindOf(before, compared) }),
          durationMs: null,
          toolUseId: id ?? null,
          harnessVersion: version ?? null,
          ...(callModel === undefined ? {} : { model: callModel }),
          ...(callSkill === undefined ? {} : { skill: callSkill }),
          side,
          prompt: cur?.index ?? null,
          ...(shell === undefined ? {} : { segments: shell.segments }),
          ...(pulls.length === 0 ? {} : { pulls }),
          ...(packages.length === 0 ? {} : { packages }),
          ...(manifest === undefined ? {} : { manifest }),
        };
        tools.push(call);
        if (id !== undefined && messageKey !== undefined) callsOfMessage.set(messageKey, [...(callsOfMessage.get(messageKey) ?? []), id]);
        if (id !== undefined) callById.set(id, { call, at: lineSeconds, plan: shell?.commitPlan ?? [] });
      } else if (blockType === 'tool_result') {
        const text = resultText(block);
        const failed = isErrorResult(block, text);
        const answered = callById.get(str(block.tool_use_id) ?? '');
        if (answered !== undefined && answered.call.status === 'none') {
          const { call, at, plan } = answered;
          if (at !== undefined && lineSeconds !== undefined && o.noDuration !== true) call.durationMs = Math.round((lineSeconds - at) * 1000);
          call.status = failed ? 'error' : 'ok';
          if (failed) {
            call.errorCode = errorCodeOf(text);
            // An edit that did not apply changed no dependency: what its input showed is not what the file holds. A call with no result in the file (`status: 'none'`) keeps its manifest, since nothing shows it failed.
            delete call.manifest;
          }
          const read = manifestReads.get(str(block.tool_use_id) ?? '');
          const seen = read === undefined || failed ? [] : manifestNames(read, text, redact);
          if (read !== undefined && seen.length > 0) call.manifest = { file: read, seen, added: [], removed: [] };
          const commits = failed ? [] : commitsRead(plan, text);
          if (commits.length > 0) call.commits = commits;
        }
        if (!failed) continue;
        errorLines.push({
          kind: 'error-line',
          cv: CAPTURE_VERSION,
          sid,
          session: input.session,
          rev: input.rev,
          toolUseId: str(block.tool_use_id) ?? null,
          tool: toolById.get(str(block.tool_use_id)) ?? '?',
          // Redact first, then cut: a secret straddling the cut is masked.
          line: cut(redact(firstInformative(text)), ERROR_LINE_CHARS),
          ts: ts ?? null,
          harnessVersion: version ?? null,
          side,
          prompt: cur?.index ?? null,
          after: tools.length,
        });
      }
    }
  }
  finish();

  Object.assign(session, shape.finish(), coverageFields(sessionCoverage));
  session.versions = [...versions].sort();
  session.branches = [...branches].sort();
  const kept = [...files].sort().slice(0, FILES_PER_SESSION_MAX);
  session.files = kept;
  session.fileHashes = [...new Set(kept.flatMap((path) => [...(fileHashes.get(path) ?? [])]))].sort();
  session.repo = sessionRoot === null ? null : sha256(`${salt}\nrepo:${identityOf(sessionRoot)}`).slice(0, 16);
  session.urls = [...urls].sort();
  session.searches = [...searches].sort();

  const repoFiles = input.repoFiles ?? repoFilesFromIndex;
  // Only the first capture may look at the repository, so a frame does not follow it. The repository and `platform` are the two inputs here that are not
  // the transcript; the platform is read every time, so re-capturing the same transcript on another OS changes its `frameId`s.
  const size = input.repoSize !== undefined ? input.repoSize : sessionRoot === null ? null : repoSizeOf(repoFiles(sessionRoot));
  const stack = stackOf({ paths: framePaths, programs: [...framePrograms], size });
  const frameOf = (parts: PromptFrameParts): Frame =>
    closedFrame({
      harness,
      harnessVersion: parts.version ?? session.env.harness,
      model: parts.model,
      effort: parts.effort,
      day: utcDay(parts.ts),
      platform: runtime.os,
      shell: majorityOrNull(frameShells),
      stack,
    });
  const sessionFrame = frameOf({ version: undefined, model: majorityOrNull(fileModels) ?? majorityOrNull(fileMessageModels), effort: majorityOrNull(fileEfforts), ts: session.tsFirst ?? undefined });
  const sessionFrameId = frameIdOf(sessionFrame);
  session.frame = sessionFrame;
  session.frameId = sessionFrameId;
  for (const [index, parts] of promptFrames.entries()) {
    const prompt = prompts[index];
    if (prompt === undefined) continue;
    prompt.frame = frameOf(parts);
    prompt.frameId = frameIdOf(prompt.frame);
  }
  for (const [position, call] of tools.entries()) {
    const frameId = (call.prompt === null ? undefined : prompts[call.prompt]?.frameId) ?? sessionFrameId;
    const response = responseOfCall[position];
    const output = response === undefined ? undefined : outputPerResponse.get(response);
    const tokens = response === undefined || output === undefined || output === 0 ? null : Math.round(output / (callsPerResponse.get(response) ?? 1));
    const draftsOfCall = drafts[position] ?? [];
    // A failed call of several read commands (`a && b`) says that the call failed, not which command did: the result carries one exit, so no segment is `error` on that evidence and the failure stays on the call.
    const chainFailed = call.status === 'error' && draftsOfCall.filter((draft) => draft.read).length > 1;
    const allocated = tokens !== null && response !== undefined && (callsPerResponse.get(response) ?? 1) > 1;
    call.steps = draftsOfCall.map((draft, seg) => ({
      n: call.n,
      seg,
      action: draft.action,
      native: draft.native,
      identity: draft.identity,
      status: draft.read && !chainFailed ? call.status : 'none',
      cost: seg === 0 ? { tokens, durationMs: call.durationMs, ...(allocated ? { allocated: true } : {}) } : { tokens: null, durationMs: null },
      parent: origin?.spawnedAt ?? null,
      edges: [],
      frameId,
    }));
  }
  for (const [key, group] of messageGroups) group.calls = callsOfMessage.get(key) ?? [];
  if (messageGroups.size > 0) session.messageUsage = [...messageGroups.values()];
  // The strata: the file's evidence once, and each prompt's own `explore` from one pass over the calls. The size is the one the frame holds, so a re-capture that carries `repoSize` keeps `repoFiles` too.
  const packageNames = tools.flatMap((call) => [...(call.packages ?? []).map((pkg) => pkg.package), ...(call.manifest?.seen ?? []), ...(call.manifest?.added ?? [])]);
  const fileStrata = strataOf({ paths: framePaths, packages: packageNames, size });
  const exploreOfPrompt = new Map<number | null, number>();
  let explore = 0;
  for (const call of tools) {
    const looked = exploreCount((call.steps ?? []).map((step) => step.action));
    explore += looked;
    exploreOfPrompt.set(call.prompt, (exploreOfPrompt.get(call.prompt) ?? 0) + looked);
  }
  session.strata = { ...fileStrata, explore };
  for (const [position, prompt] of prompts.entries()) prompt.strata = { ...fileStrata, explore: exploreOfPrompt.get(position) ?? 0 };
  linkSteps(
    tools.map((call, position) => ({
      steps: call.steps ?? [],
      rawKeys: (drafts[position] ?? []).map((draft) => draft.rawKey),
      line: `${String(call.prompt)} ${String(call.side)}`,
      status: call.status,
    })),
    origin?.spawnedAt ?? null,
  );

  return {
    session,
    prompts,
    tools,
    errorLines,
    skeleton: {
      // Written at capture from raw, never rewritten by derive, so it carries the capture stamp.
      v: CAPTURE_VERSION,
      session: input.session,
      project: input.project,
      merkleRoot: merkleRoot(rawLines.map(sha256)),
      leaves: rawLines.length,
      lines: skeletonLines,
    },
  };
};
