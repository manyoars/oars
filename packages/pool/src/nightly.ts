// The nightly cron's one entry point (`wrangler.jsonc`, `worker.ts`): the telemetry rollup the fleet read comes from, then the retention sweeps, then the erasure of raw copies whose yes was withdrawn. It reads the telemetry record and writes the rollup table, and drops expired telemetry batches and
// expired rows of the pool's own bounds. It names no ledger table and no raw state (`ledger.test.ts` and `raw-serves-nothing.test.ts` hold it to that): the raw sweep is `raw.ts`'s.
import type { Env } from './http.js';
import { SWEEP_PAGE_CALLS, sweepWithdrawnRaw } from './raw.js';
import { budgetAfter, FALLBACK_BUDGET, sweepRecord, sweepRows, type SweepEnv } from './retention.js';
import { rollupRecent, type RollupEnv } from './telemetry-rollup.js';

/** The raw sweep's pages in one night: 5 of `SWEEP_PAGE_CALLS`, held back in `RESERVED_CALLS`. */
const SWEEP_RAW_CALLS = 5 * SWEEP_PAGE_CALLS;

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
      try {
        await sweepRecord(env, now, budget);
      } finally {
        // Last, and apart from the budget the record's sweep takes: `RESERVED_CALLS` already holds back the raw sweep's pages. A withdrawal's erasure is not delayed by a night the rollup used up.
        await sweepWithdrawnRaw(env, now, SWEEP_RAW_CALLS);
      }
    }
  }
};
