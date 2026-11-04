// The outcome gold set: a random sample of prompts an operator judges blind, and a scorer that reads every signal against those
// judgments. It answers one question agreement among the signals cannot: does a local proxy predict human-judged success within an operator?
// Every arm stays separate: no composite, no per-person score. The file shows the request and the result; the signals and the agent's closing
// claim go to a sidecar beside it.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INTERRUPT_MARKER } from './derive.js';
import { checkSession } from './exclusion.js';
import { cut, EDITS, promptOpening, SHELL, shellTarget, shortName } from './extract.js';
import type { Redactor } from './redact.js';
import { PROMPT_HEAD_CHARS, type PromptObservation, type PromptStop, type PromptVerify } from './schema.js';
import { SOURCES } from './sources.js';
import { paths, type SessionsRuntime, type Store } from './store.js';

export interface Obj {
  [key: string]: unknown;
}

export const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const texts = (value: unknown): string => str(value) ?? '';

export interface TurnCall {
  name: string;
  input: Obj;
  cwd: string | null;
  /** From the call's first result; undefined when the file has none. */
  ok: boolean | undefined;
  result: string;
}

/** One prompt and what the main line did under it, read from the transcript for the text the store does not keep. */
export interface Turn {
  index: number;
  request: string;
  calls: TurnCall[];
  /** The assistant's text blocks on the main line, in order. */
  replies: string[];
}

// Capture's rules, kept in step by a test against `captureSession`, so a store `index` names the same turn here.
const firstTextBlock = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content) if (isObj(block) && block.type === 'text') return texts(block.text);
  return '';
};

const resultText = (block: Obj): string => {
  const { content } = block;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part): part is Obj => isObj(part) && part.type === 'text').map((part) => texts(part.text)).join('\n');
};

const failedResult = (block: Obj, text: string): boolean => {
  if (block.is_error === true) return true;
  const exit = /^Exit code (\d+)/.exec(text.trim());
  return exit !== null && exit[1] !== '0';
};

export const readTurns = (text: string): Turn[] => {
  const turns: Turn[] = [];
  // A resumed session repeats earlier lines: the first copy of a call carries its result, and a repeat is not fresh work.
  const calls = new Map<string, TurnCall>();
  const lines = text.split('\n');
  for (const [position, raw] of lines.entries()) {
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObj(line) || !isObj(line.message) || line.isSidechain === true) continue;
    const { content, role } = line.message;
    const blocks = Array.isArray(content) ? content.filter(isObj) : [];
    if (line.type === 'user' && role === 'user' && line.isMeta !== true) {
      const written = firstTextBlock(content);
      const opening = written === '' || blocks.some((block) => block.type === 'tool_result') ? undefined : promptOpening(written, lines, position);
      if (opening !== undefined) {
        turns.push({ index: turns.length, request: opening.request, calls: [], replies: [] });
        continue;
      }
    }
    const turn = turns.at(-1);
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        const answered = calls.get(texts(block.tool_use_id));
        if (answered !== undefined && answered.ok === undefined) {
          answered.result = resultText(block);
          answered.ok = !failedResult(block, answered.result);
        }
      } else if (turn === undefined || role !== 'assistant') continue;
      else if (block.type === 'text') turn.replies.push(texts(block.text));
      else if (block.type === 'tool_use') {
        const id = texts(block.id);
        if (id !== '' && calls.has(id)) continue;
        const call: TurnCall = { name: texts(block.name), input: isObj(block.input) ? block.input : {}, cwd: str(line.cwd) ?? null, ok: undefined, result: '' };
        calls.set(id, call);
        turn.calls.push(call);
      }
    }
  }
  return turns;
};

export interface GoldCommit {
  subject: string | null;
  stat: string | null;
}

export interface GoldEdit {
  file: string;
  added: number;
  removed: number;
  calls: number;
  /** The last new text, for a code file. Prose is left out: an agent's note or report is where its own claims live. */
  excerpt: string | null;
}

/** What the judge sees. No exit status, no closing reply, and no shell call after an edit: those are the signals and the claim. */
export interface GoldView {
  request: string;
  /** The request before this one, because "yes, do that" cannot be judged alone. */
  earlier: string | null;
  commits: GoldCommit[];
  edits: GoldEdit[];
  actions: string[];
  /** Calls that spawned a subagent. Subagent transcripts are not read. */
  subagents: number;
}

const REQUEST_CHARS = 2000;
const SUBJECT_CHARS = 200;
const EXCERPT_CHARS = 300;
const ACTION_CHARS = 120;
const ACTIONS_SHOWN = 12;
const FILES_SHOWN = 12;
const PROSE = /\.(?:md|mdx|txt|rst)$/i;
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

// `commits` sees only a first-line `git commit` (10% recall), so every segment of the command is read here.
const COMMIT_SEGMENT = /^(?:\S+=\S*\s+)*git(?:\s+-[cC]\s+(?:"[^"]*"|'[^']*'|\S+))*\s+commit\b/;
const RESULT_SUBJECT = /^\[[^\]\n]*\s[0-9a-f]{7,40}\]\s*(.*)$/m;
const RESULT_STAT = /^\s*(\d+ files? changed.*)$/m;
const HEREDOC_SUBJECT = /(?:<<-?\s*['"]?\w+['"]?\)?|@['"])\s*\r?\n([^\n]*)/;
const FLAG_SUBJECT = /\bcommit\b[^\n]*?\s-[a-zA-Z]*m\s+(?:"([^"\n]*)|'([^'\n]*))/;

const commandOf = (call: TurnCall): string => texts(call.input.command);

const isCommitCall = (call: TurnCall): boolean =>
  SHELL.has(call.name) && call.ok === true && commandOf(call).split(/&&|\|\||;|\||\n/).some((segment) => COMMIT_SEGMENT.test(segment.trim()));

const commitOf = (call: TurnCall, redact: Redactor): GoldCommit => {
  const command = commandOf(call);
  const flag = FLAG_SUBJECT.exec(command);
  const subject = RESULT_SUBJECT.exec(call.result)?.[1] ?? HEREDOC_SUBJECT.exec(command)?.[1] ?? flag?.[1] ?? flag?.[2] ?? null;
  return { subject: subject === null ? null : cut(redact(subject), SUBJECT_CHARS), stat: RESULT_STAT.exec(call.result)?.[1]?.trim() ?? null };
};

const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length);

/** Forward slashes, and relative to the call's folder when it sits inside it. */
const shownPath = (path: string, cwd: string | null): string => {
  const plain = path.replace(/\\/g, '/');
  const base = cwd?.replace(/\\/g, '/');
  return base !== undefined && plain.startsWith(`${base}/`) ? plain.slice(base.length + 1) : plain;
};

const editChange = (call: TurnCall): { added: number; removed: number; last: string } => {
  const { input } = call;
  if (call.name === 'Write') return { added: lineCount(texts(input.content)), removed: 0, last: texts(input.content) };
  const pieces = call.name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits.filter(isObj) : [input];
  return {
    added: pieces.reduce((sum, piece) => sum + lineCount(texts(piece.new_string)), 0),
    removed: pieces.reduce((sum, piece) => sum + lineCount(texts(piece.old_string)), 0),
    last: texts(pieces.at(-1)?.new_string),
  };
};

const editsOf = (calls: readonly TurnCall[], redact: Redactor): GoldEdit[] => {
  const byFile = new Map<string, GoldEdit>();
  for (const call of calls) {
    // A failed edit wrote nothing; one with no result may have written, as `isEdit` in derive.ts has it.
    if (!EDITS.has(call.name) || call.ok === false) continue;
    const file = redact(shownPath(texts(call.input.file_path), call.cwd));
    const change = editChange(call);
    const row = byFile.get(file) ?? { file, added: 0, removed: 0, calls: 0, excerpt: null };
    row.added += change.added;
    row.removed += change.removed;
    row.calls += 1;
    row.excerpt = PROSE.test(file) ? null : cut(redact(change.last), EXCERPT_CHARS);
    byFile.set(file, row);
  }
  return [...byFile.values()];
};

const actionLabel = (call: TurnCall): string => {
  const { input, name } = call;
  if (SHELL.has(name)) return `${name} ${shellTarget(commandOf(call))}`;
  const aim = str(input.file_path) === undefined ? (str(input.pattern) ?? str(input.url) ?? (name === 'WebSearch' ? str(input.query) : undefined)) : shownPath(texts(input.file_path), call.cwd);
  return aim === undefined ? shortName(name) : `${shortName(name)} ${aim}`;
};

const actionsOf = (calls: readonly TurnCall[], redact: Redactor): string[] => {
  const runs: Array<{ label: string; times: number }> = [];
  for (const call of calls) {
    const label = cut(redact(actionLabel(call)), ACTION_CHARS);
    const last = runs.at(-1);
    if (last?.label === label) last.times += 1;
    else runs.push({ label, times: 1 });
  }
  const lines = runs.map((run) => (run.times === 1 ? run.label : `${run.label} x${String(run.times)}`));
  return lines.length <= ACTIONS_SHOWN ? lines : [...lines.slice(0, ACTIONS_SHOWN), `and ${String(lines.length - ACTIONS_SHOWN)} more`];
};

export const viewOf = (turns: readonly Turn[], index: number, redact: Redactor): GoldView => {
  const calls = turns[index]?.calls ?? [];
  const earlier = turns[index - 1]?.request;
  const edits = editsOf(calls, redact);
  return {
    request: cut(redact(turns[index]?.request ?? ''), REQUEST_CHARS),
    earlier: earlier === undefined ? null : cut(redact(earlier), PROMPT_HEAD_CHARS),
    commits: calls.filter(isCommitCall).map((call) => commitOf(call, redact)),
    edits,
    // A shell call after an edit is the `verify` signal, so an edit prompt lists none; a prompt with no edit reads `na` and shows nothing by listing them.
    actions: edits.length > 0 ? [] : actionsOf(calls, redact),
    subagents: calls.filter((call) => SUBAGENT_TOOLS.has(call.name)).length,
  };
};

/**
 * The prompts that can be judged. A marker is not a request. A `no-tools` prompt has only its reply to show, and the reply is the closing claim the
 * file must hide. A session from any other harness (every harness `SOURCES` names) has no Claude Code transcript to read. A prompt with no signals has nothing to score.
 */
export const frameOf = (prompts: readonly PromptObservation[]): PromptObservation[] =>
  prompts.filter((prompt) => !prompt.head.startsWith(INTERRUPT_MARKER) && prompt.cls !== 'no-tools' && !SOURCES.some((source) => prompt.session.startsWith(`${source.name}-`)) && prompt.verify !== undefined && prompt.model !== '');

const SESSION_CAP = 2;

const hashOrder = (prompts: readonly PromptObservation[], seed: string): PromptObservation[] =>
  prompts
    .map((prompt) => ({ prompt, key: createHash('sha256').update(`${seed}\n${prompt.session}\n${String(prompt.index)}`).digest('hex') }))
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((item) => item.prompt);

/**
 * A seeded draw across class and model. Each next prompt comes from the cell with the largest `sqrt(size) / (taken + 1)`: rarer classes and models
 * get more than their share, so each one can be read, and a common cell still gets the most. A cell that runs dry drops out, and the others fill the
 * sample. The base rate it yields is the sample's, not the store's.
 */
export const drawSample = async (frame: readonly PromptObservation[], size: number, seed: string, accept: (prompt: PromptObservation) => Promise<boolean>): Promise<PromptObservation[]> => {
  const cells = new Map<string, PromptObservation[]>();
  for (const prompt of hashOrder(frame, seed)) {
    const key = `${prompt.cls}\n${prompt.model}`;
    const cell = cells.get(key);
    if (cell === undefined) cells.set(key, [prompt]);
    else cell.push(prompt);
  }
  const open = [...cells.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, queue]) => ({ queue, weight: Math.sqrt(queue.length), taken: 0 }));
  const perSession = new Map<string, number>();
  const picked: PromptObservation[] = [];
  while (picked.length < size && open.length > 0) {
    const cell = open.reduce((best, item) => (item.weight / (item.taken + 1) > best.weight / (best.taken + 1) ? item : best));
    const next = cell.queue.shift();
    if (next === undefined) {
      open.splice(open.indexOf(cell), 1);
      continue;
    }
    // One long session must not fill a cell: its prompts are not independent reads.
    if ((perSession.get(next.session) ?? 0) >= SESSION_CAP) continue;
    if (!(await accept(next))) continue;
    perSession.set(next.session, (perSession.get(next.session) ?? 0) + 1);
    picked.push(next);
    cell.taken += 1;
  }
  return hashOrder(picked, `${seed}\norder`);
};

const quoted = (text: string): string[] => text.split(/\r?\n/).map((line) => `> ${line}`.trimEnd());
const indented = (text: string): string[] => text.split(/\r?\n/).map((line) => `    ${line}`.trimEnd());
/** `1 edit`, `2 edits`: a count agrees with its noun in every line the commands print. */
export const plural = (count: number, one: string): string => `${String(count)} ${one}${count === 1 ? '' : 's'}`;

/** The request and the result as lines, every one prefixed: no text from a transcript can begin a line the parser reads. */
const shownLines = (view: GoldView): string[] => {
  const result: string[] = [];
  for (const commit of view.commits) result.push(`- Commit: ${commit.subject ?? 'message not readable'}${commit.stat === null ? '' : ` (${commit.stat})`}`.replace(/\r?\n/g, ' '));
  for (const edit of view.edits.slice(0, FILES_SHOWN)) {
    result.push(`- ${edit.file}: +${String(edit.added)} -${String(edit.removed)} in ${plural(edit.calls, 'edit')}`.replace(/\r?\n/g, ' '));
    if (edit.excerpt !== null && edit.excerpt !== '') result.push(...indented(edit.excerpt));
  }
  if (view.edits.length > FILES_SHOWN) result.push(`- and ${plural(view.edits.length - FILES_SHOWN, 'more file')}`);
  for (const action of view.actions) result.push(`- ${action}`.replace(/\r?\n/g, ' '));
  if (view.subagents > 0) result.push(`- ${plural(view.subagents, 'subagent call')} ran; their work is not shown`);
  if (result.length === 0) result.push('- No change or action in the main transcript.');
  return [...(view.earlier === null ? [] : ['Earlier request:', ...quoted(view.earlier), '']), 'Request:', ...quoted(view.request), '', 'Result:', ...result];
};

/** What an evaluator is given, and only that: the same request and result the judge sees. */
export const renderShown = (view: GoldView): string => shownLines(view).join('\n');

const BLANK_JUDGMENT = 'yes|no';

export const renderGold = (items: ReadonlyArray<{ id: string; view: GoldView }>, options: { date: string; batch: number }): string => {
  const batches = Math.ceil(items.length / options.batch);
  const lines = [
    `# Outcome gold set, ${options.date}`,
    '',
    'Did the work do what was asked? Judge from what is shown, then replace `yes|no` with `yes` or `no`. Leave a line as it is when you cannot tell.',
    'You can stop after any batch; the score reads whatever is filled in:',
    '',
    '    oars sessions gold score <this file>',
    '',
    "The agent's own closing words and every signal are kept out of this file. They are in the `.arms.json` file beside it: do not open that before judging.",
    'Local only: never commit, never quote.',
  ];
  items.forEach((item, position) => {
    if (position % options.batch === 0) lines.push('', `## Batch ${String(position / options.batch + 1)} of ${String(batches)}`);
    lines.push('', `### ${item.id}`, '', ...shownLines(item.view), '', `Judgment: ${BLANK_JUDGMENT}`);
  });
  return `${lines.join('\n')}\n`;
};

const ANSWERS = new Map([['yes', true], ['y', true], ['no', false], ['n', false]]);

export const parseGold = (text: string): { judged: Map<string, boolean>; unreadable: string[] } => {
  const judged = new Map<string, boolean>();
  const unreadable: string[] = [];
  let current: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^### (G\d+)$/.exec(line);
    if (heading !== null) {
      current = heading[1];
      continue;
    }
    const judgment = /^Judgment:(.*)$/.exec(line);
    if (judgment === null || current === undefined) continue;
    const answer = (judgment[1] ?? '').trim().toLowerCase();
    const value = ANSWERS.get(answer);
    if (value !== undefined) judged.set(current, value);
    else if (answer !== '' && answer !== BLANK_JUDGMENT) unreadable.push(current);
  }
  return { judged, unreadable };
};

export interface GoldSignals {
  verify: PromptVerify;
  stopped: PromptStop | null;
  commits: number;
  redo: boolean;
}

/** What the acting session wrote, read from its transcript. Null where the turn has none. */
export interface GoldReads {
  /** Its closing reply. */
  claim: string | null;
  /** Its last line opening with `Confidence:`. */
  confidence: string | null;
  /** The next prompt that is not a harness marker. */
  later: string | null;
}

/** The arms a fresh single-turn reader answers. */
export type GoldAskedArm = 'evaluator' | 'claim' | 'later';
/** `other` is a reader that said neither yes nor no: asked once, with no reading. */
export type GoldAnswer = 'yes' | 'no' | 'other';

/** The model and the fixed words behind every answer in a sidecar, hashed so a later reading can be matched to them. */
export interface GoldEvaluators {
  model: string;
  wordings: Array<{ arm: GoldAskedArm; wording: string; sha256: string }>;
}

/** One sampled prompt in the sidecar: everything hidden from the gold file, and what an evaluator needs. */
export interface GoldEntry {
  id: string;
  session: string;
  index: number;
  project: string;
  model: string;
  cls: string;
  subagents: number;
  signals: GoldSignals;
  /** {@link renderShown}, kept so an evaluator reads exactly what the judge read. */
  shown: string;
  /** Written by `gold arms`; absent until then, or while the transcript no longer matches `shown`. */
  reads?: GoldReads;
  answers?: { [arm in GoldAskedArm]?: GoldAnswer };
}

export interface GoldDocument {
  date: string;
  seed: string;
  batch: number;
  frame: number;
  excludedSessions: number;
  entries: GoldEntry[];
  evaluators?: GoldEvaluators;
}

interface GoldArm {
  arm: string;
  /** Higher should mean more likely judged a success; null when the arm has no reading for this prompt. */
  read: (entry: GoldEntry) => number | null;
}

const CONFIDENCE_LEVELS = new Map([['low', 0], ['medium', 1], ['moderate', 1], ['high', 2]]);
const CONFIDENCE_VALUE = /^(low|medium|moderate|high)\b(?:[\s/-]+(?:to\s+)?(low|medium|moderate|high)\b)?/i;

/** The words these lines use, in order, with a range read as its middle. Anything else, such as a percentage, has no reading. */
export const confidenceLevel = (line: string | null | undefined): number | null => {
  const value = line?.slice(line.indexOf(':') + 1).replace(/^[\s*_]+/, '') ?? '';
  const match = CONFIDENCE_VALUE.exec(value);
  if (match === null) return null;
  const level = (word: string | undefined): number | undefined => CONFIDENCE_LEVELS.get(word?.toLowerCase() ?? '');
  const low = level(match[1]) ?? 0;
  return ((low + (level(match[2]) ?? low)) / 2);
};

const answerRead = (answer: GoldAnswer | undefined): number | null => (answer === 'yes' ? 1 : answer === 'no' ? 0 : null);

const VERIFY_ORDER = new Map<PromptVerify, number>([['passed', 2], ['none', 1], ['failed', 0]]);

/** The arms, in print order. Each is an observation read on its own, and none is a label. */
export const ARMS: readonly GoldArm[] = [
  { arm: 'verify', read: (entry) => VERIFY_ORDER.get(entry.signals.verify) ?? null },
  { arm: 'stopped', read: (entry) => (entry.signals.stopped === null ? 1 : 0) },
  { arm: 'commits', read: (entry) => entry.signals.commits },
  { arm: 'redo', read: (entry) => (entry.signals.redo ? 0 : 1) },
  { arm: 'confidence', read: (entry) => confidenceLevel(entry.reads?.confidence) },
  { arm: 'claim', read: (entry) => answerRead(entry.answers?.claim) },
  { arm: 'evaluator', read: (entry) => answerRead(entry.answers?.evaluator) },
  { arm: 'later', read: (entry) => answerRead(entry.answers?.later) },
];

export interface AurocRead {
  auroc: number | null;
  low: number | null;
  high: number | null;
}

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

const sampleVariance = (values: readonly number[]): number => {
  const center = mean(values);
  return values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
};

const Z_95 = 1.96;
const NO_VARIANCE = 1e-12;

/**
 * AUROC with a DeLong 95% interval, which handles the heavy ties these signals have. A zero variance estimate (one value, perfect separation, or one
 * row a side) gives no interval: it is a small sample, not certainty.
 */
export const auroc = (positives: readonly number[], negatives: readonly number[]): AurocRead => {
  if (positives.length === 0 || negatives.length === 0) return { auroc: null, low: null, high: null };
  const beats = (positive: number, negative: number): number => (positive > negative ? 1 : positive === negative ? 0.5 : 0);
  const perPositive = positives.map((positive) => mean(negatives.map((negative) => beats(positive, negative))));
  const perNegative = negatives.map((negative) => mean(positives.map((positive) => beats(positive, negative))));
  const value = mean(perPositive);
  if (positives.length < 2 || negatives.length < 2) return { auroc: value, low: null, high: null };
  const variance = sampleVariance(perPositive) / positives.length + sampleVariance(perNegative) / negatives.length;
  if (variance < NO_VARIANCE) return { auroc: value, low: null, high: null };
  const half = Z_95 * Math.sqrt(variance);
  return { auroc: value, low: Math.max(0, value - half), high: Math.min(1, value + half) };
};

export interface ArmRow extends AurocRead {
  arm: string;
  /** Judged prompts this arm has a reading for. */
  covered: number;
  yes: number;
  baseRate: number | null;
}

export interface ModelRow {
  model: string;
  judged: number;
  baseRate: number;
  arms: ArmRow[];
}

export interface GoldScore {
  total: number;
  judged: number;
  /** How many sampled prompts each arm reads, judged or not. It says nothing about any judgment. */
  coverage: Array<{ arm: string; covered: number }>;
  models: ModelRow[];
}

const POOLED = 'all models';

const modelRow = (model: string, entries: readonly GoldEntry[], judged: ReadonlyMap<string, boolean>): ModelRow => {
  const yes = entries.filter((entry) => judged.get(entry.id) === true).length;
  const arms = ARMS.map(({ arm, read }): ArmRow => {
    const positives: number[] = [];
    const negatives: number[] = [];
    for (const entry of entries) {
      const value = read(entry);
      if (value !== null) (judged.get(entry.id) === true ? positives : negatives).push(value);
    }
    const covered = positives.length + negatives.length;
    return { arm, covered, yes: positives.length, baseRate: covered === 0 ? null : positives.length / covered, ...auroc(positives, negatives) };
  });
  return { model, judged: entries.length, baseRate: yes / entries.length, arms };
};

export const scoreGold = (entries: readonly GoldEntry[], judged: ReadonlyMap<string, boolean>): GoldScore => {
  const scored = entries.filter((entry) => judged.has(entry.id));
  const models = [...new Set(scored.map((entry) => entry.model))].sort();
  return {
    total: entries.length,
    judged: scored.length,
    coverage: ARMS.map(({ arm, read }) => ({ arm, covered: entries.filter((entry) => read(entry) !== null).length })),
    models: scored.length === 0 ? [] : [...models.map((model) => modelRow(model, scored.filter((entry) => entry.model === model), judged)), modelRow(POOLED, scored, judged)],
  };
};

const percent = (value: number | null): string => (value === null ? '-' : `${String(Math.round(value * 100))}%`);
const decimal = (value: number | null): string => (value === null ? '-' : value.toFixed(2));

export const coverageLines = (score: GoldScore): string[] => {
  const width = Math.max(...score.coverage.map((row) => row.arm.length));
  return ['Prompts each arm covers:', ...score.coverage.map((row) => `  ${row.arm.padEnd(width)}  ${String(row.covered)} of ${String(score.total)}`)];
};

export const formatScore = (score: GoldScore, unreadable: readonly string[]): string => {
  const width = Math.max(...score.coverage.map((row) => row.arm.length));
  const lines = [
    `Judged ${String(score.judged)} of ${String(score.total)}. Each arm is an observation, not a label, and no arm is combined with another.`,
    ...unreadable.map((id) => `Could not read the judgment of ${id}: write yes or no.`),
    '',
    ...coverageLines(score),
  ];
  for (const row of score.models) {
    lines.push('', `${row.model}: ${String(row.judged)} judged, base rate ${percent(row.baseRate)}`, `  ${'arm'.padEnd(width)}  covered  yes  base  AUROC  95% interval`);
    for (const arm of row.arms) {
      const interval = arm.low === null || arm.high === null ? '-' : `${decimal(arm.low)} to ${decimal(arm.high)}`;
      lines.push(`  ${arm.arm.padEnd(width)}  ${String(arm.covered).padStart(7)}  ${String(arm.yes).padStart(3)}  ${percent(arm.baseRate).padStart(4)}  ${decimal(arm.auroc).padStart(5)}  ${interval}`);
    }
  }
  return lines.join('\n');
};

/** The sidecar beside a gold file. */
export const armsPath = (goldFile: string): string => `${goldFile.replace(/\.md$/, '')}.arms.json`;

const readIfThere = (file: string): Promise<string | undefined> => readFile(file, 'utf8').catch(() => undefined);

/** The first root that holds the session, so the draw and the text arms cannot come to read different files. Undefined when none does. */
export const readTranscript = async (roots: readonly string[], project: string, session: string): Promise<string | undefined> => {
  for (const root of roots) {
    const text = await readIfThere(join(root, project, `${session}.jsonl`));
    if (text !== undefined) return text;
  }
  return undefined;
};

export interface GoldSample {
  document: GoldDocument;
  views: Array<{ id: string; view: GoldView }>;
  /** Prompts the store names whose transcript no longer matches at that index. */
  unreadable: number;
}

export const sampleGold = async (runtime: SessionsRuntime, store: Store, redact: Redactor, options: { size: number; batch: number; seed: string; date: string; termsFile: string; extraTerms: readonly string[] }): Promise<GoldSample> => {
  const roots = [runtime.projectsRoot, paths(runtime.storeDir).raw];
  const projectOf = new Map(store.sessions.map((session) => [session.session, session.project]));
  const excluded = new Set<string>();
  const checked = new Set<string>();
  const built = new Map<PromptObservation, GoldView>();
  let unreadable = 0;

  const accept = async (prompt: PromptObservation): Promise<boolean> => {
    const project = projectOf.get(prompt.session) ?? '';
    if (excluded.has(prompt.session)) return false;
    if (!checked.has(prompt.session)) {
      checked.add(prompt.session);
      // The one exclusion rule (A38): a session that holds a term, has no raw to scan, or could not be read is out, and so is every session when the term file is empty.
      if ((await checkSession(runtime, options.termsFile, project, prompt.session, options.extraTerms)).excluded) {
        excluded.add(prompt.session);
        return false;
      }
    }
    const text = await readTranscript(roots, project, prompt.session);
    const turns = text === undefined ? [] : readTurns(text);
    const turn = turns[prompt.index];
    // The transcript grew or changed after the deposit if the head no longer matches, and the signals would then describe another turn.
    if (turn === undefined || cut(redact(turn.request), PROMPT_HEAD_CHARS) !== prompt.head) {
      unreadable += 1;
      return false;
    }
    built.set(prompt, viewOf(turns, prompt.index, redact));
    return true;
  };

  const frame = frameOf(store.prompts);
  const picked = await drawSample(frame, options.size, options.seed, accept);
  const width = Math.max(3, String(picked.length).length);
  const views: GoldSample['views'] = [];
  const entries = picked.map((prompt, position): GoldEntry => {
    const id = `G${String(position + 1).padStart(width, '0')}`;
    const view = built.get(prompt) ?? viewOf([], 0, redact);
    views.push({ id, view });
    return {
      id,
      session: prompt.session,
      index: prompt.index,
      project: projectOf.get(prompt.session) ?? '',
      model: prompt.model,
      cls: prompt.cls,
      subagents: view.subagents,
      signals: { verify: prompt.verify ?? 'na', stopped: prompt.stopped ?? null, commits: prompt.commits ?? 0, redo: prompt.redo ?? false },
      shown: renderShown(view),
    };
  });
  return { document: { date: options.date, seed: options.seed, batch: options.batch, frame: frame.length, excludedSessions: excluded.size, entries }, views, unreadable };
};

export const isGoldDocument = (value: unknown): value is GoldDocument => isObj(value) && Array.isArray(value.entries);
