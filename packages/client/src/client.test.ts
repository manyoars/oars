import { describe, expect, it } from 'vitest';
import { createOarsClient, DEFAULT_API_URL } from './client.js';

const registerBody = {
  name: 'Paid API',
  services: [{ name: 'api', image: 'ghcr.io/manyoars/paid-api@sha256:0123', cpuMillicores: 250, memoryMib: 256 }],
};

// Records every request the client sends and answers each with an empty JSON object.
const recorder = () => {
  const requests: Request[] = [];
  const fetch = (request: Request): Promise<Response> => {
    requests.push(request);
    return Promise.resolve(Response.json({}));
  };
  return { requests, fetch };
};

describe('createOarsClient', () => {
  it('sends the bearer token on every request', async () => {
    const { requests, fetch } = recorder();
    const client = createOarsClient({ version: '1.2.3', token: 'oak_secret', fetch });

    await client.GET('/agents/workloads/{workloadId}', { params: { path: { workloadId: 'w-1' } } });
    await client.POST('/agents/workloads', { body: registerBody });

    expect(requests.map((request) => request.headers.get('authorization'))).toEqual(['Bearer oak_secret', 'Bearer oak_secret']);
  });

  it('sends no Authorization header when no token is set', async () => {
    const { requests, fetch } = recorder();
    const client = createOarsClient({ version: '1.2.3', fetch });

    await client.GET('/agents/workloads/{workloadId}', { params: { path: { workloadId: 'w-1' } } });

    expect(requests[0]?.headers.has('authorization')).toBe(false);
  });

  it('sends User-Agent oars/<version>', async () => {
    const { requests, fetch } = recorder();
    const client = createOarsClient({ version: '1.2.3', fetch });

    await client.GET('/agents/workloads/{workloadId}', { params: { path: { workloadId: 'w-1' } } });

    expect(requests[0]?.headers.get('user-agent')).toBe('oars/1.2.3');
  });

  it('sends a fresh Idempotency-Key on a mutation that names none', async () => {
    const { requests, fetch } = recorder();
    const client = createOarsClient({ version: '1.2.3', fetch });

    await client.POST('/agents/workloads', { body: registerBody });
    await client.POST('/agents/workloads/{workloadId}/deploy', { params: { path: { workloadId: 'w-1' } } });

    const keys = requests.map((request) => request.headers.get('idempotency-key'));
    expect(keys).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/), expect.stringMatching(/^[0-9a-f-]{36}$/)]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('keeps the Idempotency-Key a caller names, so a retry replays', async () => {
    const { requests, fetch } = recorder();
    const client = createOarsClient({ version: '1.2.3', fetch });

    await client.POST('/agents/workloads', { body: registerBody, headers: { 'Idempotency-Key': 'base:register' } });
    await client.POST('/agents/workloads', { body: registerBody, headers: { 'Idempotency-Key': 'base:register' } });

    expect(requests.map((request) => request.headers.get('idempotency-key'))).toEqual(['base:register', 'base:register']);
  });

  it('sends no Idempotency-Key on a read', async () => {
    const { requests, fetch } = recorder();
    const client = createOarsClient({ version: '1.2.3', fetch });

    await client.GET('/agents/workloads/{workloadId}', { params: { path: { workloadId: 'w-1' } } });

    expect(requests[0]?.headers.has('idempotency-key')).toBe(false);
  });

  it('calls the production API unless told otherwise', async () => {
    const { requests, fetch } = recorder();
    const client = createOarsClient({ version: '1.2.3', fetch });

    await client.GET('/agents/workloads/{workloadId}', { params: { path: { workloadId: 'w-1' } } });

    expect(DEFAULT_API_URL).toBe('https://api.manyoars.com');
    expect(requests[0]?.url).toBe('https://api.manyoars.com/agents/workloads/w-1');
  });

  it('calls the base URL it is given', async () => {
    const { requests, fetch } = recorder();
    const client = createOarsClient({ version: '1.2.3', baseUrl: 'http://localhost:4010', fetch });

    await client.GET('/agents/workloads/{workloadId}', { params: { path: { workloadId: 'w-1' } } });

    expect(requests[0]?.url).toBe('http://localhost:4010/agents/workloads/w-1');
  });
});
