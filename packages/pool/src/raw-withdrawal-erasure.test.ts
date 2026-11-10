// A withdrawal of raw consent reaches the raw copies already held (GDPR Articles 7(3) and 17(1)(b), t1053): the staged parts go when the account withdraws, and the nightly cron erases its held objects. Under Miniflare with real R2 and D1.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env, RawBucket } from './http.js';
import { sweepWithdrawnRaw, SWEEP_PAGE_CALLS, withdrawRawConsent } from './raw.js';
import { acceptanceOf, fieldOf, startPool, stubUser, type TestPool } from './test-pool.js';
import { rawDigest } from './tombstones.js';
import worker from './worker.js';

let pool: TestPool;
let unbound: TestPool;
let next = 9400;

beforeAll(async () => {
  pool = await startPool();
  unbound = await startPool({}, { raw: false });
}, 60_000);

afterAll(async () => {
  await pool.dispose();
  await unbound.dispose();
});

const grant = { 'oars-redaction-version': '1', 'oars-capture-version': 'cap-7', 'oars-raw-consent': 'granted', 'oars-raw-consent-version': 'v1' };
const TONIGHT = Date.parse('2026-11-10T03:17:00Z');

const member = async (): Promise<{ token: string; account: string }> => {
  next += 1;
  const { token, account } = await pool.signIn('github', stubUser(String(next)));
  expect((await pool.post('/v1/covenant/accept', acceptanceOf('v1'), token)).status).toBe(200);
  return { token, account };
};

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Stores one object of `text` for the account, whole, through the routes. */
const store = async (token: string, text: string): Promise<string> => {
  const bytes = new TextEncoder().encode(text);
  const hash = sha(bytes);
  expect((await pool.send(`/v1/raw/${hash}/parts/1`, { method: 'PUT', body: bytes }, token, grant)).status).toBe(200);
  expect((await pool.send(`/v1/raw/${hash}/complete`, { method: 'POST', body: JSON.stringify({ parts: 1, bytes: bytes.length }) }, token, grant)).status).toBe(201);
  return hash;
};

const withdraw = (token: string): ReturnType<TestPool['send']> => pool.send('/v1/consent/raw', { method: 'DELETE' }, token);
const say = (token: string): ReturnType<TestPool['send']> => pool.send('/v1/consent/raw', { method: 'PUT', body: JSON.stringify({ version: 'v1' }) }, token);

const keysOf = async (prefix: string): Promise<string[]> => (await (await pool.rawBucket()).list({ prefix })).objects.map((one) => one.key);
const all = async (sql: string, ...binds: (string | number)[]): Promise<readonly unknown[]> => (await (await pool.db()).prepare(sql).bind(...binds).all()).results;
const count = async (sql: string, ...binds: (string | number)[]): Promise<number> => Number(fieldOf((await all(sql, ...binds))[0], 'held'));
const night = async (when = TONIGHT): Promise<void> => worker.scheduled({ scheduledTime: when }, await pool.miniflare.getBindings<Env>());

describe('the nightly cron erases the raw copies of an account that withdrew', () => {
  it('erases its held objects, tombstones each, keeps the hash, size, and date, and leaves another account\'s objects', async () => {
    const mine = await member();
    const theirs = await member();
    const first = await store(mine.token, 'first of my transcripts');
    const second = await store(mine.token, 'second of my transcripts');
    const kept = await store(theirs.token, 'a transcript of someone who did not withdraw');
    expect((await withdraw(mine.token)).status).toBe(200);
    // Withdrawing alone leaves the held objects to the sweep.
    expect(await keysOf(`raw/${mine.account}/`)).toHaveLength(2);

    await night();

    expect(await keysOf(`raw/${mine.account}/`)).toEqual([]);
    expect(await keysOf(`raw/${theirs.account}/`)).toEqual([`raw/${theirs.account}/${kept}`]);
    expect(await all('SELECT sha256, bytes, erased_on FROM raw_objects WHERE account = ? ORDER BY sha256', mine.account)).toEqual(
      [first, second].sort().map((hash) => ({ sha256: hash, bytes: hash === first ? 'first of my transcripts'.length : 'second of my transcripts'.length, erased_on: '2026-11-10' })),
    );
    expect(await all('SELECT erased_on FROM raw_objects WHERE account = ?', theirs.account)).toEqual([{ erased_on: null }]);
    const digests = await Promise.all([first, second].map((hash) => rawDigest(`raw/${mine.account}/${hash}`)));
    expect(await count("SELECT COUNT(*) AS held FROM erasure_tombstones WHERE kind = 'raw-object' AND reason = 'consent-withdrawn' AND digest IN (?, ?)", ...digests)).toBe(2);
  }, 60_000);

  it('writes one audit row for a night that erased something, and none for a night that erased nothing', async () => {
    const { token } = await member();
    await store(token, 'first transcript to audit');
    await store(token, 'second transcript to audit');
    expect((await withdraw(token)).status).toBe(200);
    const before = await count("SELECT COUNT(*) AS held FROM erasure_audit WHERE kind = 'raw-object' AND reason = 'consent-withdrawn'");
    await night();
    const rows = await all("SELECT objects_erased, rows_erased, account, erased_on FROM erasure_audit WHERE kind = 'raw-object' AND reason = 'consent-withdrawn' ORDER BY id DESC");
    expect(rows).toHaveLength(before + 1);
    expect(rows[0]).toEqual({ objects_erased: 2, rows_erased: 0, account: null, erased_on: '2026-11-10' });
    await night(TONIGHT + 86_400_000);
    expect(await count("SELECT COUNT(*) AS held FROM erasure_audit WHERE kind = 'raw-object' AND reason = 'consent-withdrawn'")).toBe(before + 1);
  }, 60_000);

  it('refuses the same bytes afterward instead of answering that they are already stored', async () => {
    const { token } = await member();
    const bytes = new TextEncoder().encode('bytes that were erased on withdrawal');
    const hash = await store(token, 'bytes that were erased on withdrawal');
    expect((await withdraw(token)).status).toBe(200);
    await night();
    expect((await say(token)).status).toBe(200);
    expect((await pool.send(`/v1/raw/${hash}/parts/1`, { method: 'PUT', body: bytes }, token, grant)).status).toBe(403);
  }, 60_000);

  it('runs again to nothing: a second night changes no row, no object, and no tombstone', async () => {
    const { token, account } = await member();
    await store(token, 'a transcript that goes once');
    expect((await withdraw(token)).status).toBe(200);
    await night();
    const rows = await all('SELECT sha256, erased_on FROM raw_objects WHERE account = ?', account);
    const tombstones = await count('SELECT COUNT(*) AS held FROM erasure_tombstones');
    await night(TONIGHT + 86_400_000);
    expect(await all('SELECT sha256, erased_on FROM raw_objects WHERE account = ?', account)).toEqual(rows);
    expect(await count('SELECT COUNT(*) AS held FROM erasure_tombstones')).toBe(tombstones);
    expect(await keysOf(`raw/${account}/`)).toEqual([]);
  }, 60_000);

  it('leaves an account that never withdrew alone, whatever the night', async () => {
    const { token, account } = await member();
    await store(token, 'a transcript under a standing yes');
    await night();
    expect(await keysOf(`raw/${account}/`)).toHaveLength(1);
    expect(await all('SELECT erased_on FROM raw_objects WHERE account = ?', account)).toEqual([{ erased_on: null }]);
  }, 60_000);

  it('erases what was stored before a new yes and keeps what was stored under it', async () => {
    const { token, account } = await member();
    const before = await store(token, 'stored before the withdrawal');
    expect((await withdraw(token)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await say(token)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = await store(token, 'stored under the new yes');
    await night();
    expect(await keysOf(`raw/${account}/`)).toEqual([`raw/${account}/${after}`]);
    expect(await all('SELECT sha256, erased_on FROM raw_objects WHERE account = ? ORDER BY stored_at', account)).toEqual([
      { sha256: before, erased_on: '2026-11-10' },
      { sha256: after, erased_on: null },
    ]);
  }, 60_000);

  it('keeps what was stored under a yes when that yes is said again or restated for another covenant version', async () => {
    const { token, account } = await member();
    const pause = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 5));
    const before = await store(token, 'stored before the withdrawal, again');
    expect((await withdraw(token)).status).toBe(200);
    await pause();
    expect((await say(token)).status).toBe(200);
    await pause();
    const kept = await store(token, 'stored under the yes after the withdrawal');
    await pause();
    // A second typed yes from any machine does not move the start of the standing yes.
    expect((await say(token)).status).toBe(200);
    await pause();
    // A yes restated for a new covenant version (the row holds an older one) does not move it either.
    await (await pool.db()).prepare('UPDATE accounts SET raw_consent_version = ? WHERE id = ?').bind('v0', account).run();
    const restated = await store(token, 'stored as the yes was restated');
    await night();
    expect(await keysOf(`raw/${account}/`)).toEqual([kept, restated].map((hash) => `raw/${account}/${hash}`).sort());
    expect(await all('SELECT sha256, erased_on FROM raw_objects WHERE account = ? ORDER BY stored_at', account)).toEqual([
      { sha256: before, erased_on: '2026-11-10' },
      { sha256: kept, erased_on: null },
      { sha256: restated, erased_on: null },
    ]);
  }, 60_000);

  it('erases an object that finished after the withdrawal was written, since no yes stands', async () => {
    const { token, account } = await member();
    const straggler = await store(token, 'finished as the withdrawal landed');
    const db = await pool.db();
    // The withdrawal wrote its record before the object's row was stamped: stored_at is later than the withdrawal.
    await db.prepare('UPDATE accounts SET raw_consent_withdrawn_at = 1, raw_consent_withdrawn_version = ?, raw_consent = NULL, raw_consent_version = NULL WHERE id = ?').bind('v1', account).run();
    await night();
    expect(await keysOf(`raw/${account}/`)).toEqual([]);
    expect(await all('SELECT sha256, erased_on FROM raw_objects WHERE account = ?', account)).toEqual([{ sha256: straggler, erased_on: '2026-11-10' }]);
  }, 60_000);

  it('spends the calls it is given a page at a time and finishes the rest on the next run', async () => {
    const { account } = await member();
    const db = await pool.db();
    await db.prepare('UPDATE accounts SET raw_consent_withdrawn_at = 1, raw_consent = NULL, raw_consent_version = NULL WHERE id = ?').bind(account).run();
    for (let at = 0; at < 105; at += 1) await db.prepare('INSERT INTO raw_objects (account, sha256, bytes, capture_version, redaction_version, stored_at) VALUES (?, ?, 1, ?, ?, 1)').bind(account, String(at).padStart(64, '0'), 'cap', '1').run();
    const env = await pool.miniflare.getBindings<Env>();
    expect(await sweepWithdrawnRaw(env, TONIGHT, SWEEP_PAGE_CALLS - 1)).toBe(0);
    expect(await sweepWithdrawnRaw(env, TONIGHT, SWEEP_PAGE_CALLS)).toBe(100);
    expect(await count('SELECT COUNT(*) AS held FROM raw_objects WHERE account = ? AND erased_on IS NULL', account)).toBe(5);
    expect(await sweepWithdrawnRaw(env, TONIGHT, 2 * SWEEP_PAGE_CALLS)).toBe(5);
    expect(await sweepWithdrawnRaw(env, TONIGHT, 2 * SWEEP_PAGE_CALLS)).toBe(0);
  }, 90_000);

  it('does nothing on a pool with no raw bucket', async () => {
    expect(await sweepWithdrawnRaw(await unbound.miniflare.getBindings<Env>(), TONIGHT, 20)).toBe(0);
  }, 60_000);
});

describe('a withdrawal drops the account\'s staged raw parts at once', () => {
  it('drops its staged parts and leaves another account\'s staged part', async () => {
    const mine = await member();
    const theirs = await member();
    const hash = 'a'.repeat(64);
    const other = 'b'.repeat(64);
    for (const at of [1, 2, 3]) expect((await pool.send(`/v1/raw/${hash}/parts/${String(at)}`, { method: 'PUT', body: 'part' }, mine.token, grant)).status).toBe(200);
    expect((await pool.send(`/v1/raw/${other}/parts/1`, { method: 'PUT', body: 'part' }, theirs.token, grant)).status).toBe(200);
    expect(await keysOf(`staging/${mine.account}/`)).toHaveLength(3);
    expect((await withdraw(mine.token)).status).toBe(200);
    expect(await keysOf(`staging/${mine.account}/`)).toEqual([]);
    expect(await keysOf(`staging/${theirs.account}/`)).toHaveLength(1);
    // A second withdrawal finds nothing left and still answers ok.
    expect((await withdraw(mine.token)).status).toBe(200);
  }, 60_000);

  it('lists again until a page comes back empty, so a withdrawal drops every page of staged parts', async () => {
    const { token, account } = await member();
    const pages = [['staging/a/1', 'staging/a/2'], ['staging/a/3'], []];
    const asked: string[] = [];
    const deleted: string[] = [];
    // A bucket that answers a page, a second page, and then an empty one, as R2 does once a page of 1,000 keys is deleted and more were staged.
    const bucket: RawBucket = {
      put: () => Promise.resolve(undefined),
      get: () => Promise.resolve(null),
      delete: (keys) => {
        deleted.push(...keys);
        return Promise.resolve();
      },
      list: ({ prefix }) => {
        asked.push(prefix);
        return Promise.resolve({ objects: (pages.shift() ?? []).map((key) => ({ key })), truncated: false });
      },
      createMultipartUpload: () => Promise.reject(new Error('not used')),
    };
    const env: Env = { ...(await pool.miniflare.getBindings<Env>()), RAW: bucket };
    const answered = await withdrawRawConsent(new Request('https://pool.test/v1/consent/raw', { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }), env);
    expect(answered.status).toBe(200);
    expect(asked).toEqual([`staging/${account}/`, `staging/${account}/`, `staging/${account}/`]);
    expect(deleted).toEqual(['staging/a/1', 'staging/a/2', 'staging/a/3']);
  }, 60_000);

  it('answers ok on a pool with no raw bucket', async () => {
    const { token } = await (async () => {
      const signed = await unbound.signIn('github', stubUser('9990'));
      return signed;
    })();
    expect((await unbound.send('/v1/consent/raw', { method: 'DELETE' }, token)).status).toBe(200);
  }, 60_000);
});
