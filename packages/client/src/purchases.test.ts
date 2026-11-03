import { describe, expect, it } from 'vitest';
import { createOarsClient } from './client.js';
import { purchases } from './purchases.js';

const PURCHASE_ID = '3f6c1a52-8d0e-4f55-9a53-6f0d3b1d2c11';
const view = { purchaseId: PURCHASE_ID, status: 'PENDING', credits: 500 };

// Records every request and answers each with `answer`, so a test sees the call the generated operation makes.
const recorder = (answer: Response = Response.json(view, { status: 201 })) => {
  const requests: Request[] = [];
  const fetch = (request: Request): Promise<Response> => {
    requests.push(request);
    return Promise.resolve(answer.clone());
  };
  return { requests, client: createOarsClient({ version: '1.2.3', baseUrl: 'http://localhost:4010', fetch }) };
};

describe('purchases.buy', () => {
  it('posts the offer and price to POST /billing/purchases with the buyer SDK key', async () => {
    const { requests, client } = recorder();

    const result = await purchases.buy(client, { sdkKey: 'aorsk_buyer', offerId: 'po_abc', priceRef: 'pack-500' });

    const [request] = requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('http://localhost:4010/billing/purchases');
    expect(request?.headers.get('x-agent-sdk-key')).toBe('aorsk_buyer');
    expect(await request?.json()).toEqual({ offerId: 'po_abc', priceRef: 'pack-500' });
    expect(result.data).toEqual(view);
    expect(result.response.status).toBe(201);
  });

  it('sends an Idempotency-Key on every buy, a fresh one each time when none is named', async () => {
    const { requests, client } = recorder();

    await purchases.buy(client, { sdkKey: 'aorsk_buyer', offerId: 'po_abc', priceRef: 'pack-500' });
    await purchases.buy(client, { sdkKey: 'aorsk_buyer', offerId: 'po_abc', priceRef: 'pack-500' });

    const keys = requests.map((request) => request.headers.get('idempotency-key'));
    expect(keys).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/), expect.stringMatching(/^[0-9a-f-]{36}$/)]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('keeps the Idempotency-Key a caller names, so a retry returns the same purchase', async () => {
    const { requests, client } = recorder();
    const idempotencyKey = '0b6c1f0e-2d4f-4f9a-8a53-5f0d3b1d2c99';

    await purchases.buy(client, { sdkKey: 'aorsk_buyer', offerId: 'po_abc', priceRef: 'pack-500', idempotencyKey });

    expect(requests[0]?.headers.get('idempotency-key')).toBe(idempotencyKey);
  });

  it('hands back the problem body of a refused buy', async () => {
    const problem = { type: 'PURCHASING_NOT_ENABLED', title: 'No approved cap', status: 409 };
    const { client } = recorder(Response.json(problem, { status: 409 }));

    const result = await purchases.buy(client, { sdkKey: 'aorsk_buyer', offerId: 'po_abc', priceRef: 'pack-500' });

    expect(result.data).toBeUndefined();
    expect(result.error).toEqual(problem);
    expect(result.response.status).toBe(409);
  });
});

describe('purchases.get', () => {
  it('reads GET /billing/purchases/{purchaseId} with the buyer SDK key and no Idempotency-Key', async () => {
    const { requests, client } = recorder(Response.json({ ...view, status: 'SUCCEEDED' }));

    const result = await purchases.get(client, { sdkKey: 'aorsk_buyer', purchaseId: PURCHASE_ID });

    const [request] = requests;
    expect(request?.method).toBe('GET');
    expect(request?.url).toBe(`http://localhost:4010/billing/purchases/${PURCHASE_ID}`);
    expect(request?.headers.get('x-agent-sdk-key')).toBe('aorsk_buyer');
    expect(request?.headers.has('idempotency-key')).toBe(false);
    expect(result.data?.status).toBe('SUCCEEDED');
  });
});
