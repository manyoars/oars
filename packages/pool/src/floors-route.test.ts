// The floors are the Worker's bindings. A pool whose deploy sets them serves at them, states them in the signed bundle, in each read, and in the ETag; a bad binding is the default. Accounts here are real deposits under Miniflare.
import { afterAll, describe, expect, it } from 'vitest';
import { verifyBundle, VOCAB_VERSION, type Bundle } from '../../cli/src/sessions/pool-wire.js';
import { etagOf } from './bundle.js';
import { SERVED } from './derive.js';
import { floorsOf } from './floors.js';
import { sampleSkeleton } from './sample.js';
import { acceptanceOf, startPool, stubUser, type TestPool } from './test-pool.js';

const VERSION = '2.1.314';
const PATH = `/bundle/claude-code/${VERSION}/${VOCAB_VERSION}`;
const started: TestPool[] = [];

afterAll(async () => {
  await Promise.all(started.map((pool) => pool.dispose()));
});

const poolWith = async (bindings: { [name: string]: string }): Promise<TestPool> => {
  const pool = await startPool(bindings);
  started.push(pool);
  return pool;
};

const depositor = async (pool: TestPool, id: string): Promise<string> => {
  const { token } = await pool.signIn('github', stubUser(id));
  await pool.post('/v1/covenant/accept', acceptanceOf('v1'), token);
  expect((await pool.post('/v1/deposits', sampleSkeleton(id.padStart(16, '0')), token)).status).toBe(201);
  return token;
};

const fetched = async (pool: TestPool, token: string): Promise<{ bundle: Bundle; etag: string | null }> => {
  const response = await pool.raw(PATH, token);
  expect(response.status).toBe(200);
  const verified = await verifyBundle(response.json, pool.pinned(), 'claude-code', VERSION);
  if (!verified.ok) throw new Error(verified.reason);
  return { bundle: verified.bundle, etag: response.headers.get('etag') };
};

describe('a pool whose deploy lowers the public floor to 3', () => {
  it('serves at three accounts, and states 3 in the bundle, in every read, and in the ETag', async () => {
    const pool = await poolWith({ PUBLIC_FLOOR: '3', DISCLOSURE_FLOOR: '4', PUBLIC_FLOOR_FAMILIES: 'tool-day=4' });
    const tokens = [await depositor(pool, '8101'), await depositor(pool, '8102')];
    expect((await fetched(pool, tokens[0] ?? '')).bundle.reads).toEqual([]);
    tokens.push(await depositor(pool, '8103'));
    const { bundle, etag } = await fetched(pool, tokens[0] ?? '');
    expect(bundle.floors).toEqual({ public: 3, disclosure: 4, clear: 3, families: { 'tool-day': 4 } });
    expect(bundle.reads.length).toBeGreaterThan(0);
    // The family on its own floor of 4 serves nothing at three accounts; every other read cleared 3 and says so.
    expect(bundle.reads.some((read) => read.family === 'tool-day')).toBe(false);
    expect(bundle.reads.every((read) => read.floor === 3)).toBe(true);
    expect(bundle.cells.every((cell) => cell.clusters >= 3)).toBe(true);
    const generation = Number(await (await pool.db()).prepare('SELECT generation FROM pool_generation WHERE id = 1').first('generation'));
    expect(etag).toBe(etagOf('claude-code', VERSION, generation, [...SERVED.map(({ name }) => name), 'books'], floorsOf({ PUBLIC_FLOOR: '3', CLEAR_FLOOR: '3', DISCLOSURE_FLOOR: '4', PUBLIC_FLOOR_FAMILIES: 'tool-day=4' }, () => undefined)));
    // The fourth account lifts the family that was on 4 and no other.
    tokens.push(await depositor(pool, '8104'));
    const after = (await fetched(pool, tokens[0] ?? '')).bundle;
    expect(after.reads.filter((read) => read.family === 'tool-day').every((read) => read.floor === 4)).toBe(true);
    expect(after.reads.some((read) => read.family === 'tool-day')).toBe(true);
    expect(after.reads.filter((read) => read.family !== 'tool-day').every((read) => read.floor === 3)).toBe(true);
  }, 120_000);
});

describe('a pool whose bindings are bad', () => {
  const BAD: ReadonlyArray<{ label: string; bindings: { [name: string]: string } }> = [
    { label: 'under 1', bindings: { PUBLIC_FLOOR: '0', DISCLOSURE_FLOOR: '-2' } },
    { label: 'not a number', bindings: { PUBLIC_FLOOR: 'three', DISCLOSURE_FLOOR: '1.5' } },
    { label: 'a family it does not serve', bindings: { PUBLIC_FLOOR_FAMILIES: 'lve=1' } },
  ];
  it.each(BAD)('serves at the defaults, never below them: $label', async ({ bindings }) => {
    const pool = await poolWith(bindings);
    const tokens: string[] = [];
    for (const id of ['8201', '8202', '8203', '8204']) tokens.push(await depositor(pool, id));
    const four = (await fetched(pool, tokens[0] ?? '')).bundle;
    expect(four.floors).toEqual({ public: 5, disclosure: 2, clear: 5 });
    expect(four.reads).toEqual([]);
    expect(four.cells).toEqual([]);
    tokens.push(await depositor(pool, '8205'));
    const five = (await fetched(pool, tokens[0] ?? '')).bundle;
    expect(five.reads.length).toBeGreaterThan(0);
    expect(five.reads.every((read) => read.floor === 5)).toBe(true);
  }, 120_000);
});
