import { describe, expect, it } from 'vitest';
import { createOarsClient } from './client.js';
import { datasets } from './datasets.js';

const LISTING_ID = '0b6c1f0e-2d4f-4f9a-8a53-5f0d3b1d2c99';
const page = { content: [{ listingId: LISTING_ID, priceRef: 'pack-100' }], empty: false, number: 0, size: 20 };

// Records every request and answers each with `answer`, so a test sees the call the generated operation makes.
const recorder = (answer: Response) => {
  const requests: Request[] = [];
  const fetch = (request: Request): Promise<Response> => {
    requests.push(request);
    return Promise.resolve(answer.clone());
  };
  return { requests, client: createOarsClient({ version: '1.2.3', baseUrl: 'http://localhost:4010', fetch }) };
};

describe('datasets.search', () => {
  it('reads GET /billing/datasets with no credential and no query when none is named', async () => {
    const { requests, client } = recorder(Response.json(page));

    const result = await datasets.search(client, {});

    const [request] = requests;
    expect(request?.method).toBe('GET');
    expect(request?.url).toBe('http://localhost:4010/billing/datasets');
    expect(request?.headers.get('authorization')).toBeNull();
    expect(request?.headers.get('x-agent-sdk-key')).toBeNull();
    expect(result.data).toEqual(page);
  });

  it('sends each filter under the name the platform reads', async () => {
    const { requests, client } = recorder(Response.json(page));

    await datasets.search(client, { q: 'rust', harness: 'claude-code', permittedUse: 'evaluation', training: 'included', maxPricePerFetchUsd: 2.5, page: 1, size: 5 });

    const url = new URL(requests[0]?.url ?? '');
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'rust', harness: 'claude-code', permittedUse: 'evaluation', training: 'included', maxPricePerFetchUsd: '2.5', page: '1', size: '5' });
  });

  it('hands back a refusal as error with the response, and does not throw', async () => {
    const { client } = recorder(Response.json({ code: 'INVALID' }, { status: 400, headers: { 'content-type': 'application/problem+json' } }));

    const result = await datasets.search(client, { training: 'bogus' });

    expect(result.response.status).toBe(400);
    expect(result.data).toBeUndefined();
    expect(result.error).toBeDefined();
  });
});

describe('datasets.get', () => {
  it('reads GET /billing/datasets/{listingId}', async () => {
    const { requests, client } = recorder(Response.json(page.content[0]));

    const result = await datasets.get(client, { listingId: LISTING_ID });

    expect(requests[0]?.url).toBe(`http://localhost:4010/billing/datasets/${LISTING_ID}`);
    expect(result.data).toEqual(page.content[0]);
  });

  it('hands back a 404 DATASET_NOT_FOUND as error', async () => {
    const { client } = recorder(Response.json({ code: 'DATASET_NOT_FOUND' }, { status: 404, headers: { 'content-type': 'application/problem+json' } }));

    const result = await datasets.get(client, { listingId: LISTING_ID });

    expect(result.response.status).toBe(404);
    expect(result.error).toBeDefined();
  });
});
