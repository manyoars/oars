// What a recall led to (recall spec Sections 2.7 and 4). A pure function of `recalls.jsonl` and the capture records, computed at derive and never captured live, so
// `recalls.jsonl` stays append-only and a change here needs no re-deposit. Held recalls get a consequence too: they are the baseline a shown recall reads against. Only a
// shown recall touches the graph, because a held one reached nobody: it adds no `recall.*` step and exposes no cell.
import { motifsOf, stepsOfCall, type CountedStep } from './motif.js';
import type { Recall, RecallConsequence, RecallOutcome } from './recall-object.js';
import { harnessOf, type Harness, type PromptObservation, type ToolObservation } from './schema.js';
import type { Store } from './store.js';

/** A consequence window ends at the prompt's end or after this many calls (spec Section 2.7). */
export const WINDOW_CALLS = 20;

const callKey = (tool: Pick<ToolObservation, 'session' | 'n'>): string => `${tool.session}#${String(tool.n)}`;
const promptKey = (session: string, index: number | null): string => `${session}#${String(index)}`;

/**
 * Each session's main line, in order. A hook inside a subagent reports the parent's session id, so a subagent's push is placed on the parent's line by its time; that is
 * a weak spot of the window, not of the arm.
 */
const mainLines = (store: Store): Map<string, ToolObservation[]> => {
  const lines = new Map<string, ToolObservation[]>();
  for (const tool of store.tools) {
    if (tool.side) continue;
    const line = lines.get(tool.session);
    if (line === undefined) lines.set(tool.session, [tool]);
    else line.push(tool);
  }
  for (const line of lines.values()) line.sort((a, b) => a.n - b.n);
  return lines;
};

/**
 * The first call stamped after the recall. A call's line is written before its pre-tool hook runs, and a hook's text reaches the model after that call was already decided, so
 * the call a push fired on is behind it and the window opens on the next decision.
 */
const positionOf = (line: readonly ToolObservation[], at: string): number => {
  const next = line.findIndex((tool) => tool.ts !== null && tool.ts > at);
  return next < 0 ? line.length : next;
};

const outcomeOf = (prompt: PromptObservation | undefined): RecallOutcome => ({
  errors: prompt?.errors ?? null,
  verify: prompt?.verify ?? null,
  stopped: prompt?.stopped ?? null,
  commits: prompt?.commits ?? null,
  redo: prompt?.redo ?? null,
});

const consequenceOf = (recall: Recall, session: string, line: readonly ToolObservation[], position: number, harness: Harness, prompts: ReadonlyMap<string, PromptObservation>): RecallConsequence => {
  const prompt = (line[position - 1] ?? line[position])?.prompt ?? null;
  const calls: ToolObservation[] = [];
  let end: RecallConsequence['window']['end'] = 'session';
  for (const tool of line.slice(position)) {
    if (calls.length === WINDOW_CALLS) {
      end = 'calls';
      break;
    }
    if (tool.prompt !== prompt) {
      end = 'prompt';
      break;
    }
    calls.push(tool);
  }
  const steps = calls.flatMap((tool) => stepsOfCall(tool, harness));
  const names = new Set<string>(recall.answer.names);
  const measured = calls.flatMap((tool) => tool.steps ?? []).flatMap((step) => step.cost.tokens ?? []);
  return {
    window: { from: position, to: position + calls.length, calls: calls.length, end },
    // Shape level only: it is the ID that joins across accounts, and named windows would multiply a row that exists per recall.
    motifs: [...new Set(motifsOf(steps).flatMap(({ motif }) => (motif.level === 'shape' ? [motif.motifId] : [])))],
    followed: steps.some((step) => names.has(step.action)),
    cost: { tokens: measured.length === 0 ? null : measured.reduce((sum, tokens) => sum + tokens, 0), durationMs: steps.reduce((sum, step) => sum + step.durationMs, 0) },
    outcome: outcomeOf(prompts.get(promptKey(session, prompt))),
  };
};

/** Fills `n` and `consequence`. A recall with no session, or from a session this store does not hold, has nothing to read and comes back as it was. */
export const deriveConsequences = (store: Store, recalls: readonly Recall[]): Recall[] => {
  const lines = mainLines(store);
  const prompts = new Map(store.prompts.map((prompt) => [promptKey(prompt.session, prompt.index), prompt]));
  const sessions = new Map(store.sessions.map((session) => [session.session, session]));
  return recalls.map((recall) => {
    const session = recall.sid === null ? undefined : sessions.get(recall.sid);
    if (session === undefined) return recall;
    const line = lines.get(session.session) ?? [];
    const position = positionOf(line, recall.at);
    return { ...recall, n: position, consequence: consequenceOf(recall, session.session, line, position, harnessOf(session), prompts) };
  });
};

/** A step as a cell counts it, and whether it sits inside a shown recall's window. */
export interface PlacedStep {
  step: CountedStep;
  exposed: boolean;
}

/** What recalls add to the graph: the one seam `deriveCells` reads for `recall.*` steps and `exposed`. */
export interface RecallGraph {
  place: (tool: ToolObservation, steps: readonly CountedStep[]) => PlacedStep[];
  exposedPrompt: (session: string, index: number) => boolean;
}

export const NO_RECALLS: RecallGraph = {
  place: (_tool, steps) => steps.map((step) => ({ step, exposed: false })),
  exposedPrompt: () => false,
};

const pushTo = (map: Map<string, PlacedStep[]>, key: string, step: PlacedStep): void => {
  const found = map.get(key);
  if (found === undefined) map.set(key, [step]);
  else found.push(step);
};

const recallStep = (recall: Recall): PlacedStep => ({
  step: { action: recall.mode === 'pull' ? 'recall.pull' : 'recall.push', identity: null, status: 'ok', tokens: recall.answer.tokens, durationMs: 0 },
  exposed: true,
});

/**
 * Takes recalls that have been through `deriveConsequences`. An MCP pull has no session id, so the only step it has is the one in its transcript; a pull that names its session
 * (`--session`) has no MCP call, so its step is this one.
 */
export const recallGraphOf = (store: Store, recalls: readonly Recall[]): RecallGraph => {
  const lines = mainLines(store);
  const exposedCalls = new Set<string>();
  const exposedPrompts = new Set<string>();
  const before = new Map<string, PlacedStep[]>();
  const after = new Map<string, PlacedStep[]>();
  for (const recall of recalls) {
    const line = recall.sid === null ? undefined : lines.get(recall.sid);
    if (recall.arm === 'held' || recall.consequence === undefined || line === undefined) continue;
    const { from, to } = recall.consequence.window;
    for (const tool of line.slice(from, to)) {
      exposedCalls.add(callKey(tool));
      exposedPrompts.add(promptKey(tool.session, tool.prompt));
    }
    const previous = line[from - 1];
    const first = line[from];
    if (previous !== undefined) pushTo(after, callKey(previous), recallStep(recall));
    else if (first !== undefined) pushTo(before, callKey(first), recallStep(recall));
  }
  return {
    place: (tool, steps) => {
      const key = callKey(tool);
      const exposed = exposedCalls.has(key);
      return [...(before.get(key) ?? []), ...steps.map((step) => ({ step, exposed })), ...(after.get(key) ?? [])];
    },
    exposedPrompt: (session, index) => exposedPrompts.has(promptKey(session, index)),
  };
};

/** One row per mode, arm, and answer kind. Counts only. */
export interface RecallCountRow {
  mode: Recall['mode'];
  arm: Recall['arm'];
  kind: Recall['answer']['kind'];
  recalls: number;
  sessions: number;
  /** The size of what was injected, or for a held recall would have been. */
  tokens: number;
  /** Recalls with a consequence window, and of those how many followed. */
  windows: number;
  followed: number;
  windowCalls: number;
  /** Null when no window in the row measured any tokens. */
  windowTokens: number | null;
  /** Held windows that share a call with a shown recall's window. The arm is drawn per session and shape, so one session can hold both, and such a window is a contaminated baseline. */
  overlapped: number;
}

type RecallWindow = RecallConsequence['window'];

const sharesACall = (one: RecallWindow, other: RecallWindow): boolean => Math.max(one.from, other.from) < Math.min(one.to, other.to);

/** Takes recalls that have been through `deriveConsequences`; `day` is a UTC day, so one day of hooks reads as one set of rows. A shown window from any day can overlap a held one. */
export const recallCounts = (recalls: readonly Recall[], day?: string): RecallCountRow[] => {
  const rows = new Map<string, { row: RecallCountRow; sessions: Set<string> }>();
  const shown = new Map<string | null, RecallWindow[]>();
  for (const recall of recalls) {
    if (recall.arm === 'shown' && recall.consequence !== undefined) shown.set(recall.sid, [...(shown.get(recall.sid) ?? []), recall.consequence.window]);
  }
  for (const recall of recalls) {
    if (day !== undefined && !recall.at.startsWith(day)) continue;
    const key = [recall.mode, recall.arm, recall.answer.kind].join(' ');
    const held = rows.get(key) ?? { row: { mode: recall.mode, arm: recall.arm, kind: recall.answer.kind, recalls: 0, sessions: 0, tokens: 0, windows: 0, followed: 0, windowCalls: 0, windowTokens: null, overlapped: 0 }, sessions: new Set<string>() };
    rows.set(key, held);
    const { row, sessions } = held;
    row.recalls += 1;
    row.tokens += recall.answer.tokens;
    if (recall.sid !== null) sessions.add(recall.sid);
    row.sessions = sessions.size;
    const { consequence } = recall;
    if (consequence === undefined) continue;
    row.windows += 1;
    if (consequence.followed) row.followed += 1;
    row.windowCalls += consequence.window.calls;
    if (consequence.cost.tokens !== null) row.windowTokens = (row.windowTokens ?? 0) + consequence.cost.tokens;
    if (recall.arm === 'held' && (shown.get(recall.sid) ?? []).some((window) => sharesACall(consequence.window, window))) row.overlapped += 1;
  }
  return [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, { row }]) => row);
};

export const formatRecallCounts = (rows: readonly RecallCountRow[]): string =>
  rows.length === 0
    ? 'No recalls in that span.'
    : rows
        .map((row) => `${row.mode} ${row.arm} ${row.kind} | ${String(row.recalls)} recalls, ${String(row.sessions)} sessions, ${String(row.tokens)} tokens | ${String(row.windows)} windows, ${String(row.followed)} followed, ${String(row.windowCalls)} calls, ${row.windowTokens === null ? 'window tokens unmeasured' : `${String(row.windowTokens)} window tokens`}, ${String(row.overlapped)} overlapped`)
        .join('\n');
