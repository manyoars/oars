// Deposits closed by default: the gate is at the server, because a live URL is reachable by anyone and a CLI check would not hold.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VOCAB_VERSION } from '../../cli/src/sessions/pool-wire.js';
import { sampleSkeleton } from './sample.js';
import { startPool, stubUser, type TestPool } from './test-pool.js';

const storedCount = async (pool: TestPool): Promise<unknown> => (await pool.db()).prepare('SELECT COUNT(*) AS count FROM deposits').first('count');

describe('with no COVENANT_VERSION binding', () => {
  let pool: TestPool;

  beforeAll(async () => {
    pool = await startPool({ COVENANT_VERSION: '' });
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  it('refuses every deposit by name, signed in or not, with an unread body', async () => {
    const { token } = await pool.signIn('github', stubUser('2001'));
    expect(await pool.post('/v1/deposits', sampleSkeleton('0000000000002001'), token)).toMatchObject({ status: 403, json: { error: 'deposits_closed' } });
    expect(await pool.post('/v1/deposits', sampleSkeleton('0000000000002001'))).toMatchObject({ status: 403, json: { error: 'deposits_closed' } });
    expect(await pool.post('/v1/deposits', 'not json', token)).toMatchObject({ status: 403, json: { error: 'deposits_closed' } });
    expect(await storedCount(pool)).toBe(0);
  });

  it('has no covenant to name and none to accept', async () => {
    const { token } = await pool.signIn('github', stubUser('2002'));
    expect(await pool.get('/v1/covenant', token)).toEqual({ status: 200, json: { version: null, accepted: false } });
    expect(await pool.get('/v1/covenant')).toEqual({ status: 200, json: { version: null, accepted: false } });
    expect(await pool.post('/v1/covenant/accept', { version: 'v1' }, token)).toMatchObject({ status: 403, json: { error: 'deposits_closed' } });
    expect(await pool.db().then((db) => db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE covenant IS NOT NULL').first('count'))).toBe(0);
  });

  it('still serves a bundle: reads and fetch are not behind the covenant', async () => {
    const { token } = await pool.signIn('github', stubUser('2003'));
    expect((await pool.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, token)).status).toBe(200);
  });
});

describe('with COVENANT_VERSION set', () => {
  let pool: TestPool;

  beforeAll(async () => {
    pool = await startPool({ COVENANT_VERSION: 'v2' });
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  it('refuses an account that has not accepted it, by name, and stores nothing', async () => {
    const { token } = await pool.signIn('github', stubUser('3001'));
    expect(await pool.get('/v1/covenant', token)).toEqual({ status: 200, json: { version: 'v2', accepted: false } });
    expect(await pool.post('/v1/deposits', sampleSkeleton('0000000000003001'), token)).toMatchObject({ status: 403, json: { error: 'covenant_not_accepted' } });
    expect(await storedCount(pool)).toBe(0);
    expect((await pool.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, token)).status).toBe(200);
  });

  it('names the version with no sign-in, and asks a caller with no account to sign in before depositing', async () => {
    expect(await pool.get('/v1/covenant')).toEqual({ status: 200, json: { version: 'v2', accepted: false } });
    expect(await pool.get('/v1/covenant', 'a-wrong-token')).toEqual({ status: 200, json: { version: 'v2', accepted: false } });
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000003002'))).status).toBe(401);
    expect((await pool.post('/v1/covenant/accept', { version: 'v2' })).status).toBe(401);
  });

  it('takes a deposit once the account has accepted that version', async () => {
    const { token } = await pool.signIn('github', stubUser('3003'));
    expect((await pool.post('/v1/covenant/accept', { version: 'v2' }, token)).status).toBe(200);
    expect(await pool.get('/v1/covenant', token)).toEqual({ status: 200, json: { version: 'v2', accepted: true } });
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000003003'), token)).status).toBe(201);
    // A second accept changes nothing and still answers yes, so a rerun of `deposit --accept-covenant` does not fail.
    expect((await pool.post('/v1/covenant/accept', { version: 'v2' }, token)).status).toBe(200);
  });

  it('refuses to accept any version but the one in force, and a body that names none', async () => {
    const { token } = await pool.signIn('github', stubUser('3004'));
    expect(await pool.post('/v1/covenant/accept', { version: 'v1' }, token)).toMatchObject({ status: 409, json: { error: 'covenant_version' } });
    expect(await pool.post('/v1/covenant/accept', {}, token)).toMatchObject({ status: 400, json: { field: 'version' } });
    expect(await pool.post('/v1/deposits', sampleSkeleton('0000000000003004'), token)).toMatchObject({ status: 403, json: { error: 'covenant_not_accepted' } });
  });

  it('asks again when the covenant moves on: an older acceptance does not carry over', async () => {
    const { token, account } = await pool.signIn('github', stubUser('3005'));
    const db = await pool.db();
    await db.prepare('UPDATE accounts SET covenant = ? WHERE id = ?').bind('v1', account).run();
    expect(await pool.get('/v1/covenant', token)).toEqual({ status: 200, json: { version: 'v2', accepted: false } });
    expect(await pool.post('/v1/deposits', sampleSkeleton('0000000000003005'), token)).toMatchObject({ status: 403, json: { error: 'covenant_not_accepted' } });
  });
});
