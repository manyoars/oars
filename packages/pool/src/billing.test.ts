// The billing client against a fake billing API: what it asks, what it keys a customer by, and how it reads each answer.
import { describe, expect, it } from 'vitest';
import { billingOf, BillingError, BuyerRefused, customerRefOf, IdempotencyConflict, lotOf, type Billing, type BillingEnv, type Fetcher } from './billing.js';
import { FAKE_BILLING_URL, FAKE_SDK_KEY, FAKE_WORKLOAD, fakeBilling, fetcherOf, type FakeBilling } from './test-billing.js';

const configured = (extra: { [name: string]: string } = {}): BillingEnv => ({ BILLING_URL: FAKE_BILLING_URL, BILLING_SDK_KEY: FAKE_SDK_KEY, BILLING_WORKLOAD_ID: FAKE_WORKLOAD, ...extra });

const clientOf = (fake: FakeBilling, extra: { [name: string]: string } = {}): Billing => {
  const made = billingOf(configured(extra), fetcherOf(fake));
  if ('missing' in made) throw new Error(`unconfigured: ${made.missing}`);
  return made;
};

describe('customerRefOf', () => {
  it('gives two lots of one account two different customers, and one lot of one account the same one every time', () => {
    const a = customerRefOf('key', 'account-1', 'lot-a');
    const b = customerRefOf('key', 'account-1', 'lot-b');
    expect(a).not.toBe(b);
    expect(customerRefOf('key', 'account-1', 'lot-a')).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs by account and by key, and holds neither the account nor the lot', () => {
    const ref = customerRefOf('key', 'account-1', 'lot-a');
    expect(customerRefOf('key', 'account-2', 'lot-a')).not.toBe(ref);
    expect(customerRefOf('another key', 'account-1', 'lot-a')).not.toBe(ref);
    expect(ref).not.toContain('account-1');
    expect(ref).not.toContain('lot-a');
  });

  it('does not run the two ids together: (a, bc) and (ab, c) are two customers', () => {
    expect(customerRefOf('key', 'a', 'bc')).not.toBe(customerRefOf('key', 'ab', 'c'));
  });
});

describe('billingOf', () => {
  it('names the first binding that is missing', () => {
    expect(billingOf({})).toEqual({ missing: 'BILLING_URL' });
    expect(billingOf({ BILLING_URL: FAKE_BILLING_URL })).toEqual({ missing: 'BILLING_SDK_KEY' });
    expect(billingOf({ BILLING_URL: FAKE_BILLING_URL, BILLING_SDK_KEY: FAKE_SDK_KEY, BILLING_WORKLOAD_ID: '' })).toEqual({ missing: 'BILLING_WORKLOAD_ID' });
  });

  it('sends the SDK key in X-Agent-SDK-Key on every call, and no mode on any', async () => {
    const fake = fakeBilling();
    fake.addListing('price-a', 'lot-a');
    fake.setMode('live');
    const billing = clientOf(fake, { BILLING_URL: `${FAKE_BILLING_URL}/` });
    await billing.listings();
    await billing.createCustomer('ref');
    await billing.balance('ref');
    await billing.issueOffer('ref', 'lot-a');
    await billing.consume('ref', 'fetch-1');
    expect(fake.calls.map((call) => call.sdkKey)).toEqual(Array(5).fill(FAKE_SDK_KEY));
    expect(fake.calls.slice(1).map((call) => call.body ?? call.path)).toEqual([
      { customerRef: 'ref' },
      '/api/v1/billing/credits/ref',
      { customerRef: 'ref', lot: 'lot-a' },
      { customerRef: 'ref', credits: 1 },
    ]);
    expect(JSON.stringify(fake.calls)).not.toContain('mode');
  });
});

describe('listings and lotOf', () => {
  it('reads every page and leaves out an inactive listing', async () => {
    const fake = fakeBilling();
    fake.pageSize(2);
    fake.addListing('price-a', 'lot-a');
    fake.addListing('price-b', 'lot-a');
    fake.addListing('price-c', 'lot-b');
    fake.addListing('price-off', 'lot-b', false);
    expect(await clientOf(fake).listings()).toEqual([
      { priceRef: 'price-a', lot: 'lot-a' },
      { priceRef: 'price-b', lot: 'lot-a' },
      { priceRef: 'price-c', lot: 'lot-b' },
    ]);
    expect(fake.calls.map((call) => call.path)).toEqual([`/api/v1/billing/agents/${FAKE_WORKLOAD}/datasets?page=0&size=100`, `/api/v1/billing/agents/${FAKE_WORKLOAD}/datasets?page=1&size=100`]);
  });

  it('answers the lot of a price with every price of that lot, and nothing for an unknown or inactive one', async () => {
    const fake = fakeBilling();
    fake.addListing('price-a', 'lot-a');
    fake.addListing('price-b', 'lot-a');
    fake.addListing('price-c', 'lot-b');
    fake.addListing('price-off', 'lot-a', false);
    const billing = clientOf(fake);
    expect(await lotOf(billing, 'price-b')).toEqual({ lot: 'lot-a', priceRefs: ['price-a', 'price-b'] });
    expect(await lotOf(billing, 'price-c')).toEqual({ lot: 'lot-b', priceRefs: ['price-c'] });
    expect(await lotOf(billing, 'price-off')).toBeUndefined();
    expect(await lotOf(billing, 'nope')).toBeUndefined();
  });

  it('stops at the page cap rather than read a seller without end', async () => {
    const calls: string[] = [];
    const endless = billingOf(configured(), (url) => {
      calls.push(url);
      return Promise.resolve(new Response(JSON.stringify({ content: [], last: false })));
    });
    if ('missing' in endless) throw new Error('unconfigured');
    expect(await endless.listings()).toEqual([]);
    expect(calls).toHaveLength(10);
  });

  it('refuses a page that is not one, and a refused key', async () => {
    const fake = fakeBilling();
    const noPage = billingOf(configured(), () => Promise.resolve(new Response(JSON.stringify({ oops: true }))));
    if ('missing' in noPage) throw new Error('unconfigured');
    await expect(noPage.listings()).rejects.toThrow('with no page');
    const wrongKey = billingOf(configured({ BILLING_SDK_KEY: 'aorsk_wrong' }), fetcherOf(fake));
    if ('missing' in wrongKey) throw new Error('unconfigured');
    await expect(wrongKey.listings()).rejects.toThrow(BillingError);
  });
});

/** A client whose gateway answers every call with this status and body. */
const answering = (status: number, body: object): Billing => {
  const made = billingOf(configured(), () => Promise.resolve(new Response(JSON.stringify(body), { status })));
  if ('missing' in made) throw new Error('unconfigured');
  return made;
};

const balanceBody = (extra: object = {}): object => ({ customerRef: 'ref', creditsRemaining: 3, creditsHeld: 1, creditsAvailable: 2, livemode: false, ...extra });

describe('credits and customers', () => {
  it('reads creditsAvailable and the mode billing reports, for a customer billing knows', async () => {
    const fake = fakeBilling();
    fake.credit('ref', 3);
    const billing = clientOf(fake);
    expect(await billing.balance('ref')).toEqual({ available: 3, livemode: false, known: true });
    fake.setMode('live');
    fake.credit('ref', 5);
    expect(await billing.balance('ref')).toEqual({ available: 5, livemode: true, known: true });
  });

  it('takes the held credits out: available is creditsAvailable, not creditsRemaining', async () => {
    expect(await answering(200, balanceBody()).balance('ref')).toEqual({ available: 2, livemode: false, known: true });
  });

  it('reads 200 with all zeros as no customer yet, with the mode, and never as a 404', async () => {
    const fake = fakeBilling();
    expect(await clientOf(fake).balance('nobody')).toEqual({ available: 0, livemode: false, known: false });
    fake.setMode('live');
    expect(await clientOf(fake).balance('nobody')).toEqual({ available: 0, livemode: true, known: false });
  });

  it('reads a customer whose credits are all held as known', async () => {
    expect(await answering(200, balanceBody({ creditsRemaining: 1, creditsHeld: 1, creditsAvailable: 0 })).balance('ref')).toEqual({ available: 0, livemode: false, known: true });
  });

  it('reads a 404 as an error, since billing answers an unknown customer with zeros', async () => {
    await expect(answering(404, { code: 'CUSTOMER_NOT_FOUND' }).balance('ref')).rejects.toThrow('with 404');
  });

  it('refuses a revoked buyer on a balance (410) as BuyerRefused, which is no BillingError', async () => {
    const fake = fakeBilling();
    fake.credit('ref', 1);
    fake.revoke('ref');
    const refused = clientOf(fake).balance('ref');
    await expect(refused).rejects.toThrow(BuyerRefused);
    await expect(refused).rejects.not.toBeInstanceOf(BillingError);
  });

  it('refuses a balance that is not whole credits and a mode that is not a boolean, and any other status', async () => {
    for (const odd of [{ creditsAvailable: 'many' }, { creditsAvailable: -1 }, { creditsAvailable: 1.5 }, { creditsRemaining: -1 }, { creditsHeld: 'x' }, { livemode: 'false' }, { balance: 3 }]) {
      const bad = answering(200, odd.balance === undefined ? balanceBody(odd) : odd);
      await expect(bad.balance('ref')).rejects.toThrow('with no balance');
    }
    const fake = fakeBilling();
    fake.failNext(500);
    await expect(clientOf(fake).balance('ref')).rejects.toThrow('with 500');
  });

  it('creates a customer once, and takes a customer that already exists as the customer wanted', async () => {
    const fake = fakeBilling();
    const billing = clientOf(fake);
    await billing.createCustomer('ref');
    await billing.createCustomer('ref');
    expect([...fake.customers]).toEqual(['ref']);
    fake.failNext(500);
    await expect(billing.createCustomer('other')).rejects.toThrow('with 500');
  });

  it('issues an offer for the lot, the same one again while it is open, and refuses a reply without an id', async () => {
    const fake = fakeBilling();
    fake.credit('ref', 0);
    const billing = clientOf(fake);
    expect(await billing.issueOffer('ref', 'lot-a')).toBe('offer-1');
    expect(await billing.issueOffer('ref', 'lot-a')).toBe('offer-1');
    expect(await billing.issueOffer('ref', 'lot-b')).toBe('offer-2');
    expect(fake.offers.map((offer) => offer.lot)).toEqual(['lot-a', 'lot-b']);
    await expect(answering(200, { expiresAt: 'soon' }).issueOffer('ref', 'lot-a')).rejects.toThrow('no offer id');
    fake.failNext(503);
    await expect(billing.issueOffer('ref', 'lot-a')).rejects.toThrow('with 503');
  });

  it('refuses a revoked buyer on an offer (410) as BuyerRefused, and an unknown customer (404) as an error', async () => {
    const fake = fakeBilling();
    fake.credit('ref', 0);
    fake.revoke('ref');
    await expect(clientOf(fake).issueOffer('ref', 'lot-a')).rejects.toThrow(BuyerRefused);
    await expect(clientOf(fakeBilling()).issueOffer('nobody', 'lot-a')).rejects.toThrow('with 404');
  });
});

describe('consume', () => {
  it('takes one credit under the fetch id, and a replay of the same key and body takes none and gets the original numbers back', async () => {
    const fake = fakeBilling();
    fake.credit('ref', 2);
    const answers: string[] = [];
    const spy: Fetcher = async (url, init) => {
      const response = await fetcherOf(fake)(url, init);
      answers.push(await response.clone().text());
      return response;
    };
    const made = billingOf(configured(), spy);
    if ('missing' in made) throw new Error('unconfigured');
    expect(await made.consume('ref', 'fetch-1')).toBe('consumed');
    // The replay answers the first call's numbers, mode included, not the present ones.
    fake.setMode('live');
    expect(await made.consume('ref', 'fetch-1')).toBe('consumed');
    fake.setMode('test');
    expect(answers).toHaveLength(2);
    expect(answers[1]).toBe(answers[0]);
    expect(JSON.parse(answers[0] ?? '')).toEqual({ customerRef: 'ref', creditsConsumed: 1, creditsRemaining: 1, livemode: false });
    expect(fake.balanceOf('ref')).toBe(1);
    expect(fake.taken.get('ref')).toEqual(['fetch-1']);
    expect(fake.calls.map((call) => call.idempotencyKey)).toEqual(['fetch-1', 'fetch-1']);
  });

  it('answers insufficient on a short balance and on a customer billing does not know, and takes nothing', async () => {
    const fake = fakeBilling();
    fake.credit('ref', 0);
    expect(await clientOf(fake).consume('ref', 'fetch-1')).toBe('insufficient');
    expect(await clientOf(fake).consume('nobody', 'fetch-2')).toBe('insufficient');
    expect(fake.balanceOf('ref')).toBe(0);
    expect(fake.taken.size).toBe(0);
  });

  it('treats a key reused for another request (409 IDEMPOTENCY_CONFLICT) as a hard error, not a short balance and not a retry', async () => {
    const fake = fakeBilling();
    fake.credit('ref', 2);
    fake.credit('other', 2);
    const billing = clientOf(fake);
    expect(await billing.consume('ref', 'fetch-1')).toBe('consumed');
    const conflict = billing.consume('other', 'fetch-1');
    await expect(conflict).rejects.toThrow(IdempotencyConflict);
    await expect(conflict).rejects.not.toBeInstanceOf(BillingError);
    expect({ ref: fake.balanceOf('ref'), other: fake.balanceOf('other') }).toEqual({ ref: 1, other: 2 });
  });

  it('does not read another 409 as a short balance, nor a lost answer as a refusal', async () => {
    await expect(answering(409, { code: 'SOMETHING_ELSE' }).consume('ref', 'fetch-1')).rejects.toThrow('with 409');
    const fake = fakeBilling();
    fake.credit('ref', 1);
    fake.loseNextConsumeAnswer();
    const billing = clientOf(fake);
    await expect(billing.consume('ref', 'fetch-1')).rejects.toThrow('with 503');
    // The credit was taken; the retry under the same key finds it and takes no second one.
    expect(await billing.consume('ref', 'fetch-1')).toBe('consumed');
    expect(fake.balanceOf('ref')).toBe(0);
  });

  it('refuses a revoked buyer on a consume (410) as BuyerRefused, taking nothing', async () => {
    const fake = fakeBilling();
    fake.credit('ref', 1);
    fake.revoke('ref');
    const refused = clientOf(fake).consume('ref', 'fetch-1');
    await expect(refused).rejects.toThrow(BuyerRefused);
    await expect(refused).rejects.not.toBeInstanceOf(BillingError);
    expect(fake.balanceOf('ref')).toBe(1);
  });

  it('refuses a 200 that says no credit was consumed', async () => {
    await expect(answering(200, { customerRef: 'ref', creditsConsumed: 0 }).consume('ref', 'fetch-1')).rejects.toThrow('no credit consumed');
    await expect(answering(200, {}).consume('ref', 'fetch-1')).rejects.toThrow('no credit consumed');
  });

  it('says a network failure without the key', async () => {
    const down = billingOf(configured(), () => Promise.reject(new Error(`connect failed with ${FAKE_SDK_KEY}`)));
    if ('missing' in down) throw new Error('unconfigured');
    const error = await down.consume('ref', 'fetch-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BillingError);
    expect(String(error)).not.toContain(FAKE_SDK_KEY);
  });
});
