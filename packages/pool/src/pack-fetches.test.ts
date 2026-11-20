// Paid pack fetches against the fake billing API, under Miniflare's workerd: the buyer's start route here, and the operator and download routes in the sections below as they land.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerRefOf } from './billing.js';
import { buyerKeyIdOf } from './pack-fetches.js';
import { anyNumber, anyText, fieldOf, startPool, stubUser, textOf, type TestPool } from './test-pool.js';

const PSEUDONYM_KEY = 'a-test-pseudonym-key';
const BUYER_KEY = 'b'.repeat(64);

let pool: TestPool;
let next = 9000;

/** An account that has signed in, with the customer billing names for it in a lot. */
const buyer = async (): Promise<{ token: string; account: string; ref: (lot: string) => string }> => {
  next += 1;
  const { token, account } = await pool.signIn('github', stubUser(String(next)));
  return { token, account, ref: (lot) => customerRefOf(PSEUDONYM_KEY, account, lot) };
};

const start = (priceRef: string, token: string | undefined, body: unknown = { buyerKey: BUYER_KEY }): ReturnType<TestPool['post']> => pool.post(`/v1/packs/${priceRef}/fetches`, body, token);

const rows = async (account: string): Promise<readonly unknown[]> => (await (await pool.db()).prepare('SELECT * FROM pack_fetches WHERE account = ? ORDER BY created_at, fetch_id').bind(account).all()).results;

beforeAll(async () => {
  pool = await startPool();
  const { billing } = pool.stub;
  billing.addListing('price-a1', 'lot-a');
  billing.addListing('price-a2', 'lot-a');
  billing.addListing('price-b1', 'lot-b');
  billing.addListing('price-off', 'lot-a', false);
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

describe('POST /v1/packs/:priceRef/fetches', () => {
  it('is 401 without a credential and 400 without a buyer key or with one too long, and asks billing nothing', async () => {
    const { token } = await buyer();
    const before = pool.stub.billing.calls.length;
    expect((await start('price-a1', undefined)).status).toBe(401);
    for (const body of [{}, { buyerKey: '' }, { buyerKey: 7 }, { buyerKey: 'k'.repeat(513) }, 'not json']) {
      const answered = await start('price-a1', token, body);
      expect({ body, status: answered.status, error: fieldOf(answered.json, 'error'), field: fieldOf(answered.json, 'field') }).toEqual({ body, status: 400, error: 'missing_field', field: 'buyerKey' });
    }
    expect(pool.stub.billing.calls.length).toBe(before);
  });

  it('is 404 for a price the seller does not sell, and for one that is switched off', async () => {
    const { token, account } = await buyer();
    for (const priceRef of ['price-unknown', 'price-off']) {
      const answered = await start(priceRef, token);
      expect({ priceRef, status: answered.status, error: fieldOf(answered.json, 'error') }).toEqual({ priceRef, status: 404, error: 'not_found' });
    }
    expect(await rows(account)).toEqual([]);
  });

  it('answers 402 payment_required with the lot offer and the lot prices when the lot has no credit, creating the customer and queueing nothing', async () => {
    const { token, account, ref } = await buyer();
    const answered = await start('price-a2', token);
    expect(answered.status).toBe(402);
    const offerId = textOf(answered.json, 'offerId');
    expect(answered.json).toEqual({ error: 'payment_required', message: anyText(), offerId, priceRefs: ['price-a1', 'price-a2'], balance: 0 });
    expect(pool.stub.billing.customers.has(ref('lot-a'))).toBe(true);
    expect(pool.stub.billing.offers.filter((offer) => offer.customerRef === ref('lot-a'))).toEqual([{ offerId, customerRef: ref('lot-a'), lot: 'lot-a' }]);
    expect(await rows(account)).toEqual([]);
    // Asked again, the pool gets the same open offer, and the customer is not made twice.
    expect(textOf((await start('price-a1', token)).json, 'offerId')).toBe(offerId);
  });

  it('never sends the account id or the buyer key to billing', async () => {
    const { token, account } = await buyer();
    await start('price-a1', token);
    expect(JSON.stringify(pool.stub.billing.calls.slice(-4))).not.toContain(account);
    expect(JSON.stringify(pool.stub.billing.calls.slice(-4))).not.toContain(BUYER_KEY);
  });

  it('queues a fetch when the lot has credit, keeping what the operator builds from and taking no credit yet', async () => {
    const { token, account, ref } = await buyer();
    pool.stub.billing.credit(ref('lot-a'), 1);
    const answered = await start('price-a2', token);
    expect(answered.status).toBe(202);
    const fetchId = textOf(answered.json, 'fetchId');
    expect(fetchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(answered.json).toEqual({ fetchId, state: 'queued', priceRef: 'price-a2' });
    expect(await rows(account)).toEqual([
      { fetch_id: fetchId, account, price_ref: 'price-a2', lot: 'lot-a', buyer_key_id: buyerKeyIdOf(BUYER_KEY), buyer_key: BUYER_KEY, mode: 'test', state: 'queued', object_key: null, created_at: anyNumber(), ready_at: null, expires_at: null },
    ]);
    expect(buyerKeyIdOf(BUYER_KEY)).toMatch(/^[0-9a-f]{16}$/);
    expect(pool.stub.billing.balanceOf(ref('lot-a'))).toBe(1);
    expect(pool.stub.billing.taken.has(ref('lot-a'))).toBe(false);
  });

  it('never holds more queued fetches for a lot than its balance: the next start is 402 with the offer', async () => {
    const { token, account, ref } = await buyer();
    pool.stub.billing.credit(ref('lot-a'), 2);
    expect((await start('price-a1', token)).status).toBe(202);
    expect((await start('price-a2', token)).status).toBe(202);
    const third = await start('price-a1', token);
    expect({ status: third.status, balance: fieldOf(third.json, 'balance') }).toEqual({ status: 402, balance: 2 });
    expect(await rows(account)).toHaveLength(2);
  });

  it('lets two starts at once take the last credit only once', async () => {
    const { token, account, ref } = await buyer();
    pool.stub.billing.credit(ref('lot-a'), 1);
    const both = await Promise.all([start('price-a1', token), start('price-a1', token)]);
    expect(both.map((answered) => answered.status).sort()).toEqual([202, 402]);
    expect(await rows(account)).toHaveLength(1);
  });

  it('keeps a lot A credit from starting a lot B fetch: lot B is 402 with its own offer and prices', async () => {
    const { token, account, ref } = await buyer();
    pool.stub.billing.credit(ref('lot-a'), 5);
    const answered = await start('price-b1', token);
    expect(answered.status).toBe(402);
    expect(fieldOf(answered.json, 'priceRefs')).toEqual(['price-b1']);
    expect(pool.stub.billing.offers.find((offer) => offer.offerId === textOf(answered.json, 'offerId'))).toEqual({ offerId: textOf(answered.json, 'offerId'), customerRef: ref('lot-b'), lot: 'lot-b' });
    expect(ref('lot-b')).not.toBe(ref('lot-a'));
    expect(await rows(account)).toEqual([]);
    // The lot's own credit still starts its own fetch.
    expect((await start('price-a1', token)).status).toBe(202);
  });

  it('does not count another account against a lot: one buyer queueing leaves another its own credit', async () => {
    const first = await buyer();
    const second = await buyer();
    pool.stub.billing.credit(first.ref('lot-a'), 1);
    pool.stub.billing.credit(second.ref('lot-a'), 1);
    expect((await start('price-a1', first.token)).status).toBe(202);
    expect((await start('price-a1', second.token)).status).toBe(202);
  });

  it('is 502 billing_unavailable when billing fails, and queues nothing', async () => {
    const { token, account, ref } = await buyer();
    pool.stub.billing.credit(ref('lot-a'), 1);
    pool.stub.billing.failNext(500);
    const answered = await start('price-a1', token);
    expect({ status: answered.status, error: fieldOf(answered.json, 'error') }).toEqual({ status: 502, error: 'billing_unavailable' });
    expect(await rows(account)).toEqual([]);
  });

  it('refuses a restricted account', async () => {
    const { token, account } = await buyer();
    await (await pool.db()).prepare('UPDATE accounts SET restricted_at = 1 WHERE id = ?').bind(account).run();
    expect(fieldOf((await start('price-a1', token)).json, 'error')).toBe('account_restricted');
  });
});

describe('a pool with no billing bound', () => {
  it.each(['BILLING_URL', 'BILLING_SDK_KEY', 'BILLING_WORKLOAD_ID'])('is 503 not_configured naming %s when it is unset', async (name) => {
    const bare = await startPool({ [name]: '' });
    try {
      const { token } = await bare.signIn('github', stubUser('8801'));
      const answered = await bare.post('/v1/packs/price-a1/fetches', { buyerKey: BUYER_KEY }, token);
      expect({ status: answered.status, error: fieldOf(answered.json, 'error'), message: textOf(answered.json, 'message') }).toEqual({ status: 503, error: 'not_configured', message: `This pool has no ${name} binding.` });
    } finally {
      await bare.dispose();
    }
  }, 60_000);
});
