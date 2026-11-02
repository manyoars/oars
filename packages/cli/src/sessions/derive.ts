// Derive (register A28): what version 2 computed while reading a transcript, now a pure function of the capture records. Nothing here
// reads raw, so a change to a rule below bumps EXTRACTOR_VERSION and re-derives the store from the log alone. The rules match the
// version-2 extractor line for line (error_signatures.py, prompt_graphs.py, cost_per_class.py), and the recovery episodes match
// recovery_episodes.py (t693), so the numbers measured before the split reproduce after it.
import { captureSession, classify, compress, cut, EDITS, EXPLORE, ACT, normalize, shortName, type Capture, type ExtractInput } from './extract.js';
import type { Redactor } from './redact.js';
import {
  ERROR_EXAMPLE_CHARS,
  EXTRACTOR_VERSION,
  type ErrorLineObservation,
  type ErrorObservation,
  type PromptObservation,
  type SessionObservation,
  type ToolObservation,
  type UserPromptObservation,
} from './schema.js';

/** The capture records of one transcript, as the log holds them. */
export interface SessionCapture {
  session: SessionObservation;
  prompts: UserPromptObservation[];
  tools: ToolObservation[];
  errorLines: ErrorLineObservation[];
}

export interface Derived {
  prompts: PromptObservation[];
  errors: ErrorObservation[];
}

const byPosition = (a: ToolObservation, b: ToolObservation): number => a.n - b.n;

/** The `<tool> | <normalized line>` key; the line was redacted at capture, and normalize can expose a shape the first pass missed. */
const signature = (tool: string, line: string, redact: Redactor): string => `${tool} | ${redact(normalize(line))}`;

const groupBy = <T>(items: readonly T[], keyOf: (item: T) => number | null): Map<number | null, T[]> => {
  const groups = new Map<number | null, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
};

/** The version-2 prompt and error records of one transcript. */
export const deriveSession = (capture: SessionCapture, redact: Redactor): Derived => {
  const tools = [...capture.tools].sort(byPosition);
  const { session, rev } = capture.session;
  // One pass groups the calls and the main-line errors by prompt, so a session costs O(prompts + tools), not their product.
  const toolsOf = groupBy(tools, (tool) => tool.prompt);
  const errorsOf = groupBy(capture.errorLines.filter((error) => !error.side), (error) => error.prompt);
  const prompts = capture.prompts.map((prompt): PromptObservation => {
    const mine = toolsOf.get(prompt.index) ?? [];
    const main = mine.filter((tool) => !tool.side);
    const sequence = main.map((tool) => shortName(tool.tool));
    const errors = errorsOf.get(prompt.index) ?? [];
    // The two main-line calls after the prompt's first main-line error (version 2 re-armed on each error and kept the first two).
    const first = errors[0];
    const recovery = first === undefined ? [] : main.filter((tool) => tool.n >= first.after).slice(0, 2).map((tool) => shortName(tool.tool));
    const bigrams: { [bigram: string]: number } = {};
    for (let index = 0; index + 1 < sequence.length; index += 1) {
      const pair = `${sequence[index] ?? ''}>${sequence[index + 1] ?? ''}`;
      bigrams[pair] = (bigrams[pair] ?? 0) + 1;
    }
    return {
      kind: 'prompt',
      v: EXTRACTOR_VERSION,
      session,
      rev,
      index: prompt.index,
      ts: prompt.ts,
      wallSec: prompt.wallSec,
      head: prompt.head,
      cls: classify(sequence),
      tools: sequence,
      shape: compress(sequence),
      errors: errors.length,
      thinking: prompt.thinking,
      sideTools: mine.length - main.length,
      turns: prompt.turns,
      model: prompt.model,
      efforts: prompt.efforts,
      skills: prompt.skills,
      usage: prompt.usage,
      recovery,
      explore: sequence.filter((tool) => EXPLORE.has(tool)).length,
      act: sequence.filter((tool) => ACT.has(tool)).length,
      bigrams,
      contextFingerprint: prompt.promptFingerprint,
    };
  });
  const classOf = new Map(prompts.map((prompt) => [prompt.index, prompt.cls]));
  const errors = capture.errorLines.map(
    (error): ErrorObservation => ({
      kind: 'error',
      v: EXTRACTOR_VERSION,
      session,
      rev,
      ts: error.ts,
      harnessVersion: error.harnessVersion,
      tool: error.tool,
      sig: signature(error.tool, error.line, redact),
      example: cut(error.line, ERROR_EXAMPLE_CHARS),
      next: tools.slice(error.after, error.after + 2).map((tool) => tool.tool),
      editFollowed: tools.slice(error.after, error.after + 6).some((tool) => EDITS.has(tool.tool)),
      prompt: error.prompt,
      cls: error.prompt === null ? null : (classOf.get(error.prompt) ?? null),
    }),
  );
  return { prompts, errors };
};

/** Capture and derive in one call: the version-2 shape of one transcript, plus its capture records. */
export type Extract = Omit<Capture, 'prompts'> & Derived;

export const extractSession = (input: ExtractInput): Extract => {
  const capture = captureSession(input);
  return { ...capture, ...deriveSession(capture, input.redact) };
};

// Recovery episodes, ported from recovery_episodes.py (t693).

export type EpisodeOutcome = 'fixed' | 'worked around' | 'abandoned';

export interface Episode {
  session: string;
  sig: string;
  outcome: EpisodeOutcome;
  /** The position of the resolving call, else the window's length. */
  calls: number;
}

/** An episode ends when the same call succeeds, the session ends, or this many calls pass. */
export const RECOVERY_WINDOW = 20;

const FAMILY = new Map([
  ['Bash', 'shell'],
  ['PowerShell', 'shell'],
  ['BashOutput', 'shell'],
  ['Edit', 'edit'],
  ['Write', 'edit'],
  ['MultiEdit', 'edit'],
  ['NotebookEdit', 'edit'],
  ['Read', 'read'],
  ['Grep', 'read'],
  ['Glob', 'read'],
  ['LS', 'read'],
  ['WebFetch', 'fetch'],
  ['WebSearch', 'fetch'],
]);
const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'ToolSearch', 'TaskList', 'TaskGet']);

interface Call {
  tool: string;
  target: string;
  status: 'ok' | 'err' | null;
  sig: string | null;
}

/**
 * The transcript's calls in order, each with its first result's status. A resumed session repeats earlier lines, so a repeated
 * `toolUseId` is the same call and only the first copy counts; an error result whose call is not earlier in the file is a call of
 * its own, named `?`.
 */
const callsOf = (capture: SessionCapture, redact: Redactor): Call[] => {
  const tools = [...capture.tools].sort(byPosition);
  const firstError = new Map<string, ErrorLineObservation>();
  for (const error of capture.errorLines) if (error.toolUseId !== null && !firstError.has(error.toolUseId)) firstError.set(error.toolUseId, error);
  const seen = new Set<string>();
  const calls: Call[] = [];
  let pending = 0;
  const flush = (before: number): void => {
    for (let error = capture.errorLines[pending]; error !== undefined && error.after <= before; error = capture.errorLines[pending]) {
      pending += 1;
      if (error.toolUseId === null || !seen.has(error.toolUseId)) calls.push({ tool: '?', target: '?', status: 'err', sig: signature('?', error.line, redact) });
    }
  };
  for (const tool of tools) {
    flush(tool.n);
    if (tool.toolUseId !== null) {
      if (seen.has(tool.toolUseId)) continue;
      seen.add(tool.toolUseId);
    }
    const error = tool.toolUseId === null ? undefined : firstError.get(tool.toolUseId);
    const status = tool.status === 'ok' ? 'ok' : tool.status === 'error' ? 'err' : null;
    calls.push({ tool: tool.tool, target: tool.target ?? tool.tool, status, sig: status === 'err' && error !== undefined ? signature(tool.tool, error.line, redact) : null });
  }
  flush(Number.POSITIVE_INFINITY);
  return calls;
};

const resolve = (calls: readonly Call[], index: number, failed: Call): { outcome: EpisodeOutcome; calls: number } => {
  const window = calls.slice(index + 1, index + 1 + RECOVERY_WINDOW);
  const fixed = window.findIndex((call) => call.status === 'ok' && call.tool === failed.tool && call.target === failed.target);
  if (fixed >= 0) return { outcome: 'fixed', calls: fixed + 1 };
  const family = FAMILY.get(failed.tool) ?? failed.tool;
  const around = window.findIndex((call) => {
    if (call.status !== 'ok') return false;
    const callFamily = FAMILY.get(call.tool) ?? call.tool;
    const sameTarget = call.target === failed.target && !READ_ONLY.has(call.tool);
    const sameFamily = callFamily === family && (!READ_ONLY.has(call.tool) || family === 'read');
    // A failed shell command that was writing a file (heredoc, quoting) is routinely replaced by Write.
    return sameTarget || sameFamily || (family === 'shell' && callFamily === 'edit');
  });
  return around >= 0 ? { outcome: 'worked around', calls: around + 1 } : { outcome: 'abandoned', calls: window.length };
};

/** One episode per failed call of the transcript. */
export const episodesOf = (capture: SessionCapture, redact: Redactor): Episode[] => {
  const calls = callsOf(capture, redact);
  const episodes: Episode[] = [];
  for (const [index, call] of calls.entries()) {
    if (call.status !== 'err' || call.sig === null) continue;
    episodes.push({ session: capture.session.session, sig: call.sig, ...resolve(calls, index, call) });
  }
  return episodes;
};

export interface RecoveryRank {
  sig: string;
  sessions: number;
  errors: number;
  medianCalls: number;
  /** Sessions affected times median recovery calls. */
  score: number;
  fixed: number;
  workedAround: number;
  abandoned: number;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/** Signatures seen in two or more sessions, ranked by sessions times median recovery calls (recovery_episodes.py's order). */
export const rankRecovery = (episodes: readonly Episode[], top: number): RecoveryRank[] => {
  const bySig = new Map<string, Episode[]>();
  for (const episode of episodes) bySig.set(episode.sig, [...(bySig.get(episode.sig) ?? []), episode]);
  const ranked: RecoveryRank[] = [];
  for (const [sig, list] of bySig) {
    const sessions = new Set(list.map((episode) => episode.session)).size;
    if (sessions < 2) continue;
    const medianCalls = median(list.map((episode) => episode.calls));
    ranked.push({
      sig,
      sessions,
      errors: list.length,
      medianCalls,
      score: sessions * medianCalls,
      fixed: list.filter((episode) => episode.outcome === 'fixed').length,
      workedAround: list.filter((episode) => episode.outcome === 'worked around').length,
      abandoned: list.filter((episode) => episode.outcome === 'abandoned').length,
    });
  }
  ranked.sort((a, b) => b.score - a.score || b.sessions - a.sessions || b.errors - a.errors || (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0));
  return ranked.slice(0, top);
};
