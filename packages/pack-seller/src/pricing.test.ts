import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { createOarsClient } from '@manyoars/oars-client';
import { amountFrom, ensurePrice, MAX_DISPLAY_NAME_LENGTH, MAX_PRICE_REF_LENGTH, PACK_CREDITS, priceInputFor, PricingError } from './pricing.js';
import { API, server, useServer } from './test-support.js';

useServer();

const WORKLOAD = '0b1c2d3e-0000-4000-8000-000000000001';
const PATH = `${API}/billing/agents/${WORKLOAD}/prices`;
const view = { active: true, amountUsd: '19.00', createdAt: '2026-11-16T00:00:00Z', displayName: 'Alpha pack', kind: 'CREDIT_PACK', priceRef: 'pack-alpha', updatedAt: '2026-11-16T00:00:00Z' };
const clientFor = () => createOarsClient({ version: 'test', baseUrl: API, token: 'operator-token' });
const input = priceInputFor({ packId: 'alpha', title: 'Alpha pack' }, '19.00');

describe('priceInputFor', () => {
  it('maps a pack to a CREDIT_PACK price with the named credits and the configured amount', () => {
    expect(PACK_CREDITS).toBe(3);
    expect(input).toEqual({ priceRef: 'pack-alpha', displayName: 'Alpha pack', kind: 'CREDIT_PACK', credits: 3, amountUsd: '19.00' });
  });

  it('accepts a priceRef of exactly 64 characters and a title of exactly 120', () => {
    const packId = 'a'.repeat(MAX_PRICE_REF_LENGTH - 'pack-'.length);
    expect(priceInputFor({ packId, title: 't'.repeat(MAX_DISPLAY_NAME_LENGTH) }, '1').priceRef).toHaveLength(MAX_PRICE_REF_LENGTH);
  });

  it('refuses a priceRef over 64 characters', () => {
    const packId = 'a'.repeat(MAX_PRICE_REF_LENGTH - 'pack-'.length + 1);
    expect(() => priceInputFor({ packId, title: 'T' }, '1')).toThrow(PricingError);
    expect(() => priceInputFor({ packId, title: 'T' }, '1')).toThrow(/64/);
  });

  it('refuses a title over 120 characters', () => {
    expect(() => priceInputFor({ packId: 'alpha', title: 't'.repeat(MAX_DISPLAY_NAME_LENGTH + 1) }, '1')).toThrow(/120/);
  });

  it('refuses a packId the platform would not accept as a priceRef', () => {
    expect(() => priceInputFor({ packId: 'Alpha Pack', title: 'T' }, '1')).toThrow(PricingError);
  });

  it('refuses a blank title', () => {
    expect(() => priceInputFor({ packId: 'alpha', title: '  ' }, '1')).toThrow(PricingError);
  });
});

describe('amountFrom', () => {
  it('takes the amount from operator configuration', () => {
    expect(amountFrom({ OARS_SELLER_PRICE_USD: ' 19.00 ' })).toBe('19.00');
  });

  it('refuses a missing, zero, negative, or malformed amount, naming the variable', () => {
    for (const value of [undefined, '', '0', '0.00', '-5', 'ten', '1.999']) {
      expect(() => amountFrom({ OARS_SELLER_PRICE_USD: value })).toThrow(/OARS_SELLER_PRICE_USD/);
    }
  });
});

describe('ensurePrice', () => {
  it('creates the price and reports it created', async () => {
    const seen: unknown[] = [];
    server.use(
      http.post(PATH, async ({ request }) => {
        seen.push(await request.json(), request.headers.get('Authorization'));
        return HttpResponse.json(view, { status: 201 });
      }),
    );
    expect(await ensurePrice(clientFor(), WORKLOAD, input)).toBe('created');
    expect(seen).toEqual([input, 'Bearer operator-token']);
  });

  it('leaves a price that already exists alone', async () => {
    server.use(http.post(PATH, () => HttpResponse.json(view, { status: 200 })));
    expect(await ensurePrice(clientFor(), WORKLOAD, input)).toBe('present');
  });

  it('leaves a price that exists with other terms alone and says so', async () => {
    server.use(http.post(PATH, () => HttpResponse.json({ code: 'IDEMPOTENCY_CONFLICT' }, { status: 409 })));
    expect(await ensurePrice(clientFor(), WORKLOAD, input)).toBe('differs');
  });

  it('refuses any other platform answer without echoing it', async () => {
    server.use(http.post(PATH, () => HttpResponse.json({ detail: 'secret detail' }, { status: 403 })));
    await expect(ensurePrice(clientFor(), WORKLOAD, input)).rejects.toThrow(/403/);
    await expect(ensurePrice(clientFor(), WORKLOAD, input)).rejects.not.toThrow(/secret detail/);
  });
});
