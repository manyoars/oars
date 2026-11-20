// A fake of the billing API the pool sells through (`billing.ts`), for the tests: listings with lots, customers with balances, offers, and an idempotent consume. It answers the shapes the client expects and records every call, so a test can say what the pool asked and what it took.
// The shapes are the platform's as built (census t1484): the SDK key in `X-Agent-SDK-Key`, a balance as `{customerRef, creditsRemaining, creditsHeld, creditsAvailable, livemode}` (200 with zeros for a customer it does not know), a customer as `{customerRef, countryCode, regionCode}` with 400 `CUSTOMER_REGION_NOT_SUPPORTED` unless the country is `US` and the region a two-letter state, an offer as `{offerId, expiresAt}`, a consume as `{customerRef, creditsConsumed, creditsRemaining, livemode}` with 409 `INSUFFICIENT_CREDITS` for a short balance and for an unknown customer, 409 `IDEMPOTENCY_CONFLICT` for a key reused with another body, and 410 `CUSTOMER_REVOKED`.
// It is not billing: it knows no price and no purchase, and its one mode is the workload's, flipped by `setMode`; no call names one. It does not check that an idempotency key is a UUID.

export const FAKE_BILLING_URL = 'https://billing.test/api/v1';
export const FAKE_SDK_KEY = 'aorsk_test_fake';
export const FAKE_WORKLOAD = 'workload-1';

export interface FakeCall {
  method: string;
  path: string;
  /** The `X-Agent-SDK-Key` header. */
  sdkKey: string | null;
  idempotencyKey: string | null;
  body: unknown;
}

export interface FakeListing {
  priceRef: string;
  lot: string;
  active: boolean;
}

export interface FakeBilling {
  calls: FakeCall[];
  customers: Set<string>;
  offers: { offerId: string; customerRef: string; lot: string }[];
  /** What each consume took, by customer, so a replay shows as one entry. */
  taken: Map<string, string[]>;
  addListing: (priceRef: string, lot: string, active?: boolean) => void;
  /** Credits a customer as a settled purchase would (creating it). */
  credit: (customerRef: string, credits: number) => void;
  /** The credits the customer holds in the workload's current mode, or undefined when it has never been credited or created. */
  balanceOf: (customerRef: string) => number | undefined;
  /** Flips the workload's mode, as its owner does; credits are kept per mode, so a test credit never funds a live consume. */
  setMode: (mode: 'test' | 'live') => void;
  /** From now on every call naming this customer answers 410 `CUSTOMER_REVOKED`. */
  revoke: (customerRef: string) => void;
  /** From now on a customer created in this state answers 400 `CUSTOMER_REGION_NOT_SUPPORTED`, as when the platform's region policy does not take it. */
  refuseRegion: (regionCode: string) => void;
  /** From now on (until called with false) a customer call answers 409 `WORKLOAD_NOT_ACTIVE`, as when the seller workload is switched off. */
  deactivateWorkload: (inactive?: boolean) => void;
  /** The next consume takes its credit and then answers 503, as when the response is lost on the way back. */
  loseNextConsumeAnswer: () => void;
  /** The next call of any kind answers this status and nothing else. */
  failNext: (status: number) => void;
  /** How many listings a page holds, to test paging; 100 as the client asks when unset. */
  pageSize: (size: number) => void;
  /** Answers one call the way the gateway would. */
  answer: (method: string, url: URL, headers: { get: (name: string) => string | null }, body: string) => { status: number; body: object };
}

export const fakeBilling = (): FakeBilling => {
  const calls: FakeCall[] = [];
  const customers = new Set<string>();
  const balances = new Map<string, number>();
  const revoked = new Set<string>();
  const refusedRegions = new Set<string>();
  let inactive = false;
  let mode: 'test' | 'live' = 'test';
  const held = (customerRef: string): string => `${mode}:${customerRef}`;
  const offers: FakeBilling['offers'] = [];
  const taken = new Map<string, string[]>();
  /** Each consume by Idempotency-Key alone, with the body it came with and the numbers it answered: the same body replays them, another body is a conflict. */
  const keys = new Map<string, { customerRef: string; credits: number; remaining: number; livemode: boolean }>();
  const listings: FakeListing[] = [];
  let lose = false;
  let failing: number | undefined;
  let size: number | undefined;

  const parsed = (body: string): unknown => (body === '' ? undefined : JSON.parse(body));
  const field = (value: unknown, name: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined);

  return {
    calls,
    customers,
    offers,
    taken,
    addListing: (priceRef, lot, active = true) => {
      listings.push({ priceRef, lot, active });
    },
    credit: (customerRef, credits) => {
      customers.add(customerRef);
      balances.set(held(customerRef), (balances.get(held(customerRef)) ?? 0) + credits);
    },
    balanceOf: (customerRef) => balances.get(held(customerRef)),
    setMode: (next) => {
      mode = next;
    },
    revoke: (customerRef) => {
      revoked.add(customerRef);
    },
    refuseRegion: (regionCode) => {
      refusedRegions.add(regionCode);
    },
    deactivateWorkload: (next = true) => {
      inactive = next;
    },
    loseNextConsumeAnswer: () => {
      lose = true;
    },
    failNext: (status) => {
      failing = status;
    },
    pageSize: (next) => {
      size = next;
    },
    answer: (method, url, headers, text) => {
      const body = parsed(text);
      calls.push({ method, path: `${url.pathname}${url.search}`, sdkKey: headers.get('x-agent-sdk-key'), idempotencyKey: headers.get('idempotency-key'), body });
      if (failing !== undefined) {
        const status = failing;
        failing = undefined;
        return { status, body: { error: 'scripted' } };
      }
      if (headers.get('x-agent-sdk-key') !== FAKE_SDK_KEY) return { status: 401, body: { code: 'SDK_KEY_INVALID' } };
      const path = url.pathname.replace('/api/v1', '');
      if (method === 'GET' && path === `/billing/agents/${FAKE_WORKLOAD}/datasets`) {
        const per = size ?? Number(url.searchParams.get('size'));
        const page = Number(url.searchParams.get('page'));
        const content = listings.slice(page * per, (page + 1) * per);
        return { status: 200, body: { content, last: (page + 1) * per >= listings.length } };
      }
      const livemode = mode === 'live';
      const gone = { status: 410, body: { code: 'CUSTOMER_REVOKED' } };
      const ref = /^\/billing\/credits\/([^/]+)$/.exec(path)?.[1];
      if (method === 'GET' && ref !== undefined && ref !== 'consume') {
        const customerRef = decodeURIComponent(ref);
        if (revoked.has(customerRef)) return gone;
        // An unknown customer is zeros, never 404.
        const creditsRemaining = balances.get(held(customerRef)) ?? 0;
        return { status: 200, body: { customerRef, creditsRemaining, creditsHeld: 0, creditsAvailable: creditsRemaining, livemode } };
      }
      if (method === 'POST' && path === '/billing/customers') {
        const customerRef = String(field(body, 'customerRef'));
        if (inactive) return { status: 409, body: { code: 'WORKLOAD_NOT_ACTIVE' } };
        // The platform's region rule: US only, and a US customer names its state. The old body, `{customerRef}` alone, fails here.
        const regionCode = field(body, 'regionCode');
        if (field(body, 'countryCode') !== 'US' || typeof regionCode !== 'string' || !/^[A-Z]{2}$/.test(regionCode) || refusedRegions.has(regionCode)) return { status: 400, body: { code: 'CUSTOMER_REGION_NOT_SUPPORTED' } };
        const known = customers.has(customerRef);
        customers.add(customerRef);
        // The platform upserts: 201 for a new customer, 200 for one updated.
        return { status: known ? 200 : 201, body: { customerRef } };
      }
      if (method === 'POST' && path === '/billing/offers') {
        const customerRef = String(field(body, 'customerRef'));
        const lot = String(field(body, 'lot'));
        if (revoked.has(customerRef)) return gone;
        if (!customers.has(customerRef)) return { status: 404, body: { error: 'CUSTOMER_NOT_FOUND' } };
        // An open offer for the same customer and lot is reused, as billing does.
        const open = offers.find((offer) => offer.customerRef === customerRef && offer.lot === lot);
        const offer = open ?? { offerId: `offer-${String(offers.length + 1)}`, customerRef, lot };
        if (open === undefined) offers.push(offer);
        return { status: 200, body: { offerId: offer.offerId, expiresAt: '2030-01-01T00:00:00Z' } };
      }
      if (method === 'POST' && path === '/billing/credits/consume') {
        const customerRef = String(field(body, 'customerRef'));
        const key = headers.get('idempotency-key') ?? '';
        if (revoked.has(customerRef)) return gone;
        const credits = Number(field(body, 'credits'));
        const same = keys.get(key);
        if (same !== undefined) {
          // The original's numbers, mode included, not the present ones.
          return same.customerRef === customerRef && same.credits === credits ? { status: 200, body: { customerRef, creditsConsumed: credits, creditsRemaining: same.remaining, livemode: same.livemode } } : { status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } };
        }
        const balance = balances.get(held(customerRef)) ?? 0;
        // A short balance and an unknown customer are the same 409, with where to buy.
        if (balance < 1) return { status: 409, body: { code: 'INSUFFICIENT_CREDITS', actionUrl: 'https://billing.test/buy', offer: null } };
        balances.set(held(customerRef), balance - 1);
        keys.set(key, { customerRef, credits, remaining: balance - 1, livemode });
        taken.set(customerRef, [...(taken.get(customerRef) ?? []), key]);
        if (lose) {
          lose = false;
          return { status: 503, body: { error: 'lost' } };
        }
        return { status: 200, body: { customerRef, creditsConsumed: 1, creditsRemaining: balance - 1, livemode } };
      }
      return { status: 404, body: { error: 'NO_FAKE_FOR_THIS' } };
    },
  };
};

/** The fake as the client's `fetch`, for a unit test with no Worker. */
export const fetcherOf = (fake: FakeBilling): ((url: string, init: { method: string; headers: { [name: string]: string }; body?: string }) => Promise<Response>) => (url, init) => {
  const headers = new Headers(init.headers);
  const { status, body } = fake.answer(init.method, new URL(url), headers, init.body ?? '');
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
};
