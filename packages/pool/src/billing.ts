// The pool's client of the TradeAOR billing API, for paid pack fetches (K2 spec section 2). The pool is one seller workload, so every call carries that workload's `aorsk_` SDK key; a buyer is a billing customer named by an opaque `customerRef`, one per (account, lot), and a credit is the right to fetch one pack of that lot.
// The shapes below are the ones the platform's billing service answers through the gateway (`/api/v1/billing/...`, census t1484); `test-billing.ts` is the fake the tests run them against. No call carries a billing mode: the workload's stored mode decides it server side, and each answer says which one it was (`livemode`).
import { createHmac } from 'node:crypto';
import { bodyOf, bound, fieldOf, textField, type Env } from './http.js';

/** The bindings the client reads. */
export type BillingEnv = Pick<Env, 'BILLING_URL' | 'BILLING_SDK_KEY' | 'BILLING_WORKLOAD_ID'>;

/** A priceRef of a listing the pool sells, and the billing lot it belongs to. */
export interface Listing {
  priceRef: string;
  lot: string;
}

/** What a call to a gateway can do besides answer: the gateway is down, refuses the key, or answers a shape this client does not know. The message never carries the key. */
export class BillingError extends Error {}

/** Billing answered 410 `CUSTOMER_REVOKED`: it has refused this buyer for good, so a retry changes nothing. */
export class BuyerRefused extends Error {}

/** Billing answered 409 `IDEMPOTENCY_CONFLICT`: the fetch id was already used for a different request. A retry sends the same request and gets the same answer. */
export class IdempotencyConflict extends Error {}

/** A customer's credits as billing reports them. */
export interface Balance {
  /** Credits the customer can spend now (`creditsAvailable`: what is left less what an open purchase holds). */
  available: number;
  /** Whether the credits are live ones; the mode is the workload's, not a choice of this client. */
  livemode: boolean;
  /** False when billing answered all zeros: it has no customer of this name yet, or one that has spent everything, which it cannot tell apart. */
  known: boolean;
}

/** `fetch` as the client takes it, so a unit test hands it a fake and the Worker its own. */
export type Fetcher = (url: string, init: { method: string; headers: { [name: string]: string }; body?: string }) => Promise<Response>;

export interface Billing {
  /** Every listing of the seller workload that is on sale, one call per page of 100. */
  listings: () => Promise<Listing[]>;
  /** The customer's credits. Billing answers 200 with zeros for a customer it does not know, so that is `known: false`, never a missing customer. */
  balance: (customerRef: string) => Promise<Balance>;
  createCustomer: (customerRef: string) => Promise<void>;
  /** An offer for the lot's prices; answers its id. */
  issueOffer: (customerRef: string, lot: string) => Promise<string>;
  /** Takes one credit under `fetchId` as the idempotency key: `consumed` on the first call and on a replay of it, `insufficient` when the balance is short (nothing taken). */
  consume: (customerRef: string, fetchId: string) => Promise<'consumed' | 'insufficient'>;
}

/** The most listing pages the lookup reads: 100 listings a page, so a seller with more than this has outgrown a lookup per request. */
export const MAX_LISTING_PAGES = 10;

const PAGE_SIZE = 100;

/**
 * The customer the pool names for one account's credits in one lot: an HMAC of both under `PSEUDONYM_KEY`, so billing holds no account id, two lots of one account are two customers (a price bought for a cheap lot cannot fund a dearer lot's fetch), and nobody without the key can tell which customers are one account's.
 * The label keeps this key's use apart from the pool's other uses of it.
 */
export const customerRefOf = (pseudonymKey: string, account: string, lot: string): string => createHmac('sha256', pseudonymKey).update(`billing-customer\u0000${account}\u0000${lot}`).digest('hex');

/** The client for the configured gateway, or the name of the first binding a paid fetch lacks. */
export const billingOf = (env: BillingEnv, fetcher: Fetcher = fetch): Billing | { missing: string } => {
  const base = bound(env.BILLING_URL)?.replace(/\/+$/, '');
  const key = bound(env.BILLING_SDK_KEY);
  const workload = bound(env.BILLING_WORKLOAD_ID);
  if (base === undefined) return { missing: 'BILLING_URL' };
  if (key === undefined) return { missing: 'BILLING_SDK_KEY' };
  if (workload === undefined) return { missing: 'BILLING_WORKLOAD_ID' };
  const call = async (method: string, path: string, body?: object, headers: { [name: string]: string } = {}): Promise<Response> => {
    try {
      return await fetcher(`${base}${path}`, { method, headers: { 'x-agent-sdk-key': key, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch {
      throw new BillingError(`billing did not answer ${method} ${path}`);
    }
  };
  const unexpected = (method: string, path: string, response: Response): BillingError => new BillingError(`billing answered ${method} ${path} with ${String(response.status)}`);
  const refusedOr = (method: string, path: string, response: Response): BillingError | BuyerRefused => (response.status === 410 ? new BuyerRefused(`billing refused the buyer on ${method} ${path}`) : unexpected(method, path, response));
  return {
    listings: async () => {
      const found: Listing[] = [];
      for (let page = 0; page < MAX_LISTING_PAGES; page += 1) {
        const path = `/billing/agents/${encodeURIComponent(workload)}/datasets?page=${String(page)}&size=${String(PAGE_SIZE)}`;
        const response = await call('GET', path);
        if (!response.ok) throw unexpected('GET', path, response);
        const body = await bodyOf(response);
        const content = fieldOf(body, 'content');
        if (!Array.isArray(content)) throw new BillingError(`billing answered GET ${path} with no page`);
        for (const entry of content) {
          const priceRef = textField(entry, 'priceRef');
          const lot = textField(entry, 'lot');
          if (priceRef !== undefined && lot !== undefined && fieldOf(entry, 'active') === true) found.push({ priceRef, lot });
        }
        if (fieldOf(body, 'last') !== false) break;
      }
      return found;
    },
    balance: async (customerRef) => {
      const path = `/billing/credits/${encodeURIComponent(customerRef)}`;
      const response = await call('GET', path);
      if (!response.ok) throw refusedOr('GET', path, response);
      const body = await bodyOf(response);
      const [remaining, held, available] = ['creditsRemaining', 'creditsHeld', 'creditsAvailable'].map((name) => fieldOf(body, name));
      const livemode = fieldOf(body, 'livemode');
      if (![remaining, held, available].every((credits) => typeof credits === 'number' && Number.isSafeInteger(credits) && credits >= 0) || typeof available !== 'number' || typeof livemode !== 'boolean') throw new BillingError(`billing answered GET ${path} with no balance`);
      return { available, livemode, known: remaining !== 0 || held !== 0 || available !== 0 };
    },
    createCustomer: async (customerRef) => {
      const response = await call('POST', '/billing/customers', { customerRef });
      // A customer made a moment ago by another request is the customer wanted.
      if (!response.ok && response.status !== 409) throw unexpected('POST', '/billing/customers', response);
    },
    issueOffer: async (customerRef, lot) => {
      const response = await call('POST', '/billing/offers', { customerRef, lot });
      if (!response.ok) throw refusedOr('POST', '/billing/offers', response);
      const offerId = textField(await bodyOf(response), 'offerId');
      if (offerId === undefined) throw new BillingError('billing answered POST /billing/offers with no offer id');
      return offerId;
    },
    consume: async (customerRef, fetchId) => {
      const path = '/billing/credits/consume';
      const response = await call('POST', path, { customerRef, credits: 1 }, { 'idempotency-key': fetchId });
      if (response.ok) {
        const consumed = fieldOf(await bodyOf(response), 'creditsConsumed');
        if (typeof consumed !== 'number' || consumed < 1) throw new BillingError(`billing answered POST ${path} with no credit consumed`);
        return 'consumed';
      }
      if (response.status === 409) {
        const text = await response.text();
        // Only a short balance (billing says the same for a customer it does not know) is a refusal to hand over.
        if (text.includes('INSUFFICIENT_CREDITS')) return 'insufficient';
        if (text.includes('IDEMPOTENCY_CONFLICT')) throw new IdempotencyConflict(`billing already holds ${fetchId} for a different request`);
      }
      throw refusedOr('POST', path, response);
    },
  };
};

/** The lot a priceRef sells, with every priceRef of that lot (what an offer for it lists), or undefined: unknown, inactive, and another seller's all read the same. */
export const lotOf = async (billing: Billing, priceRef: string): Promise<{ lot: string; priceRefs: string[] } | undefined> => {
  const listings = await billing.listings();
  const lot = listings.find((listing) => listing.priceRef === priceRef)?.lot;
  return lot === undefined ? undefined : { lot, priceRefs: listings.filter((listing) => listing.lot === lot).map((listing) => listing.priceRef) };
};
