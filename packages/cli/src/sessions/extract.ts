// Capture: turns one transcript's text into its capture records and a skeleton in a single pass (derivation is `derive.ts`). The
// parsing rules are ported from the reference scripts in docs/research/2026-11-01-session-commons/ (parse_sessions.py, error_signatures.py, prompt_graphs.py,
// cost_per_class.py) so the counts agree: same normalization, same prompt boundaries, same class rule. Where two scripts
// read a thing differently the comment says which rule is used.
import { createHash } from 'node:crypto';
import type { Redactor } from './redact.js';
import {
  CAPTURE_VERSION,
  EXTRACTOR_VERSION,
  PROMPT_HEAD_CHARS,
  SIGNATURE_CHARS,
  type CostState,
  type ErrorLineObservation,
  type PromptClass,
  type SessionObservation,
  type Skeleton,
  type SkeletonLine,
  type ToolObservation,
  type Usage,
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
const SHELL = new Set(['Bash', 'PowerShell']);
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
  const totals: CostState = { since: isoOfMillis(startTime), input: null, cacheWrite: null, cacheRead: null, output: null };
  const add = (key: Exclude<keyof CostState, 'since'>, ...names: string[]): void => {
    for (const model of Object.values(value)) {
      if (!isObj(model)) continue;
      for (const name of names) {
        const amount = num(model[name]);
        if (amount !== undefined) totals[key] = (totals[key] ?? 0) + amount;
      }
    }
  };
  add('input', 'inputTokens', 'input_tokens');
  add('cacheWrite', 'cacheCreationInputTokens', 'cache_creation_input_tokens');
  add('cacheRead', 'cacheReadInputTokens', 'cache_read_input_tokens');
  add('output', 'outputTokens', 'output_tokens');
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

const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const;

/** A path relative to the line's working directory when it lies under it (compared without case, as Windows paths are), else as written. */
const relativeTo = (path: string, cwd: string | undefined): string => {
  const forward = path.replace(/\\/g, '/');
  if (cwd === undefined) return forward;
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return forward.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? forward.slice(base.length + 1) : forward;
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

/** The `target` of a tool call (see {@link ToolObservation.target}). */
export const targetOf = (tool: string, input: Obj, cwd: string | undefined, salt: string, redact: Redactor): string | null => {
  for (const key of PATH_KEYS) {
    const value = str(input[key]);
    if (value !== undefined && value !== '') return sha256(`${salt}\n${relativeTo(value, cwd)}`).slice(0, 16);
  }
  if (!SHELL.has(tool)) return null;
  const target = shellTarget(str(input.command) ?? '');
  return target === '' ? null : redact(target);
};

/** One pass over a transcript into its capture records and skeleton. Never throws on a malformed line: it counts it and goes on. */
export const captureSession = (input: ExtractInput): Capture => {
  const { redact } = input;
  const salt = input.salt ?? '';
  const origin = input.subagent;
  const rawLines = input.text.split(/\r\n|\n|\r/);
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const session: SessionObservation = {
    kind: 'session',
    cv: CAPTURE_VERSION,
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
    urls: [],
    searches: [],
    bashCmds: 0,
    tldrs: [],
    confidences: [],
    compactSummaries: 0,
    contextFingerprint: null,
    costUsd: null,
    usage: emptyUsage(),
  };
  const versions = new Set<string>();
  const branches = new Set<string>();
  const files = new Set<string>();
  const urls = new Set<string>();
  const searches = new Set<string>();

  const prompts: UserPromptObservation[] = [];
  const tools: ToolObservation[] = [];
  const errorLines: ErrorLineObservation[] = [];
  const skeletonLines: SkeletonLine[] = [];
  const toolById = new Map<string | undefined, string>();
  const callById = new Map<string, { call: ToolObservation; at: number | undefined }>();
  const seenResponses = new Set<string>();
  let envFingerprint: string | undefined;
  let promptFingerprint: string | undefined;
  let fingerprint: string | null = null;
  let cur: Current | undefined;

  const finish = (): void => {
    if (cur === undefined) return;
    const wall = cur.t0 !== undefined && cur.t1 !== undefined && cur.t1 >= cur.t0 ? cur.t1 - cur.t0 : null;
    prompts.push({
      kind: 'user-prompt',
      cv: CAPTURE_VERSION,
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
      contextFingerprint: fingerprint,
    });
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
    if (version !== undefined && version !== '') versions.add(version);
    const branch = str(o.gitBranch);
    if (branch !== undefined && branch !== '') branches.add(redact(branch));
    const requested = str(o.requestedModel);
    if (requested !== undefined && requested !== '') session.models[requested] = (session.models[requested] ?? 0) + 1;
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
      if (attachment?.type === 'environment' && attachment.snapshot !== undefined) envFingerprint = sha256(JSON.stringify(attachment.snapshot)).slice(0, 12);
      if (attachment?.type === 'prompt_snapshot' && attachment.systemPrompt !== undefined) promptFingerprint = sha256(JSON.stringify(attachment.systemPrompt)).slice(0, 12);
      fingerprint = envFingerprint === undefined && promptFingerprint === undefined ? fingerprint : `${promptFingerprint ?? '-'}.${envFingerprint ?? '-'}`;
      session.contextFingerprint = fingerprint;
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
        };
        continue;
      }
    }

    if (cur !== undefined) {
      // cost_per_class.py reads wall time, turns, model, and tokens from main-line lines only.
      if (!side) {
        const seconds = toSeconds(ts);
        if (ts !== undefined && ts !== '' && seconds !== undefined) cur.t1 = seconds;
        if (type === 'assistant') {
          cur.turns += 1;
          if (requested !== undefined && requested !== '') cur.models.set(requested, (cur.models.get(requested) ?? 0) + 1);
          if (lineUsage !== undefined && firstOfResponse) addUsage(cur.usage, lineUsage.usage);
        }
      }
      // prompt_graphs.py reads efforts and skills from every line.
      if (truthy(o.effort)) cur.efforts.add(String(o.effort));
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
        if (PATH_TOOLS.has(name) && str(toolInput.file_path) !== undefined && str(toolInput.file_path) !== '') files.add(redact(str(toolInput.file_path) ?? ''));
        else if (name === 'WebFetch' && str(toolInput.url) !== undefined && str(toolInput.url) !== '') urls.add(redact(str(toolInput.url) ?? ''));
        else if (name === 'WebSearch' && str(toolInput.query) !== undefined && str(toolInput.query) !== '') searches.add(redact(str(toolInput.query) ?? ''));
        else if (SHELL.has(name)) session.bashCmds += 1;
        const call: ToolObservation = {
          kind: 'tool',
          cv: CAPTURE_VERSION,
          session: input.session,
          rev: input.rev,
          parent: origin?.parent ?? input.session,
          agentType: origin?.agentType ?? null,
          n: tools.length,
          ts: ts ?? null,
          tool: name,
          status: 'none',
          target: targetOf(name, toolInput, str(o.cwd), salt, redact),
          keys: Object.keys(toolInput).sort(),
          durationMs: null,
          toolUseId: id ?? null,
          harnessVersion: version ?? null,
          side,
          prompt: cur?.index ?? null,
        };
        tools.push(call);
        // A resumed session repeats earlier lines: the first copy of a call carries its result, a repeat keeps status none.
        if (id !== undefined && !callById.has(id)) callById.set(id, { call, at: lineSeconds });
      } else if (blockType === 'tool_result') {
        const text = resultText(block);
        const failed = isErrorResult(block, text);
        const answered = callById.get(str(block.tool_use_id) ?? '');
        if (answered !== undefined && answered.call.status === 'none') {
          const { call, at } = answered;
          if (at !== undefined && lineSeconds !== undefined) call.durationMs = Math.round((lineSeconds - at) * 1000);
          call.status = failed ? 'error' : 'ok';
        }
        if (!failed) continue;
        errorLines.push({
          kind: 'error-line',
          cv: CAPTURE_VERSION,
          session: input.session,
          rev: input.rev,
          toolUseId: str(block.tool_use_id) ?? null,
          tool: toolById.get(str(block.tool_use_id)) ?? '?',
          line: redact(firstInformative(text)),
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
  session.files = [...files].sort();
  session.urls = [...urls].sort();
  session.searches = [...searches].sort();

  return {
    session,
    prompts,
    tools,
    errorLines,
    skeleton: {
      v: EXTRACTOR_VERSION,
      session: input.session,
      project: input.project,
      merkleRoot: merkleRoot(rawLines.map(sha256)),
      leaves: rawLines.length,
      lines: skeletonLines,
    },
  };
};
