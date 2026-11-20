// Paid pack fetches against the fake billing API, under Miniflare's workerd: the buyer's start route, the operator's queue and hand-over, and the buyer's download.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from './http.js';
import { customerRefOf } from './billing.js';
import { buyerKeyIdOf } from './pack-fetches.js';
import { nightly } from './nightly.js';
import { SWEEP_PACKS, sweepPacks } from './pack-operator.js';
import { FAKE_BILLING_URL, FAKE_SDK_KEY, fetcherOf } from './test-billing.js';
import { anyNumber, anyText, fieldOf, poolDbOf, startPool, stubUser, textOf, type TestPool } from './test-pool.js';
import worker from './worker.js';

const PSEUDONYM_KEY = 'a-test-pseudonym-key';
const BUYER_KEY = 'b'.repeat(64);
const OPERATOR = 'operator-secret';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
  pool = await startPool({ OPERATOR_TOKEN: OPERATOR });
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

/** A fetch the buyer has queued under one credit. */
const queued = async (credits = 1): Promise<{ token: string; account: string; ref: string; fetchId: string }> => {
  const held = await buyer();
  pool.stub.billing.credit(held.ref('lot-a'), credits);
  const fetchId = textOf((await start('price-a1', held.token)).json, 'fetchId');
  return { token: held.token, account: held.account, ref: held.ref('lot-a'), fetchId };
};

/** Every consume the fake billing has seen, with its body and Idempotency-Key. */
const consumes = (): readonly { body: unknown; key: string | null }[] => pool.stub.billing.calls.filter((call) => call.path === '/api/v1/billing/credits/consume').map((call) => ({ body: call.body, key: call.idempotencyKey }));

const operate = (method: 'GET' | 'POST', path: string, body: unknown = {}, token: string | null = OPERATOR): ReturnType<TestPool['send']> => pool.send(path, method === 'GET' ? { method } : { method, body: JSON.stringify(body) }, token ?? undefined, { 'content-type': 'application/json' });

const fetchOf = async (fetchId: string): Promise<{ [column: string]: unknown }> => {
  const row = await (await pool.db()).prepare('SELECT * FROM pack_fetches WHERE fetch_id = ?').bind(fetchId).first();
  if (typeof row !== 'object' || row === null) throw new Error(`no fetch ${fetchId}`);
  return Object.fromEntries(Object.entries(row));
};

/** Puts a pack in PACKS and marks the fetch built under it. */
const built = async (fetchId: string): Promise<string> => {
  const key = `packs/${fetchId}/pack.tar`;
  await (await pool.packsBucket()).put(key, JSON.stringify({ pack: fetchId }));
  expect((await operate('POST', `/v1/operator/fetches/${fetchId}/built`, { objectKey: key })).status).toBe(200);
  return key;
};

describe('the operator routes', () => {
  it('answer only the operator: 401 with no token or a wrong one, for every route', async () => {
    const { fetchId } = await queued();
    for (const token of [null, 'wrong']) {
      for (const [method, path] of [['GET', '/v1/operator/fetches'], ['POST', `/v1/operator/fetches/${fetchId}/built`], ['POST', `/v1/operator/fetches/${fetchId}/handover`], ['POST', `/v1/operator/fetches/${fetchId}/failed`]] as const) {
        const answered = await operate(method, path, {}, token);
        expect({ token, path, status: answered.status, error: fieldOf(answered.json, 'error') }).toEqual({ token, path, status: 401, error: 'unauthorized' });
      }
    }
    expect((await fetchOf(fetchId)).state).toBe('queued');
  });

  it('are 503 not_configured on a pool with no OPERATOR_TOKEN', async () => {
    const bare = await startPool({ OPERATOR_TOKEN: '' });
    try {
      const answered = await bare.send('/v1/operator/fetches', { method: 'GET' }, 'anything');
      expect({ status: answered.status, error: fieldOf(answered.json, 'error') }).toEqual({ status: 503, error: 'not_configured' });
    } finally {
      await bare.dispose();
    }
  }, 60_000);

  it('list the queue oldest first with the buyer key the builder builds under, and a state on request', async () => {
    const first = await queued();
    const second = await queued();
    const listed = fieldOf((await operate('GET', '/v1/operator/fetches')).json, 'fetches');
    const mine = Array.isArray(listed) ? listed.filter((entry) => [first.fetchId, second.fetchId].includes(textOf(entry, 'fetchId'))) : [];
    expect(mine.map((entry) => textOf(entry, 'fetchId')).sort()).toEqual([first.fetchId, second.fetchId].sort());
    const stamps = Array.isArray(listed) ? listed.map((entry) => Number(fieldOf(entry, 'createdAt'))) : [];
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(mine.find((entry) => textOf(entry, 'fetchId') === first.fetchId)).toEqual({ fetchId: first.fetchId, priceRef: 'price-a1', buyerKeyId: buyerKeyIdOf(BUYER_KEY), buyerKey: BUYER_KEY, mode: 'test', state: 'queued', objectKey: null, createdAt: anyNumber(), readyAt: null, expiresAt: null });
    await built(first.fetchId);
    const afterwards = fieldOf((await operate('GET', '/v1/operator/fetches?state=built')).json, 'fetches');
    expect(Array.isArray(afterwards) ? afterwards.find((entry) => textOf(entry, 'fetchId') === first.fetchId) : undefined).toMatchObject({ state: 'built', buyerKey: null, objectKey: `packs/${first.fetchId}/pack.tar` });
    const stillQueued = fieldOf((await operate('GET', '/v1/operator/fetches')).json, 'fetches');
    expect(Array.isArray(stillQueued) ? stillQueued.map((entry) => textOf(entry, 'fetchId')) : []).not.toContain(first.fetchId);
    expect((await operate('GET', '/v1/operator/fetches?state=bogus')).status).toBe(400);
  });

  it('mark a pack built only under its own prefix, only when PACKS holds it, and only once', async () => {
    const { fetchId } = await queued();
    const other = await queued();
    const path = `/v1/operator/fetches/${fetchId}/built`;
    for (const body of [{}, { objectKey: 'pack.tar' }, { objectKey: `packs/${other.fetchId}/pack.tar` }]) expect({ body, status: (await operate('POST', path, body)).status }).toEqual({ body, status: 400 });
    const absent = await operate('POST', path, { objectKey: `packs/${fetchId}/pack.tar` });
    expect({ status: absent.status, error: fieldOf(absent.json, 'error') }).toEqual({ status: 422, error: 'object_missing' });
    expect((await fetchOf(fetchId)).state).toBe('queued');
    const key = await built(fetchId);
    expect(await fetchOf(fetchId)).toMatchObject({ state: 'built', object_key: key, buyer_key: null, buyer_key_id: buyerKeyIdOf(BUYER_KEY) });
    expect(fieldOf((await operate('POST', path, { objectKey: key })).json, 'error')).toBe('not_queued');
    expect((await operate('POST', '/v1/operator/fetches/no-such-fetch/built', { objectKey: 'packs/no-such-fetch/p' })).status).toBe(404);
  });

  it('hand over a built pack by taking one credit under the fetch id, and keep the record', async () => {
    const { fetchId, ref, account } = await queued(2);
    await built(fetchId);
    const before = Date.now();
    const answered = await operate('POST', `/v1/operator/fetches/${fetchId}/handover`);
    expect(answered.status).toBe(200);
    expect(answered.json).toEqual({ fetchId, state: 'ready', expiresAt: anyNumber() });
    expect(pool.stub.billing.balanceOf(ref)).toBe(1);
    expect(pool.stub.billing.taken.get(ref)).toEqual([fetchId]);
    const row = await fetchOf(fetchId);
    expect(row).toMatchObject({ state: 'ready', account, price_ref: 'price-a1', buyer_key_id: buyerKeyIdOf(BUYER_KEY), buyer_key: null });
    expect(Number(row['ready_at'])).toBeGreaterThanOrEqual(before);
    expect(Number(row['expires_at'])).toBe(Number(row['ready_at']) + WEEK_MS);
    expect(pool.stub.billing.calls.at(-1)?.idempotencyKey).toBe(fetchId);
  });

  it('hand over a queued fetch to nobody: 409 not_built, nothing taken', async () => {
    const { fetchId, ref } = await queued();
    const answered = await operate('POST', `/v1/operator/fetches/${fetchId}/handover`);
    expect({ status: answered.status, error: fieldOf(answered.json, 'error') }).toEqual({ status: 409, error: 'not_built' });
    expect(pool.stub.billing.balanceOf(ref)).toBe(1);
    expect((await operate('POST', '/v1/operator/fetches/no-such-fetch/handover')).status).toBe(404);
  });

  it('leave the fetch built and take nothing on a short balance, and hand it over once the credit is back', async () => {
    const { fetchId, ref } = await queued();
    await built(fetchId);
    // A refund or a lost dispute takes the credit between the start and the hand-over.
    pool.stub.billing.credit(ref, -1);
    const short = await operate('POST', `/v1/operator/fetches/${fetchId}/handover`);
    expect({ status: short.status, error: fieldOf(short.json, 'error') }).toEqual({ status: 409, error: 'insufficient_credits' });
    expect(await fetchOf(fetchId)).toMatchObject({ state: 'built', ready_at: null, expires_at: null });
    expect(pool.stub.billing.taken.has(ref)).toBe(false);
    pool.stub.billing.credit(ref, 1);
    expect((await operate('POST', `/v1/operator/fetches/${fetchId}/handover`)).status).toBe(200);
    expect(pool.stub.billing.balanceOf(ref)).toBe(0);
  });

  it('end ready with one credit taken when the answer was lost and the hand-over is retried', async () => {
    const { fetchId, ref } = await queued();
    await built(fetchId);
    pool.stub.billing.loseNextConsumeAnswer();
    const lost = await operate('POST', `/v1/operator/fetches/${fetchId}/handover`);
    expect({ status: lost.status, error: fieldOf(lost.json, 'error') }).toEqual({ status: 502, error: 'billing_unavailable' });
    expect((await fetchOf(fetchId)).state).toBe('built');
    expect((await operate('POST', `/v1/operator/fetches/${fetchId}/handover`)).status).toBe(200);
    expect((await fetchOf(fetchId)).state).toBe('ready');
    expect(pool.stub.billing.balanceOf(ref)).toBe(0);
    expect(pool.stub.billing.taken.get(ref)).toEqual([fetchId]);
  });

  it('answer a hand-over of a ready fetch as it stands, without asking billing again', async () => {
    const { fetchId } = await queued();
    await built(fetchId);
    const first = await operate('POST', `/v1/operator/fetches/${fetchId}/handover`);
    const calls = pool.stub.billing.calls.length;
    const again = await operate('POST', `/v1/operator/fetches/${fetchId}/handover`);
    expect(again.json).toEqual(first.json);
    expect(pool.stub.billing.calls.length).toBe(calls);
  });

  it('hand a fetch over once when two hand-overs arrive together', async () => {
    const { fetchId, ref } = await queued();
    await built(fetchId);
    const both = await Promise.all([operate('POST', `/v1/operator/fetches/${fetchId}/handover`), operate('POST', `/v1/operator/fetches/${fetchId}/handover`)]);
    expect(both.map((answered) => answered.status)).toEqual([200, 200]);
    expect(pool.stub.billing.taken.get(ref)).toEqual([fetchId]);
  });

  it('is 502 when billing is down at the hand-over, and leaves the fetch built', async () => {
    const { fetchId } = await queued();
    await built(fetchId);
    pool.stub.billing.failNext(500);
    expect((await operate('POST', `/v1/operator/fetches/${fetchId}/handover`)).status).toBe(502);
    expect((await fetchOf(fetchId)).state).toBe('built');
  });

  it('mark a failed build without taking a credit, drop the key and any pack, and free the buyer to start again', async () => {
    const { fetchId, ref, token } = await queued();
    const key = await built(fetchId);
    const answered = await operate('POST', `/v1/operator/fetches/${fetchId}/failed`);
    expect(answered.json).toEqual({ fetchId, state: 'failed' });
    expect(await fetchOf(fetchId)).toMatchObject({ state: 'failed', buyer_key: null, object_key: null });
    expect(await (await pool.packsBucket()).get(key)).toBeNull();
    expect(pool.stub.billing.balanceOf(ref)).toBe(1);
    expect(pool.stub.billing.taken.has(ref)).toBe(false);
    // The credit is still the buyer's, and the failed fetch no longer holds it.
    expect((await start('price-a1', token)).status).toBe(202);
    expect((await operate('POST', `/v1/operator/fetches/${fetchId}/failed`)).json).toEqual({ fetchId, state: 'failed' });
    expect((await operate('POST', `/v1/operator/fetches/${fetchId}/handover`)).status).toBe(409);
  });

  it('mark a queued fetch failed, and refuse to fail one already handed over', async () => {
    const waiting = await queued();
    expect((await operate('POST', `/v1/operator/fetches/${waiting.fetchId}/failed`)).status).toBe(200);
    const done = await queued();
    await built(done.fetchId);
    await operate('POST', `/v1/operator/fetches/${done.fetchId}/handover`);
    const refused = await operate('POST', `/v1/operator/fetches/${done.fetchId}/failed`);
    expect({ status: refused.status, error: fieldOf(refused.json, 'error') }).toEqual({ status: 409, error: 'already_ready' });
    expect((await fetchOf(done.fetchId)).state).toBe('ready');
    expect((await operate('POST', '/v1/operator/fetches/no-such-fetch/failed')).status).toBe(404);
  });
});

describe('the mode billing holds', () => {
  it('records the mode billing reports on the row, and sends no mode on any call', async () => {
    const { token, account, ref } = await buyer();
    pool.stub.billing.credit(ref('lot-a'), 1);
    const before = pool.stub.billing.calls.length;
    const started = await start('price-a1', token);
    expect(started.status).toBe(202);
    const fetchId = textOf(started.json, 'fetchId');
    expect((await rows(account)).map((row) => fieldOf(row, 'mode'))).toEqual(['test']);
    await built(fetchId);
    expect((await operate('POST', `/v1/operator/fetches/${fetchId}/handover`)).status).toBe(200);
    expect(consumes().slice(-1)).toEqual([{ body: { customerRef: ref('lot-a'), credits: 1 }, key: fetchId }]);
    expect(JSON.stringify(pool.stub.billing.calls.slice(before))).not.toContain('mode');
  });

  it('counts only the credits of the mode billing is in against a start: a fetch queued in test mode does not hold back a live start', async () => {
    const { token, account, ref } = await buyer();
    pool.stub.billing.credit(ref('lot-a'), 1);
    expect((await start('price-a1', token)).status).toBe(202);
    pool.stub.billing.setMode('live');
    try {
      pool.stub.billing.credit(ref('lot-a'), 1);
      expect((await start('price-a1', token)).status).toBe(202);
      expect((await start('price-a1', token)).status).toBe(402);
    } finally {
      pool.stub.billing.setMode('test');
    }
    expect((await rows(account)).map((row) => fieldOf(row, 'mode')).sort()).toEqual(['live', 'test']);
  });
});

describe('a buyer billing has revoked', () => {
  it('is 403 buyer_refused on a start, and queues nothing', async () => {
    const { token, account, ref } = await buyer();
    pool.stub.billing.credit(ref('lot-a'), 1);
    pool.stub.billing.revoke(ref('lot-a'));
    const refused = await start('price-a1', token);
    expect({ status: refused.status, error: fieldOf(refused.json, 'error') }).toEqual({ status: 403, error: 'buyer_refused' });
    expect(await rows(account)).toEqual([]);
  });
});

describe('a mode flip between the queue and the hand-over', () => {
  it('is 409 mode_changed, takes nothing, leaves the fetch built, and hands over once billing is back in the fetch\'s mode', async () => {
    const { fetchId, ref } = await queued();
    await built(fetchId);
    const before = consumes().filter((call) => call.key === fetchId).length;
    pool.stub.billing.setMode('live');
    try {
      pool.stub.billing.credit(ref, 1);
      const answered = await operate('POST', `/v1/operator/fetches/${fetchId}/handover`);
      expect({ status: answered.status, error: fieldOf(answered.json, 'error') }).toEqual({ status: 409, error: 'mode_changed' });
      expect((await fetchOf(fetchId)).state).toBe('built');
      expect(consumes().filter((call) => call.key === fetchId)).toHaveLength(before);
      expect(pool.stub.billing.balanceOf(ref)).toBe(1);
    } finally {
      pool.stub.billing.setMode('test');
    }
    expect((await operate('POST', `/v1/operator/fetches/${fetchId}/handover`)).status).toBe(200);
    expect(pool.stub.billing.balanceOf(ref)).toBe(0);
  });
});

describe('a buyer billing has revoked since the fetch was queued', () => {
  it('is 409 buyer_refused at hand-over, leaves the fetch built, and is not a retry', async () => {
    const { fetchId, ref } = await queued();
    await built(fetchId);
    pool.stub.billing.revoke(ref);
    const answered = await operate('POST', `/v1/operator/fetches/${fetchId}/handover`);
    expect({ status: answered.status, error: fieldOf(answered.json, 'error') }).toEqual({ status: 409, error: 'buyer_refused' });
    expect((await fetchOf(fetchId)).state).toBe('built');
    expect(pool.stub.billing.balanceOf(ref)).toBe(1);
  });
});

describe('a fetch id billing already holds for another request', () => {
  it('is 409 idempotency_conflict at hand-over, leaves the fetch built, and is not a retry', async () => {
    const { fetchId, ref } = await queued();
    await built(fetchId);
    // Another customer's consume already used the fetch id, so billing holds it for a different body.
    pool.stub.billing.credit('someone-else', 1);
    const taken = await fetcherOf(pool.stub.billing)(`${FAKE_BILLING_URL}/billing/credits/consume`, { method: 'POST', headers: { 'x-agent-sdk-key': FAKE_SDK_KEY, 'idempotency-key': fetchId, 'content-type': 'application/json' }, body: JSON.stringify({ customerRef: 'someone-else', credits: 1 }) });
    expect(taken.status).toBe(200);
    const answered = await operate('POST', `/v1/operator/fetches/${fetchId}/handover`);
    expect({ status: answered.status, error: fieldOf(answered.json, 'error') }).toEqual({ status: 409, error: 'idempotency_conflict' });
    expect((await fetchOf(fetchId)).state).toBe('built');
    // One consume call by the pool, not a retry: the other is the test's own.
    expect(consumes().filter((call) => call.key === fetchId)).toHaveLength(2);
    expect(pool.stub.billing.balanceOf(ref)).toBe(1);
  });
});

/** A fetch handed over, with its pack in PACKS. */
const handedOver = async (): Promise<{ token: string; account: string; fetchId: string; key: string }> => {
  const held = await queued();
  const key = await built(held.fetchId);
  expect((await operate('POST', `/v1/operator/fetches/${held.fetchId}/handover`)).status).toBe(200);
  return { token: held.token, account: held.account, fetchId: held.fetchId, key };
};

const download = (fetchId: string, token: string | undefined): ReturnType<TestPool['raw']> => pool.raw(`/v1/packs/fetches/${fetchId}`, token);

describe('GET /v1/packs/fetches/:fetchId', () => {
  it('is 401 without a credential, and 404 for an unknown fetch and for another account\'s, the same either way', async () => {
    const { fetchId } = await handedOver();
    const stranger = await buyer();
    expect((await download(fetchId, undefined)).status).toBe(401);
    const other = await download(fetchId, stranger.token);
    const unknown = await download('00000000-0000-4000-8000-000000000000', stranger.token);
    expect({ status: other.status, json: other.json }).toEqual({ status: 404, json: unknown.json });
    expect(unknown.status).toBe(404);
  });

  it('answers pending while the fetch is queued or built, and nothing of the pack', async () => {
    const { fetchId, token } = await queued();
    const waiting = await download(fetchId, token);
    expect({ status: waiting.status, json: waiting.json }).toEqual({ status: 202, json: { fetchId, state: 'pending' } });
    await built(fetchId);
    const ready = await download(fetchId, token);
    expect({ status: ready.status, json: ready.json }).toEqual({ status: 202, json: { fetchId, state: 'pending' } });
  });

  it('answers 409 fetch_failed for a failed build', async () => {
    const { fetchId, token } = await queued();
    await operate('POST', `/v1/operator/fetches/${fetchId}/failed`);
    const answered = await download(fetchId, token);
    expect({ status: answered.status, error: fieldOf(answered.json, 'error') }).toEqual({ status: 409, error: 'fetch_failed' });
  });

  it('serves the pack from PACKS once handed over, uncached and private', async () => {
    const { fetchId, token } = await handedOver();
    const answered = await download(fetchId, token);
    expect(answered.status).toBe(200);
    expect(answered.json).toEqual({ pack: fetchId });
    expect(answered.headers.get('content-type')).toBe('application/octet-stream');
    expect(answered.headers.get('cache-control')).toBe('private, no-store');
    expect(answered.headers.get('content-disposition')).toBe(`attachment; filename="pack-${fetchId}"`);
    // Downloading is not a second spend: the pack can be fetched again inside its window.
    expect((await download(fetchId, token)).status).toBe(200);
  });

  it('is 410 gone after the seven days, even before the sweep has deleted the object', async () => {
    const { fetchId, token } = await handedOver();
    await (await pool.db()).prepare('UPDATE pack_fetches SET expires_at = ? WHERE fetch_id = ?').bind(Date.now() - 1, fetchId).run();
    const answered = await download(fetchId, token);
    expect({ status: answered.status, error: fieldOf(answered.json, 'error') }).toEqual({ status: 410, error: 'gone' });
  });

  it('is 410 gone when the object is missing from PACKS, rather than a bare error', async () => {
    const { fetchId, token, key } = await handedOver();
    await (await pool.packsBucket()).delete([key]);
    expect((await download(fetchId, token)).status).toBe(410);
  });

  it('is 503 not_configured on a pool with no PACKS bound, for a ready fetch', async () => {
    const { fetchId, token } = await handedOver();
    const row = await fetchOf(fetchId);
    const db = poolDbOf(await pool.db());
    const { downloadFetch } = await import('./pack-fetches.js');
    const answered = await downloadFetch(new Request('http://pool.test/x', { headers: { authorization: `Bearer ${token}` } }), { DB: db }, fetchId, Number(row['ready_at']) + 1);
    expect(answered.status).toBe(503);
  });
});

describe('the nightly sweep of handed-over packs', () => {
  const night = async (when: number): Promise<void> => worker.scheduled({ scheduledTime: when }, await pool.miniflare.getBindings<Env>());

  it('deletes a pack past its seven days and keeps the row as the hand-over record, and leaves live and failed fetches alone', async () => {
    const old = await handedOver();
    const live = await handedOver();
    const failed = await queued();
    const failedKey = `packs/${failed.fetchId}/pack.tar`;
    await (await pool.packsBucket()).put(failedKey, '{}');
    await operate('POST', `/v1/operator/fetches/${failed.fetchId}/failed`);
    const before = await fetchOf(old.fetchId);
    await (await pool.db()).prepare('UPDATE pack_fetches SET expires_at = ? WHERE fetch_id = ?').bind(Date.now() - 1000, old.fetchId).run();
    await night(Date.now());
    const bucket = await pool.packsBucket();
    expect(await bucket.get(old.key)).toBeNull();
    expect(await bucket.get(live.key)).not.toBeNull();
    expect(await fetchOf(old.fetchId)).toMatchObject({ fetch_id: old.fetchId, account: old.account, price_ref: 'price-a1', buyer_key_id: buyerKeyIdOf(BUYER_KEY), state: 'ready', object_key: null, ready_at: before['ready_at'] });
    expect((await fetchOf(live.fetchId))['object_key']).toBe(live.key);
    expect((await download(old.fetchId, old.token)).status).toBe(410);
    expect((await download(live.fetchId, live.token)).status).toBe(200);
  });

  /** A withdrawn account holding one raw object the nightly raw sweep erases, so a test can see that sweep ran. */
  const rawHeld = async (): Promise<{ account: string; erased: () => Promise<unknown> }> => {
    const { account } = await buyer();
    const db = await pool.db();
    const hash = 'c'.repeat(64);
    await db.prepare('UPDATE accounts SET raw_consent = NULL, raw_consent_withdrawn_at = 1 WHERE id = ?').bind(account).run();
    await db.prepare('INSERT INTO raw_objects (account, sha256, bytes, capture_version, redaction_version, stored_at) VALUES (?, ?, 1, ?, ?, 1)').bind(account, hash, 'cap-7', '1').run();
    await (await pool.rawBucket()).put(`raw/${account}/${hash}`, 'x');
    return { account, erased: async () => fieldOf(await db.prepare('SELECT erased_on FROM raw_objects WHERE account = ? AND sha256 = ?').bind(account, hash).first(), 'erased_on') };
  };

  it('is run by `nightly`: the pack is gone, its key is null, and the raw sweep that follows still ran', async () => {
    const old = await handedOver();
    const raw = await rawHeld();
    await (await pool.db()).prepare('UPDATE pack_fetches SET expires_at = ? WHERE fetch_id = ?').bind(Date.now() - 1000, old.fetchId).run();
    expect(await raw.erased()).toBeNull();
    await nightly(await pool.miniflare.getBindings<Env>(), Date.now());
    expect(await (await pool.packsBucket()).get(old.key)).toBeNull();
    expect((await fetchOf(old.fetchId))['object_key']).toBeNull();
    expect(await raw.erased()).not.toBeNull();
  });

  it('still runs the raw sweep on a night the pack sweep throws, and the error reaches the caller', async () => {
    const old = await handedOver();
    const raw = await rawHeld();
    await (await pool.db()).prepare('UPDATE pack_fetches SET expires_at = ? WHERE fetch_id = ?').bind(Date.now() - 1000, old.fetchId).run();
    const bound = await pool.miniflare.getBindings<Env>();
    const down = { head: () => Promise.resolve(null), get: () => Promise.resolve(null), delete: () => Promise.reject(new Error('r2 is down')) };
    await expect(nightly({ ...bound, PACKS: down }, Date.now())).rejects.toThrow('r2 is down');
    expect(await raw.erased()).not.toBeNull();
    // The pack waits for the next night, the row untouched.
    expect((await fetchOf(old.fetchId))['object_key']).toBe(old.key);
  });

  it('does nothing and fails nothing with no PACKS bound, and takes a bounded number a night', async () => {
    expect(await sweepPacks({ DB: poolDbOf(await pool.db()) }, Date.now() + 100 * 24 * 60 * 60 * 1000)).toBe(0);
    const { account } = await handedOver();
    const db = await pool.db();
    const insert = (index: number): Parameters<typeof db.batch>[0][number] =>
      db.prepare("INSERT INTO pack_fetches (fetch_id, account, price_ref, lot, buyer_key_id, mode, state, object_key, created_at, ready_at, expires_at) VALUES (?, ?, 'price-a1', 'lot-a', 'k', 'test', 'ready', ?, 1, 1, 2)").bind(`sweep-${String(index)}`, account, `packs/sweep-${String(index)}/pack.tar`);
    await db.batch(Array.from({ length: SWEEP_PACKS + 1 }, (_, index) => insert(index)));
    const bucket = await pool.packsBucket();
    const env = { DB: poolDbOf(db), PACKS: { delete: (keys: readonly string[]) => bucket.delete([...keys]) } };
    expect(await sweepPacks(env, 10)).toBe(SWEEP_PACKS);
    expect(await sweepPacks(env, 10)).toBe(1);
    expect(await sweepPacks(env, 10)).toBe(0);
  });
});
