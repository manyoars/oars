// The access flag (spec Section 1.4): only a counting batch sets it. An account with access is fetched without the cap; one without has `fetch_cap`.
import type { Harness } from '../../cli/src/sessions/schema.js';
import type { SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { fieldOf, type Env } from './http.js';

/** W's tiers for a batch (spec Section 1.4). `none` is a batch whose challenge or local root check failed. */
export type Tier = 'none' | 'skeleton' | 'committed' | 'audited' | 'attested';

/** The harnesses that write no raw file, so a batch of theirs can never reach `committed` and counts at `skeleton`. t811 moves this into the vocabulary. */
const WRITES_NO_RAW: ReadonlySet<Harness> = new Set<Harness>(['cursor']);

const ROOTED: ReadonlySet<Tier> = new Set<Tier>(['committed', 'audited', 'attested']);

/** SHA-256 of no bytes: the root of a transcript with no lines, and the only root `leaves: 0` can carry. */
const EMPTY_ROOT = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const TIER_ORDER: readonly Tier[] = ['none', 'skeleton', 'committed', 'audited', 'attested'];

/**
 * The tier one transcript's wire earns at ingest. `skeleton` for a harness that writes no raw file, since no root of it can ever be checked; `none` for a root that cannot be real, which
 * is no leaves under any hash but the empty one, or the empty hash over leaves; else `committed`. A fabricated but well-formed root stays committed until the raw-file check of a later layer.
 */
const transcriptTier = ({ harness, merkleRoot, leaves }: SessionSkeleton['transcripts'][number]): Tier => {
  if ((leaves === 0) !== (merkleRoot === EMPTY_ROOT)) return 'none';
  return WRITES_NO_RAW.has(harness) ? 'skeleton' : 'committed';
};

/** A batch's tier is the lowest of its transcripts', subagents folded in (spec Section 1.4): one that fails its root check takes the whole batch to `none`. */
export const batchTier = (skeleton: SessionSkeleton): Tier =>
  skeleton.transcripts.reduce<Tier>((lowest, transcript) => {
    const held = transcriptTier(transcript);
    return TIER_ORDER.indexOf(held) < TIER_ORDER.indexOf(lowest) ? held : lowest;
  }, 'attested');

/** How long a counting batch rests on the ledger before nothing can audit it and the flag stands (`ledger_days`). */
export const LEDGER_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Access = 'pending' | 'standing';

/**
 * Whether a batch counts toward access: at tier committed or higher, or at `skeleton` when every transcript's harness writes no raw file; one prompt and one tool step over the
 * whole batch, subagents folded in; and a cell increment written. `written` is how many cell increments ingest writes for the batch over the row held now (`netCellCount`), so the
 * clause reads the stored cells' increment and not a derivation of its own; a batch sent again unchanged writes none.
 */
export const batchCounts = (tier: Tier, skeleton: SessionSkeleton, written: number): boolean => {
  const tierCounts = ROOTED.has(tier) || (tier === 'skeleton' && skeleton.transcripts.every(({ harness }) => WRITES_NO_RAW.has(harness)));
  if (!tierCounts) return false;
  const prompts = skeleton.transcripts.reduce((sum, { prompts: held }) => sum + held.length, 0);
  const steps = skeleton.transcripts.reduce((sum, { tools }) => sum + tools.reduce((inner, { steps: held }) => inner + held.length, 0), 0);
  return prompts >= 1 && steps >= 1 && written >= 1;
};

/** The earliest counting date of an account: one read of the `deposits_counted` index, not a walk over the account's ledger rows. Exported so a test can ask SQLite for its plan. */
export const EARLIEST_COUNTED = "SELECT MIN(counted_at) AS first FROM deposits WHERE account = ? AND counted_at IS NOT NULL AND tier <> 'none'";

/**
 * The account's access, written to its record when it changes. `standing` is latched: once a counting batch has stood `ledger_days`, nothing can audit it, so the flag stays while
 * the account exists. Before that it is `pending` while any counting batch is not `none`, and clears when none is left. A resend that still counts keeps a batch's first `counted_at`, so a
 * client resending every session does not push a batch back toward pending; one that no longer counts clears it, and the flag falls if no counting batch is left; an ingest that writes no cell increment leaves it alone.
 */
export const accessOf = async (env: Env, account: string, now: number): Promise<Access | null> => {
  const held = fieldOf(await env.DB.prepare('SELECT access FROM accounts WHERE id = ?').bind(account).first(), 'access');
  if (held === 'standing') return 'standing';
  const first = fieldOf(await env.DB.prepare(EARLIEST_COUNTED).bind(account).first(), 'first');
  const access: Access | null = typeof first !== 'number' ? null : first <= now - LEDGER_DAYS * DAY_MS ? 'standing' : 'pending';
  if (access !== (held ?? null)) await env.DB.prepare('UPDATE accounts SET access = ? WHERE id = ?').bind(access, account).run();
  return access;
};
