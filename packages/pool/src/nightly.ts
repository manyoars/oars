// The nightly cron's one entry point (`wrangler.jsonc`, `worker.ts`): the telemetry rollup the fleet read comes from, then the retention sweeps. It reads the telemetry record and writes the rollup table, and drops expired telemetry batches and
// expired rows of the pool's own bounds. It names no ledger table (`ledger.test.ts` holds it to that).
import type { Env } from './http.js';
import { budgetAfter, FALLBACK_BUDGET, sweepRecord, sweepRows, type SweepEnv } from './retention.js';
import { rollupRecent, type RollupEnv } from './telemetry-rollup.js';

/**
 * Each step runs whatever the one before it did, so a night the rollup fails still sheds what has expired. The record's sweep is sized from the subrequests the rollup reports it used, since the two share one invocation's
 * allowance: a busy night's rollup leaves the sweep little, and the sweep's cursor finishes the rest on a quieter one.
 */
export const nightly = async (env: Env & RollupEnv & SweepEnv, now: number): Promise<void> => {
  let budget = FALLBACK_BUDGET;
  try {
    budget = budgetAfter((await rollupRecent(env, now)).reduce((sum, one) => sum + one.subrequests, 0));
  } finally {
    try {
      await sweepRows(env, now);
    } finally {
      await sweepRecord(env, now, budget);
    }
  }
};
