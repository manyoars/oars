// What the rollup serves: the fleet read for users, and the operator's anomaly read. Both come from `telemetry_install_days` (telemetry-rollup.ts) and from nothing else, so neither joins telemetry
// to a deposit or reaches a bundle.
//
// The fleet read serves a cell (a metric at one harness or oars version) only where at least `K_CELL` installs report it in the window, counted in installs. It serves percentiles and no
// counts: no install count, event count, or total, so two served numbers cannot be subtracted to show an install under the floor. A latency cell is the p50 and p95 of the fleet's latencies; a
// rate cell is the median install's rate. A percentile cannot be subtracted either: the 30 day window is not the 7 day window plus anything.
import { cellKey, histogramPercentile, percentile, WINDOWS } from '../../cli/src/telemetry/measures.js';
import type { FleetCell } from '../../cli/src/telemetry/report.js';
import { K_CELL } from './derive.js';
import { answer, bound, fieldOf, notConfigured, refuse, type Env } from './http.js';
import { dayOf, shiftDay, type Entry } from './telemetry-rollup.js';

/** One row of the rollup: an install's day. */
export interface InstallDay {
  day: string;
  install: string;
  account: string;
  batches: number;
  events: number;
  entries: Entry[];
}

const numberIn = (row: unknown, key: string): number => {
  const found = fieldOf(row, key);
  if (typeof found !== 'number') throw new Error(`no number at ${key} in a rollup row`);
  return found;
};
const textIn = (row: unknown, key: string): string => {
  const found = fieldOf(row, key);
  if (typeof found !== 'string') throw new Error(`no text at ${key} in a rollup row`);
  return found;
};

const entryOf = (raw: unknown): Entry => {
  const dimension = fieldOf(raw, 'dimension');
  const kind = fieldOf(raw, 'kind');
  const buckets = fieldOf(raw, 'buckets');
  if ((dimension !== 'harnessVersion' && dimension !== 'cli') || (kind !== 'latency' && kind !== 'rate') || !Array.isArray(buckets)) throw new Error('a rollup row holds a cell that is not one');
  return {
    metric: textIn(raw, 'metric'),
    dimension,
    value: textIn(raw, 'value'),
    kind,
    n: numberIn(raw, 'n'),
    hits: numberIn(raw, 'hits'),
    buckets: buckets.map((pair): [number, number] => [numberIn(pair, '0'), numberIn(pair, '1')]),
  };
};

/** The rollup's rows from `from` to `to` (days, inclusive). Only the rollup writes the table, so a row that does not parse is a fault to surface. */
export const rowsBetween = async (env: Env, from: string, to: string): Promise<InstallDay[]> => {
  const read = await env.DB.prepare('SELECT day, install, account, batches, events, measures FROM telemetry_install_days WHERE day >= ? AND day <= ?').bind(from, to).all();
  return read.results.map((row) => {
    const measures: unknown = JSON.parse(textIn(row, 'measures'));
    if (!Array.isArray(measures)) throw new Error('a rollup row holds no list of cells');
    return { day: textIn(row, 'day'), install: textIn(row, 'install'), account: textIn(row, 'account'), batches: numberIn(row, 'batches'), events: numberIn(row, 'events'), entries: measures.map(entryOf) };
  });
};

/** The cells the fleet read serves for these rows: every cell reported by at least `K_CELL` distinct installs. */
export const fleetCells = (rows: readonly InstallDay[]): FleetCell[] => {
  interface Collected {
    head: Entry;
    installs: Map<string, { n: number; hits: number }>;
    histogram: Map<number, number>;
  }
  const cells = new Map<string, Collected>();
  for (const row of rows) {
    for (const entry of row.entries) {
      const key = cellKey(entry);
      const cell = cells.get(key) ?? { head: entry, installs: new Map<string, { n: number; hits: number }>(), histogram: new Map<number, number>() };
      const mine = cell.installs.get(row.install) ?? { n: 0, hits: 0 };
      mine.n += entry.n;
      mine.hits += entry.hits;
      cell.installs.set(row.install, mine);
      for (const [index, count] of entry.buckets) cell.histogram.set(index, (cell.histogram.get(index) ?? 0) + count);
      cells.set(key, cell);
    }
  }
  return [...cells.values()]
    .filter(({ installs }) => installs.size >= K_CELL)
    .map(({ head, installs, histogram }): FleetCell => {
      const { metric, dimension, value, kind } = head;
      if (kind === 'rate') return { metric, dimension, value, kind, p50: Math.round(percentile([...installs.values()].map(({ n, hits }) => hits / n), 0.5) * 1000) / 1000 };
      const buckets = [...histogram.entries()];
      return { metric, dimension, value, kind, p50: histogramPercentile(buckets, 0.5), p95: histogramPercentile(buckets, 0.95) };
    })
    .sort((a, b) => a.metric.localeCompare(b.metric) || a.value.localeCompare(b.value));
};

/** The last day the nightly run has rolled up as a whole: yesterday, UTC. */
export const asOfDay = (now: number): string => shiftDay(dayOf(now), -1);

/** `GET /v1/telemetry/fleet`: both windows, ending yesterday. No sign-in and no query: the read depends on nothing the caller sends. */
export const fleet = async (env: Env, now: number): Promise<Response> => {
  const asOf = asOfDay(now);
  const rows = await rowsBetween(env, shiftDay(asOf, 1 - Math.max(...WINDOWS)), asOf);
  const windows = WINDOWS.map((days) => ({ days, cells: fleetCells(rows.filter((row) => row.day >= shiftDay(asOf, 1 - days))) }));
  return answer(200, { asOf, floor: K_CELL, windows });
};

// The measurables (conclusion section 15): are installs reporting, and since when has the fleet read been served.

export interface Measurables {
  /** Installs that reported a batch in the last 7 days, over installs that ever have: the share still reporting. */
  reporting: { installsEver: number; installsLast7Days: number; share: number };
  /** The first day on which the fleet read, as of that day, served any cell from telemetry alone; null while it never has. */
  firstFleetRead: string | null;
}

export const measurablesOf = (rows: readonly InstallDay[], asOf: string): Measurables => {
  const ever = new Set(rows.map((row) => row.install));
  const recent = new Set(rows.filter((row) => row.day >= shiftDay(asOf, -6) && row.day <= asOf).map((row) => row.install));
  const days = [...new Set(rows.map((row) => row.day))].sort();
  const first = days.find((day) => fleetCells(rows.filter((row) => row.day >= shiftDay(day, -6) && row.day <= day)).length > 0);
  return { reporting: { installsEver: ever.size, installsLast7Days: recent.size, share: ever.size === 0 ? 0 : recent.size / ever.size }, firstFleetRead: first ?? null };
};

// The operator's anomaly read: entities whose counts sit far from the fleet's, for a person to read.

export interface Outlier {
  entity: 'install' | 'account';
  id: string;
  basis: 'events' | 'batches';
  count: number;
  median: number;
  direction: 'high' | 'low';
}

/** A count this many robust deviations from the fleet's median is listed. */
export const OUTLIER_SCORE = 5;
const MAD_TO_SIGMA = 1.4826;

const medianOf = (values: readonly number[]): number => percentile(values, 0.5);

/** The outliers among `counts` (an id to its count), or none when fewer than `K_CELL` entities give no baseline to be far from. */
const outliersIn = (entity: Outlier['entity'], basis: Outlier['basis'], counts: ReadonlyMap<string, number>): Outlier[] => {
  if (counts.size < K_CELL) return [];
  const values = [...counts.values()];
  const median = medianOf(values);
  const deviation = medianOf(values.map((value) => Math.abs(value - median)));
  // The scale never falls under a tenth of the median or 1, so a fleet whose counts are all equal does not list an install for being one event off.
  const scale = Math.max(MAD_TO_SIGMA * deviation, median / 10, 1);
  return [...counts.entries()]
    .filter(([, count]) => Math.abs(count - median) / scale >= OUTLIER_SCORE)
    .map(([id, count]): Outlier => ({ entity, id, basis, count, median, direction: count > median ? 'high' : 'low' }))
    .sort((a, b) => Math.abs(b.count - b.median) - Math.abs(a.count - a.median) || a.id.localeCompare(b.id));
};

/** Installs and accounts whose event or batch counts in the rows sit far from the fleet's. It lists; it flags nothing automatically and changes nothing. */
export const anomaliesOf = (rows: readonly InstallDay[]): { installs: number; accounts: number; outliers: Outlier[] } => {
  const tally = (idOf: (row: InstallDay) => string): { events: Map<string, number>; batches: Map<string, number> } => {
    const events = new Map<string, number>();
    const batches = new Map<string, number>();
    for (const row of rows) {
      const id = idOf(row);
      if (id === '') continue;
      events.set(id, (events.get(id) ?? 0) + row.events);
      batches.set(id, (batches.get(id) ?? 0) + row.batches);
    }
    return { events, batches };
  };
  const installs = tally((row) => row.install);
  const accounts = tally((row) => row.account);
  return {
    installs: installs.events.size,
    accounts: accounts.events.size,
    outliers: [...outliersIn('install', 'events', installs.events), ...outliersIn('install', 'batches', installs.batches), ...outliersIn('account', 'events', accounts.events), ...outliersIn('account', 'batches', accounts.batches)],
  };
};

export interface OperatorEnv {
  OPERATOR_TOKEN?: string;
}

const digest = async (text: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** `GET /v1/telemetry/operator`: the operator's read, behind a bearer secret the deploy sets. It is never served to users: with no secret set the route is not configured, and any other caller is refused. */
export const operator = async (request: Request, env: Env & OperatorEnv, now: number): Promise<Response> => {
  const secret = bound(env.OPERATOR_TOKEN);
  if (secret === undefined) return notConfigured('OPERATOR_TOKEN');
  const sent = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  // Compared as digests, so the comparison does not depend on how much of the secret a guess matched.
  if (sent === undefined || (await digest(sent)) !== (await digest(secret))) return refuse(401, 'unauthorized', 'This read is for the pool operator.');
  const asOf = asOfDay(now);
  const all = await rowsBetween(env, '0000-00-00', asOf);
  const window = all.filter((row) => row.day >= shiftDay(asOf, 1 - Math.max(...WINDOWS)));
  return answer(200, {
    asOf,
    windowDays: Math.max(...WINDOWS),
    note: 'For a person to read. Nothing here is flagged, limited, or acted on automatically: a count far from the fleet is a question, not a finding.',
    ...anomaliesOf(window),
    measurables: measurablesOf(all, asOf),
  });
};
