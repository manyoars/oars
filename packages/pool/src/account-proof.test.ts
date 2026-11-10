// POST /v1/account/proof: the account proves control of itself with its sign-in token alone, and the pool stores the time for the operator to confirm a requester against (GDPR Art. 12(6)). A machine key never proves a person (Art. 32).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fieldOf, startPool, stubUser, textOf, type TestPool } from './test-pool.js';

let pool: TestPool;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const provedAtOf = async (account: string): Promise<unknown> => fieldOf(await (await pool.db()).prepare('SELECT proved_at FROM accounts WHERE id = ?').bind(account).first(), 'proved_at');

describe('POST /v1/account/proof', () => {
  it('stores the proof time for a sign-in token, answers it with the account, and overwrites it on the next proof', async () => {
    const { token, account } = await pool.signIn('github', stubUser('8201'));
    expect(await provedAtOf(account)).toBeNull();
    const first = await pool.post('/v1/account/proof', {}, token);
    expect(first.status).toBe(200);
    expect(textOf(first.json, 'account')).toBe(account);
    const provedAt = Number(fieldOf(first.json, 'provedAt'));
    expect(provedAt).toBeGreaterThan(0);
    expect(await provedAtOf(account)).toBe(provedAt);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = Number(fieldOf((await pool.post('/v1/account/proof', {}, token)).json, 'provedAt'));
    expect(second).toBeGreaterThan(provedAt);
    expect(await provedAtOf(account)).toBe(second);
  }, 60_000);

  it('refuses a live machine key with 403 deposit_only and leaves proved_at unchanged', async () => {
    const { token, account } = await pool.signIn('github', stubUser('8202'));
    const proved = Number(fieldOf((await pool.post('/v1/account/proof', {}, token)).json, 'provedAt'));
    const enrolled = await pool.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label: 'box' }, token);
    const key = textOf(enrolled.json, 'token');
    expect(await pool.post('/v1/account/proof', {}, key)).toMatchObject({ status: 403, json: { error: 'deposit_only' } });
    expect(await provedAtOf(account)).toBe(proved);
    // An account that never proved stays null too.
    const other = await pool.signIn('github', stubUser('8203'));
    const otherKey = textOf((await pool.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label: 'box' }, other.token)).json, 'token');
    expect(await pool.post('/v1/account/proof', {}, otherKey)).toMatchObject({ status: 403, json: { error: 'deposit_only' } });
    expect(await provedAtOf(other.account)).toBeNull();
  }, 60_000);

  it('answers a revoked token, an unknown token, and no token 401 and stores nothing', async () => {
    const { token, account } = await pool.signIn('github', stubUser('8204'));
    expect((await pool.send('/v1/login', { method: 'DELETE' }, token)).status).toBe(204);
    expect(await pool.post('/v1/account/proof', {}, token)).toMatchObject({ status: 401, json: { error: 'unauthorized' } });
    expect(await pool.post('/v1/account/proof', {}, 'f'.repeat(64))).toMatchObject({ status: 401 });
    expect(await pool.post('/v1/account/proof', {})).toMatchObject({ status: 401 });
    expect(await provedAtOf(account)).toBeNull();
  }, 60_000);
});
