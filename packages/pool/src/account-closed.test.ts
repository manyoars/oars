// A closed account (covenant 6.1, 7.2(a)): sign-in, machine enrollment, and activation refuse it, and the message names where to write.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPool, stubUser, textOf, type TestPool } from './test-pool.js';

let pool: TestPool;
let next = 9100;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const CLOSED = { status: 403, json: { error: 'account_closed', message: 'This account is closed. To reopen it, write to privacy@manyoars.com.' } };
const BOX = { hostClass: 'vps', launcher: 'scheduled', label: 'box' };

const member = async (): Promise<{ token: string; account: string; id: string }> => {
  next += 1;
  const id = String(next);
  return { ...(await pool.signIn('github', stubUser(id))), id };
};

/** The state a close leaves on the account row, set directly so each route is tested alone (the operator step that does it has its own tests). */
const close = async (account: string): Promise<void> => {
  await (await pool.db()).prepare('UPDATE accounts SET closed_at = ? WHERE id = ?').bind(Date.now(), account).run();
};

describe('a closed account', () => {
  it('is refused at sign-in with 403 account_closed and is given no credential', async () => {
    const { account, id } = await member();
    await close(account);
    const started = await pool.post('/v1/login/start', { provider: 'github' });
    const userCode = textOf(started.json, 'userCode');
    pool.stub.approve(`device-${/USER-(\d+)/.exec(userCode)?.[1] ?? ''}`, stubUser(id));
    const handle = textOf(started.json, 'handle');
    await pool.due(handle);
    const before = (await (await pool.db()).prepare('SELECT COUNT(*) AS held FROM tokens WHERE account = ?').bind(account).first<{ held: number }>())?.held;
    expect(await pool.post('/v1/login/poll', { handle })).toEqual(CLOSED);
    expect((await (await pool.db()).prepare('SELECT COUNT(*) AS held FROM tokens WHERE account = ?').bind(account).first<{ held: number }>())?.held).toBe(before);
  }, 60_000);

  it('is refused at machine enrollment with 403 account_closed', async () => {
    const { token, account } = await member();
    await close(account);
    expect(await pool.post('/v1/machines/enroll', BOX, token)).toEqual(CLOSED);
  }, 60_000);

  it('is refused at activation with 403 account_closed, and a revoked machine key keeps its own refusal', async () => {
    const { token, account } = await member();
    const pending = await pool.post('/v1/machines/enroll', BOX, token);
    const revoked = await pool.post('/v1/machines/enroll', BOX, token);
    await (await pool.db()).prepare("UPDATE machines SET state = 'revoked' WHERE id = ?").bind(textOf((revoked.json as { machine: unknown }).machine, 'id')).run();
    await close(account);
    expect(await pool.post('/v1/machines/activate', {}, textOf(pending.json, 'token'))).toEqual(CLOSED);
    expect(await pool.post('/v1/machines/activate', {}, textOf(revoked.json, 'token'))).toMatchObject({ status: 401, json: { error: 'machine_revoked' } });
  }, 60_000);
});
