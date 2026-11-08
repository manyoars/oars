// The nightly sweeps (retention.ts, nightly.ts): the telemetry record past its retention, and the rows the pool's own bounds leave behind. Under Miniflare's workerd with real R2 and D1, through the handler the Worker exports.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from './http.js';
import { MAX_SWEEP_PAGES_PER_DAY, RETENTION_DAYS, sweepRecord, sweepRows, type SweepBucket } from './retention.js';
import { dayOf, shiftDay, type KeptBucket } from './telemetry-rollup.js';
import { startPool, type TestPool } from './test-pool.js';
import worker from './worker.js';

const NOW = Date.parse('2026-11-07T03:17:00Z');
const today = dayOf(NOW);

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

const keys = async (): Promise<string[]> => (await (await pool.bucket()).list({ prefix: 'telemetry/' })).objects.map(({ key }) => key).sort();
const put = async (day: string, name: string): Promise<string> => {
  const key = `telemetry/${day}/${name}.json`;
  await (await pool.bucket()).put(key, '{}');
  return key;
};
const count = async (table: string): Promise<number> => Number(await (await pool.db()).prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n'));

describe('the telemetry record', () => {
  it(`drops a batch past ${String(RETENTION_DAYS)} days, keeps one inside it, and a night the cron missed is caught the next night`, async () => {
    const fresh = [await put(shiftDay(today, -(RETENTION_DAYS - 1)), 'a'), await put(today, 'b'), await put(shiftDay(today, -1), 'c')];
    const old = [await put(shiftDay(today, -RETENTION_DAYS), 'd'), await put(shiftDay(today, -RETENTION_DAYS), 'e'), await put(shiftDay(today, -(RETENTION_DAYS + 2)), 'f')];
    // Older than the catch-up window: the sweep does not go looking, so it is left (a deploy older than that has no such day).
    const ancient = await put(shiftDay(today, -(RETENTION_DAYS + 10)), 'g');
    await worker.scheduled({ scheduledTime: NOW }, await pool.miniflare.getBindings<Bindings>());
    expect(await keys()).toEqual([...fresh, ancient].sort());
    expect(old).toHaveLength(3);
  });

  it('empties a day of more than one page, a page at a time, and stops at the page bound', async () => {
    const bucket = await pool.bucket();
    const day = shiftDay(today, -RETENTION_DAYS);
    const lists: string[] = [];
    const stub: SweepBucket = {
      list: async (options) => {
        lists.push(options.prefix);
        return { objects: [...(await bucket.list(options)).objects] };
      },
      delete: (batch) => bucket.delete(batch),
    };
    for (let at = 0; at < 3; at += 1) await put(day, `bulk-${String(at)}`);
    expect(await sweepRecord({ TELEMETRY: stub }, NOW)).toBe(3);
    // One listing that found three and one that found none, for the cutoff day, then one empty listing for each day past it.
    expect(lists).toEqual([`telemetry/${day}/`, `telemetry/${day}/`, `telemetry/${shiftDay(day, -1)}/`, `telemetry/${shiftDay(day, -2)}/`]);
    // A bucket that never empties is read MAX_SWEEP_PAGES_PER_DAY times a day and no more.
    let listed = 0;
    const endless: SweepBucket = { list: () => ((listed += 1), Promise.resolve({ objects: [{ key: 'telemetry/x/y.json' }] })), delete: () => Promise.resolve() };
    await sweepRecord({ TELEMETRY: endless }, NOW);
    expect(listed).toBe(3 * MAX_SWEEP_PAGES_PER_DAY);
  });

  it('sweeps nothing when no bucket is bound', async () => {
    expect(await sweepRecord({}, NOW)).toBe(0);
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

  it('still sweeps the record when the database fails, and the failure is not swallowed', async () => {
    const bucket = await pool.bucket();
    const day = shiftDay(today, -RETENTION_DAYS);
    await put(day, 'after-failure');
    const failing = {
      DB: { prepare: () => { throw new Error('the database is down'); }, batch: () => Promise.reject(new Error('down')) },
      TELEMETRY: { list: async (options: { prefix: string }) => ({ objects: [...(await bucket.list(options)).objects], truncated: false }), get: () => Promise.reject(new Error('down')), delete: (batch: string[]) => bucket.delete(batch) },
    };
    await expect(worker.scheduled({ scheduledTime: NOW }, failing)).rejects.toThrow('the database is down');
    expect(await keys()).not.toContain(`telemetry/${day}/after-failure.json`);
  });
});

describe('sweepRows on its own', () => {
  it('runs against the Worker\'s database', async () => {
    await expect(sweepRows((await pool.miniflare.getBindings<Bindings>()), NOW)).resolves.toBeUndefined();
  });
});
