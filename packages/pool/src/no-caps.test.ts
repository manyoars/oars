// An honest deposit is never refused for volume (t880): the per-account limits are an operator's brake, off by default.
import { describe, expect, it } from 'vitest';
import { brake } from './http.js';
import { sampleSkeleton } from './sample.js';
import { startPool, stubUser, type Answer, type TestPool } from './test-pool.js';

const signedIn = async (pool: TestPool, id: string): Promise<string> => {
  const { token } = await pool.signIn('github', stubUser(id));
  await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
  return token;
};

/** Rows written straight to the ledger, so a test need not post twenty thousand deposits: the count and the stored bytes are what the limits read. */
const seed = async (pool: TestPool, rows: number, bytesEach: number): Promise<void> => {
  const db = await pool.db();
  const account = await db.prepare('SELECT id FROM accounts ORDER BY rowid DESC LIMIT 1').first('id');
  await db
    .prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO deposits (account, id, skeleton) SELECT ?, printf('f%015x', i), substr(hex(zeroblob(?)), 1, ?) FROM n")
    .bind(rows, account, bytesEach, bytesEach)
    .run();
};

describe('the per-account limits', () => {
  it('are off by default: an account past 20,000 rows and past 64 MB still deposits, and a redeposit still replaces', async () => {
    const pool = await startPool({ COVENANT_VERSION: 'v1' });
    try {
      const token = await signedIn(pool, '8001');
      await seed(pool, 20_001, 3_400);
      const held = await (await pool.db()).prepare('SELECT COUNT(*) AS rows, SUM(LENGTH(skeleton)) AS bytes FROM deposits').first();
      expect(held).toMatchObject({ rows: 20_001 });
      expect(Number(Reflect.get(held as object, 'bytes'))).toBeGreaterThan(64 * 1024 * 1024);
      const sent = (id: string): Promise<Answer> => pool.post('/v1/deposits', sampleSkeleton(id), token);
      expect((await sent('0000000000000001')).status).toBe(201);
      expect((await sent('0000000000000001')).status).toBe(201);
      expect(await (await pool.db()).prepare('SELECT COUNT(*) AS count FROM deposits').first('count')).toBe(20_002);
    } finally {
      await pool.dispose();
    }
  }, 120_000);

  it('still brake when an operator sets them, on the row count and on the stored bytes', async () => {
    const rows = await startPool({ COVENANT_VERSION: 'v1', MAX_DEPOSITS_PER_ACCOUNT: '3' });
    try {
      const token = await signedIn(rows, '8002');
      await seed(rows, 3, 10);
      expect(await rows.post('/v1/deposits', sampleSkeleton('0000000000000001'), token)).toMatchObject({ status: 403, json: { error: 'deposit_limit' } });
    } finally {
      await rows.dispose();
    }
    const bytes = await startPool({ COVENANT_VERSION: 'v1', MAX_DEPOSIT_BYTES_PER_ACCOUNT: '1000' });
    try {
      const token = await signedIn(bytes, '8003');
      expect(await bytes.post('/v1/deposits', sampleSkeleton('0000000000000001'), token)).toMatchObject({ status: 403, json: { error: 'deposit_limit' } });
    } finally {
      await bytes.dispose();
    }
  }, 120_000);
});

describe('brake', () => {
  it('is a positive whole number, and anything else is no limit', () => {
    expect(brake('3')).toBe(3);
    for (const value of [undefined, '', '0', '-2', '1.5', 'many', '9007199254740993']) expect(brake(value)).toBeUndefined();
  });
});
