// The builder of paid pack fetches against a fixture store in a temp folder, a pool that exists only in this file (the three operator routes, and a record of every call), and a bucket held in memory behind a stand-in for wrangler. Nothing here reaches a real pool, bucket, or store.
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fieldOf } from './deliver.js';
import type { Wrangler } from './erase-wrangler.js';
import { fulfil, main, objectKeyOf, operatorApi, PACKS_BUCKET, parseLots, wranglerBucket, type FulfilOptions } from './fulfil.js';
import { bash, edit, fixture, id, removeFixtures, type Fixture } from './real-work-fixture.js';
import { buildPack, keyIdOf, PackError } from './sample-pack.js';
import { validate } from './validate-pack.js';

const dirs: string[] = [];

afterEach(() => {
  removeFixtures();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SERVER = 'https://pool.test';
const TOKEN = 'operator-token-7c1d9e';
const FETCH = (n: number): string => `${String(n).repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const KEY = (n: number): string => `buyer-key-${String(n)}-5f2c81d04b`;

interface Row {
  fetchId: string;
  priceRef: string;
  buyerKey: string | null;
  state: 'queued' | 'built' | 'ready' | 'failed';
  objectKey: string | null;
}

/** The pool's side: the rows, the bucket, and every request it was sent, as `METHOD path`. */
interface Pool {
  rows: Row[];
  objects: Map<string, Buffer>;
  calls: string[];
  /** Wrangler's arguments, one line per run. */
  wrangled: string[];
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
  wrangler: Wrangler;
  /** Set to make the next matching request or upload fail once, as a lost answer or a cut upload would. */
  breakOnce: { built?: boolean; failed?: boolean; remove?: boolean; put?: string };
}

const json = (status: number, body: object): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const pool = (rows: Row[]): Pool => {
  const world: Pool = {
    rows,
    objects: new Map(),
    calls: [],
    wrangled: [],
    breakOnce: {},
    // The three routes as `pack-operator.ts` answers them; any other path is recorded and refused, so a call to the hand-over or to billing shows in `calls`.
    fetcher: (input, init) => {
      const { pathname, search } = new URL(input);
      const method = init.method ?? 'GET';
      world.calls.push(`${method} ${pathname}${search}`);
      if (new Headers(init.headers).get('authorization') !== `Bearer ${TOKEN}`) return Promise.resolve(json(401, { error: 'unauthorized' }));
      if (method === 'GET' && pathname === '/v1/operator/fetches') {
        const fetches = world.rows.filter((row) => row.state === 'queued').slice(0, 100);
        return Promise.resolve(json(200, { fetches: fetches.map((row) => ({ ...row, buyerKeyId: 'k', mode: 'test', createdAt: 1, readyAt: null, expiresAt: null })) }));
      }
      const [, fetchId, action] = /^\/v1\/operator\/fetches\/([^/]+)\/(built|failed)$/.exec(pathname) ?? [];
      const row = world.rows.find((held) => held.fetchId === fetchId);
      if (method !== 'POST' || row === undefined) return Promise.resolve(json(404, { error: 'not_found' }));
      if (action === 'failed') {
        if (world.breakOnce.failed === true) {
          world.breakOnce.failed = false;
          return Promise.resolve(json(500, { error: 'internal' }));
        }
        if (row.objectKey !== null) world.objects.delete(row.objectKey);
        Object.assign(row, { state: 'failed', buyerKey: null, objectKey: null });
        return Promise.resolve(json(200, { fetchId, state: 'failed' }));
      }
      if (world.breakOnce.built === true) {
        world.breakOnce.built = false;
        return Promise.reject(new Error('connection reset'));
      }
      const objectKey = fieldOf(JSON.parse(typeof init.body === 'string' ? init.body : '{}'), 'objectKey');
      if (typeof objectKey !== 'string' || !objectKey.startsWith(`packs/${row.fetchId}/`)) return Promise.resolve(json(400, { error: 'missing_field' }));
      if (row.state !== 'queued') return Promise.resolve(json(409, { error: 'not_queued' }));
      if (!world.objects.has(objectKey)) return Promise.resolve(json(422, { error: 'object_missing' }));
      Object.assign(row, { state: 'built', buyerKey: null, objectKey });
      return Promise.resolve(json(200, { fetchId, state: 'built', objectKey }));
    },
    wrangler: (args) => {
      world.wrangled.push(args.join(' '));
      const [r2, object, verb, target = ''] = args;
      if (r2 !== 'r2' || object !== 'object' || !target.startsWith(`${PACKS_BUCKET}/`) || !args.includes('--remote')) return Promise.reject(new Error(`unexpected wrangler call: ${args.slice(0, 3).join(' ')}`));
      const key = target.slice(PACKS_BUCKET.length + 1);
      if (verb === 'put') {
        const bytes = readFileSync(args[args.indexOf('--file') + 1] ?? '');
        if (world.breakOnce.put === key) {
          // Half the object lands before the upload is cut, so a failed upload has something to leave behind.
          world.objects.set(key, bytes.subarray(0, bytes.length / 2));
          delete world.breakOnce.put;
          return Promise.reject(new Error('upload interrupted'));
        }
        world.objects.set(key, bytes);
        return Promise.resolve('');
      }
      if (verb === 'delete') {
        if (world.breakOnce.remove === true) {
          world.breakOnce.remove = false;
          return Promise.reject(new Error('bucket unreachable'));
        }
        world.objects.delete(key);
        return Promise.resolve('');
      }
      return Promise.reject(new Error(`unexpected wrangler verb: ${String(verb)}`));
    },
  };
  return world;
};

const queued = (n: number, priceRef = 'pack-lot-a'): Row => ({ fetchId: FETCH(n), priceRef, buyerKey: KEY(n), state: 'queued', objectKey: null });

interface Bench {
  store: Fixture;
  indexKey: string;
  lots: string;
  work: string;
  log: string[];
  /** Runs the command against the pool. */
  run: (world: Pool, extra?: readonly string[]) => Promise<number>;
  /** The options `fulfil` takes for the pool, for a test that swaps the build or the check. */
  options: (world: Pool) => FulfilOptions;
}

/** A store of three sessions, the operator's files beside it, and a lots file: `pack-lot-a` sells a lot that builds, and `pack-lot-empty` one whose every session is under its turn floor, so its build writes no session. */
const bench = async (): Promise<Bench> => {
  const store = fixture();
  for (const n of [1, 2, 3]) store.add({ id: id(n), project: 'C--work-oars-app', version: '2.1.300', model: 'claude-opus-5-5', prompts: [{ text: `please fix the parser, take ${String(n)}`, calls: [edit(), bash(true)] }] });
  await store.stored();
  const indexKey = join(store.root, 'index.key');
  writeFileSync(indexKey, 'ab'.repeat(32));
  const lots = join(store.root, 'lots.json');
  writeFileSync(lots, JSON.stringify([{ lot: 'lot-a', priceRefs: ['pack-lot-a', 'pack-lot-a-bulk'], minTurns: 1 }, { lot: 'lot-empty', priceRefs: ['pack-lot-empty'], minTurns: 999 }]));
  const work = join(store.root, 'builds');
  mkdirSync(work);
  const log: string[] = [];
  const print = (text: string): void => {
    log.push(text);
  };
  const inputs = { terms: store.terms, owners: store.owners, indexKey };
  return {
    store,
    indexKey,
    lots,
    work,
    log,
    run: (world, extra = []) => main(['--lots', lots, '--terms', store.terms, '--owners', store.owners, '--index-key', indexKey, '--server', SERVER, '--work', work, ...extra], { runtime: store.runtime, print, wrangler: world.wrangler, env: { OARS_POOL_OPERATOR_TOKEN: TOKEN }, fetcher: world.fetcher }),
    options: (world) => ({ api: operatorApi(SERVER, TOKEN, world.fetcher), bucket: wranglerBucket(world.wrangler, PACKS_BUCKET, false), lots: parseLots(readFileSync(lots, 'utf8')), inputs, work, print, build: (options) => buildPack(store.runtime, options) }),
  };
};

const TAR_BLOCK = 512;
const tarText = (bytes: Buffer, at: number, length: number): string => bytes.toString('utf8', at, at + length).replace(/\0.*$/s, '');

/** What a buyer does with the object: every entry written under a new folder, up to the end blocks. */
const unpacked = (bytes: Buffer | undefined): string => {
  if (bytes === undefined) throw new Error('no object');
  const dir = mkdtempSync(join(tmpdir(), 'oars-fulfil-unpacked-'));
  dirs.push(dir);
  for (let at = 0; at + TAR_BLOCK <= bytes.length && bytes.subarray(at, at + TAR_BLOCK).some((byte) => byte !== 0); ) {
    const [prefix, base] = [tarText(bytes, at + 345, 155), tarText(bytes, at, 100)];
    const size = parseInt(tarText(bytes, at + 124, 12), 8);
    const target = join(dir, prefix === '' ? base : `${prefix}/${base}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes.subarray(at + TAR_BLOCK, at + TAR_BLOCK + size));
    at += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return dir;
};

const packField = (dir: string, field: string): unknown => fieldOf(JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8')), field);

const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name)) : [join(dir, name)]));

/** Calls that take a credit or reach billing: the hand-over route, or any path outside the three the builder may use. */
const consumeCalls = (world: Pool): string[] => world.calls.filter((call) => !/^(GET \/v1\/operator\/fetches\?state=queued|POST \/v1\/operator\/fetches\/[0-9a-f-]+\/(built|failed))$/.test(call));

const stateOf = (world: Pool, n: number): string | undefined => world.rows.find((row) => row.fetchId === FETCH(n))?.state;

describe('fulfil', () => {
  it('builds two queued fetches, each under its buyer key, uploads each pack, and marks both built', async () => {
    const b = await bench();
    const world = pool([queued(1), queued(2, 'pack-lot-a-bulk')]);
    expect(await b.run(world)).toBe(0);
    expect(world.rows.map(({ state, objectKey, buyerKey }) => ({ state, objectKey, buyerKey }))).toEqual([
      { state: 'built', objectKey: `packs/${FETCH(1)}/pack.tar`, buyerKey: null },
      { state: 'built', objectKey: `packs/${FETCH(2)}/pack.tar`, buyerKey: null },
    ]);
    expect([...world.objects.keys()].sort()).toEqual([objectKeyOf(FETCH(1)), objectKeyOf(FETCH(2))]);
    const packs = [1, 2].map((n) => unpacked(world.objects.get(objectKeyOf(FETCH(n)))));
    for (const [at, dir] of packs.entries()) {
      // Each object is a whole pack that the public validator accepts, built from the lot as it is now (all three sessions), stating its redaction version and the key it was built under.
      const result = await validate(dir);
      expect(result?.violations).toEqual([]);
      expect(result?.rows).toBe(3);
      expect(packField(dir, 'redactionVersion')).toEqual(expect.any(String));
      expect(packField(dir, 'keyId')).toBe(keyIdOf(KEY(at + 1)));
    }
    // Match ids are keyed per buyer, so the two packs share none.
    const [first = [], second = []] = packs.map((dir) => readdirSync(join(dir, 'sessions')));
    expect(first.filter((matchId) => second.includes(matchId))).toEqual([]);
    expect(consumeCalls(world)).toEqual([]);
    expect(b.log.at(-1)).toBe('Fulfilled: 2 built, 0 failed, 0 left queued.');
  });

  describe('a fetch that cannot be fulfilled is marked failed, leaves no object, takes no credit, and does not stop the next fetch', () => {
    const settled = (world: Pool): void => {
      expect(stateOf(world, 1)).toBe('failed');
      expect(stateOf(world, 2)).toBe('built');
      expect([...world.objects.keys()]).toEqual([objectKeyOf(FETCH(2))]);
      expect(world.calls).toContain(`POST /v1/operator/fetches/${FETCH(1)}/failed`);
      expect(consumeCalls(world)).toEqual([]);
    };

    it('when the build fails', async () => {
      const b = await bench();
      const world = pool([queued(1, 'pack-lot-empty'), queued(2)]);
      expect(await b.run(world)).toBe(1);
      settled(world);
      expect(b.log.join('\n')).toContain(`Fetch ${FETCH(1)} failed: The build did not give a valid pack: The build wrote no session.`);
      expect(b.log.at(-1)).toBe('Fulfilled: 1 built, 1 failed, 0 left queued.');
    });

    it('when validate-pack refuses the pack', async () => {
      const b = await bench();
      const world = pool([queued(1), queued(2)]);
      const options = b.options(world);
      // The first pack gets a file no manifest row names, which the validator refuses; the second is built as it is.
      const build: FulfilOptions['build'] = async (given) => {
        const counts = await options.build(given);
        if (given.buyerKey === KEY(1)) writeFileSync(join(given.out, 'sessions', 'stray.txt'), 'x');
        return counts;
      };
      expect(await fulfil({ ...options, build })).toEqual({ built: 1, failed: 1, left: 0 });
      settled(world);
      expect(b.log.join('\n')).toContain('validate-pack refused the pack (1 found; first: sessions/stray.txt (file): no manifest row names it)');
      // Nothing was uploaded for the refused pack.
      expect(world.wrangled.filter((line) => line.startsWith('r2 object put'))).toHaveLength(1);
    });

    it('when the upload fails', async () => {
      const b = await bench();
      const world = pool([queued(1), queued(2)]);
      world.breakOnce.put = objectKeyOf(FETCH(1));
      expect(await b.run(world)).toBe(1);
      settled(world);
      expect(b.log.join('\n')).toContain(`Fetch ${FETCH(1)} failed: The upload failed: upload interrupted`);
    });
  });

  describe('a failure that cannot be recorded leaves the fetch queued for the next run, takes no credit, and does not stop the next fetch', () => {
    const stillQueued = (world: Pool): void => {
      expect(stateOf(world, 1)).toBe('queued');
      expect(stateOf(world, 2)).toBe('built');
      expect(consumeCalls(world)).toEqual([]);
    };

    it('when the pool refuses the failed mark', async () => {
      const b = await bench();
      const world = pool([queued(1, 'pack-lot-empty'), queued(2)]);
      world.breakOnce.failed = true;
      expect(await fulfil(b.options(world))).toEqual({ built: 1, failed: 0, left: 1 });
      stillQueued(world);
      expect(b.log.join('\n')).toContain(`Fetch ${FETCH(1)}: The build did not give a valid pack: The build wrote no session. It could not be marked failed`);
    });

    it('when the bucket refuses the delete', async () => {
      const b = await bench();
      const world = pool([queued(1, 'pack-lot-empty'), queued(2)]);
      world.breakOnce.remove = true;
      expect(await fulfil(b.options(world))).toEqual({ built: 1, failed: 0, left: 1 });
      stillQueued(world);
      // The failed mark is not sent while an object might remain.
      expect(world.calls).not.toContain(`POST /v1/operator/fetches/${FETCH(1)}/failed`);
      expect(b.log.join('\n')).toContain('It could not be marked failed (bucket unreachable), so it stays queued.');
    });
  });

  it('leaves a queue row alone when its id is not a fetch id or it holds no buyer key: no wrangler call, no build folder', async () => {
    const b = await bench();
    const world = pool([{ ...queued(1), fetchId: '../x' }, { ...queued(2), buyerKey: null }]);
    expect(await fulfil(b.options(world))).toEqual({ built: 0, failed: 0, left: 2 });
    expect(world.wrangled).toEqual([]);
    expect(readdirSync(b.work)).toEqual([]);
    expect(world.calls).toEqual(['GET /v1/operator/fetches?state=queued', 'GET /v1/operator/fetches?state=queued']);
    expect(world.rows.map((row) => row.state)).toEqual(['queued', 'queued']);
  });

  it('a fetch already built is skipped by the next run', async () => {
    const b = await bench();
    const world = pool([queued(1), queued(2)]);
    expect(await b.run(world)).toBe(0);
    const [calls, wrangled] = [world.calls.length, world.wrangled.length];
    expect(await b.run(world)).toBe(0);
    // The second run read the queue once, found nothing, and built, uploaded, and marked nothing.
    expect(world.calls.slice(calls)).toEqual(['GET /v1/operator/fetches?state=queued']);
    expect(world.wrangled).toHaveLength(wrangled);
    expect(b.log.at(-1)).toBe('Fulfilled: 0 built, 0 failed, 0 left queued.');
  });

  it('a run that stopped between the upload and the built mark is finished by the next run', async () => {
    const b = await bench();
    const world = pool([queued(1)]);
    world.breakOnce.built = true;
    expect(await b.run(world)).toBe(1);
    // The pack is in the bucket and the fetch still queued, with its key: nothing was marked failed and nothing deleted.
    expect(world.rows[0]).toMatchObject({ state: 'queued', buyerKey: KEY(1), objectKey: null });
    expect(world.objects.has(objectKeyOf(FETCH(1)))).toBe(true);
    expect(world.calls.some((call) => call.endsWith('/failed'))).toBe(false);
    expect(b.log.at(-1)).toBe('Fulfilled: 0 built, 0 failed, 1 left queued.');

    expect(await b.run(world)).toBe(0);
    expect(world.rows[0]).toMatchObject({ state: 'built', objectKey: objectKeyOf(FETCH(1)) });
    // Uploaded again over the same key, then marked.
    expect(world.wrangled.filter((line) => line.startsWith(`r2 object put ${PACKS_BUCKET}/${objectKeyOf(FETCH(1))} `))).toHaveLength(2);
    expect((await validate(unpacked(world.objects.get(objectKeyOf(FETCH(1))))))?.violations).toEqual([]);
    expect(consumeCalls(world)).toEqual([]);
  });

  it('a rerun whose build fails also removes the object the stopped run left', async () => {
    const b = await bench();
    const world = pool([queued(1)]);
    world.breakOnce.built = true;
    expect(await b.run(world)).toBe(1);
    expect(world.objects.size).toBe(1);
    // The lot now builds nothing (its price moved to the empty lot), so the second run fails the fetch.
    writeFileSync(b.lots, JSON.stringify([{ lot: 'lot-empty', priceRefs: ['pack-lot-a'], minTurns: 999 }]));
    expect(await b.run(world)).toBe(1);
    expect(stateOf(world, 1)).toBe('failed');
    expect(world.objects.size).toBe(0);
  });

  it('keeps the buyer key in memory: after a run it is in no file under the temp root and in no printed line, and the build folders are gone', async () => {
    const b = await bench();
    // One fetch built, one whose build fails, one whose upload fails, and one whose builder quotes the key in its error.
    const world = pool([queued(1), queued(2, 'pack-lot-empty'), queued(3), queued(4)]);
    world.breakOnce.put = objectKeyOf(FETCH(3));
    const options = b.options(world);
    const seen: string[] = [];
    const build: FulfilOptions['build'] = (given) => {
      // While a pack is built, its folder is inside the work root.
      seen.push(given.out);
      return given.buyerKey === KEY(4) ? Promise.reject(new Error(`cannot build under ${given.buyerKey}`)) : options.build(given);
    };
    expect(await fulfil({ ...options, build })).toEqual({ built: 1, failed: 3, left: 0 });
    expect(seen).toHaveLength(4);
    expect(seen.every((out) => out.startsWith(b.work))).toBe(true);
    expect(readdirSync(b.work)).toEqual([]);
    const keys = [1, 2, 3, 4].map(KEY);
    // The whole temp root: the store, the operator's files (index.jsonl among them), and the work folder.
    const holders = filesUnder(b.store.root).filter((file) => keys.some((key) => readFileSync(file).includes(key)));
    expect(holders).toEqual([]);
    const printed = b.log.join('\n');
    expect(keys.filter((key) => printed.includes(key))).toEqual([]);
    expect(printed).toContain('cannot build under <buyer key>');
    // No wrangler argument and no request path carried a key either.
    expect(keys.filter((key) => [...world.wrangled, ...world.calls].join('\n').includes(key))).toEqual([]);
    // The objects that stayed hold no key.
    expect([...world.objects.values()].some((bytes) => keys.some((key) => bytes.includes(key)))).toBe(false);
  });

  it('leaves a fetch queued when no lot lists its price, and still builds the next', async () => {
    const b = await bench();
    const world = pool([queued(1, 'pack-unknown'), queued(2)]);
    expect(await b.run(world)).toBe(1);
    expect(stateOf(world, 1)).toBe('queued');
    expect(stateOf(world, 2)).toBe('built');
    expect(world.calls.some((call) => call.endsWith('/failed'))).toBe(false);
    expect(b.log.join('\n')).toContain(`no entry of the lots file lists the price pack-unknown`);
    expect(b.log.at(-1)).toBe('Fulfilled: 1 built, 0 failed, 1 left queued.');
  });

  it('drops the pack and leaves the fetch queued when an objection is recorded during the build', async () => {
    const b = await bench();
    const world = pool([queued(1)]);
    const options = b.options(world);
    const build: FulfilOptions['build'] = async (given) => {
      const counts = await options.build(given);
      appendFileSync(join(dirname(b.store.owners), 'objections.jsonl'), `${JSON.stringify({ session: id(1), received: '2026-11-20T10:00:00.000Z', scope: 'sale' })}\n`);
      return counts;
    };
    expect(await fulfil({ ...options, build })).toEqual({ built: 0, failed: 0, left: 1 });
    expect(stateOf(world, 1)).toBe('queued');
    expect(world.objects.size).toBe(0);
    // The next run builds under the objection: two sessions, not three.
    expect(await b.run(world)).toBe(0);
    expect((await validate(unpacked(world.objects.get(objectKeyOf(FETCH(1))))))?.rows).toBe(2);
  });

  it('uploads nothing for a fetch that left the queue during the build', async () => {
    const b = await bench();
    const world = pool([queued(1)]);
    const options = b.options(world);
    // An erasure fails the fetch while its pack is built.
    const build: FulfilOptions['build'] = async (given) => {
      const counts = await options.build(given);
      Object.assign(world.rows[0] ?? {}, { state: 'failed', buyerKey: null });
      return counts;
    };
    expect(await fulfil({ ...options, build })).toEqual({ built: 0, failed: 0, left: 1 });
    expect(world.wrangled).toEqual([]);
    expect(world.objects.size).toBe(0);
    expect(readdirSync(b.work)).toEqual([]);
  });

  it('refuses to start without its files or a token, before the queue is read', async () => {
    const b = await bench();
    const world = pool([queued(1)]);
    const io = { runtime: b.store.runtime, print: (text: string) => void b.log.push(text), wrangler: world.wrangler, fetcher: world.fetcher };
    const args = ['--lots', b.lots, '--terms', b.store.terms, '--owners', b.store.owners, '--index-key', b.indexKey];
    expect(await main(args.slice(2), { ...io, env: { OARS_POOL_OPERATOR_TOKEN: TOKEN } })).toBe(2);
    expect(await main([...args, '--token', TOKEN], { ...io, env: {} })).toBe(2);
    expect(await main(args, { ...io, env: {} })).toBe(2);
    expect(b.log.at(-1)).toBe('Give the operator token as --token-file <path> or in OARS_POOL_OPERATOR_TOKEN.');
    expect(await main([...args, '--token-file', join(b.store.root, 'absent')], { ...io, env: {} })).toBe(2);
    writeFileSync(b.lots, JSON.stringify([{ lot: 'lot-a', priceRefs: ['p'], sizes: 3 }]));
    expect(await main(args, { ...io, env: { OARS_POOL_OPERATOR_TOKEN: TOKEN } })).toBe(2);
    expect(b.log.at(-1)).toBe('Entry 1 of the lots file has an option this command does not know: sizes.');
    expect(world.calls).toEqual([]);
  });

  it('reads the token from a file and reports a pool that refuses it without printing it', async () => {
    const b = await bench();
    const world = pool([queued(1)]);
    const tokenFile = join(b.store.root, 'token');
    writeFileSync(tokenFile, `\uFEFF${TOKEN}\r\n`);
    const io = { runtime: b.store.runtime, print: (text: string) => void b.log.push(text), wrangler: world.wrangler, fetcher: world.fetcher, env: {} };
    const args = ['--lots', b.lots, '--terms', b.store.terms, '--owners', b.store.owners, '--index-key', b.indexKey, '--server', `${SERVER}/`, '--work', b.work];
    expect(await main([...args, '--token-file', tokenFile], io)).toBe(0);
    expect(stateOf(world, 1)).toBe('built');
    writeFileSync(tokenFile, 'wrong-token');
    expect(await main([...args, '--token-file', tokenFile], io)).toBe(1);
    expect(b.log.at(-1)).toBe('The pool refused the queue read: 401 unauthorized.');
  });
});

describe('parseLots', () => {
  it('reads a lot with its prices and build options, with the defaults of sample-pack', () => {
    expect(parseLots(JSON.stringify([{ lot: 'lot-2', priceRefs: ['a', 'b'], deposits: '/pulled', size: 500, stripThinking: true, olderThanDays: 30 }]))).toEqual([
      { lot: 'lot-2', priceRefs: ['a', 'b'], build: { size: 500, seed: '1', minTurns: 20, deposits: '/pulled', stripThinking: true, skeletonOnly: undefined, olderThanDays: 30, excludeManifest: undefined, excludeNames: undefined } },
    ]);
  });

  it.each([
    ['{}', 'The lots file is a JSON list.'],
    ['[3]', 'Entry 1 of the lots file is not an object.'],
    ['[{"lot": "a"}]', 'Entry 1 of the lots file needs "lot" and "priceRefs": the lot\'s name and the prices that sell it.'],
    ['[{"lot": "a", "priceRefs": []}]', 'Entry 1 of the lots file has a bad value for priceRefs.'],
    ['[{"lot": "a", "priceRefs": ["p"], "size": 0}]', 'Entry 1 of the lots file has a bad value for size.'],
    ['[{"lot": "a", "priceRefs": ["p"]}, {"lot": "b", "priceRefs": ["p"]}]', 'The price p is listed twice in the lots file.'],
  ])('refuses %s', (text, message) => {
    expect(() => parseLots(text)).toThrow(new PackError(message));
  });
});
