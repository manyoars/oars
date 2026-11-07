// What the nightly run drops so no store the pool keeps grows without a bound: the telemetry record past `RETENTION_DAYS`, and the rows the pool's own bounds leave behind (login polls past the device code's life, login-start windows,
// telemetry quota days). The record could not carry an R2 lifecycle rule instead: `wrangler.jsonc` has no field for one (a rule is set with `wrangler r2 bucket lifecycle` or in the dashboard), so a deploy step would be the only thing
// holding the bound and nothing in the repo could check it. A sweep is code, and its test is the check.
import type { Env } from './http.js';
import { LOGIN_START_WINDOW_MS } from './identity.js';
import { dayOf, shiftDay } from './telemetry-rollup.js';

/** How long a batch stays in the record. It matches Analytics Engine's three months, the other copy of the same events; the fleet and operator reads come from the rollup table and never read a batch older than the rollup's own two nights. */
export const RETENTION_DAYS = 90;

/** The sweep looks at this many days at and past the cutoff, so a night the cron missed is caught by the next. */
const CATCH_UP_DAYS = 3;

/** A day's keys are listed and deleted a page at a time (R2 takes 1,000 keys on each); this many pages bound one day's subrequests, and the next night takes the rest. */
export const MAX_SWEEP_PAGES_PER_DAY = 20;

/** The part of the telemetry bucket the sweep uses. */
export interface SweepBucket {
  list: (options: { prefix: string }) => Promise<{ objects: { key: string }[] }>;
  delete: (keys: string[]) => Promise<void>;
}

export interface SweepEnv {
  TELEMETRY?: SweepBucket;
}

/** Deletes the batches kept under the days at and just past the retention cutoff, and answers how many it deleted. An unbound bucket sweeps nothing. */
export const sweepRecord = async (env: SweepEnv, now: number): Promise<number> => {
  const bucket = env.TELEMETRY;
  if (bucket === undefined) return 0;
  let deleted = 0;
  for (let back = 0; back < CATCH_UP_DAYS; back += 1) {
    const prefix = `telemetry/${shiftDay(dayOf(now), -(RETENTION_DAYS + back))}/`;
    // Deleting empties the listing, so the next page is the same call: no cursor to carry.
    for (let page = 0; page < MAX_SWEEP_PAGES_PER_DAY; page += 1) {
      const { objects } = await bucket.list({ prefix });
      if (objects.length === 0) break;
      await bucket.delete(objects.map(({ key }) => key));
      deleted += objects.length;
    }
  }
  return deleted;
};

/** Deletes the pool's own expired bound rows: a poll row whose device code has died, a start window that is over, and a quota day that is past. */
export const sweepRows = async (env: Env, now: number): Promise<void> => {
  await env.DB.prepare('DELETE FROM login_polls WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare('DELETE FROM login_starts WHERE slot < ?').bind(Math.floor(now / LOGIN_START_WINDOW_MS)).run();
  await env.DB.prepare('DELETE FROM telemetry_quota WHERE day < ?').bind(dayOf(now)).run();
};
