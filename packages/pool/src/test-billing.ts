// A fake of the billing API the pool sells through (`billing.ts`), for the tests: listings with lots, customers with balances, offers, and an idempotent consume. It answers the shapes the client expects and records every call, so a test can say what the pool asked and what it took.
// It is not billing: it knows no price, no purchase, and no mode but the one each call names.

export const FAKE_BILLING_URL = 'https://billing.test/api/v1';
export const FAKE_SDK_KEY = 'aorsk_test_fake';
export const FAKE_WORKLOAD = 'workload-1';

export interface FakeCall {
  method: string;
  path: string;
  authorization: string | null;
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
  balanceOf: (customerRef: string) => number | undefined;
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
  const offers: FakeBilling['offers'] = [];
  const taken = new Map<string, string[]>();
  const keys = new Map<string, true>();
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
      balances.set(customerRef, (balances.get(customerRef) ?? 0) + credits);
    },
    balanceOf: (customerRef) => balances.get(customerRef),
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
      calls.push({ method, path: `${url.pathname}${url.search}`, authorization: headers.get('authorization'), idempotencyKey: headers.get('idempotency-key'), body });
      if (failing !== undefined) {
        const status = failing;
        failing = undefined;
        return { status, body: { error: 'scripted' } };
      }
      if (headers.get('authorization') !== `Bearer ${FAKE_SDK_KEY}`) return { status: 401, body: { error: 'UNAUTHORIZED' } };
      const path = url.pathname.replace('/api/v1', '');
      if (method === 'GET' && path === `/billing/agents/${FAKE_WORKLOAD}/datasets`) {
        const per = size ?? Number(url.searchParams.get('size'));
        const page = Number(url.searchParams.get('page'));
        const content = listings.slice(page * per, (page + 1) * per);
        return { status: 200, body: { content, last: (page + 1) * per >= listings.length } };
      }
      const ref = /^\/billing\/credits\/([^/]+)$/.exec(path)?.[1];
      if (method === 'GET' && ref !== undefined) {
        const customerRef = decodeURIComponent(ref);
        return customers.has(customerRef) ? { status: 200, body: { balance: balances.get(customerRef) ?? 0 } } : { status: 404, body: { error: 'CUSTOMER_NOT_FOUND' } };
      }
      if (method === 'POST' && path === '/billing/customers') {
        const customerRef = String(field(body, 'customerRef'));
        const known = customers.has(customerRef);
        customers.add(customerRef);
        return known ? { status: 409, body: { error: 'CUSTOMER_EXISTS' } } : { status: 201, body: { customerRef } };
      }
      if (method === 'POST' && path === '/billing/offers') {
        const customerRef = String(field(body, 'customerRef'));
        const lot = String(field(body, 'lot'));
        if (!customers.has(customerRef)) return { status: 404, body: { error: 'CUSTOMER_NOT_FOUND' } };
        // An open offer for the same customer and lot is reused, as billing does.
        const held = offers.find((offer) => offer.customerRef === customerRef && offer.lot === lot);
        const offer = held ?? { offerId: `offer-${String(offers.length + 1)}`, customerRef, lot };
        if (held === undefined) offers.push(offer);
        return { status: 200, body: { offerId: offer.offerId } };
      }
      if (method === 'POST' && path === '/billing/credits/consume') {
        const customerRef = String(field(body, 'customerRef'));
        const key = headers.get('idempotency-key') ?? '';
        if (keys.has(`${customerRef}:${key}`)) return { status: 200, body: { replay: true } };
        const balance = balances.get(customerRef) ?? 0;
        if (balance < 1) return { status: 409, body: { code: 'INSUFFICIENT_CREDITS' } };
        balances.set(customerRef, balance - 1);
        keys.set(`${customerRef}:${key}`, true);
        taken.set(customerRef, [...(taken.get(customerRef) ?? []), key]);
        if (lose) {
          lose = false;
          return { status: 503, body: { error: 'lost' } };
        }
        return { status: 200, body: { balance: balance - 1 } };
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
