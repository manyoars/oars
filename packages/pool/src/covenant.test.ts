// Deposits closed by default: the gate is at the server, because a live URL is reachable by anyone and a CLI check would not hold.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VOCAB_VERSION } from '../../cli/src/sessions/pool-wire.js';
import { covenantAccept, covenantStatus } from './covenant.js';
import { COVENANT_TEXTS } from './covenant-texts.js';
import type { Env } from './http.js';
import { sampleSkeleton } from './sample.js';
import { acceptanceOf, testScreen } from './test-covenant-texts.js';
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

/** What the test Worker serves for a version: the stand-in text, its link and phrase, and its hash. */
const screenOf = (version: string): object => ({ text: testScreen(version), link: `https://pool.test/covenant/${version}`, phrase: 'I AGREE', sha256: createHash('sha256').update(testScreen(version)).digest('hex') });

/** The texts a direct route call holds: the stand-in for the one version, as the test Worker holds it for `v1` and `v2`. */
const textsFor = (version: string): ReadonlyMap<string, string> => new Map([[version, testScreen(version)]]);

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
    expect(await pool.get('/v1/covenant', token)).toEqual({ status: 200, json: { version: 'v2', accepted: false, screen: screenOf('v2') } });
    expect(await pool.post('/v1/deposits', sampleSkeleton('0000000000003001'), token)).toMatchObject({ status: 403, json: { error: 'covenant_not_accepted' } });
    expect(await storedCount(pool)).toBe(0);
    expect((await pool.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, token)).status).toBe(200);
  });

  it('names the version with no sign-in, and asks a caller with no account to sign in before depositing', async () => {
    expect(await pool.get('/v1/covenant')).toEqual({ status: 200, json: { version: 'v2', accepted: false, screen: screenOf('v2') } });
    expect(await pool.get('/v1/covenant', 'a-wrong-token')).toEqual({ status: 200, json: { version: 'v2', accepted: false, screen: screenOf('v2') } });
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000003002'))).status).toBe(401);
    expect((await pool.post('/v1/covenant/accept', acceptanceOf('v2'))).status).toBe(401);
  });

  it('takes a deposit once the account has accepted that version', async () => {
    const { token } = await pool.signIn('github', stubUser('3003'));
    expect((await pool.post('/v1/covenant/accept', acceptanceOf('v2'), token)).status).toBe(200);
    expect(await pool.get('/v1/covenant', token)).toEqual({ status: 200, json: { version: 'v2', accepted: true, screen: screenOf('v2') } });
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000003003'), token)).status).toBe(201);
    // A second accept changes nothing and still answers yes, so a rerun of `deposit --accept-covenant` does not fail.
    expect((await pool.post('/v1/covenant/accept', acceptanceOf('v2'), token)).status).toBe(200);
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
    expect(await pool.get('/v1/covenant', token)).toEqual({ status: 200, json: { version: 'v2', accepted: false, screen: screenOf('v2') } });
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
    expect((await pool.post('/v1/covenant/accept', acceptanceOf('v2'), token)).status).toBe(200);
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
    await pool.post('/v1/covenant/accept', acceptanceOf('v2'), token);
    const first = await acceptances(db, account);
    expect(first).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await pool.post('/v1/covenant/accept', acceptanceOf('v2'), token)).status).toBe(200);
    expect(await acceptances(db, account)).toEqual(first);
  });

  it('adds a row for a later version and leaves the earlier one', async () => {
    const { token, account } = await pool.signIn('github', stubUser('4003'));
    const db = await pool.db();
    await pool.post('/v1/covenant/accept', acceptanceOf('v2'), token);
    const [earlier] = await acceptances(db, account);
    const env = envFor(db, 'v3');
    expect((await covenantAccept(askFor('/v1/covenant/accept', token, acceptanceOf('v3')), env, textsFor('v3'))).status).toBe(200);
    const rows = await acceptances(db, account);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(earlier);
    expect(rows[1]?.version).toBe('v3');
    expect(await db.prepare('SELECT covenant FROM accounts WHERE id = ?').bind(account).first('covenant')).toBe('v3');
  });

  const proofOf = async (db: TestDb, account: string): Promise<readonly unknown[]> =>
    (await db.prepare('SELECT version, text_sha256, input, client FROM covenant_acceptances WHERE account = ? ORDER BY version').bind(account).all()).results;

  it('records which text the person saw, how they accepted, and with which client', async () => {
    const { token, account } = await pool.signIn('github', stubUser('4006'));
    const db = await pool.db();
    expect((await pool.post('/v1/covenant/accept', acceptanceOf('v2'), token)).status).toBe(200);
    expect(await proofOf(db, account)).toEqual([{ version: 'v2', text_sha256: acceptanceOf('v2').textSha256, input: 'typed', client: 'oars/test' }]);
  });

  it('keeps the first proof when the same version is accepted again by another client', async () => {
    const { token, account } = await pool.signIn('github', stubUser('4007'));
    const db = await pool.db();
    await pool.post('/v1/covenant/accept', acceptanceOf('v2'), token);
    const first = await proofOf(db, account);
    expect((await pool.post('/v1/covenant/accept', { ...acceptanceOf('v2'), client: 'oars/another' }, token)).status).toBe(200);
    expect(await proofOf(db, account)).toEqual(first);
  });

  it('refuses an acceptance of text other than the pool holds, and records nothing', async () => {
    const { token, account } = await pool.signIn('github', stubUser('4008'));
    const db = await pool.db();
    expect(await pool.post('/v1/covenant/accept', { ...acceptanceOf('v2'), textSha256: acceptanceOf('v1').textSha256 }, token)).toMatchObject({ status: 409, json: { error: 'covenant_text', field: 'textSha256' } });
    expect(await proofOf(db, account)).toEqual([]);
    expect(await db.prepare('SELECT covenant FROM accounts WHERE id = ?').bind(account).first('covenant')).toBeNull();
  });

  it.each([
    ['textSha256', '4012'],
    ['input', '4013'],
    ['client', '4014'],
  ])('refuses an acceptance that does not state its %s, and records nothing', async (field, user) => {
    const { token, account } = await pool.signIn('github', stubUser(user));
    const db = await pool.db();
    const rest = Object.fromEntries(Object.entries(acceptanceOf('v2')).filter(([name]) => name !== field));
    expect(Object.keys(rest)).toHaveLength(3);
    expect(await pool.post('/v1/covenant/accept', rest, token)).toMatchObject({ status: 400, json: { error: 'missing_field', field } });
    expect(await proofOf(db, account)).toEqual([]);
  });

  it.each([
    ['input', '4015'],
    ['client', '4016'],
  ])('refuses a %s longer than a name and a version need, and records nothing', async (field, user) => {
    const { token, account } = await pool.signIn('github', stubUser(user));
    const db = await pool.db();
    expect(await pool.post('/v1/covenant/accept', { ...acceptanceOf('v2'), [field]: 'x'.repeat(65) }, token)).toMatchObject({ status: 400, json: { error: 'missing_field', field } });
    expect(await proofOf(db, account)).toEqual([]);
  });

  it('refuses an acceptance for a version it holds no text for, and records nothing', async () => {
    const { token, account } = await pool.signIn('github', stubUser('4010'));
    const db = await pool.db();
    const none = await covenantAccept(askFor('/v1/covenant/accept', token, acceptanceOf('v7')), envFor(db, 'v7'), new Map());
    expect(none.status).toBe(403);
    expect(await none.json()).toMatchObject({ error: 'deposits_closed' });
    expect(await proofOf(db, account)).toEqual([]);
  });

  it('refuses to change a proof column', async () => {
    const { token, account } = await pool.signIn('github', stubUser('4011'));
    const db = await pool.db();
    await pool.post('/v1/covenant/accept', acceptanceOf('v2'), token);
    await expect(db.prepare("UPDATE covenant_acceptances SET text_sha256 = 'x' WHERE account = ?").bind(account).run()).rejects.toThrow(/never changed/);
  });

  it('refuses to change or delete an acceptance row', async () => {
    const { token, account } = await pool.signIn('github', stubUser('4004'));
    const db = await pool.db();
    await pool.post('/v1/covenant/accept', acceptanceOf('v2'), token);
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
    expect((await covenantAccept(askFor('/v1/covenant/accept', token, acceptanceOf('v9')), envFor(db, 'v9'), textsFor('v9'))).status).toBe(200);
    expect((await served(db)).filter((row) => row.version === 'v9')).toHaveLength(1);
  });
});

/** A stand-in for a covenant, under a placeholder version: the wording of the real text is not in this file, and a test of the screen needs only its shape. */
const FIXTURE_VERSION = 'fixture-1';
const FIXTURE_LINK = 'https://pool.test/covenant/fixture-1';
const FIXTURE_PHRASE = 'I AGREE TO THE FIXTURE';
const FIXTURE_TEXT = ['FIXTURE COVENANT fixture-1', '', 'This text stands in for a covenant in a test.', '', `Full text: ${FIXTURE_LINK}`, '', `To accept, type: ${FIXTURE_PHRASE}`].join('\n');
const FIXTURES: ReadonlyMap<string, string> = new Map([[FIXTURE_VERSION, FIXTURE_TEXT]]);

describe('the covenant screen', () => {
  let pool: TestPool;
  let nextUser = 5000;

  beforeAll(async () => {
    pool = await startPool({ COVENANT_VERSION: 'v2' });
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  const statusOf = async (version: string, texts: ReadonlyMap<string, string>): Promise<unknown> => {
    const { token } = await pool.signIn('github', stubUser(String((nextUser += 1))));
    return (await covenantStatus(askFor('/v1/covenant', token), envFor(await pool.db(), version), texts)).json();
  };

  it('serves the text of the version in force with its link, its phrase, and the hash of that text', async () => {
    expect(await statusOf(FIXTURE_VERSION, FIXTURES)).toEqual({
      version: FIXTURE_VERSION,
      accepted: false,
      screen: { text: FIXTURE_TEXT, link: FIXTURE_LINK, phrase: FIXTURE_PHRASE, sha256: createHash('sha256').update(FIXTURE_TEXT).digest('hex') },
    });
  });

  it('says so when no file holds the version in force, so the client has nothing to accept', async () => {
    expect(await statusOf('no-file-for-this', FIXTURES)).toEqual({ version: 'no-file-for-this', accepted: false, screen: null });
  });

  it('serves no screen for a text that names no link or no phrase: a screen that cannot say how to accept is no screen', async () => {
    const lines = FIXTURE_TEXT.split('\n');
    const noLink = new Map([[FIXTURE_VERSION, lines.filter((line) => !line.startsWith('Full text:')).join('\n')]]);
    const noPhrase = new Map([[FIXTURE_VERSION, lines.filter((line) => !line.startsWith('To accept, type:')).join('\n')]]);
    expect(await statusOf(FIXTURE_VERSION, noLink)).toMatchObject({ screen: null });
    expect(await statusOf(FIXTURE_VERSION, noPhrase)).toMatchObject({ screen: null });
  });

  it('ships only texts that can be served: each one names its link and its phrase', async () => {
    for (const [version, text] of COVENANT_TEXTS) expect(await statusOf(version, COVENANT_TEXTS), version).toMatchObject({ screen: { text } });
  });

  it('serves, through the live route, the text the Worker holds for the version in force', async () => {
    expect(await pool.get('/v1/covenant')).toEqual({ status: 200, json: { version: 'v2', accepted: false, screen: screenOf('v2') } });
  });
});
