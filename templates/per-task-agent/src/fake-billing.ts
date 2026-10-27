// An in-memory stand-in for billing that follows R7's reservation rules. It backs `OARS_DEV_FAKE_BILLING=1` (local
// development, no SDK key) and the unit tests, so a test of withCredits proves the same replay behavior billing has.
import { randomBytes, randomUUID } from 'node:crypto';
import { type Balance, type Billing, BillingProblem, type CheckoutUrls, type Commit, type Reservation } from './billing.js';
import type { Recovery } from './recovery.js';

export interface FakeBilling extends Billing {
  /** Adds credits to a customer, as a paid-for pack would. */
  grant: (customerRef: string, credits: number) => void;
  /** Takes credits back, as a refund or dispute would. */
  clawback: (customerRef: string, credits: number) => void;
  /** Retires a customerRef, as a recovery does: every later call for it answers CUSTOMER_REVOKED. */
  revoke: (customerRef: string) => void;
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

// Billing's rule for a CHECKOUT charge: both URLs, each an http(s) URL (ChargeService, and the spec's pattern).
const hasUrls = (urls: Partial<CheckoutUrls>): boolean =>
  [urls.successUrl, urls.cancelUrl].every((url) => url !== undefined && /^https?:\/\/.+/.test(url));

const refuse = (status: number, code: string): BillingProblem => new BillingProblem({ status, code });

export const createFakeBilling = (options: { now: () => number }): FakeBilling => {
  const balances = new Map<string, number>();
  const rows = new Map<string, Row>();
  const revoked = new Set<string>();
  // The row a key currently stands for: a HELD or COMMITTED one. A released or expired row leaves it free for a new hold.
  const byKey = new Map<string, Row>();

  const balanceOf = (customerRef: string): number => balances.get(customerRef) ?? 0;
  // Billing refuses a revoked customerRef on every call that names one (R6).
  const live = (customerRef: string): string => {
    if (revoked.has(customerRef)) throw refuse(410, 'CUSTOMER_REVOKED');
    return customerRef;
  };
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
    revoke: (customerRef) => {
      revoked.add(customerRef);
    },
    upsertCustomer: (customerRef) =>
      settled(() => {
        live(customerRef);
      }),
    checkout: (customerRef, priceRef, urls) =>
      settled(() => {
        live(customerRef);
        if (!hasUrls(urls)) throw refuse(400, 'VALIDATION_ERROR');
        const credits = PACKS.get(priceRef);
        if (credits === undefined) throw refuse(404, 'PRICE_NOT_FOUND');
        balances.set(customerRef, balanceOf(customerRef) + credits);
        return { checkoutUrl: `https://checkout.example/fake/${priceRef}` };
      }),
    balance: (customerRef) =>
      settled(() => {
        expireStale();
        return balance(live(customerRef));
      }),
    reserve: ({ customerRef, credits, ttlSeconds, idempotencyKey }) =>
      settled(() => {
        live(customerRef);
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

// What billing keeps of a recovery link, and the mail sink the tests read it from.
export interface MailedLink {
  email: string;
  /** The link token, as it would sit in the fragment of the emailed URL. */
  token: string;
}

export interface FakeRecovery extends Recovery {
  /** Records the email Checkout collected for a customer, as billing does on the first completed Checkout. */
  bind: (customerRef: string, email: string) => void;
  /** Every link billing would have emailed, oldest first. */
  outbox: MailedLink[];
}

const LINK_TTL_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;
const REQUESTS_PER_EMAIL_PER_HOUR = 3;

interface Link {
  email: string;
  expiresAt: number;
  used: boolean;
  voided: boolean;
}

/** Spec 1 §2.1 in memory: one recovery email per customer, 15-minute single-use links (a newer one voids the older), 3 requests per email per hour. */
export const createFakeRecovery = (options: { billing: FakeBilling; now: () => number }): FakeRecovery => {
  const { billing, now } = options;
  const emails = new Map<string, string>();
  const links = new Map<string, Link>();
  const asked = new Map<string, number[]>();
  const outbox: MailedLink[] = [];

  return {
    outbox,
    bind: (customerRef, email) => {
      emails.set(customerRef, email.toLowerCase());
    },
    request: (email) =>
      settled(() => {
        const key = email.toLowerCase();
        const recent = (asked.get(key) ?? []).filter((at) => at > now() - HOUR_MS);
        const [oldest] = recent;
        if (oldest !== undefined && recent.length >= REQUESTS_PER_EMAIL_PER_HOUR) {
          throw new BillingProblem({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: Math.ceil((oldest + HOUR_MS - now()) / 1000) });
        }
        asked.set(key, [...recent, now()]);
        if (![...emails.values()].includes(key)) return;
        for (const link of links.values()) if (link.email === key) link.voided = true;
        const token = randomBytes(32).toString('base64url');
        links.set(token, { email: key, expiresAt: now() + LINK_TTL_MS, used: false, voided: false });
        outbox.push({ email: key, token });
      }),
    redeem: async ({ recoveryToken, newCustomerRef }) => {
      const link = links.get(recoveryToken);
      if (link === undefined || link.used || link.voided || link.expiresAt <= now()) throw refuse(410, 'RECOVERY_LINK_INVALID');
      link.used = true;
      const holders = [...emails].filter(([, email]) => email === link.email).map(([customerRef]) => customerRef);
      let credits = 0;
      for (const customerRef of holders) {
        const { creditsRemaining } = await billing.balance(customerRef);
        credits += creditsRemaining;
        billing.clawback(customerRef, creditsRemaining);
        billing.revoke(customerRef);
        emails.delete(customerRef);
      }
      billing.grant(newCustomerRef, credits);
      emails.set(newCustomerRef, link.email);
      return { customerRef: newCustomerRef, creditsRemaining: credits };
    },
  };
};
