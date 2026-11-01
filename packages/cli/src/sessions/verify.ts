// `oars sessions verify`: consistency invariants over a skeleton, run locally before any future upload. A skeleton holds ids,
// timestamps, tool linkage and token counts, never content, so the check needs nothing the store does not already hold.
import type { Skeleton, SkeletonLine } from './schema.js';

export interface InvariantResult {
  name: string;
  /** What was compared: lines, pairs, or tool results, as each invariant defines it. */
  checked: number;
  violations: number;
}

export const INVARIANTS = [
  'tool_result names an earlier tool_use',
  'parentUuid resolves in the file',
  'message timestamps never step back more than 1 s',
  'assistant lines carry a request id; shared ids have consecutive apiBlockIndex',
  'thinking tokens never exceed output tokens',
  'cost-state totals cover summed usage since the process start, subagents included',
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

/**
 * The harness's `cost-state` totals are a bound, not a sum (A2, diagnosed on the operator's store 2026-11-01): they cover only the
 * process that wrote them (from `startTime`, so a resumed session's earlier lines are outside), they include the session's
 * subagent transcripts, and they include side calls no transcript records (a `claude-haiku` entry in `modelUsage` with no
 * assistant line of that model; a few hundred input tokens of the main model). So the check is that the recorded usage since
 * the process start, main and subagent lines together, never exceeds the totals.
 */
const verifyCost = (lines: readonly SkeletonLine[], delegated: readonly SkeletonLine[]): InvariantResult => {
  const last = [...lines].reverse().find((line) => line.costState !== null)?.costState;
  if (last === undefined || last === null) return { name: INVARIANTS[5], checked: 0, violations: 0 };
  const since = last.since === null ? Number.NEGATIVE_INFINITY : Date.parse(last.since);
  const sums = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  // Every content block of one API response is its own line and repeats that response's usage, so it counts once per request id.
  const counted = new Set<string>();
  for (const line of [...lines, ...delegated]) {
    if (line.type !== 'assistant' || line.usage === null) continue;
    if (line.ts !== null && Date.parse(line.ts) < since) continue;
    if (line.requestId !== null) {
      if (counted.has(line.requestId)) continue;
      counted.add(line.requestId);
    }
    sums.input += line.usage.input;
    sums.cacheWrite += line.usage.cacheWrite;
    sums.cacheRead += line.usage.cacheRead;
    sums.output += line.usage.output;
  }
  let checked = 0;
  let violations = 0;
  for (const key of ['input', 'cacheWrite', 'cacheRead', 'output'] as const) {
    const total = last[key];
    if (total === null) continue;
    checked += 1;
    if (sums[key] > total) violations += 1;
  }
  return { name: INVARIANTS[5], checked, violations };
};

/** `delegated` holds the lines of the session's subagent transcripts, which its cost-state totals include. */
export const verifySkeleton = (skeleton: Skeleton, delegated: readonly SkeletonLine[] = []): InvariantResult[] => [
  verifyToolLinkage(skeleton.lines),
  verifyParents(skeleton.lines),
  verifyTimestamps(skeleton.lines),
  verifyRequests(skeleton.lines),
  verifyThinking(skeleton.lines),
  verifyCost(skeleton.lines, delegated),
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
      }
    }
  }
  return totals;
};

export const formatVerify = (results: readonly InvariantResult[], sessions: number): string =>
  [
    `${String(sessions)} skeletons checked`,
    ...results.map((result) => `${result.violations === 0 ? 'PASS' : 'FAIL'}  ${result.name}: ${String(result.checked - result.violations)} of ${String(result.checked)} hold${result.violations === 0 ? '' : `, ${String(result.violations)} exceptions`}`),
  ].join('\n');
