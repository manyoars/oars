// What the nightly run drops so no store the pool keeps grows without a bound: the telemetry record past `RETENTION_DAYS`, and the rows the pool's own bounds leave behind (login polls past the device code's life, login-start windows,
// telemetry quota days). The record could not carry an R2 lifecycle rule instead: `wrangler.jsonc` has no field for one (a rule is set with `wrangler r2 bucket lifecycle` or in the dashboard), so a deploy step would be the only thing
// holding the bound and nothing in the repo could check it. A sweep is code, and its test is the check.
import type { Env } from './http.js';
import { LOGIN_START_WINDOW_MS } from './identity.js';
import { dayOf, shiftDay } from './telemetry-rollup.js';

/** How long a batch stays in the record. It matches Analytics Engine's three months, the other copy of the same events; the fleet and operator reads come from the rollup table and never read a batch older than the rollup's own two nights. */
export const RETENTION_DAYS = 90;

/** What one Worker invocation may spend in subrequests (R2 and D1 calls count); the rollup's reads and the sweep share it. */
export const SUBREQUESTS_PER_INVOCATION = 1000;

/** What the nightly run keeps back from the sweep's budget for its other D1 calls: the three row sweeps, the cursor's read and write, and a margin. */
export const RESERVED_CALLS = 10;

/** The sweep's budget when the rollup failed and so reported nothing. The rollup reads 800 batches at most, so well over this many calls are left after any night it ran. */
export const FALLBACK_BUDGET = 100;

/** The calls the sweep may make after a rollup that spent `used` of the invocation's subrequests. A night the rollup used in full leaves little (or none), and the sweep takes the rest on a later night. */
export const budgetAfter = (used: number): number => Math.max(0, SUBREQUESTS_PER_INVOCATION - used - RESERVED_CALLS);

/** The part of the telemetry bucket the sweep uses. */
export interface SweepBucket {
  list: (options: { prefix: string }) => Promise<{ objects: { key: string }[] }>;
  delete: (keys: string[]) => Promise<void>;
}

export interface SweepEnv {
  TELEMETRY?: SweepBucket;
}

/**
 * Deletes the batches kept under every day at and before the retention cutoff that an earlier night has not emptied, oldest first, and answers how many it deleted. `budget` is the R2 calls it may make: a listing is one, a delete is one,
 * and each page of a day takes both. The cursor (`telemetry_sweep`, the oldest day not yet emptied) moves past a day only once a listing of it came back empty, so a day too big for the budget, or nights the cron missed, are
 * finished on a later night. An unbound bucket sweeps nothing. Deleting empties the listing, so the next page is the same call: no R2 cursor to carry.
 */
export const sweepRecord = async (env: Env & SweepEnv, now: number, budget: number): Promise<number> => {
  const bucket = env.TELEMETRY;
  if (bucket === undefined) return 0;
  const cutoff = shiftDay(dayOf(now), -RETENTION_DAYS);
  const stored = await env.DB.prepare('SELECT day FROM telemetry_sweep WHERE id = 1').first('day');
  // A pool with no cursor yet has kept nothing past the cutoff but what the nights since its deploy added, so it starts at the cutoff.
  let day = typeof stored === 'string' ? stored : cutoff;
  let left = budget;
  let deleted = 0;
  while (day <= cutoff && left > 0) {
    const prefix = `telemetry/${day}/`;
    const { objects } = await bucket.list({ prefix });
    left -= 1;
    if (objects.length === 0) {
      day = shiftDay(day, 1);
      continue;
    }
    // A page listed with no call left to delete it waits for the next night.
    if (left === 0) break;
    await bucket.delete(objects.map(({ key }) => key));
    left -= 1;
    deleted += objects.length;
  }
  if (day !== stored) await env.DB.prepare('INSERT INTO telemetry_sweep (id, day) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET day = excluded.day').bind(day).run();
  return deleted;
};

/** Deletes the pool's own expired bound rows: a poll row whose device code has died, a start window that is over, and a quota day that is past. */
export const sweepRows = async (env: Env, now: number): Promise<void> => {
  await env.DB.prepare('DELETE FROM login_polls WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare('DELETE FROM login_starts WHERE slot < ?').bind(Math.floor(now / LOGIN_START_WINDOW_MS)).run();
  await env.DB.prepare('DELETE FROM telemetry_quota WHERE day < ?').bind(dayOf(now)).run();
};
