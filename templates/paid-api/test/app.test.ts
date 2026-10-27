import { describe, expect, it, vi } from 'vitest';
import { CHARGING_SENTENCE, createApp } from '../src/app.js';
import { BillingProblem, customerRefFor, mintToken, reservationKey } from '../src/billing.js';
import { createFakeBilling, createFakeRecovery } from '../src/fake-billing.js';
import { RECOVERY_SENTENCE } from '../src/recovery.js';
import { bodyOf, createClock } from './support.js';

const CHECKOUT_URLS = { successUrl: 'https://agent.test/?checkout=success', cancelUrl: 'https://agent.test/?checkout=cancel' };
const PRICE_REFS = ['calls-100', 'calls-1000'];

const setup = (credits = 3) => {
  const clock = createClock();
  const fake = createFakeBilling({ now: clock.now });
  const recovery = createFakeRecovery({ billing: fake, now: clock.now });
  const app = createApp({ billing: fake, recovery, priceRefs: PRICE_REFS, checkoutUrls: CHECKOUT_URLS, now: clock.now });
  const token = mintToken();
  const customerRef = customerRefFor(token);
  fake.grant(customerRef, credits);
  return { app, clock, fake, recovery, token, customerRef };
};

const authorization = (token: string) => ({ Authorization: `Bearer ${token}` });

const post = (body: unknown, headers: { [name: string]: string } = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

describe('GET /healthz', () => {
  it('is free and answers 200 without a token or a billing call', async () => {
    const { app, fake } = setup();
    const balance = vi.spyOn(fake, 'balance');

    const response = await app.request('/healthz');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(balance).not.toHaveBeenCalled();
  });
});

describe('GET /', () => {
  it('describes the endpoints, the price refs and the charging sentence, free', async () => {
    const { app } = setup();

    const response = await app.request('/');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ priceRefs: PRICE_REFS, charging: CHARGING_SENTENCE });
    const paths = JSON.stringify(body);
    for (const path of ['/v1/customers', '/v1/credits/checkout', '/v1/credits', '/v1/transform']) expect(paths).toContain(path);
  });

  it('says it in the words the design fixes', () => {
    expect(CHARGING_SENTENCE).toBe(
      'You pay only for successful calls: a credit is held when your call starts, spent when it succeeds, and returned when it fails or times out.',
    );
  });
});

describe('POST /v1/customers', () => {
  it('mints a token, upserts the hashed customerRef and returns the token once', async () => {
    const { app, fake } = setup();
    const upsert = vi.spyOn(fake, 'upsertCustomer');

    const response = await app.request('/v1/customers', post({ countryCode: 'US', regionCode: 'CA' }));

    expect(response.status).toBe(201);
    const body: unknown = await response.json();
    const token = typeof body === 'object' && body !== null && 'token' in body ? String(body.token) : '';
    expect(token).toMatch(/^oc_[A-Za-z0-9_-]{43}$/);
    expect(body).toMatchObject({ customerRef: customerRefFor(token) });
    expect(upsert).toHaveBeenCalledExactlyOnceWith(customerRefFor(token), { countryCode: 'US', regionCode: 'CA' });
    expect(JSON.stringify(upsert.mock.calls)).not.toContain(token);
  });

  it.each([[{}], [{ countryCode: 'USA' }], [{ countryCode: 'US', regionCode: 7 }], ['not json']])('answers 400 for the body %j and mints nothing', async (body) => {
    const { app, fake } = setup();
    const upsert = vi.spyOn(fake, 'upsertCustomer');

    const response = await app.request('/v1/customers', post(body));

    expect(response.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('passes a billing refusal through the buyer mapping', async () => {
    const { app, fake } = setup();
    vi.spyOn(fake, 'upsertCustomer').mockRejectedValue(new BillingProblem({ status: 422, code: 'CUSTOMER_REGION_NOT_SUPPORTED' }));

    const response = await app.request('/v1/customers', post({ countryCode: 'DE' }));

    expect(response.status).toBe(403);
  });
});

describe('bearer authentication', () => {
  it.each([
    ['GET', '/v1/credits'],
    ['POST', '/v1/credits/checkout'],
    ['POST', '/v1/transform'],
  ])('%s %s refuses a missing, malformed or non-bearer credential with 401 and no pointer to /recover', async (method, path) => {
    const { app } = setup();
    const headers: Array<{ [name: string]: string }> = [{}, authorization('oc_short'), authorization('not-a-token'), { Authorization: 'Basic abc' }];

    for (const extra of headers) {
      const response = await app.request(path, { method, headers: { 'Content-Type': 'application/json', ...extra }, body: method === 'POST' ? '{}' : undefined });

      expect(response.status).toBe(401);
      expect(JSON.stringify(await response.json())).not.toContain('/recover');
    }
  });
});

describe('POST /v1/credits/checkout', () => {
  it('returns the checkout URL billing made for the buyer and a price ref', async () => {
    const { app, fake, token, customerRef } = setup(0);
    const checkout = vi.spyOn(fake, 'checkout');

    const response = await app.request('/v1/credits/checkout', post({ priceRef: 'calls-100' }, authorization(token)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ checkoutUrl: 'https://checkout.example/fake/calls-100' });
    expect(checkout).toHaveBeenCalledExactlyOnceWith(customerRef, 'calls-100', CHECKOUT_URLS);
  });

  it('maps an unknown price to 400', async () => {
    const { app, token } = setup(0);

    const response = await app.request('/v1/credits/checkout', post({ priceRef: 'nope' }, authorization(token)));

    expect(response.status).toBe(400);
  });

  it.each([[{}], [{ priceRef: 5 }], [{ priceRef: '' }]])('answers 400 for %j without calling billing', async (body) => {
    const { app, fake, token } = setup(0);
    const checkout = vi.spyOn(fake, 'checkout');

    const response = await app.request('/v1/credits/checkout', post(body, authorization(token)));

    expect(response.status).toBe(400);
    expect(checkout).not.toHaveBeenCalled();
  });
});

describe('GET /v1/credits', () => {
  it('returns the buyer balance with the credits held by calls in flight', async () => {
    const { app, token } = setup(3);

    const response = await app.request('/v1/credits', { headers: authorization(token) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ creditsRemaining: 3, creditsHeld: 0, creditsAvailable: 3 });
  });
});

describe('POST /v1/transform', () => {
  const text = 'Hello, brave new world! Is this thing on?';

  it('charges one credit and answers the counts, with the credits charged in a header', async () => {
    const { app, token } = setup(3);

    const response = await app.request('/v1/transform', post({ text }, authorization(token)));

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Credits-Charged')).toBe('1');
    expect(await response.json()).toMatchObject({ words: 8, sentences: 2, slug: 'hello-brave-new-world-is-this-thing-on' });
    const balance = await app.request('/v1/credits', { headers: authorization(token) });
    expect(await balance.json()).toMatchObject({ creditsRemaining: 2, creditsHeld: 0 });
  });

  it('answers 402 with the checkout URL for a buyer with no credits, and runs no transform', async () => {
    const { app, token } = setup(0);

    const response = await app.request('/v1/transform', post({ text }, authorization(token)));

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
  });

  it.each([[{}], [{ text: 5 }], ['not json'], [[]]])('answers 400 for the body %j without touching billing', async (body) => {
    const { app, fake, token } = setup(3);
    const reserve = vi.spyOn(fake, 'reserve');

    const response = await app.request('/v1/transform', post(body, authorization(token)));

    expect(response.status).toBe(400);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('keys the reservation on the customerRef, the buyer Idempotency-Key and the exact body', async () => {
    const { app, fake, token, customerRef } = setup(3);
    const reserve = vi.spyOn(fake, 'reserve');
    const body = JSON.stringify({ text });

    await app.request('/v1/transform', post(body, { ...authorization(token), 'Idempotency-Key': 'buyer-1' }));

    expect(reserve).toHaveBeenCalledExactlyOnceWith({
      customerRef,
      credits: 1,
      ttlSeconds: 45,
      idempotencyKey: reservationKey(customerRef, 'buyer-1', body),
    });
  });

  it('replays a paid call free under the same key and body, and charges again for a new body', async () => {
    const { app, token } = setup(3);
    const headers = { ...authorization(token), 'Idempotency-Key': 'buyer-1' };

    const first = await app.request('/v1/transform', post({ text }, headers));
    const replay = await app.request('/v1/transform', post({ text }, headers));
    const changed = await app.request('/v1/transform', post({ text: 'something else' }, headers));

    expect([first, replay, changed].map((response) => response.headers.get('X-Credits-Charged'))).toEqual(['1', '0', '1']);
    const balance = await app.request('/v1/credits', { headers: authorization(token) });
    expect(await balance.json()).toMatchObject({ creditsRemaining: 1 });
  });

  it('sets Retry-After on a call that is already in flight under the same key', async () => {
    const { app, token, fake } = setup(3);
    const body = JSON.stringify({ text });
    const customerRef = customerRefFor(token);
    await fake.reserve({ customerRef, credits: 1, ttlSeconds: 45, idempotencyKey: reservationKey(customerRef, 'buyer-1', body) });

    const response = await app.request('/v1/transform', post(body, { ...authorization(token), 'Idempotency-Key': 'buyer-1' }));

    expect(response.status).toBe(409);
    expect(response.headers.get('Retry-After')).toBe('45');
    expect(await response.json()).toMatchObject({ code: 'REQUEST_IN_PROGRESS' });
  });
});

describe('token recovery', () => {
  const EMAIL = 'buyer@example.com';

  it('is described on GET /: the sentence buyers are told and the three calls', async () => {
    const { app } = setup();

    const body = await bodyOf(await app.request('/'));

    expect(body['recovery']).toBe(RECOVERY_SENTENCE);
    const endpoints = JSON.stringify(body['endpoints']);
    for (const path of ['/v1/recover', '/recover', '/v1/recover/redeem']) expect(endpoints).toContain(path);
  });

  it('keeps the credits of a lost token: ask, follow the emailed link, and the old token is dead while the new one holds the rest', async () => {
    const { app, recovery, token: lost, customerRef } = setup(100);
    recovery.bind(customerRef, EMAIL);
    await app.request('/v1/transform', post({ text: 'Hello there.' }, authorization(lost)));
    expect(await bodyOf(await app.request('/v1/credits', { headers: authorization(lost) }))).toMatchObject({ creditsRemaining: 99 });

    // The edge proxy names the client; a bare in-process request has no socket to read.
    expect((await app.request('/v1/recover', post({ email: EMAIL }, { 'CF-Connecting-IP': '203.0.113.7' }))).status).toBe(202);
    const link = recovery.outbox.at(-1)?.token ?? '';
    const redeemed = await app.request('/v1/recover/redeem', post({ recoveryToken: link }));

    expect(redeemed.status).toBe(200);
    const found = String((await bodyOf(redeemed))['token']);
    // Each call carries a body that passes validation, so the 401 can only come from billing refusing the revoked customerRef.
    const calls = [
      { path: '/v1/credits', init: { headers: authorization(lost) } },
      { path: '/v1/credits/checkout', init: post({ priceRef: 'calls-100' }, authorization(lost)) },
      { path: '/v1/transform', init: post({ text: 'Hello there.' }, authorization(lost)) },
    ];
    for (const { path, init } of calls) {
      const refused = await app.request(path, init);
      expect(refused.status).toBe(401);
      expect(await bodyOf(refused)).toMatchObject({ code: 'CUSTOMER_REVOKED', recover: '/recover' });
    }
    expect(await bodyOf(await app.request('/v1/credits', { headers: authorization(found) }))).toMatchObject({ creditsRemaining: 99 });
    expect((await app.request('/v1/transform', post({ text: 'Hello there.' }, authorization(found)))).status).toBe(200);
  });
});

describe('errors', () => {
  it('answers a billing problem that is not a buyer matter with a bare 503', async () => {
    const { app, fake, token } = setup();
    vi.spyOn(fake, 'balance').mockRejectedValue(new BillingProblem({ status: 409, code: 'WORKLOAD_NOT_ACTIVE', detail: 'workload w-1 suspended' }));

    const response = await app.request('/v1/credits', { headers: authorization(token) });

    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('w-1');
  });

  it('answers any other failure with a generic 500 that leaks nothing', async () => {
    const { app, fake, token } = setup();
    vi.spyOn(fake, 'balance').mockRejectedValue(new Error('secret internals'));

    const response = await app.request('/v1/credits', { headers: authorization(token) });

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('secret');
  });

  it('answers an unknown path with 404 JSON', async () => {
    const { app } = setup();

    const response = await app.request('/v2/nothing');

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});
