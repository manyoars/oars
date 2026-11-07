// The nightly rollup: the telemetry record (the R2 batches `POST /v1/telemetry` keeps whole) read into one row per install, account, and day, which is what the fleet read and the operator's anomaly read come from.
// Why R2 and not Analytics Engine: a Worker has a binding to write Analytics Engine but none to read it, so reading it means the SQL API with an account token held as a secret, a new moving part; the R2
// binding is already here, and R2 is the record that outlives Analytics Engine's three months. The rollup is a pure function of a day's objects, so running it again changes nothing, and it
// reads only that: nothing here touches a deposit, a contributor, or a bundle.
import { bucketOf, cellKey, measuresOf, type Kind, type Measure } from '../../cli/src/telemetry/measures.js';
import { fieldOf, type Env } from './http.js';
import { INSTALL } from './telemetry.js';

/** The part of an R2 bucket the rollup reads. */
export interface KeptBucket {
  list: (options: { prefix: string; cursor?: string }) => Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  get: (key: string) => Promise<{ text: () => Promise<string> } | null>;
}

export interface RollupEnv {
  TELEMETRY?: KeptBucket;
}

/** One cell's observations from one install on one day. A latency keeps a histogram, so the pool never holds the latencies themselves. */
export interface Entry {
  metric: string;
  dimension: Measure['dimension'];
  value: string;
  kind: Kind;
  n: number;
  /** For a rate: the observations that were a yes. */
  hits: number;
  buckets: [number, number][];
}

/** A Worker invocation may make about a thousand subrequests, and each batch read is one; a day with more is rolled up to this many and the rest wait for the next run. */
export const MAX_BATCHES_PER_RUN = 800;
/** An install-day holds at most this many cells, so a crafted batch cannot grow a row without bound. */
export const MAX_CELLS_PER_INSTALL_DAY = 64;

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ACCOUNT_LENGTH = 128;

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** `day` moved by `days` (negative for earlier). */
export const shiftDay = (day: string, days: number): string => dayOf(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS);

interface Accumulated {
  install: string;
  account: string;
  batches: number;
  seen: Set<string>;
  cells: Map<string, { head: Measure; n: number; hits: number; buckets: Map<number, number> }>;
}

const isEvent = (value: unknown): value is object => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Adds one event to the install's day: once, however many batches carried it (delivery is at least once, so a resent batch carries the same events again). */
const add = (into: Accumulated, event: object): void => {
  const identity = JSON.stringify(event);
  if (into.seen.has(identity)) return;
  into.seen.add(identity);
  for (const measure of measuresOf(event)) {
    const key = cellKey(measure);
    const cell = into.cells.get(key) ?? { head: measure, n: 0, hits: 0, buckets: new Map<number, number>() };
    cell.n += 1;
    if (measure.kind === 'rate') cell.hits += measure.x;
    else cell.buckets.set(bucketOf(measure.x), (cell.buckets.get(bucketOf(measure.x)) ?? 0) + 1);
    into.cells.set(key, cell);
  }
};

const entriesOf = (accumulated: Accumulated): Entry[] =>
  [...accumulated.cells.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, MAX_CELLS_PER_INSTALL_DAY)
    .map(([, { head, n, hits, buckets }]) => ({ metric: head.metric, dimension: head.dimension, value: head.value, kind: head.kind, n, hits, buckets: [...buckets.entries()].sort((a, b) => a[0] - b[0]) }));

/** What a kept object holds, or undefined when it is not a batch this rollup can read (it is skipped, not repaired: the record stays as it came). */
const batchOf = (text: string): { install: string; account: string; events: object[] } | undefined => {
  let held: unknown;
  try {
    held = JSON.parse(text);
  } catch {
    return undefined;
  }
  const batch = fieldOf(held, 'batch');
  const install = fieldOf(batch, 'install');
  const events = fieldOf(batch, 'events');
  if (typeof install !== 'string' || !INSTALL.test(install) || !Array.isArray(events)) return undefined;
  const account = fieldOf(held, 'account');
  return { install: install.toLowerCase(), account: typeof account === 'string' ? account.slice(0, MAX_ACCOUNT_LENGTH) : '', events: events.filter(isEvent) };
};

export interface Rolled {
  day: string;
  batches: number;
  installs: number;
  /** True when the day held more batches than one run reads. */
  truncated: boolean;
}

/** Rolls the day's batches (by the day they arrived) into its rows, replacing whatever rows the day had. */
export const rollupDay = async (env: Env & RollupEnv, day: string): Promise<Rolled | undefined> => {
  const bucket = env.TELEMETRY;
  if (bucket === undefined || !DAY.test(day)) return undefined;
  const byInstall = new Map<string, Accumulated>();
  let batches = 0;
  let truncated = false;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `telemetry/${day}/`, ...(cursor === undefined ? {} : { cursor }) });
    for (const { key } of page.objects) {
      if (batches >= MAX_BATCHES_PER_RUN) {
        truncated = true;
        break;
      }
      const text = await (await bucket.get(key))?.text();
      const batch = text === undefined ? undefined : batchOf(text);
      if (batch === undefined) continue;
      batches += 1;
      const id = `${batch.install}\u0000${batch.account}`;
      const into = byInstall.get(id) ?? { install: batch.install, account: batch.account, batches: 0, seen: new Set<string>(), cells: new Map() };
      into.batches += 1;
      for (const event of batch.events) add(into, event);
      byInstall.set(id, into);
    }
    cursor = truncated || !page.truncated ? undefined : page.cursor;
  } while (cursor !== undefined);
  const insert = [...byInstall.values()].map((one) =>
    env.DB.prepare('INSERT INTO telemetry_install_days (day, install, account, batches, events, measures) VALUES (?, ?, ?, ?, ?, ?)').bind(day, one.install, one.account, one.batches, one.seen.size, JSON.stringify(entriesOf(one))),
  );
  // One transaction, so a reader sees the day before or after the run, never half of it.
  await env.DB.batch([env.DB.prepare('DELETE FROM telemetry_install_days WHERE day = ?').bind(day), ...insert]);
  return { day, batches, installs: new Set([...byInstall.values()].map((one) => one.install)).size, truncated };
};

/** What the nightly run does: the day before and the day before that, since a batch whose first answer was lost arrives a day late. */
export const rollupRecent = async (env: Env & RollupEnv, now: number): Promise<Rolled[]> => {
  const today = dayOf(now);
  const rolled: Rolled[] = [];
  for (const day of [shiftDay(today, -2), shiftDay(today, -1)]) {
    const one = await rollupDay(env, day);
    if (one !== undefined) rolled.push(one);
  }
  return rolled;
};
