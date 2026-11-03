// Layer 2's self-baseline (spec 2.2, t744): a session's week against the operator's own other weeks on the same harness. Local only: no pooled field,
// no network, no account step. The peer baseline waits for T2.
import { harnessOf, type Harness, type PromptObservation, type SessionObservation, type ToolObservation } from './schema.js';

/** A week needs this many tool calls to be a unit or a baseline week (spec 5.4 item 1). */
export const BASELINE_MIN_CALLS = 1000;
/** A baseline needs this many other qualifying weeks (spec 5.4 item 1). */
export const BASELINE_MIN_WEEKS = 4;
/** F's bounds: a median distance at or under the low is F 1, at or over the high is F 0. */
export const FIT_LOW = 1 / 10;
export const FIT_HIGH = 2 / 5;

/** The fixed bin edges of the numeric dimensions: a value goes in the first bin whose edge it is under, else the last. */
export const DURATION_EDGES_MS: readonly number[] = [100, 1000, 10_000, 60_000];
export const WALL_EDGES_SEC: readonly number[] = [5, 30, 120, 600];
export const CACHE_SHARE_EDGES: readonly number[] = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
export const OUTPUT_PER_TURN_EDGES: readonly number[] = [50, 200, 500, 1000, 2000];

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export const DIMENSIONS = ['tool mix', 'status', 'durationMs', 'wallSec', 'cache-read share', 'output per turn', 'prompt class'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** The fields each record needs, so a caller passes the store's records and a test passes small ones. */
export type BaselineSession = Pick<SessionObservation, 'session' | 'tsFirst' | 'tools' | 'harness'>;
export type BaselineTool = Pick<ToolObservation, 'session' | 'status' | 'durationMs'>;
export type BaselinePrompt = Pick<PromptObservation, 'session' | 'wallSec' | 'cls' | 'turns' | 'usage'>;

export interface DimensionDistance {
  dimension: Dimension;
  distance: number;
}

/** One session's layer-2 result: `scored` with `m` and `f`, or `not run` with the reason and nothing scored. */
export interface SelfBaselineResult {
  session: string;
  harness: Harness;
  /** The UTC Monday of the session's `tsFirst` (YYYY-MM-DD); null when `tsFirst` is null. */
  week: string | null;
  status: 'scored' | 'not run';
  reason: string | null;
  /** Tool calls in the session's week on its harness. */
  calls: number;
  /** The other qualifying weeks the baseline pools. */
  baselineWeeks: number;
  distances: DimensionDistance[];
  m: number | null;
  f: number | null;
}

type Histogram = Map<string, number>;
type Histograms = Map<Dimension, Histogram>;

/** The UTC Monday 00:00 (epoch ms) of the week holding `ts`; null for a null or unparsable timestamp. */
export const weekOf = (ts: string | null): number | null => {
  const at = ts === null ? Number.NaN : Date.parse(ts);
  if (Number.isNaN(at)) return null;
  const day = Math.floor(at / DAY_MS) * DAY_MS;
  // 1970-01-01 was a Thursday: three days after the Monday of its week.
  return day - ((((day / DAY_MS) + 3) % 7) * DAY_MS);
};

/** The median; the mean of the middle two for an even count. Never called with an empty list. */
export const medianOf = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/** F = 1 - clamp((m - 1/10) / (2/5 - 1/10)). */
export const fitOf = (m: number): number => 1 - Math.min(1, Math.max(0, (m - FIT_LOW) / (FIT_HIGH - FIT_LOW)));

const binOf = (value: number, edges: readonly number[]): string => {
  const index = edges.findIndex((edge) => value < edge);
  return String(index === -1 ? edges.length : index);
};

const add = (histogram: Histogram, key: string, count = 1): void => {
  histogram.set(key, (histogram.get(key) ?? 0) + count);
};

const emptyHistograms = (): Histograms => new Map(DIMENSIONS.map((dimension) => [dimension, new Map<string, number>()]));

const histogramOf = (histograms: Histograms, dimension: Dimension): Histogram => histograms.get(dimension) ?? new Map<string, number>();

const callsOf = (session: BaselineSession): number => Object.values(session.tools).reduce((total, count) => total + count, 0);

const addInto = (into: Histograms, from: Histograms): void => {
  for (const dimension of DIMENSIONS) for (const [key, count] of histogramOf(from, dimension)) add(histogramOf(into, dimension), key, count);
};

const total = (histogram: Histogram): number => [...histogram.values()].reduce((sum, count) => sum + count, 0);

/** Half the sum of absolute differences of the two normalized histograms. */
const distanceBetween = (a: Histogram, b: Histogram): number => {
  const sumA = total(a);
  const sumB = total(b);
  let sum = 0;
  for (const key of new Set([...a.keys(), ...b.keys()])) sum += Math.abs((a.get(key) ?? 0) / sumA - (b.get(key) ?? 0) / sumB);
  return sum / 2;
};

interface WeekGroup {
  harness: Harness;
  start: number;
  calls: number;
  histograms: Histograms;
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Every session's result. A session belongs wholly to the UTC week of its `tsFirst` and takes the F of its harness and week. A week qualifies at
 * {@link BASELINE_MIN_CALLS} tool calls with its last UTC day no later than `asOf`; the baseline is a harness's other qualifying weeks, their counts
 * added per bin so each week weighs what its calls weigh. A dimension with no counts on one side or both is dropped; `m` is the median of the
 * rest. Mechanics only: no signature, no record content.
 */
export const selfBaseline = (sessions: readonly BaselineSession[], tools: readonly BaselineTool[], prompts: readonly BaselinePrompt[], asOf: number): SelfBaselineResult[] => {
  const toolsOf = new Map<string, BaselineTool[]>();
  for (const tool of tools) toolsOf.set(tool.session, (toolsOf.get(tool.session) ?? []).concat(tool));
  const promptsOf = new Map<string, BaselinePrompt[]>();
  for (const prompt of prompts) promptsOf.set(prompt.session, (promptsOf.get(prompt.session) ?? []).concat(prompt));

  const groups = new Map<string, WeekGroup>();
  const keyOf = new Map<string, string | null>();
  for (const session of sessions) {
    const start = weekOf(session.tsFirst);
    if (start === null) {
      keyOf.set(session.session, null);
      continue;
    }
    const harness = harnessOf(session);
    const key = `${harness}:${String(start)}`;
    keyOf.set(session.session, key);
    const group = groups.get(key) ?? { harness, start, calls: 0, histograms: emptyHistograms() };
    groups.set(key, group);
    group.calls += callsOf(session);
    for (const [tool, count] of Object.entries(session.tools)) add(histogramOf(group.histograms, 'tool mix'), tool, count);
    for (const tool of toolsOf.get(session.session) ?? []) {
      add(histogramOf(group.histograms, 'status'), tool.status);
      if (tool.durationMs !== null) add(histogramOf(group.histograms, 'durationMs'), binOf(tool.durationMs, DURATION_EDGES_MS));
    }
    for (const prompt of promptsOf.get(session.session) ?? []) {
      add(histogramOf(group.histograms, 'prompt class'), prompt.cls);
      if (prompt.wallSec !== null) add(histogramOf(group.histograms, 'wallSec'), binOf(prompt.wallSec, WALL_EDGES_SEC));
      const input = prompt.usage.input + prompt.usage.cacheWrite + prompt.usage.cacheRead;
      if (input > 0) add(histogramOf(group.histograms, 'cache-read share'), binOf(prompt.usage.cacheRead / input, CACHE_SHARE_EDGES));
      if (prompt.turns > 0) add(histogramOf(group.histograms, 'output per turn'), binOf(prompt.usage.output / prompt.turns, OUTPUT_PER_TURN_EDGES));
    }
  }

  const scored = new Map<string, Omit<SelfBaselineResult, 'session' | 'harness' | 'week'>>();
  for (const [key, group] of groups) {
    const base = { calls: group.calls, baselineWeeks: 0, distances: [], m: null, f: null };
    if (group.calls < BASELINE_MIN_CALLS) {
      scored.set(key, { ...base, status: 'not run', reason: `week under ${String(BASELINE_MIN_CALLS)} tool calls` });
      continue;
    }
    const others = [...groups.values()].filter((other) => other.harness === group.harness && other.start !== group.start && other.calls >= BASELINE_MIN_CALLS && other.start + WEEK_MS - DAY_MS <= Math.floor(asOf / DAY_MS) * DAY_MS);
    if (others.length < BASELINE_MIN_WEEKS) {
      scored.set(key, { ...base, baselineWeeks: others.length, status: 'not run', reason: `under ${String(BASELINE_MIN_WEEKS)} qualifying baseline weeks` });
      continue;
    }
    const pooled = emptyHistograms();
    for (const other of others) addInto(pooled, other.histograms);
    const distances = DIMENSIONS.filter((dimension) => total(histogramOf(group.histograms, dimension)) > 0 && total(histogramOf(pooled, dimension)) > 0).map(
      (dimension): DimensionDistance => ({ dimension, distance: distanceBetween(histogramOf(group.histograms, dimension), histogramOf(pooled, dimension)) }),
    );
    // The tool mix has counts on both sides whenever the week and the baseline each hold 1,000 calls, so at least one dimension always remains.
    const m = medianOf(distances.map((entry) => entry.distance));
    scored.set(key, { ...base, baselineWeeks: others.length, distances, m, f: fitOf(m), status: 'scored', reason: null });
  }

  return sessions.map((session): SelfBaselineResult => {
    const key = keyOf.get(session.session) ?? null;
    const harness = harnessOf(session);
    const found = key === null ? undefined : scored.get(key);
    if (key === null || found === undefined) return { session: session.session, harness, week: null, status: 'not run', reason: 'no first timestamp', calls: 0, baselineWeeks: 0, distances: [], m: null, f: null };
    return { session: session.session, harness, week: isoDay(groups.get(key)?.start ?? 0), ...found };
  });
};

/** A count line for the scored sessions, then one per reason a session was not run. Counts only. */
export const formatSelfBaseline = (results: readonly SelfBaselineResult[]): string => {
  const reasons = new Map<string, number>();
  for (const entry of results) if (entry.reason !== null) add(reasons, entry.reason);
  return [
    `${String(results.length)} sessions against their own earlier weeks (layer 2, local; a low F lowers W and rejects nothing)`,
    `      scored: ${String(results.filter((entry) => entry.status === 'scored').length)}`,
    ...[...reasons].sort().map(([reason, count]) => `      not run, ${reason}: ${String(count)}`),
  ].join('\n');
};
