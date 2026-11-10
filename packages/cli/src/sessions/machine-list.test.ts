// `oars pool machines` and `oars pool machines revoke <id>`, against a stand-in pool.
import { mkdirSync, writeFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { harness, server, useServer, type Harness } from '../test-support.js';
import { signInsFile } from './pool-replica.js';
import { cleanup, stage } from './test-support.js';

useServer();
afterEach(cleanup);

const POOL = 'https://pool.test';
const DAY = 86_400_000;
const EXPIRES = Date.parse('2027-02-01T10:00:00Z');

const scene = (signedIn = true): Harness => {
  const staged = stage();
  const h = harness({ OARS_POOL_URL: POOL });
  h.deps.sessions = staged.runtime;
  if (signedIn) {
    mkdirSync(staged.storeDir, { recursive: true });
    writeFileSync(signInsFile(staged.storeDir), JSON.stringify([{ server: POOL, account: 'acct_one', token: 'a-pool-credential', expiresAt: Date.now() + DAY, signingKey: { kty: 'OKP', crv: 'Ed25519', x: 'a-pinned-key' } }]));
  }
  return h;
};

const machine = (extra: object): object => ({ id: 'id-1', label: 'night runner', hostClass: 'vps', launcher: 'scheduled', allowRepos: [], state: 'active', expiresAt: EXPIRES, createdAt: 1, lastDepositDay: null, ...extra });

describe('oars pool machines', () => {
  it('says so when there are none', async () => {
    const h = scene();
    server.use(http.get(`${POOL}/v1/machines`, () => HttpResponse.json({ machines: [] })));
    expect(await run(['pool', 'machines'], h.deps)).toBe(0);
    expect(h.out.join('')).toContain('No machines are enrolled');
  });

  it('prints one line per machine: label, id, class, launcher, state, last deposit day, and expiry', async () => {
    const h = scene();
    let authorization: string | null = null;
    server.use(
      http.get(`${POOL}/v1/machines`, ({ request }) => {
        authorization = request.headers.get('authorization');
        return HttpResponse.json({ machines: [machine({ lastDepositDay: '2026-11-08' }), machine({ id: 'id-2', label: 'ci box', hostClass: 'ci', launcher: 'interactive', state: 'pending' })] });
      }),
    );
    expect(await run(['pool', 'machines'], h.deps)).toBe(0);
    expect(authorization).toBe('Bearer a-pool-credential');
    expect(h.out.join('').trimEnd().split('\n')).toEqual([
      'night runner  id-1  vps  scheduled  active  last deposit 2026-11-08  expires 2027-02-01',
      'ci box  id-2  ci  interactive  pending  last deposit never  expires 2027-02-01',
    ]);
  });

  it('says the pool did not answer with a list when a 200 has no machines array, not that it answered HTTP 200', async () => {
    const h = scene();
    server.use(http.get(`${POOL}/v1/machines`, () => HttpResponse.json({ ok: true })));
    await expect(run(['pool', 'machines'], h.deps)).resolves.toBe(1);
    expect(h.err.join('')).toContain('The pool did not answer with a list of machines.');
    expect(h.err.join('')).not.toContain('HTTP 200');
  });

  it('prints the machines as JSON', async () => {
    const h = scene();
    server.use(http.get(`${POOL}/v1/machines`, () => HttpResponse.json({ machines: [machine({})] })));
    expect(await run(['pool', 'machines', '--json'], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join(''))).toMatchObject({ ok: true, machines: [{ id: 'id-1', lastDepositDay: null }] });
  });

  it('needs the login', async () => {
    const h = scene(false);
    expect(await run(['pool', 'machines'], h.deps)).toBe(3);
    expect(h.err.join('')).toContain('oars pool login');
  });

  it('fails on a refusal and on a row it cannot read', async () => {
    const h = scene();
    server.use(http.get(`${POOL}/v1/machines`, () => HttpResponse.json({ error: 'unauthorized', message: 'Sign in with oars pool login first.' }, { status: 401 })));
    expect(await run(['pool', 'machines'], h.deps)).toBe(3);
    server.use(http.get(`${POOL}/v1/machines`, () => HttpResponse.json({ machines: [{ id: 'x' }, null] })));
    expect(await run(['pool', 'machines'], h.deps)).toBe(1);
    expect(h.err.join('')).toContain('cannot read');
  });
});

describe('oars pool machines revoke', () => {
  it('revokes the machine and says which', async () => {
    const h = scene();
    const asked: string[] = [];
    server.use(
      http.delete(`${POOL}/v1/machines/:id`, ({ params, request }) => {
        asked.push(`${String(params.id)} ${String(request.headers.get('authorization'))}`);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    expect(await run(['pool', 'machines', 'revoke', 'id-1'], h.deps)).toBe(0);
    expect(asked).toEqual(['id-1 Bearer a-pool-credential']);
    expect(h.out.join('')).toContain('Revoked machine id-1');
  });

  it('exits nonzero naming the id when the pool has no such machine', async () => {
    const h = scene();
    server.use(http.delete(`${POOL}/v1/machines/:id`, () => HttpResponse.json({ error: 'not_found', message: 'None.' }, { status: 404 })));
    expect(await run(['pool', 'machines', 'revoke', 'no-such'], h.deps)).toBe(2);
    expect(h.err.join('')).toContain('No machine no-such');
  });

  it('fails on any other answer, and needs the login', async () => {
    const h = scene();
    server.use(http.delete(`${POOL}/v1/machines/:id`, () => HttpResponse.json({ error: 'unauthorized', message: 'Sign in.' }, { status: 401 })));
    expect(await run(['pool', 'machines', 'revoke', 'id-1'], h.deps)).toBe(3);
    expect(await run(['pool', 'machines', 'revoke', 'id-1', '--server', POOL], scene(false).deps)).toBe(3);
  });
});
