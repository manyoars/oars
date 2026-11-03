import { describe, expect, it } from 'vitest';
import { createOarsClient } from './client.js';
import type { components } from './generated/schema.js';

type Key = components['schemas']['DeveloperApiKeyResponse'];

const workloadId = '3f1c2a9e-5b7d-4e8a-9c01-6d2b7a8e4f10';
const keyId = '0b9d6c1e-2f4a-4a3b-8d5e-7c1f9a2b3c4d';

// A stand-in for the platform's key endpoints: it keeps what create is sent and answers list and revoke from it, so the test
// shows the workload id survives the client's request and response types, not only the wire.
const fakePlatform = () => {
  const keys: Key[] = [];
  const requests: Request[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    requests.push(request.clone());
    const { pathname } = new URL(request.url);
    if (request.method === 'POST' && pathname === '/me/api-keys') {
      const sent = await request.json();
      const scope = typeof sent === 'object' && sent !== null && 'workloadId' in sent && typeof sent.workloadId === 'string' ? sent.workloadId : undefined;
      const key: Key = {
        keyId,
        name: 'agent runtime',
        prefix: 'oak_3f1c',
        authorities: ['AGENT_OPERATE'],
        status: 'ACTIVE',
        createdAt: '2026-11-03T12:00:00Z',
        ...(scope === undefined ? {} : { workloadId: scope }),
      };
      keys.push(key);
      return Response.json({ key, replayed: false, secret: 'oak_secret' }, { status: 201 });
    }
    if (request.method === 'GET' && pathname === '/me/api-keys') return Response.json({ content: keys });
    if (request.method === 'DELETE' && pathname === `/me/api-keys/${keyId}`) {
      keys.splice(0, keys.length);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  };
  return { keys, requests, fetch };
};

describe('workload-scoped API keys', () => {
  it('round-trips the workload id through create, list, and revoke', async () => {
    const { requests, fetch } = fakePlatform();
    const client = createOarsClient({ version: '1.2.3', token: 'oak_owner', fetch });

    const created = await client.POST('/me/api-keys', {
      params: { header: { 'Idempotency-Key': 'key:create' } },
      body: { name: 'agent runtime', authorities: ['AGENT_OPERATE'], workloadId },
    });
    expect(await requests[0]?.json()).toMatchObject({ workloadId });
    expect(created.data?.key.workloadId).toBe(workloadId);
    expect(created.data?.secret).toBe('oak_secret');

    const listed = await client.GET('/me/api-keys', { params: { query: {} } });
    expect(listed.data?.content.map((key) => key.workloadId)).toEqual([workloadId]);

    const revoked = await client.DELETE('/me/api-keys/{keyId}', { params: { path: { keyId } } });
    expect(revoked.response.status).toBe(204);
    expect(requests[2]?.method).toBe('DELETE');
    expect(requests[2]?.url).toBe(`https://api.manyoars.com/me/api-keys/${keyId}`);
  });

  it('leaves workloadId off an ordinary key', async () => {
    const { requests, fetch } = fakePlatform();
    const client = createOarsClient({ version: '1.2.3', fetch });

    const created = await client.POST('/me/api-keys', {
      params: { header: { 'Idempotency-Key': 'ci:create' } },
      body: { name: 'ci', authorities: ['AGENT_OPERATE'] },
    });

    expect(await requests[0]?.json()).not.toHaveProperty('workloadId');
    expect(created.data?.key.workloadId).toBeUndefined();
  });
});
