// What an `operator-fleet` source changes and what it does not (t1361): the account's deposits still feed the cells and its own weeks, and setting it back to `user` puts it in the count again. The four counts that drop it are pinned in panel.test.ts, covenant-funnel.test.ts, and proof-sheet.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSource } from '../scripts/set-source.js';
import { sampleSkeleton } from './sample.js';
import { PANEL_COUNT } from './stored.js';
import { acceptanceOf, fieldOf, startPool, stubUser, type TestDb, type TestPool } from './test-pool.js';

let pool: TestPool;
let db: TestDb;

beforeAll(async () => {
  pool = await startPool();
  db = await pool.db();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const storeOf = (): Parameters<typeof setSource>[0] => ({
  rows: async (sql, binds) => (await db.prepare(sql).bind(...binds).all()).results,
  run: async (sql, binds) => Number(fieldOf(fieldOf(await db.prepare(sql).bind(...binds).run(), 'meta'), 'changes')),
});

const cellSessions = async (): Promise<number> => Number(fieldOf((await db.prepare('SELECT COALESCE(SUM(sessions), 0) AS held FROM cells').all()).results[0], 'held'));

describe('an operator-fleet account', () => {
  it('feeds the cells and its own weeks like a user, and is the panel\'s again once set back to user', async () => {
    const { token, account } = await pool.signIn('github', stubUser('9301'));
    await pool.post('/v1/covenant/accept', acceptanceOf('v1'), token);
    await setSource(storeOf(), { account, source: 'operator-fleet', by: 'owner', reason: 'the fleet' });
    const before = await cellSessions();
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000930101'), token)).status).toBe(201);
    expect(await cellSessions()).toBeGreaterThan(before);
    expect(Number(fieldOf((await db.prepare('SELECT COUNT(*) AS weeks FROM account_weeks WHERE account = ?').bind(account).all()).results[0], 'weeks'))).toBe(1);
    const panel = async (): Promise<number> => Number(fieldOf((await db.prepare(PANEL_COUNT).bind(0).all()).results[0], 'accounts'));
    expect(await panel()).toBe(0);
    await setSource(storeOf(), { account, source: 'user', by: 'owner', reason: 'undo' });
    expect(await panel()).toBe(1);
  });
});
