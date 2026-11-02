// `oars sessions verify`: consistency invariants over a skeleton, run locally before any future upload. A skeleton holds ids,
// timestamps, tool linkage and token counts, never content, so the check needs nothing the store does not already hold.
import { CAPTURE_VERSION, OLDEST_READABLE_CAPTURE, type SessionObservation, type Skeleton, type SkeletonLine, type ToolObservation } from './schema.js';

export interface InvariantResult {
  name: string;
  /** What was compared: lines, pairs, or tool results, as each invariant defines it. */
  checked: number;
  violations: number;
  /** Checks that neither hold nor fail, each counted under the cause it was traced to (the cost-state check only). */
  observed?: ObservedClass[];
}

export type CostClass = 'resume scope' | 'subagent transcripts' | 'harness side calls' | 'other';

export interface ObservedClass {
  cls: CostClass;
  /** True for a check that holds only once its scope is applied; false for a total above the recorded sum. */
  holds: boolean;
  checks: number;
  /** The first session seen in the class. */
  example: string | null;
}

/** The order the classes print in: the two scopings a check needs to hold, then the two causes of a total above the sum. */
const CLASSES: readonly { cls: CostClass; holds: boolean }[] = [
  { cls: 'resume scope', holds: true },
  { cls: 'subagent transcripts', holds: true },
  { cls: 'harness side calls', holds: false },
  { cls: 'other', holds: false },
];
const emptyClasses = (): ObservedClass[] => CLASSES.map((entry) => ({ ...entry, checks: 0, example: null }));

export const INVARIANTS = [
  'tool_result names an earlier tool_use',
  'parentUuid resolves in the file',
  'message timestamps never step back more than 1 s',
  'assistant lines carry a request id; shared ids have consecutive apiBlockIndex',
  'thinking tokens never exceed output tokens',
  'cost-state totals equal summed usage since the process start, subagents included',
] as const;

const STEP_BACK_MS = 1000;

const verifyToolLinkage = (lines: readonly SkeletonLine[]): InvariantResult => {
  const seen = new Set<string>();
  let checked = 0;
  let violations = 0;
  for (const line of lines) {
    for (const result of line.results) {
      checked += 1;
      if (result === null || !seen.has(result)) violations += 1;
    }
    for (const tool of line.tools) if (tool.id !== null) seen.add(tool.id);
  }
  return { name: INVARIANTS[0], checked, violations };
};

const verifyParents = (lines: readonly SkeletonLine[]): InvariantResult => {
  const ids = new Set(lines.map((line) => line.uuid).filter((uuid): uuid is string => uuid !== null));
  const withParent = lines.filter((line) => line.parentUuid !== null);
  return { name: INVARIANTS[1], checked: withParent.length, violations: withParent.filter((line) => line.parentUuid !== null && !ids.has(line.parentUuid)).length };
};

const verifyTimestamps = (lines: readonly SkeletonLine[]): InvariantResult => {
  const stamps = lines
    .filter((line) => line.role !== null && line.ts !== null)
    .map((line) => Date.parse(line.ts ?? ''))
    .filter((millis) => !Number.isNaN(millis));
  let violations = 0;
  for (let index = 1; index < stamps.length; index += 1) if ((stamps[index - 1] ?? 0) - (stamps[index] ?? 0) > STEP_BACK_MS) violations += 1;
  return { name: INVARIANTS[2], checked: Math.max(stamps.length - 1, 0), violations };
};

const verifyRequests = (lines: readonly SkeletonLine[]): InvariantResult => {
  const assistants = lines.filter((line) => line.type === 'assistant');
  const groups = new Map<string, SkeletonLine[]>();
  let checked = 0;
  let violations = 0;
  for (const line of assistants) {
    checked += 1;
    if (line.requestId === null) {
      violations += 1;
      continue;
    }
    groups.set(line.requestId, [...(groups.get(line.requestId) ?? []), line]);
  }
  for (const group of groups.values()) {
    if (group.length < 2 || group.some((line) => line.apiBlockIndex === null)) continue;
    for (let index = 1; index < group.length; index += 1) {
      checked += 1;
      if ((group[index]?.apiBlockIndex ?? 0) !== (group[index - 1]?.apiBlockIndex ?? 0) + 1) violations += 1;
    }
  }
  return { name: INVARIANTS[3], checked, violations };
};

const verifyThinking = (lines: readonly SkeletonLine[]): InvariantResult => {
  const reporting = lines.filter((line) => line.hasThinking && line.usage !== null);
  return { name: INVARIANTS[4], checked: reporting.length, violations: reporting.filter((line) => (line.usage?.thinking ?? 0) > (line.usage?.output ?? 0)).length };
};

type Sums = { input: number; cacheWrite: number; cacheRead: number; output: number };
const KEYS = ['input', 'cacheWrite', 'cacheRead', 'output'] as const;

/** Assistant usage from `since` on. Every content block of one API response is its own line and repeats its usage: once per request id. */
const sumUsage = (lines: readonly SkeletonLine[], since: number): Sums => {
  const sums: Sums = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const counted = new Set<string>();
  for (const line of lines) {
    if (line.type !== 'assistant' || line.usage === null) continue;
    if (line.ts !== null && Date.parse(line.ts) < since) continue;
    if (line.requestId !== null) {
      if (counted.has(line.requestId)) continue;
      counted.add(line.requestId);
    }
    for (const key of KEYS) sums[key] += line.usage[key];
  }
  return sums;
};

/**
 * The harness's `cost-state` totals (A2, diagnosed on the operator's store 2026-11-01) cover only the process that wrote them
 * (from `startTime`, so a resumed session's earlier lines are outside) and include the session's subagent transcripts. Within
 * that scope the recorded usage must equal the totals, and a sum above them fails. A total above the sum is not a failure: the
 * harness also counts side calls no transcript records (001cf645's `modelUsage` has a `claude-haiku` entry and no assistant line
 * of that model), so it is reported as observed, under that class on a key such a model reported, else under `other`.
 * A check that holds only once a scope is applied is counted under that scope.
 */
const verifyCost = (lines: readonly SkeletonLine[], delegated: readonly SkeletonLine[], session: string): InvariantResult => {
  const last = [...lines].reverse().find((line) => line.costState !== null)?.costState;
  const observed = emptyClasses();
  if (last === undefined || last === null) return { name: INVARIANTS[5], checked: 0, violations: 0, observed };
  const since = last.since === null ? Number.NEGATIVE_INFINITY : Date.parse(last.since);
  const scoped = sumUsage([...lines, ...delegated], since);
  const resumed = sumUsage(lines, since);
  const unscoped = sumUsage(lines, Number.NEGATIVE_INFINITY);
  const named = new Set([...lines, ...delegated].map((line) => line.model));
  // A key is a side call only when a model no line names reported it; the entries of an older skeleton carry none.
  const sideKeys = new Set(last.models.filter((entry) => !named.has(entry.model)).flatMap((entry) => entry.keys));
  const note = (cls: CostClass): void => {
    const entry = observed.find((candidate) => candidate.cls === cls);
    if (entry === undefined) return;
    entry.checks += 1;
    entry.example ??= session;
  };
  let checked = 0;
  let violations = 0;
  for (const key of KEYS) {
    const total = last[key];
    if (total === null) continue;
    checked += 1;
    if (scoped[key] > total) violations += 1;
    else if (scoped[key] < total) note(sideKeys.has(key) ? 'harness side calls' : 'other');
    else if (unscoped[key] !== total) {
      if (resumed[key] !== unscoped[key]) note('resume scope');
      if (scoped[key] !== resumed[key]) note('subagent transcripts');
    }
  }
  return { name: INVARIANTS[5], checked, violations, observed };
};

/** `delegated` holds the lines of the session's subagent transcripts, which its cost-state totals include. */
export const verifySkeleton = (skeleton: Skeleton, delegated: readonly SkeletonLine[] = []): InvariantResult[] => [
  verifyToolLinkage(skeleton.lines),
  verifyParents(skeleton.lines),
  verifyTimestamps(skeleton.lines),
  verifyRequests(skeleton.lines),
  verifyThinking(skeleton.lines),
  verifyCost(skeleton.lines, delegated, skeleton.session),
];

/** A subagent transcript is stored as `<parent>~...~agent-<id>`; a main session's id holds no `~`. */
const mainSessionOf = (session: string): string => session.split('~')[0] ?? session;

/** Sums each invariant over many skeletons, each main session's cost-state checked with its subagent transcripts' lines. */
export const verifyAll = (skeletons: readonly Skeleton[]): InvariantResult[] => {
  const totals: InvariantResult[] = INVARIANTS.map((name) => ({ name, checked: 0, violations: 0 }));
  const delegated = new Map<string, SkeletonLine[]>();
  for (const skeleton of skeletons) {
    const parent = mainSessionOf(skeleton.session);
    if (parent !== skeleton.session) delegated.set(parent, (delegated.get(parent) ?? []).concat(skeleton.lines));
  }
  for (const skeleton of skeletons) {
    for (const [index, result] of verifySkeleton(skeleton, delegated.get(skeleton.session)).entries()) {
      const total = totals[index];
      if (total !== undefined) {
        total.checked += result.checked;
        total.violations += result.violations;
        if (result.observed !== undefined) total.observed = mergeClasses(total.observed ?? emptyClasses(), result.observed);
      }
    }
  }
  return totals;
};

const mergeClasses = (into: readonly ObservedClass[], from: readonly ObservedClass[]): ObservedClass[] =>
  into.map((entry, index) => {
    const other = from[index];
    return other === undefined ? entry : { ...entry, checks: entry.checks + other.checks, example: entry.example ?? other.example };
  });

const classLine = (label: string, classes: readonly ObservedClass[]): string[] => {
  const shown = classes.filter((entry) => entry.checks > 0);
  if (shown.length === 0) return [];
  const parts = shown.map((entry) => `${String(entry.checks)} ${entry.cls}${entry.example === null ? '' : ` (e.g. ${entry.example})`}`);
  return [`      ${label}: ${parts.join(', ')}`];
};

const formatResult = (result: InvariantResult): string[] => {
  const classes = result.observed ?? [];
  const above = classes.filter((entry) => !entry.holds);
  const observed = above.reduce((sum, entry) => sum + entry.checks, 0);
  const holding = result.checked - result.violations - observed;
  return [
    `${result.violations === 0 ? 'PASS' : 'FAIL'}  ${result.name}: ${String(holding)} of ${String(result.checked)} hold${result.violations === 0 ? '' : `, ${String(result.violations)} exceptions`}${observed === 0 ? '' : `, ${String(observed)} observed`}`,
    ...classLine('equal only within scope', classes.filter((entry) => entry.holds)),
    ...classLine('total above the recorded sum, as observed', above),
  ];
};

export const formatVerify = (results: readonly InvariantResult[], sessions: number): string =>
  [`${String(sessions)} skeletons checked`, ...results.flatMap(formatResult)].join('\n');

export const CAPTURE_INVARIANTS = [
  'every session is captured at the current capture version (none is cv-behind)',
  'sessions captured at the current version share one sid',
  'every fileHash on a session is a path target of one of its tool calls',
  'a path target names its base; no other target does',
] as const;

const HASH = /^[0-9a-f]{16}$/;

/**
 * The CAPTURE 4 fields, checked over the store's capture records (t714): cv-behind sessions (a version-3 session not yet captured
 * again), a mixed `sid` (two salts in one store, so path joins hold only within each), `fileHashes` that no tool call explains, and
 * `targetBase` set on, or missing from, the wrong kind of target. Skeleton invariants stay in {@link verifyAll}.
 */
export const verifyCaptured = (sessions: readonly SessionObservation[], tools: readonly ToolObservation[]): InvariantResult[] => {
  const current = sessions.filter((session) => session.cv === CAPTURE_VERSION);
  const readable = sessions.filter((session) => Number(session.cv) >= OLDEST_READABLE_CAPTURE);
  const counts = new Map<string, number>();
  for (const session of current) if (session.sid !== null) counts.set(session.sid, (counts.get(session.sid) ?? 0) + 1);
  const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const targets = new Map<string, Set<string>>();
  for (const tool of tools) if (tool.targetBase !== null && tool.target !== null) targets.set(tool.session, (targets.get(tool.session) ?? new Set<string>()).add(tool.target));
  const currentTools = tools.filter((tool) => tool.cv === CAPTURE_VERSION);
  return [
    { name: CAPTURE_INVARIANTS[0], checked: readable.length, violations: readable.filter((session) => Number(session.cv) < Number(CAPTURE_VERSION)).length },
    { name: CAPTURE_INVARIANTS[1], checked: current.length, violations: current.filter((session) => session.sid !== majority).length },
    {
      name: CAPTURE_INVARIANTS[2],
      checked: current.length,
      violations: current.filter((session) => session.fileHashes.some((hash) => targets.get(session.session)?.has(hash) !== true)).length,
    },
    {
      name: CAPTURE_INVARIANTS[3],
      checked: currentTools.length,
      violations: currentTools.filter((tool) => (tool.targetBase !== null) !== (tool.target !== null && HASH.test(tool.target))).length,
    },
  ];
};
