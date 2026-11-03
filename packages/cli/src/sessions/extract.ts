// Capture: turns one transcript's text into its capture records and a skeleton in a single pass (derivation is `derive.ts`). The
// parsing rules are ported from the reference scripts in docs/research/2026-11-01-session-commons/ (parse_sessions.py, error_signatures.py, prompt_graphs.py,
// cost_per_class.py) so the counts agree: same normalization, same prompt boundaries, same class rule. Where two scripts
// read a thing differently the comment says which rule is used.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { ACTION_TABLES, actionOf, shellOf, type ActionTable, type CanonicalAction } from './actions.js';
import { closedFrame, frameIdOf, repoFilesFromIndex, stackOf, utcDay } from './frame.js';
import { linkSteps } from './graph.js';
import { callIdentity, shellIdentity, UNREAD_SHELL, type WordOfCommand } from './identity.js';
import type { Redactor } from './redact.js';
import {
  CAPTURE_VERSION,
  ERROR_LINE_CHARS,
  FILES_PER_SESSION_MAX,
  PROMPT_HEAD_CHARS,
  SIGNATURE_CHARS,
  type CostState,
  type ErrorLineObservation,
  type Frame,
  type Harness,
  type PromptClass,
  type PullEcosystem,
  type SessionObservation,
  type ShellIdentity,
  type ShellSegment,
  type Skeleton,
  type SkeletonLine,
  type StepIdentity,
  type TargetBase,
  type ToolObservation,
  type ToolPull,
  type Usage,
  type UsageKey,
  type UserPromptObservation,
} from './schema.js';

interface Obj {
  [key: string]: unknown;
}

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
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

const resultText = (block: Obj): string => {
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

const isErrorResult = (block: Obj, text: string): boolean => {
  if (truthy(block.is_error)) return true;
  const exit = EXIT_RE.exec(text.trim());
  return exit !== null && exit[1] !== '0';
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
}

/** cost_per_class.py: only numeric fields count; thinking comes from `output_tokens_details`. */
const readUsage = (message: Obj): LineUsage | undefined => {
  const raw = message.usage;
  if (!isObj(raw)) return undefined;
  const details = isObj(raw.output_tokens_details) ? raw.output_tokens_details : {};
  const thinking = num(details.thinking_tokens);
  return {
    usage: {
      input: num(raw.input_tokens) ?? 0,
      cacheWrite: num(raw.cache_creation_input_tokens) ?? 0,
      cacheRead: num(raw.cache_read_input_tokens) ?? 0,
      output: num(raw.output_tokens) ?? 0,
      thinking: thinking ?? 0,
    },
    hasThinking: thinking !== undefined,
  };
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
  /** The `n` of the `spawnedBy` call in the parent transcript, when the deposit could read it. */
  spawnedAt?: number | null;
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
  turns: number;
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

const firstTextBlock = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content) if (isObj(block) && block.type === 'text') return str(block.text) ?? '';
  return '';
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
export const hashPath = (path: string, cwd: string | undefined, root: string | null, salt: string): { hash: string; base: TargetBase } => {
  const { key, base } = pathKey(path, cwd, root);
  return { hash: sha256(`${salt}\n${key}`).slice(0, 16), base };
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
type ShellOp = '&&' | '||' | '|' | ';' | '&' | '\n' | 'group';
type ShellToken = ShellWord | ShellOp;
type ShellLink = 'and' | 'pipe' | 'break' | 'end';

/** One simple command, after its prelude. */
interface ShellCommand {
  program: string;
  args: ShellWord[];
  read: boolean;
  /** How the next command joins this one. */
  link: ShellLink;
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
  segments: ShellSegment[];
  /** The same commands as `segments`, in public names only, with the redacted text they compare by. */
  steps: ShellStepRead[];
  pulls: ToolPull[];
  commitPlan: PlannedCommit[];
}

const HEREDOC = /(?<!<)<<-?\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][\w.-]*))/g;
const HERE_STRING = /@(['"])\s*$/;

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
    const last = [...line.matchAll(HEREDOC)].at(-1);
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

const tokenize = (text: string): ShellToken[] => {
  const tokens: ShellToken[] = [];
  let word = '';
  let quoted = false;
  let started = false;
  let redirected = false;
  const flush = (): void => {
    if (started && redirected) redirected = false;
    else if (started && !quoted && (word === '{' || word === '}')) tokens.push('group');
    else if (started) tokens.push({ text: word, quoted });
    word = '';
    quoted = false;
    started = false;
  };
  const op = (token: ShellOp): void => {
    flush();
    redirected = false;
    const last = tokens.at(-1);
    // A line that ends in an operator continues on the next one.
    if (token === '\n' && (last === undefined || last === '&&' || last === '||' || last === '|' || last === '\n')) return;
    tokens.push(token);
  };
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    const next = text.charAt(at + 1);
    if (char === "'") {
      const end = text.indexOf("'", at + 1);
      const stop = end < 0 ? text.length : end;
      word += text.slice(at + 1, stop);
      quoted = true;
      started = true;
      at = stop + 1;
    } else if (char === '"') {
      quoted = true;
      started = true;
      at += 1;
      while (at < text.length && text.charAt(at) !== '"') {
        if (text.charAt(at) === '\\' && text.charAt(at + 1) === '\n') at += 2;
        else if (text.charAt(at) === '\\' && text.charAt(at + 1) === '"') {
          word += '"';
          at += 2;
        } else {
          word += text.charAt(at);
          at += 1;
        }
      }
      at += 1;
    } else if ((char === '\\' || char === '`') && next === '\n') {
      at += 2;
    } else if (char === '\\' && next !== '' && /[\s&|;()<>'"]/.test(next)) {
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
      op('group');
      at += 1;
    } else {
      word += char;
      started = true;
      at += 1;
    }
  }
  flush();
  return tokens;
};

/** A block keyword names no program, and its condition or body is the command. `for` stays: its words say what it walks. */
const BLOCK_WORDS = new Set(['if', 'then', 'elif', 'else', 'elseif', 'do', 'while', 'until', 'fi', 'done', 'esac', 'try', 'finally', '!']);
const WRAPPERS = new Set(['sudo', 'env', '.', 'command', 'exec', 'nohup', 'nice', 'time', 'call']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The words from the command's real program on. */
const afterPrelude = (words: readonly ShellWord[]): readonly ShellWord[] => {
  let at = 0;
  for (;;) {
    const word = words[at];
    if (word === undefined) return [];
    if (word.quoted) return words.slice(at);
    if (BLOCK_WORDS.has(word.text) || ASSIGNMENT.test(word.text)) at += 1;
    else if (WRAPPERS.has(word.text) || word.text === 'timeout') {
      const isTimeout = word.text === 'timeout';
      at += 1;
      while (words[at]?.text.startsWith('-') === true) at += 1;
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

/** The shells that run every word after the flag as the command. `bash -c npm test` runs `npm` with `test` as `$0`, so bash and its kin take one word. */
const JOINING_SHELLS = new Set(['pwsh', 'powershell', 'cmd']);

/**
 * The command a shell is told to run: `bash -lc "..."`, `pwsh -NoProfile -Command "..."`, `cmd /c ...`. A joining shell's unquoted words pass as
 * they are, not joined into text and read again, so a quoted `-m "a && b"` stays an argument.
 */
const shellArgument = (program: string, args: readonly ShellWord[]): readonly ShellToken[] | null => {
  if (!SHELLS.has(program)) return null;
  const flag = args.findIndex((word) => !word.quoted && COMMAND_FLAG.test(word.text));
  const first = flag < 0 ? undefined : args[flag + 1];
  if (first === undefined) return null;
  return JOINING_SHELLS.has(program) && !first.quoted ? args.slice(flag + 1) : tokenize(first.text);
};

const linkOf = (ops: readonly ShellOp[]): ShellLink => {
  if (ops.some((op) => op === ';' || op === '&' || op === '||' || op === '\n')) return 'break';
  return ops.includes('|') ? 'pipe' : 'and';
};

/** Every simple command in order, with whether the call's status reports it. A shell's argument takes the place of the shell, under the shell's own read. */
const readCommands = (tokens: readonly ShellToken[]): ShellCommand[] => {
  const commands: ShellCommand[] = [];
  let pending: ShellOp[] = [];
  let words: ShellWord[] = [];
  const close = (): void => {
    const real = afterPrelude(words);
    words = [];
    const [head, ...args] = real;
    const program = head === undefined ? null : programOf(head);
    if (program === null) return;
    const previous = commands.at(-1);
    if (previous !== undefined) previous.link = linkOf(pending);
    pending = [];
    commands.push({ program, args, read: true, link: 'end' });
  };
  for (const token of tokens) {
    if (typeof token === 'string') {
      close();
      pending.push(token);
    } else words.push(token);
  }
  close();
  // Walking back, a later `;`, `&`, newline, or `||` means the status is no longer this command's; a pipe hides only the command it follows.
  let overridden = pending.includes('&');
  for (const command of commands.toReversed()) {
    if (command.link === 'break') overridden = true;
    command.read = !overridden && command.link !== 'pipe';
  }
  return commands.flatMap((command) => {
    const argument = shellArgument(command.program, command.args);
    if (argument === null) return [command];
    const inner = readCommands(argument);
    if (inner.length === 0) return [command];
    for (const held of inner) held.read &&= command.read;
    const last = inner.at(-1);
    if (last !== undefined) last.link = command.link;
    return inner;
  });
};

const isPlainWord = (word: ShellWord): boolean => !word.quoted && word.text !== '' && !/^-|\$|[\\/]/.test(word.text);

const runOf = (command: ShellCommand): string =>
  [command.program, ...command.args.filter(isPlainWord).map((word) => cut(word.text, RUN_WORD_CHARS))].slice(0, RUN_WORDS_MAX).join(' ');

/** Positional words and flag values. A flag in `takesValue` owns the next word, which is therefore not a name. */
const parseArgs = (args: readonly ShellWord[], takesValue: ReadonlySet<string>): { names: string[]; flags: Map<string, string> } => {
  const names: string[] = [];
  const flags = new Map<string, string>();
  for (let at = 0; at < args.length; at += 1) {
    const text = args[at]?.text ?? '';
    if (!text.startsWith('-')) names.push(text);
    else if (text.includes('=')) flags.set(text.slice(0, text.indexOf('=')), text.slice(text.indexOf('=') + 1));
    else if (takesValue.has(text)) {
      flags.set(text, args[at + 1]?.text ?? '');
      at += 1;
    }
  }
  return { names, flags };
};

const NODE_VALUE_FLAGS = new Set(['-w', '--workspace', '--registry', '--prefix', '--filter', '-F', '-C', '--dir', '--cache', '--tag', '--cwd', '--loglevel', '--userconfig', '-p', '--package', '-c', '--call', '--omit', '--include', '--save-prefix', '--skill', '-s']);
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

/** `name@version`, keeping a leading `@` with the name. */
const atVersion = (ecosystem: PullEcosystem, text: string): ToolPull | null => {
  const at = text.lastIndexOf('@');
  const name = at > 0 ? text.slice(0, at) : text;
  const version = at > 0 ? text.slice(at + 1) : '';
  if (namesNothing(name)) return null;
  return { ecosystem, name, version: version === '' || version.includes('$') ? null : version };
};

const wholeName = (ecosystem: PullEcosystem, text: string): ToolPull | null => (namesNothing(text) ? null : { ecosystem, name: text, version: null });

const nodeSpec = (text: string): ToolPull | null => {
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
  const version = stated === '' || stated.includes('$') ? null : operator === '==' || operator === '===' || operator === '@' ? stated : `${operator}${stated}`;
  return { ecosystem: 'pypi', name: match[1] ?? '', version };
};

/** A module path's first element has a dot; `fmt`, `cmd/x`, and `all` are not downloads. */
const goSpec = (text: string): ToolPull | null => (/^(?:<org-domain>|[A-Za-z0-9-]+\.[^/\\]+)\//.test(text) ? atVersion('go', text) : null);

const localOr = (ecosystem: PullEcosystem, text: string): ToolPull | null => (LOCAL_SPEC.test(text) ? null : atVersion(ecosystem, text));

const present = (pull: ToolPull | null): pull is ToolPull => pull !== null;

/** `npx`, `bunx`, and `dlx` run one package: a `--package` flag names it, else the first word. `skills add` installs a skill rather than running a tool. */
const runnerPulls = (names: readonly string[], flags: ReadonlyMap<string, string>): Array<ToolPull | null> => {
  const [first, sub, source] = names;
  if (first !== undefined && atVersion('npm', first)?.name === 'skills' && sub === 'add' && source !== undefined) return [LOCAL_SPEC.test(source) ? null : wholeName('skill', source)];
  const packaged = flags.get('-p') ?? flags.get('--package');
  if (packaged !== undefined) return [nodeSpec(packaged)];
  return first === undefined ? [] : [nodeSpec(first)];
};

const nodePulls = (args: readonly ShellWord[]): Array<ToolPull | null> => {
  const { names, flags } = parseArgs(args, NODE_VALUE_FLAGS);
  const [sub, ...specs] = names[0] === 'global' ? names.slice(1) : names;
  if (sub === 'dlx') return runnerPulls(specs, flags);
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
    .map((pull) => (pull !== null && pull.version === null && stated !== undefined && stated !== '' ? { ...pull, version: stated } : pull));

const pullsOfCommand = (program: string, args: readonly ShellWord[]): Array<ToolPull | null> => {
  if (program === 'npm' || program === 'pnpm' || program === 'yarn' || program === 'bun') return nodePulls(args);
  if (program === 'npx' || program === 'bunx') {
    const { names, flags } = parseArgs(args, NODE_VALUE_FLAGS);
    return runnerPulls(names, flags);
  }
  if (/^pip[\d.]*$/.test(program)) return pipPulls(args);
  if (/^(?:python[\d.]*|py)$/.test(program)) {
    const module = args.findIndex((word) => word.text === '-m');
    return module >= 0 && /^pip[\d.]*$/.test(args[module + 1]?.text ?? '') ? pipPulls(args.slice(module + 2)) : [];
  }
  if (program === 'uv') return uvPulls(args);
  if (program === 'uvx') return uvxPulls(args);
  if (program === 'pipx') return pipxPulls(args);
  if (program === 'cargo') {
    const { names, flags } = parseArgs(args, CARGO_VALUE_FLAGS);
    return names[0] === 'add' || names[0] === 'install' ? versionedPulls('cargo', names.slice(1), flags.get('--version') ?? flags.get('--vers')) : [];
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

const gitCall = (command: ShellCommand): GitCall | null => {
  if (command.program !== 'git') return null;
  let scope = '';
  for (let at = 0; at < command.args.length; at += 1) {
    const text = command.args[at]?.text ?? '';
    if (GIT_VALUE_FLAGS.has(text)) {
      if (text !== '-c') scope += `${text} ${command.args[at + 1]?.text ?? ''};`;
      at += 1;
    } else if (!text.startsWith('-')) return { sub: text, args: command.args.slice(at + 1), scope };
  }
  return null;
};

const NOT_A_COMMIT = /^(?:--dry-run|-h|--help|--porcelain|--short|--long)$/;
const QUIET = /^(?:--quiet|-[a-zA-Z]*q[a-zA-Z]*)$/;
const MOVES_HEAD = new Set(['checkout', 'switch', 'pull', 'merge', 'rebase', 'reset', 'cherry-pick', 'revert', 'am', 'commit']);
const CHANGES_FOLDER = new Set(['cd', 'pushd', 'popd', 'set-location', 'sl', 'chdir']);
const LOG_ONE = /^(?:-1|-n1|--max-count=1)$/;
const LOG_FILTER = /^--(?:grep|author|committer|since|until|after|before|all|branches|remotes|tags|skip|reverse)(?:=|$)/;
const LOG_FORMAT = /^--(?:format|pretty)=/;

/** A read of the commit just made: `rev-parse [--short] HEAD`, or a one-commit `log` of HEAD whose format prints a hash. */
const readsHead = (git: GitCall): boolean => {
  const words = git.args.map((word) => word.text);
  if (git.sub === 'rev-parse') {
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
    if (git === null || git.sub !== 'commit' || git.args.some((word) => NOT_A_COMMIT.test(word.text))) return [];
    return [{ quiet: git.args.some((word) => !word.quoted && QUIET.test(word.text)), readBack: isReadBack(commands, at, git.scope) }];
  });

/** A shell call's segments, pulls, and the commits it holds, from the command alone. The command is redacted before anything is kept. */
export const readShell = (command: string, redact: Redactor): ShellRead => {
  const commands = readCommands(tokenize(redactCommand(dropBodies(command.replace(/\r\n/g, '\n')), redact)));
  const kept = commands.slice(-SEGMENTS_PER_CALL_MAX);
  const pulls = new Map<string, ToolPull>();
  for (const { program, args } of commands) {
    for (const pull of pullsOfCommand(program, args).filter(present)) pulls.set(JSON.stringify(pull), pull);
  }
  return {
    segments: kept.map((held) => ({ run: runOf(held), read: held.read })),
    steps: kept.map((held) => ({ identity: shellIdentity(held.program, held.args, pullsOfCommand(held.program, held.args).filter(present)), read: held.read, run: runOf(held) })),
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

/** An MCP call's full server name, which `shortName` cuts for the tool sequence, redacted because a harness takes it from the operator's config. */
export const pullsOfTool = (name: string, redact: Redactor): ToolPull[] => {
  const pull = name.startsWith('mcp__') ? wholeName('mcp', redact(name.split('__')[1] ?? '')) : null;
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
const draftsOf = (table: ActionTable, named: { action: CanonicalAction; native: string }, native: string, shell: ShellRead | undefined, target: string | null, input: Obj): StepDraft[] => {
  const { action } = named;
  if (action === 'shell.exec') {
    const read = shell?.steps ?? [];
    if (read.length === 0) return [{ action, native: named.native, identity: UNREAD_SHELL, read: true, rawKey: `${native}\n${str(input.command) ?? ''}` }];
    return read.map((held) => ({ action, native: named.native, identity: held.identity, read: held.read, rawKey: `${native}\n${held.run}` }));
  }
  const url = str(input.url);
  const skill = str(input.skill);
  return [{ action, ...callIdentity(table, action, native, named.native, { skill, url }), read: true, rawKey: `${native}\n${target ?? url ?? skill ?? ''}` }];
};

/** The `target` of a tool call (see {@link ToolObservation.target}). */
export const targetOf = (
  tool: string,
  input: Obj,
  cwd: string | undefined,
  salt: string,
  redact: Redactor,
  root: string | null = null,
): { target: string | null; base: TargetBase | null } => {
  for (const key of PATH_KEYS) {
    const value = str(input[key]);
    if (value !== undefined && value !== '') {
      const { hash, base } = hashPath(value, cwd, root, salt);
      return { target: hash, base };
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
    const content = isObj(parsed) && isObj(parsed.message) ? parsed.message.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObj(block) || block.type !== 'tool_use') continue;
      const id = str(block.id);
      if (id !== undefined && !positions.has(id)) positions.set(id, n);
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
  let promptFingerprint: string | null = null;
  let cur: Current | undefined;

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
      thinking: cur.thinking,
      turns: cur.turns,
      model: majority(cur.models),
      efforts: [...cur.efforts].sort(),
      skills: [...cur.skills].sort(),
      usage: cur.usage,
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
      tools: blocks.filter((block) => block.type === 'tool_use').map((block) => ({ id: str(block.id) ?? null, name: str(block.name) ?? '?' })),
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

    if (type === 'attachment') {
      const attachment = isObj(o.attachment) ? o.attachment : undefined;
      if (attachment?.type === 'prompt_snapshot' && attachment.systemPrompt !== undefined) promptFingerprint = sha256(JSON.stringify(attachment.systemPrompt)).slice(0, 12);
      session.promptFingerprint = promptFingerprint;
      continue;
    }
    if (message === undefined) continue;

    if (type === 'user' && role === 'user' && o.isMeta !== true) {
      const text = firstNonEmptyText(content);
      if (text !== '' && !side) {
        session.userTurns += 1;
      }
    }
    if (type === 'assistant' && role === 'assistant') {
      session.assistantTurns += 1;
      if (!side && lineUsage !== undefined && firstOfResponse) addUsage(session.usage, lineUsage.usage);
    }

    // prompt_graphs.py and cost_per_class.py: a prompt is a main-line user line with text, no tool result, and no leading "<".
    if (type === 'user' && role === 'user' && o.isMeta !== true && !side) {
      const text = firstTextBlock(content);
      const hasResult = Array.isArray(content) && content.some((block: unknown) => isObj(block) && block.type === 'tool_result');
      if (text !== '' && !hasResult && !text.startsWith('<')) {
        finish();
        cur = {
          index: prompts.length,
          ts,
          t0: toSeconds(ts),
          t1: undefined,
          head: cut(redact(text), PROMPT_HEAD_CHARS), // redact first: a key straddling the limit would otherwise lose its tail and slip past the patterns
          thinking: 0,
          models: new Map(),
          efforts: new Set(),
          skills: new Set(),
          usage: emptyUsage(),
          turns: 0,
          version: version !== undefined && version !== '' ? version : undefined,
          effortCounts: new Map(),
          messageModels: new Map(),
        };
        continue;
      }
    }

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
          if (lineUsage !== undefined && firstOfResponse) addUsage(cur.usage, lineUsage.usage);
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
        session.tools[name] = (session.tools[name] ?? 0) + 1;
        const id = str(block.id);
        toolById.set(id, name);
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
        const shell = SHELL.has(name) || named.action === 'shell.exec' ? readShell(str(toolInput.command) ?? '', redact) : undefined;
        for (const held of shell?.steps ?? []) framePrograms.add(held.identity.program);
        drafts.push(draftsOf(actions, named, native, shell, aimed.target, toolInput));
        // A repeat of a call a resumed session copied holds no share: the first copy already has it.
        const repeat = id !== undefined && callById.has(id);
        responseOfCall.push(repeat ? undefined : response);
        if (!repeat) callsPerResponse.set(response, (callsPerResponse.get(response) ?? 0) + 1);
        const pulls = shell?.pulls ?? pullsOfTool(name, redact);
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
          tool: name,
          status: 'none',
          target: aimed.target,
          targetBase: aimed.base,
          keys: Object.keys(toolInput).sort(),
          durationMs: null,
          toolUseId: id ?? null,
          harnessVersion: version ?? null,
          side,
          prompt: cur?.index ?? null,
          ...(shell === undefined ? {} : { segments: shell.segments }),
          ...(pulls.length === 0 ? {} : { pulls }),
        };
        tools.push(call);
        // A resumed session repeats earlier lines: the first copy of a call carries its result, a repeat keeps status none.
        if (id !== undefined && !callById.has(id)) callById.set(id, { call, at: lineSeconds, plan: shell?.commitPlan ?? [] });
      } else if (blockType === 'tool_result') {
        const text = resultText(block);
        const failed = isErrorResult(block, text);
        const answered = callById.get(str(block.tool_use_id) ?? '');
        if (answered !== undefined && answered.call.status === 'none') {
          const { call, at, plan } = answered;
          if (at !== undefined && lineSeconds !== undefined && o.noDuration !== true) call.durationMs = Math.round((lineSeconds - at) * 1000);
          call.status = failed ? 'error' : 'ok';
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

  session.versions = [...versions].sort();
  session.branches = [...branches].sort();
  const kept = [...files].sort().slice(0, FILES_PER_SESSION_MAX);
  session.files = kept;
  session.fileHashes = [...new Set(kept.flatMap((path) => [...(fileHashes.get(path) ?? [])]))].sort();
  session.repo = sessionRoot === null ? null : sha256(`${salt}\nrepo:${identityOf(sessionRoot)}`).slice(0, 16);
  session.urls = [...urls].sort();
  session.searches = [...searches].sort();

  const repoFiles = input.repoFiles ?? repoFilesFromIndex;
  const stack = stackOf({ paths: framePaths, programs: [...framePrograms], repoFiles: sessionRoot === null ? null : repoFiles(sessionRoot) });
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
    call.steps = (drafts[position] ?? []).map((draft, seg) => ({
      n: call.n,
      seg,
      action: draft.action,
      native: draft.native,
      identity: draft.identity,
      status: draft.read ? call.status : 'none',
      cost: seg === 0 ? { tokens, durationMs: call.durationMs } : { tokens: null, durationMs: null },
      parent: origin?.spawnedAt ?? null,
      edges: [],
      frameId,
    }));
  }
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
