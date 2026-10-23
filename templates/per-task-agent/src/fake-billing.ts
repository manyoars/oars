// An in-memory stand-in for billing that follows R7's reservation rules. It backs `OARS_DEV_FAKE_BILLING=1` (local
// development, no SDK key) and the unit tests, so a test of withCredits proves the same replay behavior billing has.
import { randomUUID } from 'node:crypto';
import { type Balance, type Billing, BillingProblem, type Commit, type Reservation } from './billing.js';

export interface FakeBilling extends Billing {
  /** Adds credits to a customer, as a paid-for pack would. */
  grant: (customerRef: string, credits: number) => void;
  /** Takes credits back, as a refund or dispute would. */
  clawback: (customerRef: string, credits: number) => void;
}

interface Row {
  id: string;
  customerRef: string;
  credits: number;
  status: Reservation['status'];
  expiresAt: number;
  committedAt?: number;
  committedCredits: number;
  replayCount: number;
}

// The packs the starter template sells; the fake credits one the moment it is "bought".
const PACKS = new Map([
  ['task-1', 1],
  ['tasks-5', 5],
]);

// Runs the work now and hands back its result, or its thrown BillingProblem, as a promise.
const settled = <T>(work: () => T): Promise<T> =>
  new Promise((resolve) => {
    resolve(work());
  });

const refuse = (status: number, code: string): BillingProblem => new BillingProblem({ status, code });

export const createFakeBilling = (options: { now: () => number }): FakeBilling => {
  const balances = new Map<string, number>();
  const rows = new Map<string, Row>();
  // The row a key currently stands for: a HELD or COMMITTED one. A released or expired row leaves it free for a new hold.
  const byKey = new Map<string, Row>();

  const balanceOf = (customerRef: string): number => balances.get(customerRef) ?? 0;
  const heldBy = (customerRef: string): number =>
    [...rows.values()].filter((row) => row.customerRef === customerRef && row.status === 'HELD').reduce((sum, row) => sum + row.credits, 0);
  // A HELD row past its expiresAt counts as EXPIRED at once, without waiting for the job (R7).
  const expireStale = (): void => {
    for (const row of rows.values()) {
      if (row.status === 'HELD' && row.expiresAt <= options.now()) row.status = 'EXPIRED';
    }
  };
  const view = (row: Row, replayed: boolean): Reservation => ({
    reservationId: row.id,
    status: row.status,
    credits: row.credits,
    expiresAt: new Date(row.expiresAt).toISOString(),
    replayed,
    replayCount: row.replayCount,
    ...(row.committedAt === undefined ? {} : { committedAt: new Date(row.committedAt).toISOString() }),
  });
  const find = (reservationId: string): Row => {
    expireStale();
    const row = rows.get(reservationId);
    if (row === undefined) throw refuse(404, 'RESERVATION_NOT_FOUND');
    return row;
  };
  const balance = (customerRef: string): Balance => {
    const held = heldBy(customerRef);
    const remaining = balanceOf(customerRef);
    return { customerRef, creditsRemaining: remaining, creditsHeld: held, creditsAvailable: Math.max(0, remaining - held), livemode: false };
  };

  // Every method does its work in one synchronous step, so concurrent callers are serialized as billing's transaction
  // would serialize them.
  return {
    grant: (customerRef, credits) => {
      balances.set(customerRef, balanceOf(customerRef) + credits);
    },
    clawback: (customerRef, credits) => {
      balances.set(customerRef, Math.max(0, balanceOf(customerRef) - credits));
    },
    upsertCustomer: () => Promise.resolve(),
    checkout: (customerRef, priceRef) =>
      settled(() => {
        const credits = PACKS.get(priceRef);
        if (credits === undefined) throw refuse(404, 'PRICE_NOT_FOUND');
        balances.set(customerRef, balanceOf(customerRef) + credits);
        return { checkoutUrl: `https://checkout.example/fake/${priceRef}` };
      }),
    balance: (customerRef) =>
      settled(() => {
        expireStale();
        return balance(customerRef);
      }),
    reserve: ({ customerRef, credits, ttlSeconds, idempotencyKey }) =>
      settled(() => {
        expireStale();
        const existing = byKey.get(idempotencyKey);
        if (existing?.status === 'HELD') return view(existing, true);
        if (existing?.status === 'COMMITTED') {
          existing.replayCount += 1;
          return view(existing, true);
        }
        if (balance(customerRef).creditsAvailable < credits) {
          throw new BillingProblem({ status: 409, code: 'INSUFFICIENT_CREDITS', actionUrl: `https://checkout.example/packs/${customerRef}` });
        }
        const row: Row = {
          id: randomUUID(),
          customerRef,
          credits,
          status: 'HELD',
          expiresAt: options.now() + ttlSeconds * 1000,
          committedCredits: 0,
          replayCount: 0,
        };
        rows.set(row.id, row);
        byKey.set(idempotencyKey, row);
        return view(row, false);
      }),
    commit: (reservationId) =>
      settled((): Commit => {
        const row = find(reservationId);
        if (row.status === 'EXPIRED') throw refuse(409, 'RESERVATION_EXPIRED');
        if (row.status === 'RELEASED') throw refuse(409, 'RESERVATION_RELEASED');
        const replayed = row.status === 'COMMITTED';
        if (!replayed) {
          // A clawback can leave less than the hold: billing debits the lesser (LEAST(hold, balance)).
          row.committedCredits = Math.min(row.credits, balanceOf(row.customerRef));
          balances.set(row.customerRef, balanceOf(row.customerRef) - row.committedCredits);
          row.status = 'COMMITTED';
          row.committedAt = options.now();
        }
        return {
          reservationId: row.id,
          status: row.status,
          committedCredits: row.committedCredits,
          creditsRemaining: balanceOf(row.customerRef),
          replayed,
        };
      }),
    release: (reservationId) =>
      settled(() => {
        const row = find(reservationId);
        if (row.status === 'COMMITTED') throw refuse(409, 'RESERVATION_COMMITTED');
        if (row.status === 'HELD') row.status = 'RELEASED';
      }),
  };
};
