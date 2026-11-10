// The operator's withdrawal of raw consent (`erase withdraw`, docs/pool-rights.md "Art. 7(3)"): the update the route runs (`WITHDRAW_RAW_CONSENT`, one text for both), then the account's staged raw parts dropped. The held objects are erased by the nightly sweep
// (`sweepWithdrawnRaw`), which reads the record this writes, exactly as it does after the route. Run it for a requester confirmed by a token proof, never a machine key.
import { stagedPrefix, WITHDRAW_RAW_CONSENT } from '../src/raw.js';
import { nameOf, type EraseStore } from './erase.js';

/** Whether the account's raw yes stands (`yes`), was withdrawn (`withdrawn`), or was never given (`never`). */
export type RawStanding = 'yes' | 'withdrawn' | 'never';

/** The account's raw consent as the pool holds it: the standing, and when a withdrawal was recorded. */
export interface RawConsent {
  account: string;
  standing: RawStanding;
  withdrawnAt: number | null;
}

/** What one run did: whether it recorded a withdrawal, how many staged parts it dropped, and whether it could list them at all. */
export interface Withdrawn {
  withdrawn: boolean;
  stagedDropped: number;
  stagedListed: boolean;
}

const fieldOf = (row: unknown, key: string): unknown => (typeof row === 'object' && row !== null ? Reflect.get(row, key) : undefined);

/** Reads the account's raw consent. An account the pool has never seen is an error, since withdrawing a mistyped id would otherwise look like success. */
export const rawConsentOf = async (store: EraseStore, accountId: string): Promise<RawConsent> => {
  const account = nameOf(accountId, 'the account');
  const row = (await store.rows('SELECT raw_consent, raw_consent_withdrawn_at FROM accounts WHERE id = ?', [account]))[0];
  if (row === undefined) throw new Error(`No account ${account} in the pool.`);
  const withdrawnAt = fieldOf(row, 'raw_consent_withdrawn_at');
  const standing: RawStanding = typeof fieldOf(row, 'raw_consent') === 'number' ? 'yes' : typeof withdrawnAt === 'number' ? 'withdrawn' : 'never';
  return { account, standing, withdrawnAt: typeof withdrawnAt === 'number' ? withdrawnAt : null };
};

/**
 * Records the withdrawal, then drops the account's staged parts, as the route does in that order. A yes that stands is cleared with the time and the version it answered; no yes standing matches no row, so a rerun changes nothing and keeps the first record.
 * An account that withdrew still has its staged parts dropped, so a run that stopped between the two steps finishes on the rerun. An account that never gave a yes has nothing to withdraw and nothing staged, and is left alone. A run that cannot list the bucket (`listRaw` absent) drops none and says so.
 */
export const withdrawRaw = async (store: EraseStore, accountId: string, now: Date): Promise<Withdrawn> => {
  const { account, standing } = await rawConsentOf(store, accountId);
  if (standing === 'never') return { withdrawn: false, stagedDropped: 0, stagedListed: true };
  const withdrawn = (await store.run(WITHDRAW_RAW_CONSENT, [now.getTime(), account])) > 0;
  if (store.listRaw === undefined) return { withdrawn, stagedDropped: 0, stagedListed: false };
  const prefix = stagedPrefix(account);
  const staged = await store.listRaw(prefix);
  // A listing is by prefix, so a key outside it is a wrong answer; nothing is deleted on its word.
  const stray = staged.find((key) => !key.startsWith(prefix));
  if (stray !== undefined) throw new Error(`the listing for ${prefix} named ${stray}, which is not a staged part of the account`);
  for (const key of staged) await store.deleteObject(key);
  return { withdrawn, stagedDropped: staged.length, stagedListed: true };
};
