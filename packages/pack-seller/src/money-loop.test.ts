import { join } from 'node:path';
import { Readable } from 'node:stream';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { createOarsClient, purchases } from '@manyoars/oars-client';
import { main as validatePack } from '../../pool/scripts/validate-pack.js';
import { ENV_WORKLOAD_ID, runPrice } from './price.js';
import { MANIFEST_NAME } from './tar.js';
import { API, customerRefOf, harness, server, untar, useServer } from './test-support.js';
import { BUYER_KEY, cleanWorlds, envOf, makeWorld, type World } from './test-world.js';

useServer();
afterEach(cleanWorlds);

const WORKLOAD = '0b1c2d3e-0000-4000-8000-000000000001';
const OPERATOR_TOKEN = 'operator-token-secret-value';
const BUYER_SDK_KEY = 'aorsk_buyer_secret_value';
const RESERVATION = 'rsv_0001';
const accept = { recipientLegalName: 'Ada Lovelace', licenseVersion: '2026-11', state: 'CA' };
const stamp = '2099-01-01T00:00:00Z';

/** A string field of a parsed JSON body; fails the test when it is not one. */
const textOf = (body: unknown, name: string): string => {
  const value: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, name) : undefined;
  if (typeof value !== 'string') throw new Error(`The body has no ${name}.`);
  return value;
};

interface Model {
  priceCredits: number;
  credits: number;
  held: number;
  settled: boolean;
  calls: string[];
  prices: Set<string>;
}

/** The platform as msw, keeping the state the loop reads: the price, the purchase until it settles, and the credit balance. Every call is recorded in order. */
const platformModel = (options: { refuseCommit?: boolean } = {}) => {
  const state: Model = { priceCredits: 0, credits: 0, held: 0, settled: false, calls: [], prices: new Set() };
  server.use(
    http.post(`${API}/billing/agents/:workloadId/prices`, async ({ request, params }) => {
      expect(params.workloadId).toBe(WORKLOAD);
      expect(request.headers.get('Authorization')).toBe(`Bearer ${OPERATOR_TOKEN}`);
      const body: unknown = await request.json();
      const priceRef = textOf(body, 'priceRef');
      const known = state.prices.has(priceRef);
      state.prices.add(priceRef);
      state.priceCredits = 3;
      expect(body).toMatchObject({ kind: 'CREDIT_PACK', credits: state.priceCredits, amountUsd: '19.00' });
      state.calls.push(known ? 'price-replayed' : 'price-created');
      return HttpResponse.json({ priceRef, displayName: textOf(body, 'displayName'), kind: 'CREDIT_PACK', amountUsd: '19.00', active: true, createdAt: stamp, updatedAt: stamp }, { status: known ? 200 : 201 });
    }),
    http.post(`${API}/billing/customers`, () => HttpResponse.json({ customerRef: 'x', countryCode: 'US', createdAt: stamp, updatedAt: stamp }, { status: 201 })),
    http.post(`${API}/billing/offers`, () => HttpResponse.json({ offerId: 'po_e2e', expiresAt: stamp })),
    http.post(`${API}/billing/purchases`, ({ request }) => {
      expect(request.headers.get('X-Agent-SDK-Key')).toBe(BUYER_SDK_KEY);
      state.calls.push('buy');
      return HttpResponse.json({ purchaseId: 'pur_e2e', status: 'PENDING', credits: state.priceCredits }, { status: 201 });
    }),
    http.get(`${API}/billing/purchases/:id`, () => {
      state.calls.push(state.settled ? 'purchase-succeeded' : 'purchase-pending');
      return HttpResponse.json({ purchaseId: 'pur_e2e', status: state.settled ? 'SUCCEEDED' : 'PENDING', credits: state.priceCredits });
    }),
    http.get(`${API}/billing/credits/:ref`, () => {
      state.calls.push('balance');
      return HttpResponse.json({ creditsAvailable: state.credits - state.held, creditsHeld: state.held, creditsRemaining: state.credits, customerRef: 'x', livemode: false });
    }),
    http.post(`${API}/billing/credits/reservations`, () => {
      state.held += 1;
      state.calls.push('reserve');
      return HttpResponse.json({ reservationId: RESERVATION, credits: 1, status: 'HELD', expiresAt: stamp, replayCount: 0, replayed: false }, { status: 201 });
    }),
    http.post(`${API}/billing/credits/reservations/:id/commit`, () => {
      state.calls.push('commit');
      if (options.refuseCommit === true) return HttpResponse.json({ code: 'RESERVATION_EXPIRED' }, { status: 409 });
      state.held -= 1;
      state.credits -= 1;
      return HttpResponse.json({ reservationId: RESERVATION, status: 'COMMITTED' });
    }),
    http.post(`${API}/billing/credits/reservations/:id/release`, () => {
      state.held -= 1;
      state.calls.push('release');
      return HttpResponse.json({ reservationId: RESERVATION, status: 'RELEASED' });
    }),
  );
  return {
    state,
    /** The payment webhook: the purchase succeeds and the pack's credits land on the balance. */
    settle: () => {
      state.settled = true;
      state.credits += state.priceCredits;
    },
  };
};

/** An operator machine and a platform; nothing is bought yet. */
const setup = async (options: { refuseCommit?: boolean } = {}) => {
  const world = await makeWorld();
  const platform = platformModel(options);
  const { call } = harness(await world.store());
  const env = { ...envOf(world.inputs), OARS_SELLER_API_URL: API, [ENV_WORKLOAD_ID]: WORKLOAD, OARS_SELLER_PRICE_USD: '19.00' };
  const price = () => runPrice(env, { token: () => Promise.resolve(OPERATOR_TOKEN) });
  const offer = async () => {
    const response = await call('POST', '/packs/alpha/offer', { body: accept });
    const offered: unknown = await response.clone().json();
    return { ref: await customerRefOf(response), offerId: textOf(offered, 'offerId'), priceRef: textOf(offered, 'priceRef') };
  };
  const download = (ref: string) => call('POST', '/packs/alpha/download', { body: { buyerKey: BUYER_KEY }, headers: [['X-Customer-Ref', ref]] });
  const balance = (ref: string) => call('GET', '/credits', { headers: [['X-Customer-Ref', ref]] });
  const buyer = createOarsClient({ version: 'test', baseUrl: API });
  return { world, platform, price, offer, download, balance, buyer };
};

/** What the buyer does with the bytes that came down: unpack, then `validate-pack` on the folder. */
const validated = async (world: World, name: string, archive: Buffer) => {
  const dir = join(world.root, 'received', name);
  const names = untar(archive, dir);
  const printed: string[] = [];
  const code = await validatePack([dir], { print: (text) => printed.push(text) });
  return { names, code, printed: printed.join('\n') };
};

/** The bytes a buyer holds when the stream ends or breaks: everything read before the failure. */
const received = async (response: Response): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of Readable.fromWeb(response.body ?? new ReadableStream<Uint8Array>())) {
      if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    }
  } catch {
    // The stream broke: the buyer keeps what came before.
  }
  return Buffer.concat(chunks);
};

describe('the test-mode money loop', () => {
  it('registers, prices, offers, buys, settles, downloads, and validates the archive that came down', async () => {
    const { world, platform, price, offer, download, balance, buyer } = await setup();
    // Every store path is under the world's own temp folder.
    const { packsDir, terms, owners, indexKey, storeDir, projectsDir } = world.inputs;
    for (const path of [packsDir, terms, owners, indexKey, storeDir, projectsDir]) expect(path.startsWith(world.root)).toBe(true);

    expect(await price()).toEqual({ ok: true, lines: ['Price pack-alpha created.'] });
    expect(platform.state.priceCredits).toBe(3);

    const offered = await offer();
    expect(offered).toMatchObject({ offerId: 'po_e2e', priceRef: 'pack-alpha' });

    const bought = await purchases.buy(buyer, { sdkKey: BUYER_SDK_KEY, offerId: offered.offerId, priceRef: offered.priceRef });
    expect(bought.data).toMatchObject({ purchaseId: 'pur_e2e', status: 'PENDING', credits: 3 });
    expect((await purchases.get(buyer, { sdkKey: BUYER_SDK_KEY, purchaseId: 'pur_e2e' })).data?.status).toBe('PENDING');
    expect(await (await balance(offered.ref)).json()).toMatchObject({ creditsAvailable: 0 });

    platform.settle();
    expect((await purchases.get(buyer, { sdkKey: BUYER_SDK_KEY, purchaseId: 'pur_e2e' })).data?.status).toBe('SUCCEEDED');
    expect(await (await balance(offered.ref)).json()).toMatchObject({ creditsAvailable: 3 });

    const response = await download(offered.ref);
    expect(response.status).toBe(200);
    const archive = Buffer.from(await response.arrayBuffer());
    expect(platform.state.calls.slice(-3)).toEqual(['balance', 'reserve', 'commit']);
    expect(platform.state.credits).toBe(2);

    const result = await validated(world, 'first', archive);
    expect(result.names).toContain(MANIFEST_NAME);
    expect(result.printed).toMatch(/^Conforms to the session record spec/);
    expect(result.code).toBe(0);
  });

  it('refuses a download before the purchase settles with 402, reserving nothing', async () => {
    const { platform, price, offer, download } = await setup();
    await price();
    const offered = await offer();
    const response = await download(offered.ref);
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: 'No credits are available.' });
    expect(platform.state.calls).not.toContain('reserve');
    expect(platform.state.held).toBe(0);
  });

  it('refuses the download after the credits are spent down to zero with 402, and holds nothing', async () => {
    const { world, platform, price, offer, download, balance } = await setup();
    await price();
    const offered = await offer();
    platform.settle();
    for (let n = 1; n <= 3; n += 1) {
      const response = await download(offered.ref);
      expect(response.status).toBe(200);
      expect((await validated(world, `d${String(n)}`, Buffer.from(await response.arrayBuffer()))).code).toBe(0);
      expect(platform.state.credits).toBe(3 - n);
    }
    const refused = await download(offered.ref);
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({ error: 'No credits are available.' });
    expect(await (await balance(offered.ref)).json()).toMatchObject({ creditsAvailable: 0 });
    expect(platform.state).toMatchObject({ credits: 0, held: 0 });
    expect(platform.state.calls.filter((call) => call === 'commit')).toHaveLength(3);
  });
});

describe('a refused commit', () => {
  it('ends the stream with an archive validate-pack rejects, and releases the reservation', async () => {
    const { world, platform, price, offer, download } = await setup({ refuseCommit: true });
    await price();
    const offered = await offer();
    platform.settle();
    const bytes = await received(await download(offered.ref));
    const result = await validated(world, 'refused', bytes);
    expect(result.code).toBe(1);
    expect(result.printed).toContain(MANIFEST_NAME);
    expect(result.names).not.toContain(MANIFEST_NAME);
    expect(platform.state.calls.slice(-4)).toEqual(['balance', 'reserve', 'commit', 'release']);
    expect(platform.state).toMatchObject({ credits: 3, held: 0 });
  });
});

describe('a stream cut after the commit', () => {
  it('keeps the credit spent, releases nothing, and lets the buyer download again on the credit left', async () => {
    const { world, platform, price, offer, download } = await setup();
    await price();
    const offered = await offer();
    platform.settle();
    const reader = (await download(offered.ref)).body?.getReader();
    if (reader === undefined) throw new Error('The download has no body.');
    while (!platform.state.calls.includes('commit')) {
      if ((await reader.read()).done) throw new Error('The stream ended before the commit.');
    }
    await reader.cancel();
    expect(platform.state.calls).not.toContain('release');
    expect(platform.state).toMatchObject({ credits: 2, held: 0 });
    const again = await download(offered.ref);
    expect(again.status).toBe(200);
    expect((await validated(world, 'again', Buffer.from(await again.arrayBuffer()))).code).toBe(0);
    expect(platform.state).toMatchObject({ credits: 1, held: 0 });
  });
});
