// An honest deposit is never refused for volume (t880): the per-account limits are an operator's brake, off by default.
import { describe, expect, it } from 'vitest';
import { brake } from './http.js';
import { sampleSkeleton } from './sample.js';
import { fieldOf, startPool, stubUser, textOf, type Answer, type TestPool } from './test-pool.js';

const signedIn = async (pool: TestPool, id: string): Promise<string> => {
  const { token } = await pool.signIn('github', stubUser(id));
  await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
  return token;
};

/** Rows written straight to the ledger, so a test need not post twenty thousand deposits: the count and the stored bytes are what the limits read. */
const seed = async (pool: TestPool, rows: number, bytesEach: number): Promise<void> => {
  const db = await pool.db();
  const account = textOf(await db.prepare('SELECT id FROM accounts ORDER BY rowid DESC LIMIT 1').first(), 'id');
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
      expect(Number(fieldOf(held, 'bytes'))).toBeGreaterThan(64 * 1024 * 1024);
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
      expect(await rows.post('/v1/deposits', sampleSkeleton('0000000000000001'), token)).toMatchObject({ status: 403, json: { error: 'deposit_limit', message: "An operator's brake holds this account to at most 3 deposits." } });
    } finally {
      await rows.dispose();
    }
    const bytes = await startPool({ COVENANT_VERSION: 'v1', MAX_DEPOSIT_BYTES_PER_ACCOUNT: '1000' });
    try {
      const token = await signedIn(bytes, '8003');
      expect(await bytes.post('/v1/deposits', sampleSkeleton('0000000000000001'), token)).toMatchObject({ status: 403, json: { error: 'deposit_limit', message: "An operator's brake holds this account to at most 1000 stored bytes." } });
    } finally {
      await bytes.dispose();
    }
    const both = await startPool({ COVENANT_VERSION: 'v1', MAX_DEPOSITS_PER_ACCOUNT: '3', MAX_DEPOSIT_BYTES_PER_ACCOUNT: '1000' });
    try {
      const token = await signedIn(both, '8004');
      await seed(both, 3, 10);
      expect(await both.post('/v1/deposits', sampleSkeleton('0000000000000001'), token)).toMatchObject({ status: 403, json: { error: 'deposit_limit', message: "An operator's brake holds this account to at most 3 deposits and 1000 stored bytes." } });
    } finally {
      await both.dispose();
    }
  }, 120_000);
});

describe('a redeposit', () => {
  it('replaces the row in place, adds nothing to the count, and never deletes: the ledger triggers still refuse a delete', async () => {
    const pool = await startPool({ COVENANT_VERSION: 'v1', MAX_DEPOSITS_PER_ACCOUNT: '1' });
    try {
      const token = await signedIn(pool, '8004');
      const db = await pool.db();
      const first = sampleSkeleton('0000000000000001', { languages: ['typescript'] }, '2026-11-01');
      expect((await pool.post('/v1/deposits', first, token)).status).toBe(201);
      const before = await db.prepare('SELECT skeleton FROM deposits').first('skeleton');
      // At a one-row brake, the same session again is a replacement, not a second row.
      expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000000001', { languages: ['python'] }, '2026-11-02'), token)).status).toBe(201);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM deposits').first('count')).toBe(1);
      expect(await db.prepare('SELECT skeleton FROM deposits').first('skeleton')).not.toBe(before);
      // The replacement was an UPDATE: the ledger's delete triggers hold, and the earlier cells stay as contributors.
      await expect(db.prepare('DELETE FROM deposits').run()).rejects.toThrow('ledger rows are never deleted');
      await expect(db.prepare('DELETE FROM contributors').run()).rejects.toThrow('ledger rows are never deleted');
      expect(Number(await db.prepare('SELECT COUNT(*) AS count FROM contributors').first('count'))).toBeGreaterThan(0);
    } finally {
      await pool.dispose();
    }
  }, 60_000);
});

describe('brake', () => {
  it('is a positive whole number, and anything else is no limit', () => {
    expect(brake('3')).toBe(3);
    for (const value of [undefined, '', '0', '-2', '1.5', 'many', '9007199254740993']) expect(brake(value)).toBeUndefined();
  });
});
