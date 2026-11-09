import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sampleSkeleton } from './sample.js';
import { acceptanceOf, startPool, stubUser, type TestPool, textOf } from './test-pool.js';

let pool: TestPool;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

describe('a deposit stores its batch on the ledger', () => {
  it('keeps the projected skeleton and the deltas, which the wire does not carry yet', async () => {
    const { token, account } = await pool.signIn('github', stubUser('8101'));
    await pool.post('/v1/covenant/accept', acceptanceOf('v1'), token);
    const skeleton = sampleSkeleton('0000000000008101');
    expect((await pool.post('/v1/deposits', skeleton, token)).status).toBe(201);
    const row = await (await pool.db()).prepare('SELECT skeleton, deltas FROM deposits WHERE account = ?').bind(account).first();
    expect(JSON.parse(textOf(row, 'skeleton'))).toEqual(skeleton);
    expect(textOf(row, 'deltas')).toBe('[]');
  });
});
