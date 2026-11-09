// Deposits closed by default: the gate is at the server, because a live URL is reachable by anyone and a CLI check would not hold.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VOCAB_VERSION } from '../../cli/src/sessions/pool-wire.js';
import { covenantAccept, covenantStatus } from './covenant.js';
import type { Env } from './http.js';
import { sampleSkeleton } from './sample.js';
import { fieldOf, poolDbOf, startPool, stubUser, textOf, type TestDb, type TestPool } from './test-pool.js';

interface Stamp {
  version: string;
  at: number;
}

const stamps = (rows: readonly unknown[]): Stamp[] => rows.map((row) => ({ version: textOf(row, 'version'), at: Number(fieldOf(row, 'at')) }));

const acceptances = async (db: TestDb, account: string): Promise<Stamp[]> =>
  stamps((await db.prepare('SELECT version, accepted_at AS at FROM covenant_acceptances WHERE account = ? ORDER BY version').bind(account).all()).results);

const served = async (db: TestDb): Promise<Stamp[]> => stamps((await db.prepare('SELECT version, first_served_at AS at FROM covenant_served ORDER BY version').all()).results);

/** The route functions run against the pool's own database under another version in force; the harness's `batch` is a stub, so this one runs the statements in order. */
const envFor = (db: TestDb, version: string): Env => ({ DB: { ...poolDbOf(db), batch: async (statements) => { const done = []; for (const statement of statements) done.push(await statement.run()); return done; } }, COVENANT_VERSION: version });

const askFor = (path: string, token: string, body?: object): Request =>
  new Request(`https://pool.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

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

  it('writes no covenant record while no version is set: nothing served, nothing accepted', async () => {
    const { token } = await pool.signIn('github', stubUser('2004'));
    await pool.get('/v1/covenant', token);
    await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
    expect(await served(await pool.db())).toEqual([]);
    expect((await (await pool.db()).prepare('SELECT COUNT(*) AS count FROM covenant_acceptances').first('count'))).toBe(0);
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

describe('the covenant record', () => {
  let pool: TestPool;

  beforeAll(async () => {
    pool = await startPool({ COVENANT_VERSION: 'v2' });
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  it('records a first acceptance with its version and time, beside the column the gate reads', async () => {
    const { token, account } = await pool.signIn('github', stubUser('4001'));
    const db = await pool.db();
    const before = Date.now();
    expect((await pool.post('/v1/covenant/accept', { version: 'v2' }, token)).status).toBe(200);
    const rows = await acceptances(db, account);
    expect(rows.map((row) => row.version)).toEqual(['v2']);
    const at = rows[0]?.at ?? 0;
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await db.prepare('SELECT covenant FROM accounts WHERE id = ?').bind(account).first('covenant')).toBe('v2');
  });

  it('keeps the first time when the same version is accepted again', async () => {
    const { token, account } = await pool.signIn('github', stubUser('4002'));
    const db = await pool.db();
    await pool.post('/v1/covenant/accept', { version: 'v2' }, token);
    const first = await acceptances(db, account);
    expect(first).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await pool.post('/v1/covenant/accept', { version: 'v2' }, token)).status).toBe(200);
    expect(await acceptances(db, account)).toEqual(first);
  });

  it('adds a row for a later version and leaves the earlier one', async () => {
    const { token, account } = await pool.signIn('github', stubUser('4003'));
    const db = await pool.db();
    await pool.post('/v1/covenant/accept', { version: 'v2' }, token);
    const [earlier] = await acceptances(db, account);
    const env = envFor(db, 'v3');
    expect((await covenantAccept(askFor('/v1/covenant/accept', token, { version: 'v3' }), env)).status).toBe(200);
    const rows = await acceptances(db, account);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(earlier);
    expect(rows[1]?.version).toBe('v3');
    expect(await db.prepare('SELECT covenant FROM accounts WHERE id = ?').bind(account).first('covenant')).toBe('v3');
  });

  it('refuses to change or delete an acceptance row', async () => {
    const { token, account } = await pool.signIn('github', stubUser('4004'));
    const db = await pool.db();
    await pool.post('/v1/covenant/accept', { version: 'v2' }, token);
    await expect(db.prepare('UPDATE covenant_acceptances SET accepted_at = 1 WHERE account = ?').bind(account).run()).rejects.toThrow(/never changed/);
    await expect(db.prepare('DELETE FROM covenant_acceptances WHERE account = ?').bind(account).run()).rejects.toThrow(/never deleted/);
  });

  it('refuses to change or delete a first-served row', async () => {
    const db = await pool.db();
    await pool.get('/v1/covenant');
    await expect(db.prepare("UPDATE covenant_served SET first_served_at = 1 WHERE version = 'v2'").run()).rejects.toThrow(/never changed/);
    await expect(db.prepare("DELETE FROM covenant_served WHERE version = 'v2'").run()).rejects.toThrow(/never deleted/);
  });

  it('stores the first-served time once per version: one row on the first read, none moved by a later read, a second for a changed version', async () => {
    const db = await pool.db();
    expect(await pool.get('/v1/covenant')).toMatchObject({ status: 200 });
    const first = await served(db);
    expect(first.filter((row) => row.version === 'v2')).toHaveLength(1);
    expect(first.filter((row) => row.version === 'v4')).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.get('/v1/covenant');
    expect(await served(db)).toEqual(first);
    expect((await covenantStatus(askFor('/v1/covenant', 'none'), envFor(db, 'v4'))).status).toBe(200);
    const both = await served(db);
    expect(both).toHaveLength(first.length + 1);
    expect(both.filter((row) => row.version !== 'v4')).toEqual(first);
    expect(both.filter((row) => row.version === 'v4')).toHaveLength(1);
  });

  it('counts an acceptance as a serving too: a client that knew the version still leaves its start on record', async () => {
    const { token } = await pool.signIn('github', stubUser('4005'));
    const db = await pool.db();
    expect((await covenantAccept(askFor('/v1/covenant/accept', token, { version: 'v9' }), envFor(db, 'v9'))).status).toBe(200);
    expect((await served(db)).filter((row) => row.version === 'v9')).toHaveLength(1);
  });
});
