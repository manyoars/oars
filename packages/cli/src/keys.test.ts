import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { ExitCode } from './errors.js';
import { API, harness, ISSUER, server, useServer } from './test-support.js';

useServer();

const WORKLOAD = '3f1c2a9e-5b7d-4e8a-9c01-6d2b7a8e4f10';
const KEY_ID = '7d0c1f52-9a4e-4c3b-8e21-5f6a9b0c1d2e';
const problemJson = { 'Content-Type': 'application/problem+json' };

const keyView = (fields: object) => ({
  keyId: KEY_ID,
  name: 'agent',
  prefix: 'oars_ab12',
  status: 'ACTIVE',
  authorities: ['AGENT_OPERATE', 'AGENT_READ'],
  createdAt: '2026-11-03T00:00:00Z',
  ...fields,
});

// Creating and revoking a key need a signed-in person, so the happy paths run from a seeded login rather than OARS_API_KEY.
const signedIn = async (env: NodeJS.ProcessEnv = {}) => {
  const h = harness(env);
  await h.deps.store.write({ issuerUrl: ISSUER, apiUrl: API, email: 'dev@example.com', refreshToken: 'r', accessToken: 'session-token', expiresAt: '2099-01-01T00:00:00Z' });
  return h;
};

const humanSessionRequired = () => HttpResponse.json({ code: 'HUMAN_SESSION_REQUIRED', title: 'A signed-in person is required' }, { status: 403, headers: problemJson });

interface Seen {
  body: unknown;
  idempotencyKey: string | null;
  authorization: string | null;
}

const create = (answer: () => Response) => {
  const seen: Seen[] = [];
  server.use(
    http.post(`${API}/me/api-keys`, async ({ request }) => {
      seen.push({ body: await request.json(), idempotencyKey: request.headers.get('Idempotency-Key'), authorization: request.headers.get('Authorization') });
      return answer();
    }),
  );
  return seen;
};

describe('oars keys create', () => {
  it('--workload scopes the key, sends the scoped authorities, and prints the secret once', async () => {
    const h = await signedIn();
    const seen = create(() => HttpResponse.json({ key: keyView({ workloadId: WORKLOAD }), replayed: false, secret: 'oars_secret_1' }, { status: 201 }));

    expect(await run(['keys', 'create', '--name', 'agent', '--workload', WORKLOAD], h.deps)).toBe(ExitCode.OK);

    expect(seen[0]?.body).toEqual({ name: 'agent', authorities: ['AGENT_OPERATE', 'AGENT_READ'], workloadId: WORKLOAD });
    expect(seen[0]?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[0]?.authorization).toBe('Bearer session-token');
    expect(h.out.join('')).toContain('Secret (shown once; save it now): oars_secret_1');
    expect(h.out.join('')).toContain(`workload ${WORKLOAD}`);
  });

  it('without --workload sends no workloadId, honors --authority and --expires-in-days, and --json prints key and secret', async () => {
    const h = await signedIn();
    const seen = create(() => HttpResponse.json({ key: keyView({ authorities: ['AGENT_READ'] }), replayed: false, secret: 's3' }, { status: 201 }));

    expect(await run(['keys', 'create', '--name', 'agent', '--authority', 'AGENT_READ', '--expires-in-days', '30', '--json'], h.deps)).toBe(ExitCode.OK);

    expect(seen[0]?.body).toEqual({ name: 'agent', authorities: ['AGENT_READ'], expiresInDays: 30 });
    expect(JSON.parse(h.out[0] ?? '')).toMatchObject({ ok: true, secret: 's3', key: { keyId: KEY_ID } });
  });

  it('prints "all workloads" and "no expiry" for an ordinary key with no expiry', async () => {
    const h = await signedIn();
    create(() => HttpResponse.json({ key: keyView({}), replayed: false, secret: 's' }, { status: 201 }));

    await run(['keys', 'create', '--name', 'agent'], h.deps);

    expect(h.out.join('')).toContain('all workloads');
    expect(h.out.join('')).toContain('no expiry');
  });

  it('a replay carries no secret: exit 5 and says to revoke and create another', async () => {
    const h = await signedIn();
    create(() => HttpResponse.json({ key: keyView({}), replayed: true }));

    expect(await run(['keys', 'create', '--name', 'agent', '--idempotency-key', 'K'], h.deps)).toBe(ExitCode.CONFLICT);
    expect(h.err.join('')).toContain('Revoke it and create another');
    // A lost response followed by a retry lands here: the id is the only way to tell which key it was.
    expect(h.err.join('')).toContain(KEY_ID);
  });

  it('a key asking for more than a workload may carry is exit 4 with the platform code', async () => {
    const h = await signedIn();
    create(() => HttpResponse.json({ code: 'API_KEY_WORKLOAD_SCOPE_EXCEEDS_CAP', title: 'Too many authorities' }, { status: 400, headers: problemJson }));

    expect(await run(['keys', 'create', '--name', 'agent', '--workload', WORKLOAD, '--authority', 'AGENT_DEPLOY', '--json'], h.deps)).toBe(ExitCode.INVALID);
    expect(JSON.parse(h.out[0] ?? '')).toMatchObject({ ok: false, step: 'keys-create', problem: { code: 'API_KEY_WORKLOAD_SCOPE_EXCEEDS_CAP' } });
  });

  it('--name is required', async () => {
    const h = await signedIn();
    expect(await run(['keys', 'create'], h.deps)).toBe(ExitCode.USAGE);
  });
});

describe('oars keys list', () => {
  it('prints each key, scoped or not', async () => {
    const h = await signedIn();
    server.use(http.get(`${API}/me/api-keys`, () => HttpResponse.json({ content: [keyView({ workloadId: WORKLOAD }), keyView({ keyId: 'k2', expiresAt: '2027-01-01T00:00:00Z' })], last: true })));

    expect(await run(['keys', 'list'], h.deps)).toBe(ExitCode.OK);

    const lines = h.out.join('').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`workload ${WORKLOAD}`);
    expect(lines[1]).toContain('all workloads');
    expect(lines[1]).toContain('expires 2027-01-01');
  });

  it('--json carries the keys and reads every page; no keys says so', async () => {
    const h = await signedIn();
    const pages: string[] = [];
    server.use(
      http.get(`${API}/me/api-keys`, ({ request }) => {
        const page = new URL(request.url).searchParams.get('page') ?? '';
        pages.push(page);
        return HttpResponse.json({ content: [keyView({ keyId: `k${page}` })], last: page === '1' });
      }),
    );

    expect(await run(['keys', 'list', '--json'], h.deps)).toBe(ExitCode.OK);
    expect(pages).toEqual(['0', '1']);
    expect(JSON.parse(h.out[0] ?? '')).toMatchObject({ ok: true, keys: [{ keyId: 'k0' }, { keyId: 'k1' }] });

    const empty = await signedIn();
    server.use(http.get(`${API}/me/api-keys`, () => HttpResponse.json({ content: [], last: true })));
    await run(['keys', 'list'], empty.deps);
    expect(empty.out.join('')).toBe('You have no API keys.\n');
  });
});

describe('oars keys revoke', () => {
  it('DELETEs the key by id and says so', async () => {
    const h = await signedIn();
    const urls: string[] = [];
    server.use(
      http.delete(`${API}/me/api-keys/${KEY_ID}`, ({ request }) => {
        urls.push(new URL(request.url).pathname);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    expect(await run(['keys', 'revoke', KEY_ID], h.deps)).toBe(ExitCode.OK);
    expect(urls).toEqual([`/me/api-keys/${KEY_ID}`]);
    expect(h.out.join('')).toBe(`Revoked key ${KEY_ID}.\n`);
  });

  it('--json prints the revoked id; a missing key is the platform problem', async () => {
    const h = await signedIn();
    server.use(http.delete(`${API}/me/api-keys/${KEY_ID}`, () => new HttpResponse(null, { status: 204 })));
    expect(await run(['keys', 'revoke', KEY_ID, '--json'], h.deps)).toBe(ExitCode.OK);
    expect(JSON.parse(h.out[0] ?? '')).toEqual({ ok: true, keyId: KEY_ID, revoked: true });

    const gone = await signedIn();
    server.use(http.delete(`${API}/me/api-keys/${KEY_ID}`, () => HttpResponse.json({ code: 'API_KEY_NOT_FOUND', title: 'No such key' }, { status: 404, headers: problemJson })));
    // A 404 has no exit code of its own, so exitCodeForProblem maps it to UNEXPECTED (1).
    expect(await run(['keys', 'revoke', KEY_ID, '--json'], gone.deps)).toBe(ExitCode.UNEXPECTED);
    expect(JSON.parse(gone.out[0] ?? '')).toMatchObject({ ok: false, step: 'keys-revoke', problem: { code: 'API_KEY_NOT_FOUND' } });
  });
});

describe('an API key cannot create or revoke keys', () => {
  it('create with OARS_API_KEY set is exit 3 carrying HUMAN_SESSION_REQUIRED', async () => {
    const h = harness({ OARS_API_KEY: 'agent-key' });
    const seen = create(humanSessionRequired);

    expect(await run(['keys', 'create', '--name', 'agent', '--json'], h.deps)).toBe(ExitCode.AUTH);

    expect(seen[0]?.authorization).toBe('Bearer agent-key');
    expect(JSON.parse(h.out[0] ?? '')).toMatchObject({ ok: false, step: 'keys-create', problem: { code: 'HUMAN_SESSION_REQUIRED' } });
  });

  it('revoke with OARS_API_KEY set is exit 3 carrying HUMAN_SESSION_REQUIRED', async () => {
    const h = harness({ OARS_API_KEY: 'agent-key' });
    server.use(http.delete(`${API}/me/api-keys/${KEY_ID}`, humanSessionRequired));

    expect(await run(['keys', 'revoke', KEY_ID, '--json'], h.deps)).toBe(ExitCode.AUTH);
    expect(JSON.parse(h.out[0] ?? '')).toMatchObject({ ok: false, step: 'keys-revoke', problem: { code: 'HUMAN_SESSION_REQUIRED' } });
  });
});
