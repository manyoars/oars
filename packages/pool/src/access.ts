// The access flag (spec Section 1.4): only a counting batch sets it. An account with access is fetched without the cap; one without has `fetch_cap`.
import type { Harness } from '../../cli/src/sessions/schema.js';
import type { SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { fieldOf, type Env } from './http.js';

/** W's tiers for a batch (spec Section 1.4). `none` is a batch whose challenge or local root check failed. */
export type Tier = 'none' | 'skeleton' | 'committed' | 'audited' | 'attested';

/** What every ingest writes until a wire carries a root (Brief 2): so no claude-code batch can count yet. */
export const INGEST_TIER: Tier = 'skeleton';

/** The harnesses that write no raw file, so a batch of theirs can never reach `committed` and counts at `skeleton`. t811 moves this into the vocabulary. */
const WRITES_NO_RAW: ReadonlySet<Harness> = new Set<Harness>(['cursor']);

const ROOTED: ReadonlySet<Tier> = new Set<Tier>(['committed', 'audited', 'attested']);

/** How long a counting batch rests on the ledger before nothing can audit it and the flag stands (`ledger_days`). */
export const LEDGER_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Access = 'pending' | 'standing';

/**
 * Whether a batch counts toward access: at tier committed or higher, or at `skeleton` when every transcript's harness writes no raw file; one prompt and one tool step over the
 * whole batch, subagents folded in; and at least one derived cell. `cellsOf` is the batch's cell count, and the cell clause stands in for "a cell increment written" until the
 * stored cells land (t813), which reads the written increment instead.
 */
export const batchCounts = (tier: Tier, skeleton: SessionSkeleton, cellsOf: (skeleton: SessionSkeleton) => number): boolean => {
  const tierCounts = ROOTED.has(tier) || (tier === 'skeleton' && skeleton.transcripts.every(({ harness }) => WRITES_NO_RAW.has(harness)));
  if (!tierCounts) return false;
  const prompts = skeleton.transcripts.reduce((sum, { prompts: held }) => sum + held.length, 0);
  const steps = skeleton.transcripts.reduce((sum, { tools }) => sum + tools.reduce((inner, { steps: held }) => inner + held.length, 0), 0);
  return prompts >= 1 && steps >= 1 && cellsOf(skeleton) >= 1;
};

/**
 * The account's access, written to its record when it changes. `standing` is latched: once a counting batch has stood `ledger_days`, nothing can audit it, so the flag stays while
 * the account exists. Before that it is `pending` while any counting batch is not `none`, and clears when none is left. A resend that still counts keeps a batch's first `counted_at`, so a
 * client resending every session does not push a batch back toward pending; one that no longer counts clears it, and the flag falls if no counting batch is left.
 */
export const accessOf = async (env: Env, account: string, now: number): Promise<Access | null> => {
  const held = fieldOf(await env.DB.prepare('SELECT access FROM accounts WHERE id = ?').bind(account).first(), 'access');
  if (held === 'standing') return 'standing';
  const first = fieldOf(await env.DB.prepare("SELECT MIN(counted_at) AS first FROM deposits WHERE account = ? AND counted_at IS NOT NULL AND tier <> 'none'").bind(account).first(), 'first');
  const access: Access | null = typeof first !== 'number' ? null : first <= now - LEDGER_DAYS * DAY_MS ? 'standing' : 'pending';
  if (access !== (held ?? null)) await env.DB.prepare('UPDATE accounts SET access = ? WHERE id = ?').bind(access, account).run();
  return access;
};
