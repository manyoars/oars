// The billing client against a fake billing API: what it asks, what it keys a customer by, and how it reads each answer.
import { describe, expect, it } from 'vitest';
import { billingOf, BillingError, customerRefOf, lotOf, modeOf, type Billing, type BillingEnv } from './billing.js';
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

  it('is test mode unless the deploy says live exactly', () => {
    expect(modeOf({})).toBe('test');
    expect(modeOf({ BILLING_MODE: 'LIVE' })).toBe('test');
    expect(modeOf({ BILLING_MODE: 'live' })).toBe('live');
  });

  it('sends the SDK key on every call and the configured mode on the ones a mode applies to', async () => {
    const fake = fakeBilling();
    fake.addListing('price-a', 'lot-a');
    const billing = clientOf(fake, { BILLING_MODE: 'live', BILLING_URL: `${FAKE_BILLING_URL}/` });
    await billing.listings();
    await billing.createCustomer('ref');
    await billing.balance('ref');
    await billing.issueOffer('ref', 'lot-a');
    await billing.consume('ref', 'fetch-1');
    expect(fake.calls.map((call) => call.authorization)).toEqual(Array(5).fill(`Bearer ${FAKE_SDK_KEY}`));
    expect(fake.calls.slice(1).map((call) => call.body ?? call.path)).toEqual([
      { customerRef: 'ref', mode: 'live' },
      '/api/v1/billing/credits/ref?mode=live',
      { customerRef: 'ref', lot: 'lot-a', mode: 'live' },
      { customerRef: 'ref', credits: 1, mode: 'live' },
    ]);
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

describe('credits and customers', () => {
  it('reads a balance, and an unknown customer as undefined', async () => {
    const fake = fakeBilling();
    fake.credit('ref', 3);
    const billing = clientOf(fake);
    expect(await billing.balance('ref')).toBe(3);
    expect(await billing.balance('nobody')).toBeUndefined();
  });

  it('refuses a balance that is not a whole number of credits, and any other status', async () => {
    for (const body of [{ balance: 'many' }, { balance: -1 }, { balance: 1.5 }, {}]) {
      const odd = billingOf(configured(), () => Promise.resolve(new Response(JSON.stringify(body))));
      if ('missing' in odd) throw new Error('unconfigured');
      await expect(odd.balance('ref')).rejects.toThrow('with no balance');
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
    const bare = billingOf(configured(), () => Promise.resolve(new Response('{}')));
    if ('missing' in bare) throw new Error('unconfigured');
    await expect(bare.issueOffer('ref', 'lot-a')).rejects.toThrow('no offer id');
    fake.failNext(503);
    await expect(billing.issueOffer('ref', 'lot-a')).rejects.toThrow('with 503');
  });
});

describe('consume', () => {
  it('takes one credit under the fetch id, and a replay of the same key takes none', async () => {
    const fake = fakeBilling();
    fake.credit('ref', 2);
    const billing = clientOf(fake);
    expect(await billing.consume('ref', 'fetch-1')).toBe('consumed');
    expect(await billing.consume('ref', 'fetch-1')).toBe('consumed');
    expect(fake.balanceOf('ref')).toBe(1);
    expect(fake.taken.get('ref')).toEqual(['fetch-1']);
    expect(fake.calls.map((call) => call.idempotencyKey)).toEqual(['fetch-1', 'fetch-1']);
  });

  it('answers insufficient on a short balance and takes nothing', async () => {
    const fake = fakeBilling();
    fake.credit('ref', 0);
    expect(await clientOf(fake).consume('ref', 'fetch-1')).toBe('insufficient');
    expect(fake.balanceOf('ref')).toBe(0);
    expect(fake.taken.size).toBe(0);
  });

  it('does not read another 409 as a short balance, nor a lost answer as a refusal', async () => {
    const other = billingOf(configured(), () => Promise.resolve(new Response(JSON.stringify({ code: 'IDEMPOTENCY_CONFLICT' }), { status: 409 })));
    if ('missing' in other) throw new Error('unconfigured');
    await expect(other.consume('ref', 'fetch-1')).rejects.toThrow('with 409');
    const fake = fakeBilling();
    fake.credit('ref', 1);
    fake.loseNextConsumeAnswer();
    const billing = clientOf(fake);
    await expect(billing.consume('ref', 'fetch-1')).rejects.toThrow('with 503');
    // The credit was taken; the retry under the same key finds it and takes no second one.
    expect(await billing.consume('ref', 'fetch-1')).toBe('consumed');
    expect(fake.balanceOf('ref')).toBe(0);
  });

  it('says a network failure without the key', async () => {
    const down = billingOf(configured(), () => Promise.reject(new Error(`connect failed with ${FAKE_SDK_KEY}`)));
    if ('missing' in down) throw new Error('unconfigured');
    const error = await down.consume('ref', 'fetch-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BillingError);
    expect(String(error)).not.toContain(FAKE_SDK_KEY);
  });
});
