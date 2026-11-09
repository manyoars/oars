// What telemetry measures, in one place: the CLI's own report and the pool's rollup both turn an event into the same `Measure`s, so a user's number and the fleet's are the same number.
// A measure is one observation in a cell: a latency in milliseconds, or a yes/no that rates are made from. The cell is (metric, dimension, value): `hook.pre-tool.latency` at harness
// `claude-code`, version `2.1.5`. The reader is tolerant on purpose: the pool reads batches kept whole from any client, so a value that does not fit is skipped, never trusted.
import { isHarness } from '../sessions/pool-wire.js';
import { CI_WORDS, SURFACE_WORDS } from './schema.js';

/** A latency in a cell, or a yes (1) or no (0) that a rate is made from. */
export type Kind = 'latency' | 'rate';

export interface Measure {
  metric: string;
  /** What the value groups by: the harness and harness version a hook ran under (`claude-code/2.1.5`), or the oars version for a command. */
  dimension: 'harnessVersion' | 'cli';
  value: string;
  kind: Kind;
  /** Milliseconds for a latency; 1 or 0 for a rate. */
  x: number;
}

/** The windows the report shows and the pool serves, in days. */
export const WINDOWS: readonly number[] = [7, 30];

const DAY_MS = 86_400_000;

/** The hooks that exist; any other name in a batch is not measured. */
export const HOOK_NAMES: readonly string[] = ['session-start', 'prompt', 'pre-tool', 'post-tool', 'stop', 'nightly', 'gate'];

/** A group value as the program writes it: a version or a word, short, with no space, slash, or quote. Anything else is `other`. */
const VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const COMMAND = /^[a-z][A-Za-z0-9-]{0,31}$/;

export const OTHER = 'other';
export const UNRECORDED = 'unrecorded';

const valueOf = (raw: unknown): string => {
  if (raw === undefined) return UNRECORDED;
  return typeof raw === 'string' && VALUE.test(raw) ? raw : OTHER;
};

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null && !Array.isArray(value);
const fieldOf = (value: unknown, key: string): unknown => (isObject(value) ? Reflect.get(value, key) : undefined);

/** A whole number of milliseconds a day long at most, or undefined. */
const millis = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= DAY_MS ? value : undefined);

const latency = (metric: string, dimension: Measure['dimension'], value: string, x: number): Measure => ({ metric, dimension, value, kind: 'latency', x });
const rate = (metric: string, dimension: Measure['dimension'], value: string, yes: boolean): Measure => ({ metric, dimension, value, kind: 'rate', x: yes ? 1 : 0 });

/**
 * The value of a hook cell: the harness and its version, `claude-code/2.1.5`, so one version number under two harnesses is two cells. A harness off the closed list is `other`; an event written
 * before the field existed has none and reads `unrecorded`, never dropped.
 */
const hookCellOf = (harness: unknown, version: unknown): string => {
  const named = harness === undefined ? UNRECORDED : typeof harness === 'string' && isHarness(harness) ? harness : OTHER;
  return `${named}/${valueOf(version)}`;
};

/** The measures of a `hook` event: its latency, and whether it found something. A hook that failed is neither a hit nor a miss. */
const hookMeasures = (data: unknown): Measure[] => {
  const name = fieldOf(data, 'name');
  if (typeof name !== 'string' || !HOOK_NAMES.includes(name)) return [];
  const version = hookCellOf(fieldOf(data, 'harness'), fieldOf(data, 'harnessVersion'));
  const found: Measure[] = [];
  const took = millis(fieldOf(data, 'latencyMs'));
  if (took !== undefined) found.push(latency(`hook.${name}.latency`, 'harnessVersion', version, took));
  const outcome = fieldOf(data, 'outcome');
  // `held` found something and held it back for the unexposed arm, so it counts as a find.
  if (outcome === 'hit' || outcome === 'held') found.push(rate(`hook.${name}.hit`, 'harnessVersion', version, true));
  else if (outcome === 'miss') found.push(rate(`hook.${name}.hit`, 'harnessVersion', version, false));
  return found;
};

/** The measures of a `command` event: how long it took, and whether it failed, under the first name of its path. */
const commandMeasures = (event: unknown, data: unknown): Measure[] => {
  const path = fieldOf(data, 'path');
  const first = Array.isArray(path) && typeof path[0] === 'string' && COMMAND.test(path[0]) ? path[0] : 'none';
  const version = valueOf(fieldOf(event, 'cli'));
  const found: Measure[] = [];
  const took = millis(fieldOf(data, 'durationMs'));
  if (took !== undefined) found.push(latency(`command.${first}.latency`, 'cli', version, took));
  const exit = fieldOf(data, 'exitCode');
  if (typeof exit === 'number' && Number.isSafeInteger(exit) && exit >= 0 && exit <= 255) found.push(rate(`command.${first}.failure`, 'cli', version, exit !== 0));
  return found;
};

/** The measures of a `store-health` event: whether the nightly could read the store, and whether it found a session that does not verify. */
const storeMeasures = (event: unknown, data: unknown): Measure[] => {
  const version = valueOf(fieldOf(event, 'cli'));
  const unread = fieldOf(data, 'readFailed') === 1;
  const found: Measure[] = [rate('store.readFailure', 'cli', version, unread)];
  const failed = fieldOf(data, 'verifyFailed');
  if (!unread && typeof failed === 'number' && Number.isSafeInteger(failed) && failed >= 0) found.push(rate('store.verifyFailure', 'cli', version, failed > 0));
  return found;
};

/**
 * The cell of a `first-run` event: one yes (the first run was in CI) or no under the oars version, in a metric named for the listing surface (`first-run.npx`), so the pool's rollup holds each install's
 * first-run day, its surface, and whether it ran in CI. `measuresOf` leaves it out on purpose: a rate over one event is no measure of the program, so the user's own report has no use for it. A word off
 * the closed lists reads as `unknown` or not-CI, and the install is still counted.
 */
export const firstRunMeasures = (event: unknown): Measure[] => {
  if (fieldOf(event, 'type') !== 'first-run') return [];
  const data = fieldOf(event, 'data');
  const surface = fieldOf(data, 'surface');
  const ci = fieldOf(data, 'ci');
  const known = typeof surface === 'string' && SURFACE_WORDS.some((word) => word === surface) ? surface : 'unknown';
  const inCi = typeof ci === 'string' && ci !== 'none' && CI_WORDS.some((word) => word === ci);
  return [rate(`first-run.${known}`, 'cli', valueOf(fieldOf(event, 'cli')), inCi)];
};

/** What one event measures; an event of a type nothing measures, or that is not an object, measures nothing. */
export const measuresOf = (event: unknown): Measure[] => {
  const type = fieldOf(event, 'type');
  const data = fieldOf(event, 'data');
  switch (type) {
    case 'hook':
      return hookMeasures(data);
    case 'command':
      return commandMeasures(event, data);
    case 'store-health':
      return storeMeasures(event, data);
    default:
      return [];
  }
};

/** Every cell is named by these three together. */
export const cellKey = (measure: Pick<Measure, 'metric' | 'dimension' | 'value'>): string => `${measure.metric}\u0000${measure.dimension}\u0000${measure.value}`;

/**
 * The bucket edges a latency histogram counts in, each 1.5 times the one before (1, 2, 3, 4, 6, 9, ...) up to a day. The pool keeps a histogram, not the latencies, so its percentile is the
 * upper edge of the bucket that holds it: within a factor of 1.5 of the true one.
 */
export const LATENCY_EDGES: readonly number[] = ((): number[] => {
  const edges: number[] = [];
  for (let step = 0; ; step += 1) {
    const edge = Math.ceil(1.5 ** step);
    if (edges.at(-1) !== edge) edges.push(edge);
    if (edge >= DAY_MS) return edges;
  }
})();

/** The index of the first edge at or above the latency. */
export const bucketOf = (milliseconds: number): number => LATENCY_EDGES.findIndex((edge) => milliseconds <= edge);

/** The p-th percentile (0 to 1) of a histogram given as [bucket index, count] pairs, as that bucket's upper edge. */
export const histogramPercentile = (buckets: readonly (readonly [number, number])[], p: number): number => {
  const sorted = [...buckets].sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((sum, [, count]) => sum + count, 0);
  const target = Math.max(1, Math.ceil(p * total));
  let seen = 0;
  for (const [index, count] of sorted) {
    seen += count;
    if (seen >= target) return LATENCY_EDGES[index] ?? DAY_MS;
  }
  return 0;
};

/** The nearest-rank p-th percentile (0 to 1) of numbers; 0 for none. */
export const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
};
