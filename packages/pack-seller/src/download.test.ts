import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPack, PackError } from '../../pool/scripts/sample-pack.js';
import { cleanWorlds, makeWorld, readIfPresent, BUYER_KEY, type World } from './test-world.js';
import { API, customerRefOf, harness, platform, server, useServer } from './test-support.js';

useServer();
afterEach(cleanWorlds);

const RESERVATION = 'rsv_0001';
const accept = { recipientLegalName: 'Ada Lovelace', licenseVersion: '2026-11' };
const balanceOf = (creditsAvailable: number) => ({ creditsAvailable, creditsHeld: 0, creditsRemaining: creditsAvailable, customerRef: 'x', livemode: false });

/** The platform as msw: a customer, an offer, a balance, and the reservation calls, each recorded in call order. */
const platformWith = (calls: string[], options: { credits?: number; commitStatus?: number } = {}) => {
  server.use(
    platform('/billing/customers', 201, { customerRef: 'x', countryCode: 'US', createdAt: 't', updatedAt: 't' }),
    platform('/billing/offers', 200, { offerId: 'po_abc', expiresAt: '2099-01-01T00:00:00Z' }),
    http.get(`${API}/billing/credits/:ref`, () => {
      calls.push('balance');
      return HttpResponse.json(balanceOf(options.credits ?? 3));
    }),
    http.post(`${API}/billing/credits/reservations`, () => {
      calls.push('reserve');
      return HttpResponse.json({ reservationId: RESERVATION, credits: 1, status: 'HELD', expiresAt: '2099-01-01T00:00:00Z', replayCount: 0, replayed: false }, { status: 201 });
    }),
    http.post(`${API}/billing/credits/reservations/:id/commit`, () => {
      calls.push('commit');
      return HttpResponse.json({ reservationId: RESERVATION, status: 'COMMITTED' }, { status: options.commitStatus ?? 200 });
    }),
    http.post(`${API}/billing/credits/reservations/:id/release`, () => {
      calls.push('release');
      return HttpResponse.json({ reservationId: RESERVATION, status: 'RELEASED' });
    }),
  );
};

const NAME_END = 100;
const SIZE_AT = 124;
/** The file names of a ustar archive and whether it ends with the two zero blocks. */
const tarNames = (bytes: Buffer): { names: string[]; ended: boolean } => {
  const names: string[] = [];
  let at = 0;
  while (at + 512 <= bytes.length && bytes.subarray(at, at + 512).some((byte) => byte !== 0)) {
    const prefix = bytes.toString('utf8', at + 345, at + 500).replace(/\0.*$/s, '');
    const base = bytes.toString('utf8', at, at + NAME_END).replace(/\0.*$/s, '');
    names.push(prefix === '' ? base : `${prefix}/${base}`);
    const size = parseInt(bytes.toString('utf8', at + SIZE_AT, at + SIZE_AT + 12).replace(/\0.*$/s, ''), 8);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return { names, ended: bytes.length - at === 1024 && bytes.subarray(at).every((byte) => byte === 0) };
};

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));

interface Rig {
  world: World;
  calls: string[];
  lines: string[];
  builds: { count: number };
  call: ReturnType<typeof harness>['call'];
  offer: () => Promise<string>;
  download: (ref: string, body?: object) => Promise<Response>;
}

const rig = async (options: { credits?: number; commitStatus?: number; failBuild?: boolean } = {}): Promise<Rig> => {
  const world = await makeWorld();
  const builds = { count: 0 };
  const store = await world.open({
    build: (buildOptions) => {
      builds.count += 1;
      if (options.failBuild === true) throw new PackError('a term named zorblax could not be read at C:/secret/path');
      return buildPack(world.runtime, buildOptions);
    },
  });
  const calls: string[] = [];
  platformWith(calls, options);
  const { call, lines } = harness(store);
  const offer = async (): Promise<string> => customerRefOf(await call('POST', '/packs/alpha/offer', { body: accept, caller: `caller-${String(Math.random())}` }));
  const download = (ref: string, body: object = { buyerKey: BUYER_KEY }): Promise<Response> =>
    call('POST', '/packs/alpha/download', { body, headers: [['X-Customer-Ref', ref]] });
  return { world, calls, lines, builds, call, offer, download };
};

describe('POST /packs/{packId}/download', () => {
  it('reads the balance, reserves, builds, streams a tar, commits, and records the delivery with the offer\'s recipient and license', async () => {
    const r = await rig();
    const ref = await r.offer();
    const response = await r.download(ref);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/x-tar');
    const tar = tarNames(Buffer.from(await response.arrayBuffer()));
    expect(tar.ended).toBe(true);
    expect(tar.names).toEqual(expect.arrayContaining(['manifest.jsonl', 'pack.json']));
    expect(r.calls).toEqual(['balance', 'reserve', 'commit']);
    const rows = readIfPresent(r.world.deliveries).split('\n').filter((row) => row !== '').map((row): unknown => JSON.parse(row));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient: 'Ada Lovelace', license: '2026-11' });
  });

  it('refuses a customer with no balance before reserving, and builds nothing', async () => {
    const r = await rig({ credits: 0 });
    const response = await r.download(await r.offer());
    expect(response.status).toBe(402);
    expect(r.calls).toEqual(['balance']);
    expect(r.builds.count).toBe(0);
    expect(readIfPresent(r.world.deliveries)).toBe('');
  });

  it('releases the reservation and writes no delivery when the build fails, and shows the buyer none of the builder\'s text', async () => {
    const r = await rig({ failBuild: true });
    const response = await r.download(await r.offer());
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe('{"error":"The pack could not be built."}');
    expect(r.calls).toEqual(['balance', 'reserve', 'release']);
    expect(readIfPresent(r.world.deliveries)).toBe('');
  });

  it('releases the reservation and writes no delivery when the stream is cut off', async () => {
    const r = await rig();
    const response = await r.download(await r.offer());
    const reader = response.body?.getReader();
    expect((await reader?.read())?.done).toBe(false);
    await reader?.cancel();
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.calls).toEqual(['balance', 'reserve', 'release']);
    expect(readIfPresent(r.world.deliveries)).toBe('');
  });

  it('ends the stream without the archive terminator, releases, and writes no delivery when the commit is refused', async () => {
    const r = await rig({ commitStatus: 409 });
    const response = await r.download(await r.offer());
    await expect(response.arrayBuffer()).rejects.toThrow();
    expect(r.calls).toEqual(['balance', 'reserve', 'commit', 'release']);
    expect(readIfPresent(r.world.deliveries)).toBe('');
  });

  it('reuses its build on a re-download by the same customer, still costs one credit each time, and records the delivery once', async () => {
    const r = await rig();
    const ref = await r.offer();
    await (await r.download(ref)).arrayBuffer();
    await (await r.download(ref)).arrayBuffer();
    expect(r.builds.count).toBe(1);
    expect(r.calls).toEqual(['balance', 'reserve', 'commit', 'balance', 'reserve', 'commit']);
    expect(readIfPresent(r.world.deliveries).split('\n').filter((row) => row !== '')).toHaveLength(1);
  });

  it('rebuilds when an objection was recorded since the last build', async () => {
    const r = await rig();
    const ref = await r.offer();
    await (await r.download(ref)).arrayBuffer();
    await import('node:fs').then(({ writeFileSync }) => {
      writeFileSync(r.world.objections, `${JSON.stringify({ name: 'Priya Raman', received: '2026-06-09T09:00:00.000Z', scope: 'sale' })}\n`);
    });
    await (await r.download(ref)).arrayBuffer();
    expect(r.builds.count).toBe(2);
  });

  it('refuses an unknown customerRef with 404 before any billing call', async () => {
    const r = await rig();
    const response = await r.download('c_unknown0123456789abcdef0123456789');
    expect(response.status).toBe(404);
    expect(r.calls).toEqual([]);
  });

  it('refuses a customerRef whose offer was for another pack', async () => {
    const r = await rig();
    const ref = 'c_otherpack0123456789abcdef0123456';
    (await r.world.store()).ledger.record({ customerRef: ref, packId: 'beta', recipientLegalName: 'Other', licenseVersion: 'v1', recordedAt: 1 });
    const store = await r.world.store();
    const { call } = harness(store);
    const response = await call('POST', '/packs/alpha/download', { body: { buyerKey: BUYER_KEY }, headers: [['X-Customer-Ref', ref]] });
    expect(response.status).toBe(404);
    expect(r.calls).toEqual([]);
  });

  it('answers 400 with no customerRef header or no buyer key, before any billing call', async () => {
    const r = await rig();
    const ref = await r.offer();
    expect((await r.call('POST', '/packs/alpha/download', { body: { buyerKey: BUYER_KEY } })).status).toBe(400);
    expect((await r.download(ref, {})).status).toBe(400);
    expect((await r.download(ref, { buyerKey: 'k'.repeat(513) })).status).toBe(400);
    expect(r.calls).toEqual([]);
  });

  it('holds the buyer key for the build only: it is in no log line and in no file anything wrote, and the customerRef is in no log line', async () => {
    const r = await rig();
    const ref = await r.offer();
    const response = await r.download(ref);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.includes(BUYER_KEY)).toBe(false);
    expect(r.lines.join('\n')).not.toContain(BUYER_KEY);
    expect(r.lines.join('\n')).not.toContain(ref);
    const files = filesUnder(r.world.root);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      expect(statSync(file).isFile()).toBe(true);
      expect(readFileSync(file).includes(BUYER_KEY), file).toBe(false);
    }
    expect(files.some((file) => file.includes(BUYER_KEY))).toBe(false);
  });
});
