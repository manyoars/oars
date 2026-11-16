import { http, HttpResponse, passthrough } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { ENV_INDEX_KEY_FILE, ENV_OWNERS_FILE, ENV_PACKS_DIR, ENV_PROJECTS_DIR, ENV_STORE_DIR, ENV_TERMS_FILE } from './pack-store.js';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { BUYER_KEY, cleanWorlds, makeWorld, readIfPresent, type World } from './test-world.js';
import { ENV_API_URL, ENV_PORT, ENV_SDK_KEY } from './config.js';
import { createSellerServer, start } from './server.js';
import { API, SDK_KEY, customerRefOf, server, useServer } from './test-support.js';

useServer();
afterEach(cleanWorlds);

const REF = 'c_0123456789abcdef0123456789abcdef';

describe('start', () => {
  it('sends the SDK key in X-Agent-SDK-Key and no Authorization header', async () => {
    const seen: { sdk: string | null; authorization: string | null }[] = [];
    server.use(
      http.all('http://127.0.0.1:*/*', () => passthrough()),
      http.get(`${API}/billing/credits/${REF}`, ({ request }) => {
        seen.push({ sdk: request.headers.get('X-Agent-SDK-Key'), authorization: request.headers.get('Authorization') });
        return HttpResponse.json({ creditsAvailable: 3, creditsHeld: 0, creditsRemaining: 3, customerRef: REF, livemode: false });
      }),
    );
    const { inputs } = await makeWorld();
    const env = {
      [ENV_API_URL]: API, [ENV_SDK_KEY]: SDK_KEY, [ENV_PORT]: '0',
      [ENV_PACKS_DIR]: inputs.packsDir, [ENV_TERMS_FILE]: inputs.terms, [ENV_OWNERS_FILE]: inputs.owners,
      [ENV_INDEX_KEY_FILE]: inputs.indexKey, [ENV_STORE_DIR]: inputs.storeDir, [ENV_PROJECTS_DIR]: inputs.projectsDir,
    };
    const started = await start(env, { log: () => undefined });
    if (!started.ok) throw new Error(started.line);
    try {
      const response = await fetch(`http://127.0.0.1:${String(started.port)}/credits`, { headers: { 'X-Customer-Ref': REF } });
      expect(response.status).toBe(200);
      expect(seen).toEqual([{ sdk: SDK_KEY, authorization: null }]);
    } finally {
      started.server.close();
    }
  });
});

describe('the 500 path', () => {
  it('answers a fixed one-line body when a handler throws', async () => {
    server.use(http.all('http://127.0.0.1:*/*', () => passthrough()));
    const real = await (await makeWorld()).store();
    const throwing = { ...real, catalog: { ...real.catalog, list: () => { throw new Error('secret detail aorsk_x'); } } };
    const sellerServer = createSellerServer({ config: { apiUrl: API, sdkKey: SDK_KEY, port: 0, host: '127.0.0.1' }, store: throwing, log: () => undefined });
    await new Promise<void>((resolve) => sellerServer.listen(0, '127.0.0.1', resolve));
    try {
      const address = sellerServer.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${String(port)}/packs`);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('{"error":"Internal error."}');
    } finally {
      sellerServer.close();
    }
  });
});

const REFERENCE = 'c_socketdownload0123456789abcdef01';
const accept = { recipientLegalName: 'Ada Lovelace', licenseVersion: '2026-11' };

/** A seller over a real socket on a world's store, with the platform as msw; `released` resolves when the platform sees the release call. */
const listening = async (world: World): Promise<{ sellerServer: Server; base: string; calls: string[]; released: Promise<void> }> => {
  const calls: string[] = [];
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.all('http://127.0.0.1:*/*', () => passthrough()),
    http.post(`${API}/billing/customers`, () => HttpResponse.json({ customerRef: REFERENCE, countryCode: 'US', createdAt: 't', updatedAt: 't' }, { status: 201 })),
    http.post(`${API}/billing/offers`, () => HttpResponse.json({ offerId: 'po_abc', expiresAt: '2099-01-01T00:00:00Z' })),
    http.get(`${API}/billing/credits/:ref`, () => HttpResponse.json({ creditsAvailable: 3, creditsHeld: 0, creditsRemaining: 3, customerRef: REFERENCE, livemode: false })),
    http.post(`${API}/billing/credits/reservations`, () => HttpResponse.json({ reservationId: 'rsv_1', credits: 1, status: 'HELD', expiresAt: '2099-01-01T00:00:00Z', replayCount: 0, replayed: false }, { status: 201 })),
    http.post(`${API}/billing/credits/reservations/:id/commit`, () => {
      calls.push('commit');
      return HttpResponse.json({ reservationId: 'rsv_1', status: 'COMMITTED' });
    }),
    http.post(`${API}/billing/credits/reservations/:id/release`, () => {
      calls.push('release');
      release();
      return HttpResponse.json({ reservationId: 'rsv_1', status: 'RELEASED' });
    }),
  );
  const sellerServer = createSellerServer({ config: { apiUrl: API, sdkKey: SDK_KEY, port: 0, host: '127.0.0.1' }, store: await world.store(), log: () => undefined });
  await new Promise<void>((resolve) => sellerServer.listen(0, '127.0.0.1', resolve));
  const address = sellerServer.address();
  return { sellerServer, base: `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`, calls, released };
};

const requestDownload = async (base: string): Promise<{ response: Response; abort: () => void }> => {
  const offer = await fetch(`${base}/packs/alpha/offer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(accept) });
  const customerRef = await customerRefOf(offer);
  const controller = new AbortController();
  const response = await fetch(`${base}/packs/alpha/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Customer-Ref': customerRef },
    body: JSON.stringify({ buyerKey: BUYER_KEY }),
    signal: controller.signal,
  });
  return { response, abort: () => {
    controller.abort();
  } };
};

describe('the download over a socket', () => {
  // The transport is what these two tests: the pipeline from the archive to the socket, and a closed client reaching the source.
  it('ends the archive with the two zero blocks after the commit', async () => {
    const world = await makeWorld();
    const { sellerServer, base, calls } = await listening(world);
    try {
      const { response } = await requestDownload(base);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.length % 512).toBe(0);
      expect(bytes.subarray(bytes.length - 1024).every((byte) => byte === 0)).toBe(true);
      expect(bytes.subarray(bytes.length - 1536, bytes.length - 1024).some((byte) => byte !== 0)).toBe(true);
      expect(calls).toEqual(['commit']);
    } finally {
      sellerServer.close();
    }
  });

  it('releases the reservation and writes no delivery row when the client closes after the first chunk', async () => {
    const world = await makeWorld();
    // Pad the buyer's build so the archive is far larger than the socket buffers: the commit cannot come before the client has read it all.
    const store = await world.store();
    const prepared = await store.prepare('alpha', BUYER_KEY);
    if (!prepared.ok) throw new Error('The fixture build failed.');
    appendFileSync(join(prepared.value, 'padding.bin'), Buffer.alloc(64 * 1024 * 1024));
    const { sellerServer, base, calls, released } = await listening(world);
    try {
      const { response, abort } = await requestDownload(base);
      const reader = response.body?.getReader();
      expect((await reader?.read())?.done).toBe(false);
      abort();
      await released;
      expect(calls).toEqual(['release']);
      expect(readIfPresent(world.deliveries)).toBe('');
    } finally {
      sellerServer.close();
    }
  });
});
