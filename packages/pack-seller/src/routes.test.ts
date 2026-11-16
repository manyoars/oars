import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { OFFER_RATE_LIMIT, OFFER_RATE_REFUSAL_STATUS, OFFER_RATE_WINDOW_MS } from './rate-limit.js';
import { API, customerRefOf, harness, PACK, platform, SDK_KEY, server, useServer } from './test-support.js';

useServer();

const REF = 'c_0123456789abcdef0123456789abcdef';
const refHeader: [string, string][] = [['X-Customer-Ref', REF]];
const OFFER = { offerId: 'po_abc', expiresAt: '2099-01-01T00:00:00Z' };
const customer = { customerRef: 'x', countryCode: 'US', createdAt: 't', updatedAt: 't' };
const accept = { recipientLegalName: 'Ada Lovelace', licenseVersion: '2026-11' };

const platformUp = () => [
  platform('/billing/customers', 201, customer),
  platform('/billing/offers', 200, OFFER),
];

describe('health and pack pages (steps 4)', () => {
  it('answers /health', async () => {
    const { call } = harness();
    const response = await call('GET', '/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('lists packs, shows one, and 404s an unknown pack and an unknown route', async () => {
    const { call } = harness();
    expect(await (await call('GET', '/packs')).json()).toEqual({ packs: [PACK] });
    expect(await (await call('GET', '/packs/alpha')).json()).toEqual(PACK);
    expect((await call('GET', '/packs/nope')).status).toBe(404);
    expect((await call('GET', '/packs/alpha/other')).status).toBe(404);
    expect((await call('GET', '/elsewhere')).status).toBe(404);
  });

  it('creates the seller customer under a fresh high-entropy ref with the seller key', async () => {
    const seen: { ref: string; key: string | null }[] = [];
    server.use(
      http.post(`${API}/billing/customers`, async ({ request }) => {
        const body = await request.json();
        seen.push({ ref: JSON.stringify(body), key: request.headers.get('X-Agent-SDK-Key') });
        return HttpResponse.json(customer, { status: 201 });
      }),
      platform('/billing/offers', 200, OFFER),
    );
    const { call } = harness();
    const a = await customerRefOf(await call('POST', '/packs/alpha/offer', { body: accept }));
    const b = await customerRefOf(await call('POST', '/packs/alpha/offer', { body: accept }));
    expect(a).toMatch(/^c_[A-Za-z0-9_-]{43}$/);
    expect(b).not.toBe(a);
    expect(seen.map((entry) => entry.key)).toEqual([SDK_KEY, SDK_KEY]);
    expect(seen[0]?.ref).toContain(a);
  });
});

describe('offer route (step 5)', () => {
  it('returns the offer, the priceRef, and the customerRef, and records the recipient and license', async () => {
    server.use(...platformUp());
    const { call, ledger } = harness();
    const response = await call('POST', '/packs/alpha/offer', { body: accept });
    const copy = response.clone();
    expect(response.status).toBe(200);
    expect(await copy.json()).toMatchObject({ offerId: 'po_abc', priceRef: 'pack-alpha' });
    expect(ledger.find(await customerRefOf(response))).toMatchObject({ packId: 'alpha', recipientLegalName: 'Ada Lovelace', licenseVersion: '2026-11' });
  });

  it('refuses a request without the recipient legal name', async () => {
    const { call } = harness();
    const response = await call('POST', '/packs/alpha/offer', { body: { licenseVersion: '2026-11' } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'recipientLegalName is required.' });
  });

  it('refuses a request without the license version, and a body that is not JSON', async () => {
    const { call } = harness();
    expect((await call('POST', '/packs/alpha/offer', { body: { recipientLegalName: 'Ada' } })).status).toBe(400);
    expect((await call('POST', '/packs/alpha/offer', { body: { recipientLegalName: '  ', licenseVersion: 'v' } })).status).toBe(400);
    const notJson = await call('POST', '/packs/alpha/offer');
    expect(notJson.status).toBe(400);
  });

  it('returns the customerRef once and never logs it', async () => {
    server.use(...platformUp());
    const { call, lines } = harness();
    const first = await customerRefOf(await call('POST', '/packs/alpha/offer', { body: accept }));
    const second = await call('POST', '/packs/alpha/offer', { body: accept });
    const secondText = await second.text();
    expect(secondText).not.toContain(first);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(first);
    expect(lines.join('\n')).not.toContain(SDK_KEY);
    expect(lines.join('\n')).not.toContain('Ada Lovelace');
  });
});

describe('offer rate limit (driven clock)', () => {
  const offerOnce = (call: ReturnType<typeof harness>['call'], caller = 'caller-1') =>
    call('POST', '/packs/alpha/offer', { body: accept, caller });

  it('allows requests under and at the limit', async () => {
    server.use(...platformUp());
    const { call } = harness();
    for (let i = 0; i < OFFER_RATE_LIMIT; i += 1) expect((await offerOnce(call)).status).toBe(200);
  });

  it('refuses the request over the limit, per caller', async () => {
    server.use(...platformUp());
    const { call } = harness();
    for (let i = 0; i < OFFER_RATE_LIMIT; i += 1) await offerOnce(call);
    const over = await offerOnce(call);
    expect(over.status).toBe(OFFER_RATE_REFUSAL_STATUS);
    expect(await over.json()).toEqual({ error: 'Too many offer requests. Try again later.' });
    expect((await offerOnce(call, 'caller-2')).status).toBe(200);
  });

  it('counts a refused request toward the limit even before the body is read', async () => {
    const { call } = harness();
    for (let i = 0; i < OFFER_RATE_LIMIT; i += 1) await call('POST', '/packs/alpha/offer', { body: {} });
    expect((await call('POST', '/packs/alpha/offer', { body: accept })).status).toBe(OFFER_RATE_REFUSAL_STATUS);
  });

  it('resets when the window ends and not before', async () => {
    server.use(...platformUp());
    const { call, advance } = harness();
    for (let i = 0; i < OFFER_RATE_LIMIT; i += 1) await offerOnce(call);
    advance(OFFER_RATE_WINDOW_MS - 1);
    expect((await offerOnce(call)).status).toBe(OFFER_RATE_REFUSAL_STATUS);
    advance(1);
    expect((await offerOnce(call)).status).toBe(200);
  });
});

describe('credits and reservations (step 9)', () => {
  it('reads the balance with the customer ref from a header', async () => {
    let key: string | null = null;
    server.use(
      http.get(`${API}/billing/credits/${REF}`, ({ request }) => {
        key = request.headers.get('X-Agent-SDK-Key');
        return HttpResponse.json({ creditsAvailable: 3, creditsHeld: 0, creditsRemaining: 3, customerRef: REF, livemode: false });
      }),
    );
    const { call, lines } = harness();
    const response = await call('GET', '/credits', { headers: refHeader });
    expect(await response.json()).toMatchObject({ creditsAvailable: 3 });
    expect(key).toBe(SDK_KEY);
    expect(lines.join('\n')).not.toContain(REF);
  });

  it('refuses a balance read without a well-formed customer ref', async () => {
    const { call } = harness();
    expect((await call('GET', '/credits')).status).toBe(400);
    expect((await call('GET', '/credits', { headers: [['X-Customer-Ref', 'short']] })).status).toBe(400);
  });

  it('reserves one credit for 300 seconds under the caller idempotency key, and generates one when absent', async () => {
    const seen: { body: unknown; key: string | null }[] = [];
    server.use(
      http.post(`${API}/billing/credits/reservations`, async ({ request }) => {
        seen.push({ body: await request.json(), key: request.headers.get('Idempotency-Key') });
        return HttpResponse.json({ credits: 1, expiresAt: 't', replayCount: 0, replayed: false, reservationId: 'rv_1', status: 'HELD' });
      }),
    );
    const { call } = harness();
    const given = '3f6c1b1e-0d7a-4c55-9d6e-2a1b4c5d6e7f';
    expect((await call('POST', '/credits/reservations', { headers: [...refHeader, ['Idempotency-Key', given]] })).status).toBe(200);
    expect((await call('POST', '/credits/reservations', { headers: refHeader })).status).toBe(200);
    expect(seen[0]).toEqual({ body: { customerRef: REF, credits: 1, ttlSeconds: 300 }, key: given });
    expect(seen[1]?.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a reservation without a customer ref or with a key that is not a UUID', async () => {
    const { call } = harness();
    expect((await call('POST', '/credits/reservations')).status).toBe(400);
    expect((await call('POST', '/credits/reservations', { headers: [...refHeader, ['Idempotency-Key', 'nope']] })).status).toBe(400);
  });

  it('commits and releases a reservation', async () => {
    server.use(
      platform('/billing/credits/reservations/rv_1/commit', 200, { committedCredits: 1, creditsRemaining: 2, replayed: false, reservationId: 'rv_1', status: 'COMMITTED' }),
      platform('/billing/credits/reservations/rv_1/release', 200, { replayed: false, reservationId: 'rv_1', status: 'RELEASED' }),
    );
    const { call } = harness();
    expect(await (await call('POST', '/credits/reservations/rv_1/commit')).json()).toMatchObject({ status: 'COMMITTED' });
    expect(await (await call('POST', '/credits/reservations/rv_1/release')).json()).toMatchObject({ status: 'RELEASED' });
    expect((await call('POST', '/credits/reservations/rv_1/other')).status).toBe(404);
    expect((await call('GET', '/credits/elsewhere')).status).toBe(404);
  });
});

describe('platform refusals map to one seller status each', () => {
  const LEAK = 'platform secret text aorsk_leak';
  const classes: [number, number][] = [
    [400, 400],
    [401, 502],
    [403, 502],
    [402, 402],
    [404, 404],
    [410, 404],
    [409, 409],
    [422, 409],
    [423, 409],
    [429, 503],
    [500, 502],
  ];

  it.each(classes)('platform %i answers %i with a one-line body and no platform text, key, or customerRef', async (platformStatus, sellerStatus) => {
    server.use(platform('/billing/customers', platformStatus, { title: LEAK, detail: LEAK, customerRef: REF }));
    const { call, lines } = harness();
    const response = await call('POST', '/packs/alpha/offer', { body: accept });
    const text = await response.text();
    expect(response.status).toBe(sellerStatus);
    expect(text).toMatch(/^\{"error":"[^"]*"\}$/);
    expect(text).not.toMatch(/leak|secret|aorsk_|c_/);
    expect(text).not.toContain(REF);
    expect(lines.join('\n')).not.toContain('leak');
  });

  it('answers 502 when the platform cannot be reached', async () => {
    server.use(http.post(`${API}/billing/customers`, () => HttpResponse.error()));
    const { call } = harness();
    expect((await call('POST', '/packs/alpha/offer', { body: accept })).status).toBe(502);
  });

  it('maps a refusal on the offer, balance, reserve, commit, and release calls the same way', async () => {
    server.use(
      platform('/billing/customers', 201, customer),
      platform('/billing/offers', 409, {}),
      platform(`/billing/credits/${REF}`, 404, {}, 'get'),
      platform('/billing/credits/reservations', 409, {}),
      platform('/billing/credits/reservations/rv_1/commit', 410, {}),
      platform('/billing/credits/reservations/rv_1/release', 429, {}),
    );
    const { call } = harness();
    expect((await call('POST', '/packs/alpha/offer', { body: accept })).status).toBe(409);
    expect((await call('GET', '/credits', { headers: refHeader })).status).toBe(404);
    expect((await call('POST', '/credits/reservations', { headers: refHeader })).status).toBe(409);
    expect((await call('POST', '/credits/reservations/rv_1/commit')).status).toBe(404);
    expect((await call('POST', '/credits/reservations/rv_1/release')).status).toBe(503);
  });
});
