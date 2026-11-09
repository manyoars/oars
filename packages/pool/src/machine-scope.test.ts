// The machine key's scope: a key deposits, reads the covenant, and activates and rotates itself, and every other route answers it 403 `deposit_only`. The table below is the router's own route list (`ROUTES`) and the raw tier's (`RAW_ROUTES`), so a route added later is walked without anyone remembering to list it, and a route that lets a key through by mistake fails here by name.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RAW_ROUTES } from './raw.js';
import { fieldOf, startPool, stubUser, textOf, type TestPool } from './test-pool.js';
import { ROUTES } from './worker.js';

/** The only routes a machine key may call. A route added with `machine: true` changes this list, which is a decision a reviewer should see. */
const MACHINE_ROUTES = ['GET /v1/covenant', 'POST /v1/deposits', 'POST /v1/machines/activate', 'POST /v1/machines/rotate'];

const HASH = 'a'.repeat(64);

/** A path each raw route accepts. Its pattern must match it, so a raw route added without a sample here fails the walk instead of going untested. */
const RAW_SAMPLES = [
  { method: 'PUT', path: `/v1/raw/${HASH}/parts/1` },
  { method: 'POST', path: `/v1/raw/${HASH}/complete` },
];

interface Probe {
  method: string;
  path: string;
}

/** A path template with a name in every `:name` segment. */
const concrete = (path: string): string => path.replace(/:[A-Za-z]+/g, 'x');

let pool: TestPool;
let accountToken: string;
let keys: { [state: string]: string };

const enroll = async (): Promise<{ key: string; id: string }> => {
  const answered = await pool.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label: 'scope probe' }, accountToken);
  return { key: textOf(answered.json, 'token'), id: textOf(fieldOf(answered.json, 'machine'), 'id') };
};

/** A machine that has activated, with its key. */
const activated = async (): Promise<{ key: string; id: string }> => {
  const machine = await enroll();
  await pool.post('/v1/machines/activate', {}, machine.key);
  return machine;
};

beforeAll(async () => {
  pool = await startPool();
  accountToken = (await pool.signIn('github', stubUser('4401'))).token;
  const waiting = await enroll();
  const live = await activated();
  const revoked = await activated();
  await pool.send(`/v1/machines/${revoked.id}`, { method: 'DELETE' }, accountToken);
  keys = { pending: waiting.key, active: live.key, revoked: revoked.key };
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const send = (probe: Probe, key: string): ReturnType<TestPool['send']> =>
  pool.send(probe.path, probe.method === 'POST' || probe.method === 'PUT' ? { method: probe.method, body: '{}' } : { method: probe.method }, key);

describe('the machine key scope', () => {
  it('lets a key call exactly the routes that say so', () => {
    expect(ROUTES.filter((route) => route.machine).map((route) => `${route.method} ${route.path}`).sort()).toEqual(MACHINE_ROUTES);
  });

  it('has a sample for every raw route, and each sample is that route', () => {
    for (const route of RAW_ROUTES) {
      const samples = RAW_SAMPLES.filter((sample) => sample.method === route.method && route.pattern.test(sample.path));
      expect({ route: `${route.method} ${route.pattern.source}`, samples: samples.length }).toEqual({ route: `${route.method} ${route.pattern.source}`, samples: 1 });
    }
    expect(RAW_SAMPLES).toHaveLength(RAW_ROUTES.length);
  });

  it('answers every other route 403 deposit_only to a pending token, an active key, and a revoked key, and changes nothing', async () => {
    const probes: Probe[] = [
      ...ROUTES.filter((route) => !route.machine).map((route) => ({ method: route.method, path: concrete(route.path) })),
      ...RAW_SAMPLES,
      // An unknown path is refused by the scope before the router says it is unknown.
      { method: 'GET', path: '/v1/no-such-route' },
    ];
    const state = async (): Promise<unknown> => ({
      machines: (await (await pool.db()).prepare('SELECT id, state, key_hash, retired_hash FROM machines ORDER BY id').all()).results,
      tokens: await (await pool.db()).prepare('SELECT COUNT(*) AS count FROM tokens').first('count'),
      accounts: await (await pool.db()).prepare('SELECT COUNT(*) AS count FROM accounts').first('count'),
    });
    const before = await state();
    for (const [held, key] of Object.entries(keys)) {
      for (const probe of probes) {
        const answered = await send(probe, key);
        const named = { held, route: `${probe.method} ${probe.path}` };
        expect({ ...named, status: answered.status, error: fieldOf(answered.json, 'error') }).toEqual({ ...named, status: 403, error: 'deposit_only' });
      }
    }
    expect(await state()).toEqual(before);
  });

  it('does not refuse a key at the routes it may call', async () => {
    for (const route of ROUTES.filter((entry) => entry.machine)) {
      // Each route gets a key of its own: rotating one replaces it.
      const answered = await send({ method: route.method, path: concrete(route.path) }, (await activated()).key);
      expect({ route: `${route.method} ${route.path}`, refusedAsDepositOnly: fieldOf(answered.json, 'error') === 'deposit_only' }).toEqual({ route: `${route.method} ${route.path}`, refusedAsDepositOnly: false });
    }
  });
});
