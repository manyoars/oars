import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyBundle } from '../../cli/src/sessions/pool-wire.js';
import { sampleSkeleton } from './sample.js';
import { fieldOf, startPool, stubUser, type TestPool } from './test-pool.js';
import { isoWeekOf } from './week.js';

const PATH = '/bundle/2.1.314/0';

let pool: TestPool;

const deposit = async (target: TestPool, id: string): Promise<string> => {
  const { token } = await target.signIn('github', stubUser(id));
  await target.post('/v1/covenant/accept', { version: 'v1' }, token);
  expect((await target.post('/v1/deposits', sampleSkeleton(id.padStart(16, '0')), token)).status).toBe(201);
  return token;
};

const tally = async (target: TestPool, account: string): Promise<{ week: unknown; fetches: unknown }> => {
  const row = await (await target.db()).prepare('SELECT fetch_week AS week, fetches FROM accounts WHERE id = ?').bind(account).first();
  return { week: fieldOf(row, 'week'), fetches: fieldOf(row, 'fetches') };
};

const etagOf = (headers: Headers): string => {
  const etag = headers.get('etag');
  if (etag === null) throw new Error('no ETag');
  return etag;
};

beforeAll(async () => {
  // The default cap, one fetch a week, so a test meets the cap without setting it.
  pool = await startPool({ FETCH_CAP: '' });
  for (const id of ['2001', '2002', '2003']) await deposit(pool, id);
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

describe('fetch_cap: fetches per account per ISO week', () => {
  it('serves the whole bundle to the account that fetches, then answers 429 with Retry-After at the next week', async () => {
    const { token } = await pool.signIn('github', stubUser('2101'));
    const first = await pool.raw(PATH, token);
    expect(first.status).toBe(200);
    const verified = await verifyBundle(first.json, pool.signingKey(), '2.1.314');
    if (!verified.ok) throw new Error(verified.reason);
    expect(verified.bundle.reads.length).toBeGreaterThan(0);
    expect(verified.bundle.cells.length).toBeGreaterThan(0);

    const second = await pool.raw(PATH, token);
    expect(second).toMatchObject({ status: 429, json: { error: 'fetch_cap' } });
    const wait = Number(second.headers.get('retry-after'));
    expect(Number.isInteger(wait)).toBe(true);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(7 * 24 * 3600);
  });

  it('counts per account, not per harness version: a second version is the second fetch', async () => {
    const { token } = await pool.signIn('github', stubUser('2102'));
    expect((await pool.raw(PATH, token)).status).toBe(200);
    expect((await pool.raw('/bundle/2.2.0/0', token)).status).toBe(429);
  });

  it('keeps the count per account: another account still has its own fetch', async () => {
    const one = await pool.signIn('github', stubUser('2103'));
    const two = await pool.signIn('github', stubUser('2104'));
    expect((await pool.raw(PATH, one.token)).status).toBe(200);
    expect((await pool.raw(PATH, one.token)).status).toBe(429);
    expect((await pool.raw(PATH, two.token)).status).toBe(200);
  });

  it('stops at the cap a deploy sets, and falls back to one when the binding is not a positive whole number', async () => {
    const two = await startPool({ FETCH_CAP: '2' });
    const junk = await startPool({ FETCH_CAP: 'many' });
    try {
      const { token } = await two.signIn('github', stubUser('2105'));
      expect([(await two.raw(PATH, token)).status, (await two.raw(PATH, token)).status, (await two.raw(PATH, token)).status]).toEqual([200, 200, 429]);
      const other = await junk.signIn('github', stubUser('2106'));
      expect([(await junk.raw(PATH, other.token)).status, (await junk.raw(PATH, other.token)).status]).toEqual([200, 429]);
    } finally {
      await two.dispose();
      await junk.dispose();
    }
  }, 60_000);

  it('spends exactly one of two fetches made at once', async () => {
    const { token } = await pool.signIn('github', stubUser('2107'));
    const answers = await Promise.all([pool.raw(PATH, token), pool.raw(PATH, token)]);
    expect(answers.map(({ status }) => status).sort()).toEqual([200, 429]);
  });

  it('spends nothing on a refusal before the spend: a bad version, a bad vocabulary, no signing key', async () => {
    const { token, account } = await pool.signIn('github', stubUser('2108'));
    expect((await pool.raw('/bundle/acme/0', token)).status).toBe(400);
    expect((await pool.raw('/bundle/2.1.314/9', token)).status).toBe(400);
    expect(await tally(pool, account)).toEqual({ week: null, fetches: 0 });

    const bare = await startPool({ SLICE_SIGNING_KEY: '' });
    try {
      // No key, no sign-in: the account and its token are written directly.
      const db = await bare.db();
      await db.prepare("INSERT INTO accounts (id) VALUES ('unkeyed')").run();
      await db.prepare("INSERT INTO tokens (hash, account, expires_at) VALUES (?, 'unkeyed', ?)").bind(createHash('sha256').update('a-token').digest('hex'), Date.now() + 60_000).run();
      expect((await bare.raw(PATH, 'a-token')).status).toBe(503);
      expect(await tally(bare, 'unkeyed')).toEqual({ week: null, fetches: 0 });
    } finally {
      await bare.dispose();
    }
  }, 60_000);
});

describe('across an ISO week boundary', () => {
  it('starts the count again in a new week: a count left in an earlier week is replaced by this fetch', async () => {
    const { token, account } = await pool.signIn('github', stubUser('2201'));
    await (await pool.db()).prepare('UPDATE accounts SET fetch_week = ?, fetches = 1 WHERE id = ?').bind('2020-W53', account).run();
    expect((await pool.raw(PATH, token)).status).toBe(200);
    expect(await tally(pool, account)).toEqual({ week: isoWeekOf(Date.now()), fetches: 1 });
    expect((await pool.raw(PATH, token)).status).toBe(429);
  });

  it('refuses a count spent in this week, and an account at the cap is not counted further', async () => {
    const { token, account } = await pool.signIn('github', stubUser('2202'));
    await (await pool.db()).prepare('UPDATE accounts SET fetch_week = ?, fetches = 1 WHERE id = ?').bind(isoWeekOf(Date.now()), account).run();
    expect((await pool.raw(PATH, token)).status).toBe(429);
    expect((await tally(pool, account)).fetches).toBe(1);
  });

  it('drops every earlier week\'s count when a fetch is served, so only this week is kept per account', async () => {
    const stale = await pool.signIn('github', stubUser('2203'));
    const fresh = await pool.signIn('github', stubUser('2204'));
    await (await pool.db()).prepare('UPDATE accounts SET fetch_week = ?, fetches = 1 WHERE id = ?').bind('2020-W01', stale.account).run();
    expect((await pool.raw(PATH, fresh.token)).status).toBe(200);
    expect(await tally(pool, stale.account)).toEqual({ week: null, fetches: 0 });
  });
});

describe('a 304 spends none', () => {
  it('answers a conditional request with 304 and the same ETag, at the cap and with the count unchanged', async () => {
    const { token, account } = await pool.signIn('github', stubUser('2301'));
    const first = await pool.raw(PATH, token);
    const etag = etagOf(first.headers);
    expect((await pool.raw(PATH, token)).status).toBe(429);
    for (let again = 0; again < 3; again += 1) {
      const held = await pool.raw(PATH, token, { 'if-none-match': etag });
      expect(held.status).toBe(304);
      expect(held.json).toBeNull();
      expect(etagOf(held.headers)).toBe(etag);
    }
    expect((await tally(pool, account)).fetches).toBe(1);
  });

  it('matches a weakened ETag, as a proxy that compresses sends it, and one of several listed', async () => {
    const { token } = await pool.signIn('github', stubUser('2302'));
    const etag = etagOf((await pool.raw(PATH, token)).headers);
    expect((await pool.raw(PATH, token, { 'if-none-match': `W/${etag}` })).status).toBe(304);
    expect((await pool.raw(PATH, token, { 'if-none-match': `"other", ${etag}` })).status).toBe(304);
  });

  it('is not served to a caller with no credential', async () => {
    const { token } = await pool.signIn('github', stubUser('2303'));
    const etag = etagOf((await pool.raw(PATH, token)).headers);
    expect((await pool.raw(PATH, undefined, { 'if-none-match': etag })).status).toBe(401);
  });

  it('sends the bundle when the ETag is that of another version, and that spends a fetch', async () => {
    const { token } = await pool.signIn('github', stubUser('2304'));
    const etag = etagOf((await pool.raw(PATH, token)).headers);
    const other = await pool.signIn('github', stubUser('2306'));
    expect((await pool.raw('/bundle/2.2.0/0', other.token, { 'if-none-match': etag })).status).toBe(200);
    expect((await tally(pool, other.account)).fetches).toBe(1);
  });

  it('never reads the pool: a conditional request is answered when a stored row would break a parse', async () => {
    const bare = await startPool();
    try {
      await deposit(bare, '2401');
      const { token } = await bare.signIn('github', stubUser('2402'));
      const etag = etagOf((await bare.raw(PATH, token)).headers);
      const db = await bare.db();
      // The generation trigger is dropped so the damaged row does not move the ETag: only a read of the pool would find it.
      await db.prepare('DROP TRIGGER deposits_generation_insert').run();
      const other = await bare.signIn('github', stubUser('2403'));
      await db.prepare("INSERT INTO deposits (account, id, skeleton) VALUES (?, 'damaged', 'not json')").bind(other.account).run();
      expect((await bare.raw(PATH, token, { 'if-none-match': etag })).status).toBe(304);
    } finally {
      await bare.dispose();
    }
  }, 60_000);
});

describe('the ETag follows the rows', () => {
  it('moves when a deposit lands or a held one changes, and stays when the same session is sent again', async () => {
    const own = await startPool();
    try {
      const etag = async (id: string): Promise<string> => etagOf((await own.raw(PATH, (await own.signIn('github', stubUser(id))).token)).headers);
      const before = await etag('2501');
      const token = await deposit(own, '2502');
      const after = await etag('2503');
      expect(after).not.toBe(before);

      expect((await own.post('/v1/deposits', sampleSkeleton('0000000000002502'), token)).status).toBe(201);
      expect(await etag('2504')).toBe(after);

      expect((await own.post('/v1/deposits', sampleSkeleton('0000000000002502', { languages: ['go'] }), token)).status).toBe(201);
      const changed = await etag('2505');
      expect(changed).not.toBe(after);

      await (await own.db()).prepare('DELETE FROM deposits').run();
      expect(await etag('2506')).not.toBe(changed);
    } finally {
      await own.dispose();
    }
  }, 60_000);

  it('differs by harness version', async () => {
    const own = await startPool();
    try {
      const { token } = await own.signIn('github', stubUser('2507'));
      const one = etagOf((await own.raw(PATH, token)).headers);
      const two = etagOf((await own.raw('/bundle/2.2.0/0', token)).headers);
      expect(one).not.toBe(two);
    } finally {
      await own.dispose();
    }
  }, 60_000);
});
