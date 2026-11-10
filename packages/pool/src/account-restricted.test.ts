// A restricted account (GDPR Art. 18, C4): the pool keeps its data stored and takes nothing more. A deposit and a raw part are refused 403 `account_restricted` with no credential revoked, its records stop counting toward shared cells, and its own export, an erasure, and lifting the restriction still work.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { heldBy } from './cluster-store.js';
import { sampleSkeleton } from './sample.js';
import { acceptanceOf, fieldOf, poolDbOf, startPool, stubUser, textOf, type TestPool } from './test-pool.js';

let pool: TestPool;
let next = 9400;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const RESTRICTED = { status: 403, json: { error: 'account_restricted', message: 'This account is restricted at your request: the pool keeps its data stored and takes nothing more until the restriction is lifted. Write to privacy@manyoars.com.' } };
const grant = { 'oars-redaction-version': '1', 'oars-capture-version': 'cap-7', 'oars-raw-consent': 'granted', 'oars-raw-consent-version': 'v1' };
const HASH = 'a'.repeat(64);

/** A signed-in account that accepted the covenant in force. */
const member = async (): Promise<{ token: string; account: string }> => {
  next += 1;
  const signedIn = await pool.signIn('github', stubUser(String(next)));
  expect((await pool.post('/v1/covenant/accept', acceptanceOf('v1'), signedIn.token)).status).toBe(200);
  return signedIn;
};

/** The state `erase restrict --confirm` leaves, set directly so each route is tested alone (the operator command has its own tests). */
const restrict = async (account: string, at: number | null = Date.now()): Promise<void> => {
  await (await pool.db()).prepare('UPDATE accounts SET restricted_at = ? WHERE id = ?').bind(at, account).run();
};

const deposits = async (account: string): Promise<number> => Number(await (await pool.db()).prepare('SELECT COUNT(*) AS held FROM deposits WHERE account = ?').bind(account).first('held'));

const sessionOf = (at: number): string => String(at).padStart(16, '0');

describe('a restricted account', () => {
  it('is refused a deposit with 403 account_restricted, keeps its credential, and deposits again once the restriction is lifted', async () => {
    const { token, account } = await member();
    expect((await pool.post('/v1/deposits', sampleSkeleton(sessionOf(1)), token)).status).toBe(201);
    await restrict(account);
    expect(await pool.post('/v1/deposits', sampleSkeleton(sessionOf(2)), token)).toMatchObject(RESTRICTED);
    expect(await deposits(account)).toBe(1);
    expect((await pool.get('/v1/covenant', token)).status).toBe(200);
    await restrict(account, null);
    expect((await pool.post('/v1/deposits', sampleSkeleton(sessionOf(2)), token)).status).toBe(201);
    expect(await deposits(account)).toBe(2);
  }, 60_000);

  it('is refused a deposit made with the key of one of its machines', async () => {
    const { token, account } = await member();
    const enrolled = await pool.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label: 'box', allowRepos: [] }, token);
    const key = textOf(enrolled.json, 'token');
    expect((await pool.post('/v1/machines/activate', {}, key)).status).toBe(200);
    await restrict(account);
    expect(await pool.post('/v1/deposits', sampleSkeleton(sessionOf(3)), key)).toMatchObject(RESTRICTED);
    expect(await deposits(account)).toBe(0);
  }, 60_000);

  it('is refused a raw part and the completion of a raw object', async () => {
    const { token, account } = await member();
    await restrict(account);
    const part = await pool.send(`/v1/raw/${HASH}/parts/1`, { method: 'PUT', body: new Uint8Array([1, 2, 3]) }, token, grant);
    expect(part).toMatchObject(RESTRICTED);
    const done = await pool.send(`/v1/raw/${HASH}/complete`, { method: 'POST', body: JSON.stringify({ parts: 1, bytes: 3 }) }, token, grant);
    expect(done).toMatchObject(RESTRICTED);
    expect(await (await pool.db()).prepare('SELECT COUNT(*) AS held FROM raw_objects WHERE account = ?').bind(account).first('held')).toBe(0);
  }, 60_000);

  it('can still read its own export', async () => {
    const { token, account } = await member();
    expect((await pool.post('/v1/deposits', sampleSkeleton(sessionOf(4)), token)).status).toBe(201);
    await restrict(account);
    const exported = await pool.get('/v1/account/export', token);
    expect(exported.status).toBe(200);
    expect(textOf(exported.json, 'account')).toBe(account);
  }, 60_000);

  it('stops counting toward a shared cell: another account’s later deposit recounts it without the restricted one', async () => {
    const a = await member();
    const b = await member();
    expect((await pool.post('/v1/deposits', sampleSkeleton(sessionOf(5)), a.token)).status).toBe(201);
    expect((await pool.post('/v1/deposits', sampleSkeleton(sessionOf(6)), b.token)).status).toBe(201);
    const counts = async (): Promise<number[]> => [...new Set((await (await pool.db()).prepare('SELECT clusters FROM cells WHERE sessions > 0').all()).results.map((row) => Number(fieldOf(row, 'clusters'))))];
    const before = (await counts()).sort();
    await restrict(a.account);
    const c = await member();
    expect((await pool.post('/v1/deposits', sampleSkeleton(sessionOf(7)), c.token)).status).toBe(201);
    // The cells of the shared sample now hold b and c; with a still counting they would hold one more than they did.
    const after = (await counts()).sort();
    await restrict(a.account, null);
    const d = await member();
    expect((await pool.post('/v1/deposits', sampleSkeleton(sessionOf(8)), d.token)).status).toBe(201);
    const lifted = (await counts()).sort();
    expect(Math.max(...after)).toBe(Math.max(...before));
    expect(Math.max(...lifted)).toBe(Math.max(...after) + 2);
  }, 120_000);

  it('holds no cell or stratum for the depositor read once restricted', async () => {
    const { token, account } = await member();
    expect((await pool.post('/v1/deposits', sampleSkeleton(sessionOf(9)), token)).status).toBe(201);
    const env = { DB: poolDbOf(await pool.db()) };
    expect((await heldBy(env, account, 'cell')).length).toBeGreaterThan(0);
    await restrict(account);
    expect(await heldBy(env, account, 'cell')).toEqual([]);
    expect(await heldBy(env, account, 'stratum')).toEqual([]);
  }, 60_000);
});
