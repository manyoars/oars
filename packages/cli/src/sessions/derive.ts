// Derive (register A28): what version 2 computed while reading a transcript, now a pure function of the capture records. Nothing here
// reads raw, so a change to a rule below bumps EXTRACTOR_VERSION and re-derives the store from the log alone. The rules match the
// version-2 extractor line for line (error_signatures.py, prompt_graphs.py, cost_per_class.py), and the recovery episodes match
// recovery_episodes.py, so the numbers measured before the split reproduce after it.
import { captureSession, classify, compress, cut, EDITS, EXPLORE, ACT, normalize, SHELL, shortName, type Capture, type ExtractInput } from './extract.js';
import type { Redactor } from './redact.js';
import { DECLINED_RE, INTERRUPT_MARKER, REJECTED_RE } from './session-shape.js';
import {
  ERROR_EXAMPLE_CHARS,
  EXTRACTOR_VERSION,
  type ErrorLineObservation,
  type ErrorObservation,
  type PromptIntervention,
  type PromptObservation,
  type PromptStop,
  type PromptVerify,
  type SessionObservation,
  type ShellSegment,
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

// The prompt outcome signals. All of them read the main line with a resumed session's repeats dropped: a repeated call has status
// `none` under a later prompt, so it would read as a fresh edit of the same path. A subagent transcript's calls are not read here.

/**
 * A later edit of a path within this many prompts is a redo. On the operator's store 58% of re-edits with no commit between them are one prompt
 * apart and 82% within three; past that the tail is long and flat (88% at five, 99% at twenty), so a larger window adds unrelated later work.
 */
export const REDO_WINDOW = 3;

// The rejection result and the interrupt marker live in session-shape.ts, which capture also reads; the marker is a user line capture keeps as a prompt of its own.
export { INTERRUPT_MARKER };

export const firstCopies = <T extends { side: boolean; toolUseId: string | null }>(records: readonly T[]): T[] => {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (record.side) return false;
    if (record.toolUseId === null) return true;
    if (seen.has(record.toolUseId)) return false;
    seen.add(record.toolUseId);
    return true;
  });
};

/** A failed edit wrote nothing. An edit with no result in the file may have written, so it counts. */
const isEdit = (tool: ToolObservation): boolean => EDITS.has(tool.tool) && tool.status !== 'error';

/** The commits a call made. A record captured before `segments` has only its first line's `target`, so it stays the floor it was. */
const commitsIn = (tool: ToolObservation): number => {
  if (!SHELL.has(tool.tool) || tool.status !== 'ok') return 0;
  if (tool.segments === undefined) return tool.target === 'git commit' ? 1 : 0;
  return tool.commits?.length ?? 0;
};

/** The `edit-verify` rule's shell call, less a backgrounded one, whose `ok` says only that it started. */
const isVerifyCall = (tool: ToolObservation): boolean => SHELL.has(tool.tool) && !tool.keys.includes('run_in_background');

const ANY_ARGS_RUNNER = /^(?:vitest|jest|mocha|ava|pytest|tox|nox|rspec|phpunit|ctest|tsc|eslint|ruff|mypy|pyright|playwright|cypress|bazel|ninja|pre-commit|unittest)(?: |$)/;
/** A package manager that runs a tool by name: `pnpm vitest run`, `yarn tsc`, `npm exec vitest`. */
const PACKAGE_RUNNER = /^(?:npm exec|pnpm|yarn|bun) /;
/** Runners whose installing or opening subcommand verifies nothing. */
const NOT_A_RUN = /^(?:playwright install|pre-commit install|cypress open)(?: |$)/;
const VERB_RUNNER = /^(?:npm|pnpm|yarn|bun|mvn|mvnw|gradle|gradlew|just|make|cargo|go|dotnet|deno|swift|astro|nx|turbo) /;
const WORK_WORD = /^(?:[\w:-]*[-:])?(?:test|tests|check|checks|typecheck|verify|build|lint|compile|e2e|clippy|nextest|vet)(?:[-:][\w:-]*)?$/;
const OTHER_RUNNER = /^(?:make$|(?:npm|bun) t(?: |$)|(?:mvn|mvnw) (?:.* )?(?:package|install)(?: |$))/;
/**
 * A subcommand whose later words are names, not work: `npm install lint-staged` and `go run check` verify nothing. One word may come before it, because
 * a flag's value stays in `run`: `pnpm --filter web add test-utils` reads `pnpm web add test-utils`, and `yarn workspace web add x` has two. A first
 * word that is itself work (`cargo test add`, `npm test install`) runs that work, and the name after it is its argument.
 */
const NAMES_WORDS = /^(?:npm|pnpm|yarn|bun|cargo|go|dotnet) (?:(?!run )(?:workspace \S+|\S+) )?(?:add|i|install|uninstall|remove|rm|link|view|get)(?: |$)|^(?:cargo|go) run(?: |$)/;
const RUN_WRAPPER = /^(?:npx|bunx|uvx|pipx run|uv run|poetry run|pnpm exec|pnpm dlx|yarn dlx|bundle exec|python[\d.]*|py) /;

/** Whether a segment runs a build, a test suite, a type check, or a linter. A rule over the captured `run`, so a change here re-derives without a transcript. */
export const isRunner = (segment: ShellSegment): boolean => {
  const run = segment.run.replace(RUN_WRAPPER, '');
  const bare = run.replace(PACKAGE_RUNNER, '');
  if (NOT_A_RUN.test(bare)) return false;
  if (ANY_ARGS_RUNNER.test(run) || ANY_ARGS_RUNNER.test(bare) || OTHER_RUNNER.test(run)) return true;
  if (NAMES_WORDS.test(run) && !WORK_WORD.test(run.split(' ')[1] ?? '')) return false;
  return VERB_RUNNER.test(run) && run.split(' ').slice(1).some((word) => WORK_WORD.test(word));
};

/**
 * The last runner after the prompt's last edit decides, so a later `ls` or `git status` does not. Undefined when a shell call is reached
 * that was captured before `segments`: it could be a runner, and saying `none` would claim it was not.
 */
const verifyOf = (calls: readonly ToolObservation[]): PromptVerify | undefined => {
  const lastEdit = calls.findLastIndex(isEdit);
  if (lastEdit < 0) return 'na';
  for (const call of calls.slice(lastEdit + 1).filter(isVerifyCall).reverse()) {
    if (call.segments === undefined) return undefined;
    const runner = call.segments.findLast(isRunner);
    if (runner !== undefined) {
      if (call.status === 'none') return 'none';
      if (!runner.read) return 'masked';
      return call.status === 'ok' ? 'passed' : 'failed';
    }
  }
  return 'none';
};

/** A rejection names the call the operator declined, and the harness follows it with the interrupt marker, so it is read first. */
const stoppedOf = (errors: readonly ErrorLineObservation[], nextHead: string | undefined): PromptStop | null => {
  if (errors.some((error) => REJECTED_RE.test(error.line))) return 'rejected';
  return nextHead?.startsWith(INTERRUPT_MARKER) === true ? 'interrupt' : null;
};

/** A decline in the fixed text Codex or Gemini CLI writes (`DECLINED_RE`). It is read for `intervention` only: `stopped` stays as the books and the gold arms read it. */
const declinedIn = (errors: readonly ErrorLineObservation[]): boolean => errors.some((error) => DECLINED_RE.test(error.line));

/**
 * The prompts whose edit a later prompt repeated, and of those the ones the very next prompt repeated (`immediate`, the `redo` bucket of `intervention`). One walk in call order: a commit settles every path
 * edited so far, so it empties the map. `nextOf` gives a prompt's next record.
 */
const redonePrompts = (calls: readonly ToolObservation[], nextOf: ReadonlyMap<number, number>): { redone: Set<number>; immediate: Set<number> } => {
  const redone = new Set<number>();
  const immediate = new Set<number>();
  const lastEditor = new Map<string, number>();
  for (const call of calls) {
    if (commitsIn(call) > 0) lastEditor.clear();
    else if (call.prompt !== null && call.target !== null && isEdit(call)) {
      const earlier = lastEditor.get(call.target);
      if (earlier !== undefined && earlier !== call.prompt && call.prompt - earlier <= REDO_WINDOW) redone.add(earlier);
      if (earlier !== undefined && nextOf.get(earlier) === call.prompt) immediate.add(earlier);
      lastEditor.set(call.target, call.prompt);
    }
  }
  return { redone, immediate };
};

/**
 * A segment that undoes work in git: a revert that names a commit (a bare `git revert` is `--abort`, `--continue`, or `--quit`, whose flag the segment drops), a restore, or a bare checkout
 * (the segment drops a path, a flag, and a word with a slash or quotes, so `git checkout -- <path>` and `git checkout feature/x` are the same bare word pair; `isGitUndo` narrows it by the step's flags).
 */
const GIT_UNDO = /^git (?:revert .|restore(?: |$))|^git checkout(?: \.)?$/;
const BARE_CHECKOUT = /^git checkout$/;
/** Flags of a `git checkout` that move to or create a branch, or leave one with a literal `-`: none of them undoes work. `<literal>` is also what the step makes of any flag off the public list (`--theirs`, `--patch`), so those read as no undo too: a limit, pinned in `intervention.test.ts`. */
const CHECKOUT_MOVES = new Set(['<literal>', '-b', '-B', '--orphan', '--detach']);
/** A prompt that begins by asking for the undo, in English: `revert that`, `please undo`, `rollback`. */
const ASKS_UNDO = /^(?:please )?(?:revert|undo|roll ?back)\b/i;

/** The capture version that keeps a `git checkout` step's `target` class. */
const TARGET_CLASS_CAPTURE = 23;

/** Whether the segment at index `at` is a checkout that moves to a branch: the step with the same `seg` holds the flags that the segment drops (the stored step no longer holds `run`). */
const movesBranch = (tool: ToolObservation, at: number): boolean => {
  const steps = tool.steps?.filter(({ seg }) => seg === at).map(({ identity }) => identity).filter((identity) => identity !== null && 'program' in identity) ?? [];
  // From CAPTURE 23 the step names the class of what the checkout acts on: a proved path is an undo whatever the flags, and an unproved word is never one. Before it, only the flags tell.
  if (Number(tool.cv) >= TARGET_CLASS_CAPTURE) {
    if (steps.some((identity) => identity.target === 'path')) return false;
    if (steps.some((identity) => identity.target === 'word')) return true;
  }
  return steps.some((identity) => identity.flags.some((flag) => CHECKOUT_MOVES.has(flag)));
};

/** A clean shell call that undid work in git. `git reset --hard` is read from the step, since a segment keeps no flag. */
const isGitUndo = (tool: ToolObservation): boolean =>
  SHELL.has(tool.tool) &&
  tool.status === 'ok' &&
  (tool.segments?.some(({ run }, at) => GIT_UNDO.test(run) && !(BARE_CHECKOUT.test(run) && movesBranch(tool, at))) === true ||
    tool.steps?.some(({ identity }) => identity !== null && 'program' in identity && identity.program === 'git' && identity.sub === 'reset' && identity.flags.includes('--hard')) === true);

/**
 * What the next prompt `next` did to the work of a prompt (docs/sessions-store.md, "Prompt intervention"). First match: the last prompt or the marker's own record is `unknown`; then a stop (`stopped` set) is `user-stop`; then `revert`, `redo`,
 * `after-error`; then `unknown` again when the next prompt ran a shell call captured before `segments`, which could have been an undo; else `none`.
 */
const interventionOf = (
  prompt: { head: string },
  stopped: boolean,
  next: { head: string; index: number } | undefined,
  settled: readonly ToolObservation[],
  nextCalls: readonly ToolObservation[],
  immediate: boolean,
): PromptIntervention => {
  if (next === undefined || prompt.head.startsWith(INTERRUPT_MARKER)) return 'unknown';
  // A stop is read before the others: a rejected call is settled as an error, so `after-error` would otherwise claim every rejection.
  if (stopped) return 'user-stop';
  if (settled.some(isEdit) && (nextCalls.some(isGitUndo) || ASKS_UNDO.test(next.head.trimStart()))) return 'revert';
  if (immediate) return 'redo';
  if (settled.at(-1)?.status === 'error') return 'after-error';
  return nextCalls.some((tool) => SHELL.has(tool.tool) && tool.segments === undefined) ? 'unknown' : 'none';
};

/** The version-2 prompt and error records of one transcript, with the outcome signals. */
export const deriveSession = (capture: SessionCapture, redact: Redactor): Derived => {
  const tools = [...capture.tools].sort(byPosition);
  const { session, rev } = capture.session;
  // One pass groups the calls and the main-line errors by prompt, so a session costs O(prompts + tools), not their product.
  const toolsOf = groupBy(tools, (tool) => tool.prompt);
  const errorsOf = groupBy(capture.errorLines.filter((error) => !error.side), (error) => error.prompt);
  // Capture pushes an error line for every failed result it reads, repeats included; `errors` and `recovery` keep them, as version 2 did.
  const stopsOf = groupBy(firstCopies(capture.errorLines), (error) => error.prompt);
  const calls = firstCopies(tools);
  const settledOf = groupBy(calls, (tool) => tool.prompt);
  const nextOf = new Map<number, number>();
  for (let at = 1; at < capture.prompts.length; at++) {
    const before = capture.prompts[at - 1];
    const after = capture.prompts[at];
    if (before !== undefined && after !== undefined) nextOf.set(before.index, after.index);
  }
  const { redone, immediate } = redonePrompts(calls, nextOf);
  const prompts = capture.prompts.map((prompt, position): PromptObservation => {
    const mine = toolsOf.get(prompt.index) ?? [];
    const main = mine.filter((tool) => !tool.side);
    const settled = settledOf.get(prompt.index) ?? [];
    const sequence = main.map((tool) => shortName(tool.tool));
    const errors = errorsOf.get(prompt.index) ?? [];
    const stopped = stoppedOf(stopsOf.get(prompt.index) ?? [], capture.prompts[position + 1]?.head);
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
      ...(prompt.usageObserved === undefined ? {} : { usageObserved: prompt.usageObserved }),
      ...(prompt.usageResponses === undefined ? {} : { usageResponses: prompt.usageResponses }),
      recovery,
      explore: sequence.filter((tool) => EXPLORE.has(tool)).length,
      strata: prompt.strata,
      act: sequence.filter((tool) => ACT.has(tool)).length,
      bigrams,
      contextFingerprint: prompt.promptFingerprint,
      verify: verifyOf(settled),
      stopped,
      commits: settled.reduce((sum, tool) => sum + commitsIn(tool), 0),
      redo: redone.has(prompt.index),
      intervention: interventionOf(prompt, stopped !== null || declinedIn(stopsOf.get(prompt.index) ?? []), capture.prompts[position + 1], settled, settledOf.get(capture.prompts[position + 1]?.index ?? -1) ?? [], immediate.has(prompt.index)),
      ...(prompt.frame === undefined ? {} : { frame: prompt.frame }),
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
      toolUseId: error.toolUseId,
      next: tools.slice(error.after, error.after + 2).map((tool) => tool.tool),
      // `isEdit` skips an edit whose own result was an error, so the stored row and `recoveryCalls` (the wire's value) read one rule.
      editFollowed: tools.slice(error.after, error.after + 6).some(isEdit),
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

// Recovery episodes, ported from recovery_episodes.py.

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
