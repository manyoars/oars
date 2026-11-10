// A closed account (covenant 6.1, 7.2(a)): sign-in, machine enrollment, and activation refuse it, and the message names where to write.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { credentialFor, storeToken } from './identity.js';
import { fieldOf, poolDbOf, startPool, stubUser, textOf, type TestPool } from './test-pool.js';

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

/** The proof time the pool stored on the account row, or null when none. */
const provedAtOf = async (account: string): Promise<number | null> => {
  const held = fieldOf(await (await pool.db()).prepare('SELECT proved_at FROM accounts WHERE id = ?').bind(account).first(), 'proved_at');
  return held === null ? null : Number(held);
};

/** A provider sign-in that finishes for `id`, answered by the pool's poll route. */
const signInClosed = async (id: string): Promise<{ status: number; json: unknown }> => {
  const started = await pool.post('/v1/login/start', { provider: 'github' });
  pool.stub.approve(`device-${/USER-(\d+)/.exec(textOf(started.json, 'userCode'))?.[1] ?? ''}`, stubUser(id));
  const handle = textOf(started.json, 'handle');
  await pool.due(handle);
  return pool.post('/v1/login/poll', { handle });
};

const tokensOf = async (account: string): Promise<number> => Number(fieldOf(await (await pool.db()).prepare('SELECT COUNT(*) AS held FROM tokens WHERE account = ?').bind(account).first(), 'held'));

/** The state a close leaves on the account row, set directly so each route is tested alone (the operator step that does it has its own tests). */
const close = async (account: string): Promise<void> => {
  await (await pool.db()).prepare('UPDATE accounts SET closed_at = ? WHERE id = ?').bind(Date.now(), account).run();
};

describe('a closed account', () => {
  it('is refused at sign-in with 403 account_closed and is given no credential', async () => {
    const { account, id } = await member();
    await close(account);
    const before = await tokensOf(account);
    const refused = await signInClosed(id);
    expect(refused).toMatchObject({ status: 403, json: { error: 'account_closed', account } });
    expect(await tokensOf(account)).toBe(before);
  }, 60_000);

  it('records the sign-in as proof of control, returns it, and overwrites it with the later time', async () => {
    const { account, id } = await member();
    await close(account);
    expect(await provedAtOf(account)).toBeNull();
    const first = await signInClosed(id);
    const provedAt = Number(fieldOf(first.json, 'provedAt'));
    expect(provedAt).toBeGreaterThan(0);
    expect(await provedAtOf(account)).toBe(provedAt);
    expect(textOf(first.json, 'message')).toBe(`This account is closed. Your sign-in was recorded at ${new Date(provedAt).toISOString()} as proof that you control it. To make a request about it, write to privacy@manyoars.com; if we asked you for proof, reply with the account and that time.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = Number(fieldOf((await signInClosed(id)).json, 'provedAt'));
    expect(second).toBeGreaterThan(provedAt);
    expect(await provedAtOf(account)).toBe(second);
  }, 60_000);

  it('records the proof too when the close lands between the check and the insert', async () => {
    const { account } = await member();
    const env = { DB: poolDbOf(await pool.db(), async (sql) => { if (sql.startsWith('INSERT INTO tokens')) await close(account); }) };
    const refused = await credentialFor(env, '', 'k1', account, undefined);
    expect(refused.status).toBe(403);
    expect(await provedAtOf(account)).toBe(Number(fieldOf(await refused.json(), 'provedAt')));
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
    await (await pool.db()).prepare("UPDATE machines SET state = 'revoked' WHERE id = ?").bind(textOf(fieldOf(revoked.json, 'machine'), 'id')).run();
    await close(account);
    expect(await pool.post('/v1/machines/activate', {}, textOf(pending.json, 'token'))).toEqual(CLOSED);
    expect(await pool.post('/v1/machines/activate', {}, textOf(revoked.json, 'token'))).toMatchObject({ status: 401, json: { error: 'machine_revoked' } });
  }, 60_000);

  it('stores no token when the close lands between the check and the insert', async () => {
    const { account } = await member();
    const db = await pool.db();
    const env = { DB: poolDbOf(db, async (sql) => { if (sql.startsWith('INSERT INTO tokens')) await close(account); }) };
    const before = await tokensOf(account);
    expect(await storeToken(env, account, 'a'.repeat(64), Date.now() + 60_000)).toBe(false);
    expect(await tokensOf(account)).toBe(before);
    // An open account still stores one.
    const open = await member();
    expect(await storeToken({ DB: poolDbOf(db) }, open.account, 'b'.repeat(64), Date.now() + 60_000)).toBe(true);
  }, 60_000);
});
