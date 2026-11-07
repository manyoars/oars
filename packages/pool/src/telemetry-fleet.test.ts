// The telemetry rollup, the fleet read, and the operator's anomaly read. The routes and the nightly handler run under Miniflare's workerd (real R2 and D1); the counting rules run on rows built in memory.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LATENCY_EDGES } from '../../cli/src/telemetry/measures.js';
import { ownCells } from '../../cli/src/telemetry/report.js';
import { DEFAULT_PUBLIC_FLOOR } from './floors.js';
import type { Env, PoolDb } from './http.js';
import { anomaliesOf, fleetCells, measurablesOf, operator, OUTLIER_SCORE, type InstallDay } from './telemetry-fleet.js';
import { dayOf, MAX_BATCHES_PER_RUN, rollupDay, rollupRecent, shiftDay, type Entry, type KeptBucket } from './telemetry-rollup.js';
import { fieldOf, startPool, type TestPool } from './test-pool.js';
import { type SweepBucket } from './retention.js';
import worker from './worker.js';

const DAY_MS = 86_400_000;
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// One clock for the whole run, so a run that crosses 00:00 UTC still reads the days it kept its batches under.
const NOW = Date.now();
const today = (): string => dayOf(NOW);
const daysAgo = (n: number): string => shiftDay(today(), -n);

let tick = 0;
/** A hook event with its own time: the rollup counts an event once, and two with the same install, time, and data are one event sent twice. */
const hook = (latencyMs: number, outcome = 'hit', harnessVersion = '2.1.5', name = 'pre-tool', harness = 'claude-code'): object => {
  tick += 1;
  return { v: 1, id: 'x', at: new Date(Date.parse('2026-11-06T12:00:00.000Z') + tick).toISOString(), type: 'hook', cli: '0.4.0', os: 'linux', data: { name, latencyMs, outcome, harness, harnessVersion } };
};

let kept = 0;
/** A batch as the telemetry route keeps it, under the day it arrived. */
const keep = async (pool: TestPool, day: string, install: string, events: object[], account?: string): Promise<void> => {
  kept += 1;
  await (await pool.bucket()).put(`telemetry/${day}/${String(kept).padStart(8, '0')}.json`, JSON.stringify({ received: `${day}T10:00:00.000Z`, ...(account === undefined ? {} : { account }), batch: { install, events } }));
};

interface Bindings {
  DB: Env['DB'];
  TELEMETRY: KeptBucket & SweepBucket;
}

/** The nightly handler the Worker exports, run on the pool's own bindings. */
const nightly = async (pool: TestPool): Promise<void> => {
  await worker.scheduled({ scheduledTime: NOW }, await pool.miniflare.getBindings<Bindings>());
};

const keysOf = (value: unknown): string[] => (typeof value === 'object' && value !== null ? Object.keys(value) : []);

const cellsOf = (json: unknown, days: number): { [name: string]: unknown }[] => {
  const windows: unknown = fieldOf(json, 'windows');
  const window: unknown = Array.isArray(windows) ? windows.find((one: unknown) => fieldOf(one, 'days') === days) : undefined;
  const cells: unknown = fieldOf(window, 'cells');
  return Array.isArray(cells) ? cells.filter((one: unknown): one is { [name: string]: unknown } => typeof one === 'object' && one !== null) : [];
};

const rowCount = async (pool: TestPool): Promise<number> => {
  const row = await (await pool.db()).prepare('SELECT COUNT(*) AS held FROM telemetry_install_days').first();
  const held = fieldOf(row, 'held');
  if (typeof held !== 'number') throw new Error('no count');
  return held;
};

describe('the fleet read, from the nightly rollup, on the Worker', () => {
  let pool: TestPool;

  beforeAll(async () => {
    pool = await startPool({ COVENANT_VERSION: '', OPERATOR_TOKEN: 'operator-secret' });
  }, 60_000);

  afterEach(async () => {
    const bucket = await pool.bucket();
    const { objects } = await bucket.list({ prefix: 'telemetry/' });
    if (objects.length > 0) await bucket.delete(objects.map(({ key }) => key));
    await (await pool.db()).prepare('DELETE FROM telemetry_install_days').run();
  });

  afterAll(async () => {
    await pool.dispose();
  });

  /** `count` installs each report the same ten pre-tool fires of `latency` ms on `day`. */
  const report = async (count: number, day: string, latency = 100, version = '2.1.5', first = 1): Promise<void> => {
    for (let at = 0; at < count; at += 1) await keep(pool, day, uuid(first + at), Array.from({ length: 10 }, () => hook(latency, 'hit', version)));
  };

  it('serves nothing for a cell fewer than DEFAULT_PUBLIC_FLOOR installs report, and serves it at DEFAULT_PUBLIC_FLOOR', async () => {
    await report(DEFAULT_PUBLIC_FLOOR - 1, daysAgo(1));
    await nightly(pool);
    const below = await pool.get('/v1/telemetry/fleet');
    expect(below.status).toBe(200);
    expect(cellsOf(below.json, 7)).toEqual([]);
    expect(cellsOf(below.json, 30)).toEqual([]);

    await keep(pool, daysAgo(1), uuid(DEFAULT_PUBLIC_FLOOR), [hook(100)]);
    await nightly(pool);
    const at = await pool.get('/v1/telemetry/fleet');
    // 100 ms falls in the bucket whose upper edge is 130 (edges grow by 1.5 times each).
    expect(LATENCY_EDGES.find((edge) => edge >= 100)).toBe(130);
    expect(cellsOf(at.json, 7)).toContainEqual({ metric: 'hook.pre-tool.latency', dimension: 'harnessVersion', value: 'claude-code/2.1.5', kind: 'latency', p50: 130, p95: 130 });
    expect(cellsOf(at.json, 7)).toContainEqual({ metric: 'hook.pre-tool.hit', dimension: 'harnessVersion', value: 'claude-code/2.1.5', kind: 'rate', p50: 1 });
  }, 60_000);

  it('keys a hook cell by harness and harness version: one version under two harnesses is two served cells', async () => {
    for (let at = 1; at <= DEFAULT_PUBLIC_FLOOR; at += 1) await keep(pool, daysAgo(1), uuid(at), [hook(100, 'hit', '2.1.5', 'pre-tool', 'claude-code'), hook(400, 'hit', '2.1.5', 'pre-tool', 'codex')]);
    await nightly(pool);
    const latency = cellsOf((await pool.get('/v1/telemetry/fleet')).json, 7).filter((cell) => cell['metric'] === 'hook.pre-tool.latency');
    expect(latency.map((cell) => cell['value']).sort()).toEqual(['claude-code/2.1.5', 'codex/2.1.5']);
    expect(latency.find((cell) => cell['value'] === 'codex/2.1.5')?.['p50']).toBe(LATENCY_EDGES.find((edge) => edge >= 400));
  }, 60_000);

  it('serves a latency cell equal to the user’s own numbers over the same events: DEFAULT_PUBLIC_FLOOR installs that each hold the fixture’s ten pre-tool latencies', async () => {
    // The ten latencies of the CLI report's fixture spool; the fleet side runs the rollup and `fleetCells`, the user's side runs `ownCells`, and both count in `measures.ts` buckets.
    const events = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((ms) => hook(ms));
    for (let at = 1; at <= DEFAULT_PUBLIC_FLOOR; at += 1) await keep(pool, daysAgo(1), uuid(at), events);
    await nightly(pool);
    const served = cellsOf((await pool.get('/v1/telemetry/fleet')).json, 7).find((one) => one['metric'] === 'hook.pre-tool.latency');
    const own = ownCells(events.map((event) => JSON.stringify(event)), Date.parse('2026-11-06T13:00:00Z'), 7).find((one) => one.metric === 'hook.pre-tool.latency');
    expect(own).toMatchObject({ kind: 'latency', n: 10 });
    expect(served).toMatchObject({ p50: own && 'p50' in own ? own.p50 : undefined, p95: own && 'p95' in own ? own.p95 : undefined });
    expect(served?.['p50']).toBeDefined();
  }, 60_000);

  it('serves no count, no total, and no install, so no two served numbers differ by an install under the floor', async () => {
    // Five installs on 2.1.5 and four on 2.1.6; one of the five reported only 20 days ago.
    await report(DEFAULT_PUBLIC_FLOOR - 1, daysAgo(2), 100, '2.1.5', 1);
    await keep(pool, daysAgo(20), uuid(DEFAULT_PUBLIC_FLOOR), [hook(100)]);
    await report(DEFAULT_PUBLIC_FLOOR - 1, daysAgo(2), 100, '2.1.6', 50);
    await nightly(pool);
    // Day 20 is not in the nightly's two days: roll it as the operator's backfill would.
    await rollupDayFor(pool, daysAgo(20));
    const answered = await pool.get('/v1/telemetry/fleet');
    expect(keysOf(answered.json).sort()).toEqual(['asOf', 'floor', 'windows']);
    const seven = cellsOf(answered.json, 7);
    const thirty = cellsOf(answered.json, 30);
    for (const cell of [...seven, ...thirty]) expect(keysOf(cell).every((key) => ['metric', 'dimension', 'value', 'kind', 'p50', 'p95'].includes(key))).toBe(true);
    // 2.1.6 has four installs: never served, in either window, and no cell totals it with 2.1.5.
    expect([...seven, ...thirty].some((cell) => cell.value === '2.1.6')).toBe(false);
    expect([...seven, ...thirty].some((cell) => cell.value !== 'claude-code/2.1.5')).toBe(false);
    // 2.1.5 has five installs in 30 days and four in 7: the 30 day cell is served and the 7 day cell is not, and nothing served differs by the fifth.
    expect(thirty.some((cell) => cell.value === 'claude-code/2.1.5')).toBe(true);
    expect(seven.some((cell) => cell.value === 'claude-code/2.1.5')).toBe(false);
    expect(JSON.stringify(answered.json)).not.toMatch(/install|events|batches|"n"|count|total/i);
  }, 60_000);

  it('serves the median install’s rate and the fleet’s latency percentiles, over the installs and the window', async () => {
    const rates = [0, 0.25, 0.5, 0.75, 1];
    for (const [at, share] of rates.entries()) await keep(pool, daysAgo(1), uuid(at + 1), Array.from({ length: 4 }, (_, one) => hook(one < share * 4 ? 10 : 1000, one < share * 4 ? 'hit' : 'miss')));
    await nightly(pool);
    const cells = cellsOf((await pool.get('/v1/telemetry/fleet')).json, 7);
    expect(cells.find((cell) => cell.metric === 'hook.pre-tool.hit')).toMatchObject({ kind: 'rate', p50: 0.5 });
    // Ten of twenty fires took 10 ms (bucket edge 12) and ten took 1000 (edge 1,098 or the next edge up).
    const latency = cells.find((cell) => cell.metric === 'hook.pre-tool.latency');
    expect(latency).toMatchObject({ kind: 'latency', p50: LATENCY_EDGES.find((edge) => edge >= 10) });
    expect(latency?.p95).toBe(LATENCY_EDGES.find((edge) => edge >= 1000));
  }, 60_000);

  it('serves two windows that differ by one install as percentiles only, so neither shows the install between them', async () => {
    // DEFAULT_PUBLIC_FLOOR installs report 3 days ago (in both windows); one more reported 20 days ago (in the 30 only).
    await report(DEFAULT_PUBLIC_FLOOR, daysAgo(3), 100, '2.1.5', 1);
    await keep(pool, daysAgo(20), uuid(DEFAULT_PUBLIC_FLOOR + 1), [hook(100)]);
    await rollupDayFor(pool, daysAgo(3));
    await rollupDayFor(pool, daysAgo(20));
    const answered = await pool.get('/v1/telemetry/fleet');
    const seven = cellsOf(answered.json, 7);
    const thirty = cellsOf(answered.json, 30);
    expect(seven.map((cell) => cell.metric).sort()).toEqual(['hook.pre-tool.hit', 'hook.pre-tool.latency']);
    expect(thirty.map((cell) => cell.metric).sort()).toEqual(['hook.pre-tool.hit', 'hook.pre-tool.latency']);
    // Each cell holds the percentile and nothing else (a rate holds p50 alone), so there is no count to subtract between the windows.
    for (const cell of seven) expect(keysOf(cell).sort()).toEqual(cell.kind === 'rate' ? ['dimension', 'kind', 'metric', 'p50', 'value'] : ['dimension', 'kind', 'metric', 'p50', 'p95', 'value']);
    expect(thirty.map((cell) => keysOf(cell).sort())).toEqual(seven.map((cell) => keysOf(cell).sort()));
  }, 60_000);

  it('counts a batch that arrives twice once, and rolls a day again to the same rows', async () => {
    const events = [hook(100), hook(200), hook(100)];
    await keep(pool, daysAgo(1), uuid(1), events);
    await keep(pool, daysAgo(1), uuid(1), events);
    await nightly(pool);
    const rows = await (await pool.db()).prepare('SELECT batches, events FROM telemetry_install_days').all();
    expect(rows.results).toEqual([{ batches: 2, events: 3 }]);
    await nightly(pool);
    expect(await rowCount(pool)).toBe(1);
    expect((await (await pool.db()).prepare('SELECT batches, events FROM telemetry_install_days').all()).results).toEqual(rows.results);
  }, 60_000);

  it('skips an object that is not a batch and an install id that is not an install, and keeps a cell cap on a row', async () => {
    const bucket = await pool.bucket();
    await bucket.put(`telemetry/${daysAgo(1)}/junk.json`, 'not json');
    await bucket.put(`telemetry/${daysAgo(1)}/shape.json`, JSON.stringify({ batch: { install: 'not-a-uuid', events: [hook(1)] } }));
    await bucket.put(`telemetry/${daysAgo(1)}/events.json`, JSON.stringify({ batch: { install: uuid(1), events: 'no' } }));
    const many = Array.from({ length: 80 }, (_, at) => ({ v: 1, id: 'x', at: '2026-11-06T12:00:00.000Z', type: 'command', cli: `0.${String(at)}.0`, os: 'linux', data: { path: ['pool'], durationMs: 5, exitCode: 0 } }));
    await keep(pool, daysAgo(1), uuid(2), many);
    await nightly(pool);
    const rows = (await (await pool.db()).prepare('SELECT install, measures FROM telemetry_install_days').all()).results;
    expect(rows).toHaveLength(1);
    const measures: unknown = JSON.parse(String(fieldOf(rows[0], 'measures')));
    expect(Array.isArray(measures) && measures.length).toBe(64);
  }, 60_000);

  it('reads no query and no credential: the same answer with or without them', async () => {
    await report(DEFAULT_PUBLIC_FLOOR, daysAgo(1));
    await nightly(pool);
    const plain = await pool.get('/v1/telemetry/fleet');
    const asked = await pool.get('/v1/telemetry/fleet?install=x&window=1', 'a-token');
    expect(asked.json).toEqual(plain.json);
  }, 60_000);

  describe('the operator’s read', () => {
    const operatorGet = (token?: string): Promise<{ status: number; json: unknown }> => pool.get('/v1/telemetry/operator', token);

    it('refuses without the secret, and is not configured with none set', async () => {
      expect((await operatorGet()).status).toBe(401);
      expect((await operatorGet('guess')).status).toBe(401);
      const response = await operator(new Request('http://pool.test/v1/telemetry/operator', { headers: { authorization: 'Bearer anything' } }), { DB: unusedDb }, NOW);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'not_configured' });
    });

    it('lists the one install that sits far from the fleet, and changes nothing', async () => {
      for (let at = 1; at <= 9; at += 1) await keep(pool, daysAgo(1), uuid(at), Array.from({ length: 18 + (at % 3) }, () => hook(50)));
      await keep(pool, daysAgo(1), uuid(10), Array.from({ length: 2000 }, () => hook(50)));
      await nightly(pool);
      const before = (await (await pool.db()).prepare('SELECT * FROM telemetry_install_days ORDER BY install').all()).results;
      const answered = await operatorGet('operator-secret');
      expect(answered.status).toBe(200);
      const outliers: unknown = fieldOf(answered.json, 'outliers');
      expect(outliers).toEqual([{ entity: 'install', id: uuid(10), basis: 'events', count: 2000, median: 19, direction: 'high' }]);
      expect(String(fieldOf(answered.json, 'note'))).toContain('Nothing here is flagged, limited, or acted on automatically');
      expect((await (await pool.db()).prepare('SELECT * FROM telemetry_install_days ORDER BY install').all()).results).toEqual(before);
    }, 60_000);

    it('reads the thirty day window for anomalies and counts installs in the database, so it never loads the whole table', async () => {
      // Install 1 sent 2,000 events 45 days ago: far outside the window, so it is no outlier. Five installs report ten events each 10 days ago, and two of them one more 3 days ago.
      await keep(pool, daysAgo(45), uuid(1), Array.from({ length: 2000 }, () => hook(50)));
      for (const at of [2, 3, 4]) await keep(pool, daysAgo(45), uuid(at), [hook(50)]);
      for (let at = 1; at <= DEFAULT_PUBLIC_FLOOR; at += 1) await keep(pool, daysAgo(10), uuid(at), Array.from({ length: 10 }, () => hook(50)));
      for (const at of [1, 2]) await keep(pool, daysAgo(3), uuid(at), [hook(50)]);
      for (const day of [45, 10, 3]) await rollupDayFor(pool, daysAgo(day));
      const { DB: real } = await pool.miniflare.getBindings<Bindings>();
      const asked: string[] = [];
      const recording: PoolDb = {
        prepare: (sql) => ({
          bind: (...values) => {
            asked.push(`${sql} <- ${values.join(',')}`);
            return real.prepare(sql).bind(...values);
          },
        }),
        batch: (statements) => real.batch(statements),
      };
      const answered = await operator(new Request('http://pool.test/v1/telemetry/operator', { headers: { authorization: 'Bearer operator-secret' } }), { DB: recording, OPERATOR_TOKEN: 'operator-secret' }, NOW);
      const json: unknown = await answered.json();
      expect(answered.status).toBe(200);
      expect(fieldOf(json, 'outliers')).toEqual([]);
      // Five installs ever, two in the last 7 days, and the first day the fleet read was served is the day five installs report together.
      expect(fieldOf(json, 'measurables')).toEqual({ reporting: { installsEver: DEFAULT_PUBLIC_FLOOR, installsLast7Days: 2, share: 2 / DEFAULT_PUBLIC_FLOOR }, firstFleetRead: daysAgo(10) });
      expect(asked.some((sql) => sql.includes('COUNT(DISTINCT install)'))).toBe(true);
      expect(asked.some((sql) => sql.includes('MIN(day)'))).toBe(true);
      // No read of the rows starts at the beginning of time.
      expect(asked.filter((sql) => sql.includes('SELECT day, install') && sql.includes('0000-00-00'))).toEqual([]);
    }, 60_000);

    it('finds the first fleet read across a week-apart cohort: five installs report a week apart and the fleet read is first served on the day the fifth reports', async () => {
      for (const [at, ago] of [29, 22, 15, 8, 1].entries()) {
        await keep(pool, daysAgo(ago), uuid(at + 1), [hook(50)]);
        await rollupDayFor(pool, daysAgo(ago));
      }
      const answered = await operatorGet('operator-secret');
      expect(answered.status).toBe(200);
      expect(fieldOf(fieldOf(answered.json, 'measurables'), 'firstFleetRead')).toBe(daysAgo(1));
    }, 60_000);
  });
});

describe('the fleet read follows the PUBLIC_FLOOR binding', () => {
  /** Three installs each report the same ten pre-tool fires yesterday; the nightly rolls them. */
  const threeInstalls = async (pool: TestPool): Promise<void> => {
    for (let at = 1; at <= 3; at += 1) await keep(pool, daysAgo(1), uuid(at), Array.from({ length: 10 }, () => hook(100)));
    await nightly(pool);
  };

  it('serves a cell three installs report, and states floor 3, when the pool is deployed with PUBLIC_FLOOR 3', async () => {
    const low = await startPool({ COVENANT_VERSION: '', PUBLIC_FLOOR: '3' });
    try {
      await threeInstalls(low);
      const answered = await low.get('/v1/telemetry/fleet');
      expect(answered.status).toBe(200);
      expect(fieldOf(answered.json, 'floor')).toBe(3);
      expect(cellsOf(answered.json, 7)).toContainEqual({ metric: 'hook.pre-tool.hit', dimension: 'harnessVersion', value: 'claude-code/2.1.5', kind: 'rate', p50: 1 });
    } finally {
      await low.dispose();
    }
  }, 60_000);

  it('serves nothing for the same three installs at the default binding, and states the default floor', async () => {
    const standard = await startPool({ COVENANT_VERSION: '' });
    try {
      await threeInstalls(standard);
      const answered = await standard.get('/v1/telemetry/fleet');
      expect(fieldOf(answered.json, 'floor')).toBe(DEFAULT_PUBLIC_FLOOR);
      expect(cellsOf(answered.json, 7)).toEqual([]);
      expect(cellsOf(answered.json, 30)).toEqual([]);
    } finally {
      await standard.dispose();
    }
  }, 60_000);
});

/** The operator's backfill of one past day: the nightly run reaches only the last two. */
const rollupDayFor = async (pool: TestPool, day: string): Promise<void> => {
  await rollupDay(await pool.miniflare.getBindings<Bindings>(), day);
};

const unusedDb: PoolDb = {
  prepare: () => {
    throw new Error('this read must not reach the database');
  },
  batch: () => Promise.reject(new Error('this read must not reach the database')),
};

const entry = (value: string, n: number, hits: number, kind: Entry['kind'] = 'rate', metric = 'hook.pre-tool.hit'): Entry => ({
  metric,
  dimension: 'harnessVersion',
  value,
  kind,
  n,
  hits,
  buckets: kind === 'latency' ? [[LATENCY_EDGES.findIndex((edge) => edge >= 100), n]] : [],
});
const row = (day: string, install: string, more: Partial<InstallDay> = {}): InstallDay => ({ day, install, account: '', batches: 1, events: 20, entries: [], ...more });

describe('the counting rules', () => {
  it('serves a cell by distinct installs, not by rows: one install over many days is one install', () => {
    const rows = Array.from({ length: 30 }, (_, at) => row(daysAgo(at), uuid(1), { entries: [entry('2.1.5', 5, 5)] }));
    expect(fleetCells(rows, DEFAULT_PUBLIC_FLOOR)).toEqual([]);
    const five = [...rows, ...[2, 3, 4, 5].map((at) => row(daysAgo(1), uuid(at), { entries: [entry('2.1.5', 5, 5)] }))];
    expect(fleetCells(five, DEFAULT_PUBLIC_FLOOR)).toHaveLength(1);
  });

  it('serves a cell at the floor the deploy set: five installs clear 3 and not 6', () => {
    const rows = [1, 2, 3, 4, 5].map((at) => row(daysAgo(1), uuid(at), { entries: [entry('2.1.5', 5, 5)] }));
    expect(fleetCells(rows, 3)).toHaveLength(1);
    expect(fleetCells(rows, 6)).toEqual([]);
  });

  it('weighs installs equally in a latency cell: one install with 2,000 fires beside four with one each is not the fleet’s percentile', () => {
    const slow = LATENCY_EDGES.findIndex((edge) => edge >= 1000);
    const fast = LATENCY_EDGES.findIndex((edge) => edge >= 10);
    const latency = (index: number, n: number): Entry => ({ metric: 'hook.pre-tool.latency', dimension: 'harnessVersion', value: '2.1.5', kind: 'latency', n, hits: 0, buckets: [[index, n]] });
    const rows = [row(daysAgo(1), uuid(1), { entries: [latency(slow, 2000)] }), ...[2, 3, 4, 5].map((at) => row(daysAgo(1), uuid(at), { entries: [latency(fast, 1)] }))];
    expect(fleetCells(rows, DEFAULT_PUBLIC_FLOOR)).toEqual([expect.objectContaining({ p50: LATENCY_EDGES[fast], p95: LATENCY_EDGES[slow] })]);
    // The install's own p50 is the slow edge, which the pooled fires would have served.
    expect(LATENCY_EDGES[fast]).not.toBe(LATENCY_EDGES[slow]);
    // An install row with no fires weighs nothing.
    const empty = { ...latency(fast, 0), buckets: [] };
    expect(fleetCells([...rows, row(daysAgo(1), uuid(6), { entries: [empty] })], DEFAULT_PUBLIC_FLOOR)).toHaveLength(1);
  });

  it('measures the share of installs still reporting, and the first day the fleet read was served', () => {
    const entries = [entry('2.1.5', 3, 3)];
    // Five installs report from day 30 to day 20 ago; two go on to report in the last week; one more joins.
    const rows = [
      ...[1, 2, 3, 4, 5].flatMap((at) => [30, 20].map((ago) => row(daysAgo(ago), uuid(at), { entries }))),
      row(daysAgo(2), uuid(1), { entries }),
      row(daysAgo(2), uuid(2), { entries }),
      row(daysAgo(1), uuid(6), { entries }),
    ];
    const measured = measurablesOf(rows, daysAgo(1), DEFAULT_PUBLIC_FLOOR);
    expect(measured.reporting).toEqual({ installsEver: 6, installsLast7Days: 3, share: 0.5 });
    expect(measured.firstFleetRead).toBe(daysAgo(30));
    expect(measurablesOf([], daysAgo(1), DEFAULT_PUBLIC_FLOOR)).toEqual({ reporting: { installsEver: 0, installsLast7Days: 0, share: 0 }, firstFleetRead: null });
    // Four installs never make a cell; install 6 joining install 1 to 4 would, inside the 30 day window.
    expect(measurablesOf(rows.filter((one) => one.install !== uuid(5) && one.install !== uuid(6)), daysAgo(1), DEFAULT_PUBLIC_FLOOR).firstFleetRead).toBeNull();
  });

  it('finds the first fleet read against the widest served window: five installs a week apart serve a 30 day cell on the day the fifth reports', () => {
    const entries = [entry('2.1.5', 3, 3)];
    const rows = [28, 21, 14, 7, 0].map((ago, at) => row(daysAgo(ago), uuid(at + 1), { entries }));
    expect(fleetCells(rows, DEFAULT_PUBLIC_FLOOR)).toHaveLength(1);
    expect(measurablesOf(rows, daysAgo(0), DEFAULT_PUBLIC_FLOOR).firstFleetRead).toBe(daysAgo(0));
    expect(measurablesOf(rows.slice(0, 4), daysAgo(0), DEFAULT_PUBLIC_FLOOR).firstFleetRead).toBeNull();
  });

  it('lists a far count among installs and among accounts, and lists none without a baseline of DEFAULT_PUBLIC_FLOOR', () => {
    const counts = [18, 19, 20, 20, 21, 22, 19, 20, 5000];
    const rows = counts.map((events, at) => row(daysAgo(1), uuid(at + 1), { events, batches: 1, account: `acct-${String(at % 5)}` }));
    const found = anomaliesOf(rows, DEFAULT_PUBLIC_FLOOR);
    expect(found.installs).toBe(9);
    expect(found.outliers.filter((one) => one.entity === 'install' && one.basis === 'events').map((one) => one.id)).toEqual([uuid(9)]);
    // Five accounts; the 5000-event install sits in acct-3 with the 4th install's 20.
    expect(found.outliers.filter((one) => one.entity === 'account').map((one) => [one.id, one.direction])).toEqual([['acct-3', 'high']]);
    expect(anomaliesOf(rows.slice(0, DEFAULT_PUBLIC_FLOOR - 2).concat(rows.slice(-1)), DEFAULT_PUBLIC_FLOOR).outliers).toEqual([]);
    expect(OUTLIER_SCORE).toBe(5);
  });

  it('lists a far low count, and not a fleet whose counts are all alike', () => {
    const alike = Array.from({ length: 6 }, (_, at) => row(daysAgo(1), uuid(at + 1), { events: 100, batches: 2 }));
    expect(anomaliesOf(alike, DEFAULT_PUBLIC_FLOOR).outliers).toEqual([]);
    expect(anomaliesOf([...alike.slice(0, 5), row(daysAgo(1), uuid(7), { events: 1, batches: 2 })], DEFAULT_PUBLIC_FLOOR).outliers).toEqual([{ entity: 'install', id: uuid(7), basis: 'events', count: 1, median: 100, direction: 'low' }]);
    // One event off in a fleet of identical counts is not far.
    expect(anomaliesOf([...alike, row(daysAgo(1), uuid(8), { events: 101, batches: 2 })], DEFAULT_PUBLIC_FLOOR).outliers).toEqual([]);
  });
});

describe('the rollup', () => {
  const fakeDb = (): { db: PoolDb; statements: string[] } => {
    const statements: string[] = [];
    const bound = { first: () => Promise.resolve(undefined), all: () => Promise.resolve({ results: [] }), run: () => Promise.resolve({ meta: { changes: 0 } }) };
    return {
      statements,
      db: {
        prepare: (sql) => {
          statements.push(sql);
          return { bind: () => bound };
        },
        batch: () => Promise.resolve([]),
      },
    };
  };

  it('does nothing without the bucket, and refuses a day that is not a day', async () => {
    const { db, statements } = fakeDb();
    expect(await rollupDay({ DB: db }, daysAgo(1))).toBeUndefined();
    const bucket: KeptBucket = { list: () => Promise.reject(new Error('unreachable')), get: () => Promise.reject(new Error('unreachable')) };
    expect(await rollupDay({ DB: db, TELEMETRY: bucket }, 'yesterday')).toBeUndefined();
    expect(await rollupRecent({ DB: db }, NOW)).toEqual([]);
    expect(statements).toEqual([]);
  });

  it('follows the list’s cursor, and reads no more than one run’s batches of a day', async () => {
    const { db } = fakeDb();
    let gets = 0;
    const batch = (at: number): string => JSON.stringify({ batch: { install: uuid(at), events: [hook(10)] } });
    const bucket: KeptBucket = {
      list: ({ cursor }) => {
        const start = cursor === undefined ? 0 : Number(cursor);
        const objects = Array.from({ length: 500 }, (_, at) => ({ key: `telemetry/${daysAgo(1)}/${String(start + at)}.json` }));
        return Promise.resolve({ objects, truncated: true, cursor: String(start + 500) });
      },
      get: () => {
        gets += 1;
        return Promise.resolve({ text: () => Promise.resolve(batch(gets)) });
      },
    };
    const rolled = await rollupDay({ DB: db, TELEMETRY: bucket }, daysAgo(1));
    expect(rolled).toMatchObject({ batches: MAX_BATCHES_PER_RUN, truncated: true });
    expect(gets).toBe(MAX_BATCHES_PER_RUN);
  });

  it('rolls yesterday, then the day before', async () => {
    const { db } = fakeDb();
    const listed: string[] = [];
    const bucket: KeptBucket = {
      list: ({ prefix }) => {
        listed.push(prefix);
        return Promise.resolve({ objects: [], truncated: false });
      },
      get: () => Promise.resolve(null),
    };
    const now = Date.parse('2026-11-07T03:17:00Z');
    expect((await rollupRecent({ DB: db, TELEMETRY: bucket }, now)).map((one) => one.day)).toEqual(['2026-11-06', '2026-11-05']);
    expect(listed).toEqual(['telemetry/2026-11-06/', 'telemetry/2026-11-05/']);
    expect(now - Date.parse('2026-11-05T00:00:00Z')).toBeLessThan(3 * DAY_MS);
  });

  describe('one run, two days over the cap', () => {
    const overCap = (): { bucket: KeptBucket; gets: () => number } => {
      let gets = 0;
      return {
        gets: () => gets,
        bucket: {
          list: ({ prefix }) => Promise.resolve({ objects: Array.from({ length: MAX_BATCHES_PER_RUN + 200 }, (_, at) => ({ key: `${prefix}${String(at)}.json` })), truncated: false }),
          get: () => {
            gets += 1;
            return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ batch: { install: uuid(gets), events: [hook(10)] } })) });
          },
        },
      };
    };

    it('shares one budget of batch reads, so the total stays at the cap, and says which day was cut', async () => {
      const { db } = fakeDb();
      const { bucket, gets } = overCap();
      const rolled = await rollupRecent({ DB: db, TELEMETRY: bucket }, Date.parse('2026-11-07T03:17:00Z'));
      expect(gets()).toBeLessThanOrEqual(MAX_BATCHES_PER_RUN);
      expect(rolled.map((one) => [one.day, one.gets, one.truncated])).toEqual([['2026-11-06', MAX_BATCHES_PER_RUN, true], ['2026-11-05', 0, true]]);
    });

    it('lists nothing for a kept day once the budget is spent', async () => {
      const { db } = fakeDb();
      const listed: string[] = [];
      const { bucket } = overCap();
      const rolled = await rollupRecent({ DB: db, TELEMETRY: { list: (options) => (listed.push(options.prefix), bucket.list(options)), get: bucket.get } }, Date.parse('2026-11-07T03:17:00Z'));
      expect(listed).toEqual(['telemetry/2026-11-06/']);
      expect(rolled[1]).toEqual({ day: '2026-11-05', batches: 0, installs: 0, truncated: true, gets: 0, kept: true });
    });

    it('keeps the rows an earlier night wrote for the day it could not read whole, and writes the day it counts for the first time', async () => {
      const { db, statements } = fakeDb();
      const { bucket } = overCap();
      const rolled = await rollupRecent({ DB: db, TELEMETRY: bucket }, Date.parse('2026-11-07T03:17:00Z'));
      expect(rolled.map((one) => one.kept)).toEqual([false, true]);
      expect(statements.filter((sql) => sql.startsWith('DELETE'))).toHaveLength(1);
    });
  });
});
