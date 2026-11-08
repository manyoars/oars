// The nightly sweeps (retention.ts, nightly.ts): the telemetry record past its retention, and the rows the pool's own bounds leave behind. Under Miniflare's workerd with real R2 and D1, through the handler the Worker exports.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from './http.js';
import { nightly } from './nightly.js';
import { budgetAfter, FALLBACK_BUDGET, RESERVED_CALLS, RETENTION_DAYS, SUBREQUESTS_PER_INVOCATION, sweepRecord, sweepRows, type SweepBucket } from './retention.js';
import { dayOf, rollupRecent, shiftDay, type KeptBucket } from './telemetry-rollup.js';
import { startPool, type TestPool } from './test-pool.js';
import worker from './worker.js';

const NOW = Date.parse('2026-11-07T03:17:00Z');
const DAY_MS = 86_400_000;
const today = dayOf(NOW);
const cutoff = shiftDay(today, -RETENTION_DAYS);

interface Bindings {
  DB: Env['DB'];
  TELEMETRY: KeptBucket & SweepBucket;
}

let pool: TestPool;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

// Each test starts from an empty record and no cursor, since the cursor is state the next night resumes from.
beforeEach(async () => {
  const bucket = await pool.bucket();
  const listed = (await bucket.list({ prefix: 'telemetry/' })).objects.map(({ key }) => key);
  if (listed.length > 0) await bucket.delete(listed);
  await (await pool.db()).prepare('DELETE FROM telemetry_sweep').run();
});

const keys = async (): Promise<string[]> => (await (await pool.bucket()).list({ prefix: 'telemetry/' })).objects.map(({ key }) => key).sort();
const put = async (day: string, name: string): Promise<string> => {
  const key = `telemetry/${day}/${name}.json`;
  await (await pool.bucket()).put(key, '{}');
  return key;
};
const count = async (table: string): Promise<number> => Number(await (await pool.db()).prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n'));
const cursor = async (): Promise<unknown> => (await pool.db()).prepare('SELECT day FROM telemetry_sweep WHERE id = 1').first('day');

/** A bucket held in memory that lists `pageSize` keys at a time (R2 lists 1,000) and counts every call, so a test can see how many subrequests a night spent. */
const memory = (pageSize: number): { bucket: KeptBucket & SweepBucket; fill: (day: string, total: number) => void; left: (day: string) => number; calls: () => number } => {
  const held = new Set<string>();
  let calls = 0;
  const under = (prefix: string): string[] => [...held].filter((key) => key.startsWith(prefix)).sort();
  return {
    fill: (day, total) => {
      for (let at = 0; at < total; at += 1) held.add(`telemetry/${day}/${String(at).padStart(6, '0')}.json`);
    },
    left: (day) => under(`telemetry/${day}/`).length,
    calls: () => calls,
    bucket: {
      list: ({ prefix, cursor: from }) => {
        calls += 1;
        const all = under(prefix);
        const start = from === undefined ? 0 : Number(from);
        const more = start + pageSize < all.length;
        return Promise.resolve({ objects: all.slice(start, start + pageSize).map((key) => ({ key })), truncated: more, ...(more ? { cursor: String(start + pageSize) } : {}) });
      },
      get: () => {
        calls += 1;
        return Promise.resolve({ text: () => Promise.resolve('{}') });
      },
      delete: (batch) => {
        calls += 1;
        for (const key of batch) held.delete(key);
        return Promise.resolve();
      },
    },
  };
};

describe('the telemetry record', () => {
  it(`drops a batch past ${String(RETENTION_DAYS)} days, keeps one inside it, and moves the cursor past the day it emptied`, async () => {
    const fresh = [await put(shiftDay(today, -(RETENTION_DAYS - 1)), 'a'), await put(today, 'b'), await put(shiftDay(today, -1), 'c')];
    await put(cutoff, 'd');
    await put(cutoff, 'e');
    await worker.scheduled({ scheduledTime: NOW }, await pool.miniflare.getBindings<Bindings>());
    expect(await keys()).toEqual(fresh.sort());
    expect(await cursor()).toBe(shiftDay(cutoff, 1));
  });

  it('empties a day of more than one page, a page at a time', async () => {
    const held = memory(2);
    held.fill(cutoff, 5);
    const bindings = await pool.miniflare.getBindings<Bindings>();
    expect(await sweepRecord({ DB: bindings.DB, TELEMETRY: held.bucket }, NOW, 100)).toBe(5);
    expect(held.left(cutoff)).toBe(0);
    // Three pages of a list and a delete, and the empty listing that shows the day is done.
    expect(held.calls()).toBe(7);
    expect(await cursor()).toBe(shiftDay(cutoff, 1));
  });

  it('finishes a day too big for one night on the next: the cursor stays on it until a listing comes back empty', async () => {
    const held = memory(2);
    held.fill(cutoff, 6);
    const env = { DB: (await pool.miniflare.getBindings<Bindings>()).DB, TELEMETRY: held.bucket };
    // Four calls: two pages deleted.
    expect(await sweepRecord(env, NOW, 4)).toBe(4);
    expect(held.left(cutoff)).toBe(2);
    expect(await cursor()).toBe(cutoff);
    // Three calls: the last page is listed and deleted, and the empty listing is the third. A fourth night would find nothing.
    expect(await sweepRecord(env, NOW, 3)).toBe(2);
    expect(held.left(cutoff)).toBe(0);
    expect(await cursor()).toBe(shiftDay(cutoff, 1));
    // An odd budget lists a page it has no call left to delete, and leaves it.
    held.fill(shiftDay(cutoff, 1), 3);
    expect(await sweepRecord(env, NOW + DAY_MS, 1)).toBe(0);
    expect(held.left(shiftDay(cutoff, 1))).toBe(3);
  });

  it('sweeps nothing on a night with no calls left, and keeps the cursor where it was', async () => {
    const kept = await put(cutoff, 'waits');
    const env = await pool.miniflare.getBindings<Bindings>();
    expect(await sweepRecord(env, NOW, 0)).toBe(0);
    expect(await keys()).toEqual([kept]);
    expect(await cursor()).toBe(cutoff);
  });

  it('empties days the cron missed, however many: a night past the old three-night window finishes them', async () => {
    const env = await pool.miniflare.getBindings<Bindings>();
    await put(cutoff, 'first');
    await worker.scheduled({ scheduledTime: NOW }, env);
    // Ten nights with no run: the days after the first cutoff, up to the new one, are all past retention when it comes back.
    const missed: string[] = [];
    for (let after = 1; after <= 10; after += 1) missed.push(await put(shiftDay(cutoff, after), `missed-${String(after)}`));
    const fresh = await put(shiftDay(cutoff, 11), 'inside');
    await worker.scheduled({ scheduledTime: NOW + 10 * DAY_MS }, env);
    expect(await keys()).toEqual([fresh]);
    expect(missed).toHaveLength(10);
    expect(await cursor()).toBe(shiftDay(cutoff, 11));
  });

  it('sweeps nothing when no bucket is bound', async () => {
    expect(await sweepRecord({ DB: (await pool.miniflare.getBindings<Bindings>()).DB }, NOW, 100)).toBe(0);
    expect(await cursor()).toBeNull();
  });
});

describe('the night after a rollup that used its full budget', () => {
  it('sizes the sweep from the rollup\'s subrequests: it sweeps less, stays inside the invocation\'s allowance, and the cursor finishes the day on the next night', async () => {
    const held = memory(100);
    const yesterday = shiftDay(today, -1);
    // Yesterday holds more batches than one run reads, so the rollup spends its whole 800 reads; the cutoff day holds more pages than the rest of the allowance deletes.
    held.fill(yesterday, 900);
    held.fill(cutoff, 12_000);
    const env = { DB: (await pool.miniflare.getBindings<Bindings>()).DB, TELEMETRY: held.bucket };
    const rolled = await rollupRecent(env, NOW);
    // 9 listings (the ninth page is cut at its first key), 800 reads, and the one write of the day's rows; the day before is cut before it starts.
    expect(rolled.map((one) => one.subrequests)).toEqual([810, 0]);
    expect(budgetAfter(810)).toBe(SUBREQUESTS_PER_INVOCATION - 810 - RESERVED_CALLS);
    const spent = held.calls();

    await expect(nightly(env, NOW)).resolves.toBeUndefined();
    // The night's R2 calls, the rollup's and the sweep's, stay under the one invocation's allowance; the sweep took what the rollup left.
    expect(held.calls() - spent).toBeLessThanOrEqual(SUBREQUESTS_PER_INVOCATION - RESERVED_CALLS);
    expect(held.left(cutoff)).toBe(12_000 - 9_000);
    expect(await cursor()).toBe(cutoff);

    await nightly(env, NOW);
    expect(held.left(cutoff)).toBe(0);
    expect(await cursor()).toBe(shiftDay(cutoff, 1));
  });

  it('gives the sweep nothing when the rollup used the whole allowance, and a failed rollup a fixed share', () => {
    expect(budgetAfter(SUBREQUESTS_PER_INVOCATION)).toBe(0);
    expect(budgetAfter(5_000)).toBe(0);
    expect(budgetAfter(0)).toBe(SUBREQUESTS_PER_INVOCATION - RESERVED_CALLS);
    expect(FALLBACK_BUDGET).toBeLessThan(SUBREQUESTS_PER_INVOCATION - 800 - RESERVED_CALLS);
  });
});

describe('the rows of the pool\'s own bounds', () => {
  it('sheds a poll row past its device code, a start window that is over, and a quota day that is past, and keeps the rest', async () => {
    const db = await pool.db();
    const slot = Math.floor(NOW / 3_600_000);
    await db.prepare('DELETE FROM login_polls').run();
    await db.prepare('DELETE FROM login_starts').run();
    await db.prepare('DELETE FROM telemetry_quota').run();
    for (const [hash, expires] of [['dead', NOW - 1], ['edge', NOW], ['live', NOW + 1]] as const) await db.prepare('INSERT INTO login_polls (handle_hash, next_at, interval_sec, expires_at) VALUES (?, 0, 5, ?)').bind(hash, expires).run();
    for (const at of [slot - 1, slot]) await db.prepare('INSERT INTO login_starts (client, slot, count) VALUES (?, ?, 1)').bind('someone', at).run();
    for (const day of [shiftDay(today, -1), today]) await db.prepare('INSERT INTO telemetry_quota (install, day, count) VALUES (?, ?, 1)').bind('i', day).run();
    await worker.scheduled({ scheduledTime: NOW }, await pool.miniflare.getBindings<Bindings>());
    expect(await count('login_polls')).toBe(1);
    expect(await db.prepare('SELECT handle_hash AS h FROM login_polls').first('h')).toBe('live');
    expect(await db.prepare('SELECT slot AS s FROM login_starts').first('s')).toBe(slot);
    expect(await db.prepare('SELECT day AS d FROM telemetry_quota').first('d')).toBe(today);
  });

  it('still sweeps the rows and the record when the rollup fails, and the failure is not swallowed', async () => {
    const bucket = await pool.bucket();
    const old = await put(cutoff, 'after-failure');
    await put(shiftDay(today, -1), 'unreadable');
    await (await pool.db()).prepare('INSERT INTO telemetry_quota (install, day, count) VALUES (?, ?, 1)').bind('stale', shiftDay(today, -1)).run();
    const failing = {
      DB: (await pool.miniflare.getBindings<Bindings>()).DB,
      TELEMETRY: { list: async (options: { prefix: string }) => ({ objects: [...(await bucket.list(options)).objects], truncated: false }), get: () => Promise.reject(new Error('the bucket is down')), delete: (batch: string[]) => bucket.delete(batch) },
    };
    await expect(worker.scheduled({ scheduledTime: NOW }, failing)).rejects.toThrow('the bucket is down');
    expect(await keys()).not.toContain(old);
    expect(await (await pool.db()).prepare('SELECT COUNT(*) AS n FROM telemetry_quota WHERE install = ?').bind('stale').first('n')).toBe(0);
  });

  it('does not swallow a database that is down: the record\'s cursor cannot be read, and the night fails', async () => {
    const bucket = await pool.bucket();
    const failing = {
      DB: { prepare: () => { throw new Error('the database is down'); }, batch: () => Promise.reject(new Error('down')) },
      TELEMETRY: { list: async (options: { prefix: string }) => ({ objects: [...(await bucket.list(options)).objects], truncated: false }), get: () => Promise.reject(new Error('down')), delete: (batch: string[]) => bucket.delete(batch) },
    };
    await expect(worker.scheduled({ scheduledTime: NOW }, failing)).rejects.toThrow('the database is down');
  });
});

describe('sweepRows on its own', () => {
  it('runs against the Worker\'s database', async () => {
    await expect(sweepRows((await pool.miniflare.getBindings<Bindings>()), NOW)).resolves.toBeUndefined();
  });
});
