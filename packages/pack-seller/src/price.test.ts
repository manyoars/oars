import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { ENV_WORKLOAD_ID, runPrice } from './price.js';
import { API, SDK_KEY, server, useServer } from './test-support.js';
import { cleanWorlds, envOf, makeWorld } from './test-world.js';

useServer();
afterEach(cleanWorlds);

const WORKLOAD = '0b1c2d3e-0000-4000-8000-000000000001';
const TOKEN = 'operator-token-secret-value';
const PATH = `${API}/billing/agents/${WORKLOAD}/prices`;
const view = { active: true, amountUsd: '19.00', createdAt: '2026-11-16T00:00:00Z', displayName: 'Alpha pack', kind: 'CREDIT_PACK', priceRef: 'pack-alpha', updatedAt: '2026-11-16T00:00:00Z' };

const env = async (extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> => ({
  ...envOf((await makeWorld()).inputs),
  OARS_SELLER_API_URL: API,
  OARS_SELLER_SDK_KEY: SDK_KEY,
  [ENV_WORKLOAD_ID]: WORKLOAD,
  OARS_SELLER_PRICE_USD: '19.00',
  ...extra,
});
const deps = { token: () => Promise.resolve(TOKEN) };
const scan = (lines: string[]): void => {
  for (const secret of [TOKEN, SDK_KEY, 'Bearer']) expect(lines.join('\n')).not.toContain(secret);
};

describe('runPrice', () => {
  it('creates the price of each pack under the operator token and prints one line with the price id', async () => {
    const seen: unknown[] = [];
    server.use(
      http.post(PATH, async ({ request }) => {
        seen.push(await request.json(), request.headers.get('Authorization'), request.headers.get('X-Agent-SDK-Key'));
        return HttpResponse.json(view, { status: 201 });
      }),
    );
    const result = await runPrice(await env(), deps);
    expect(result).toEqual({ ok: true, lines: ['Price pack-alpha created.'] });
    expect(seen).toEqual([{ priceRef: 'pack-alpha', displayName: 'Alpha pack', kind: 'CREDIT_PACK', credits: 3, amountUsd: '19.00' }, `Bearer ${TOKEN}`, null]);
    scan(result.lines);
  });

  it('creates nothing on a second run: the platform replays the price', async () => {
    let calls = 0;
    server.use(
      http.post(PATH, () => {
        calls += 1;
        return HttpResponse.json(view, { status: calls === 1 ? 201 : 200 });
      }),
    );
    const settings = await env();
    expect((await runPrice(settings, deps)).lines).toEqual(['Price pack-alpha created.']);
    const second = await runPrice(settings, deps);
    expect(second).toEqual({ ok: true, lines: ['Price pack-alpha already exists.'] });
    scan(second.lines);
  });

  it('leaves a price that exists with other terms alone and exits with a failure', async () => {
    server.use(http.post(PATH, () => HttpResponse.json({ code: 'IDEMPOTENCY_CONFLICT' }, { status: 409 })));
    const result = await runPrice(await env(), deps);
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toMatch(/^Price pack-alpha exists with other terms/);
  });

  it.each([
    ['OARS_SELLER_PRICE_USD', 'OARS_SELLER_PRICE_USD must be a positive amount'],
    [ENV_WORKLOAD_ID, `${ENV_WORKLOAD_ID} is not set.`],
    ['OARS_SELLER_API_URL', 'OARS_SELLER_API_URL is not set.'],
    ['OARS_SELLER_PACKS_DIR', 'OARS_SELLER_PACKS_DIR is not set.'],
  ])('refuses a missing %s in one line that names it, before any call', async (name, line) => {
    const result = await runPrice(await env({ [name]: undefined }), { token: () => Promise.reject(new Error(`must not run ${TOKEN}`)) });
    expect(result.ok).toBe(false);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain(line);
    scan(result.lines);
  });

  it('refuses a workload id that is not a UUID and an API URL that is not a URL', async () => {
    expect((await runPrice(await env({ [ENV_WORKLOAD_ID]: 'nope' }), deps)).lines).toEqual([`${ENV_WORKLOAD_ID} is not a workload id (a UUID).`]);
    expect((await runPrice(await env({ OARS_SELLER_API_URL: 'nope' }), deps)).lines).toEqual(['OARS_SELLER_API_URL is not a URL.']);
  });

  it('refuses a packs folder with no pack', async () => {
    const world = await makeWorld();
    const empty = join(world.root, 'empty-packs');
    mkdirSync(empty);
    const settings = { ...(await env()), ...envOf(world.inputs), OARS_SELLER_PACKS_DIR: empty };
    expect((await runPrice(settings, deps)).lines).toEqual(['The packs folder lists no pack.']);
  });

  it('says one line when the operator login cannot be used, without the reason', async () => {
    const result = await runPrice(await env(), { token: () => Promise.reject(new Error(`refresh failed for ${TOKEN}`)) });
    expect(result).toEqual({ ok: false, lines: ['The operator login could not be used: run oars login, or set OARS_API_KEY.'] });
    scan(result.lines);
  });

  it('says one line for a platform refusal or a network failure, without the answer', async () => {
    server.use(http.post(PATH, () => HttpResponse.json({ detail: `bad ${TOKEN}` }, { status: 403 })));
    const refused = await runPrice(await env(), deps);
    expect(refused).toEqual({ ok: false, lines: ['The platform answered 403 to the price.'] });
    server.use(http.post(PATH, () => HttpResponse.error()));
    const down = await runPrice(await env(), deps);
    expect(down).toEqual({ ok: false, lines: ['The platform could not be reached.'] });
    scan([...refused.lines, ...down.lines]);
  });
});
