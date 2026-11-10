// The operator's erasure against a local pool under Miniflare: each kind leaves a tombstone, the same content is refused when it comes back, an audit row holds no content, and the aggregates keep their counts.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '../../cli/src/sessions/schema.js';
import { isListed } from '../src/field-classes.js';
import { sampleSkeleton } from '../src/sample.js';
import { PANEL_COUNT } from '../src/stored.js';
import { acceptanceOf, fieldOf, startPool, stubUser, textOf, type StubUser, type TestBucket, type TestDb, type TestPool } from '../src/test-pool.js';
import { telemetryOf } from './erase-test-telemetry.js';
import { anonymizeSkeleton, closeAccount, eraseAccount, eraseLeakedSecret, eraseRawObject, findRawContaining, holdsValue, weekOf, type EraseStore, type RawHit } from './erase.js';

let pool: TestPool;
let next = 7000;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const grant = { 'oars-redaction-version': '1', 'oars-capture-version': 'cap-1', 'oars-raw-consent': 'granted', 'oars-raw-consent-version': 'v1' };
const NOW = new Date('2026-11-08T12:00:00Z');

/** An invented key shaped like a cloud access key: the value a redactor missed. */
const FAKE_KEY = 'AKIAFAKEKEY0000SECRET';
/** A second value, for the test whose first deposit must pass: a tombstone from an earlier test would refuse FAKE_KEY. */
const SECOND_KEY = 'AKIAFAKEKEY0000SECOND';
/** A third and a fourth, for a value that sits in a frame's `model` and for one that sits in a staged part. */
const MODEL_KEY = 'AKIAFAKEKEY0MODELKEY';
const PART_KEY = 'AKIAFAKEKEY0000PARTS';
/** Two values for two deposits that differ in nothing else, and one for a harness version that is not a semver. */
const TWIN_A = 'AKIAFAKEKEY0TWINAAAA';
const TWIN_B = 'AKIAFAKEKEY0TWINBBBB';
const VERSION_KEY = 'AKIAFAKEKEY0VERSION';

/** The pieces handed out one at a time, as a stream: each is made only when asked for. */
const asyncPieces = (pieces: Iterable<Uint8Array>): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator]: () => {
    const next = pieces[Symbol.iterator]();
    return { next: () => Promise.resolve(next.next()) };
  },
});

/** The erasure store over the pool's local D1 and raw bucket, as `wrangler --local` would reach them. */
const storeOf = (db: TestDb, bucket: TestBucket, telemetry: TestBucket, chunk = 64 * 1024): EraseStore => ({
  telemetry: telemetryOf(telemetry),
  rows: async (sql, binds) => (await db.prepare(sql).bind(...binds).all()).results,
  run: async (sql, binds) => Number(fieldOf(fieldOf(await db.prepare(sql).bind(...binds).run(), 'meta'), 'changes')),
  deleteObject: (key) => bucket.delete([key]),
  // The object's bytes in pieces of `chunk`, as a file read gives them: the find never holds the whole object.
  readObject: async (key) => {
    const found = await bucket.get(key);
    if (found === null) return null;
    const bytes = new Uint8Array(await found.arrayBuffer());
    return asyncPieces(
      (function* pieces() {
        for (let at = 0; at < bytes.length; at += chunk) yield bytes.subarray(at, at + chunk);
      })(),
    );
  },
});

const store = async (chunk?: number): Promise<EraseStore> => storeOf(await pool.db(), await pool.rawBucket(), await pool.bucket(), chunk);

const member = async (): Promise<{ token: string; account: string; user: StubUser }> => {
  next += 1;
  const user = stubUser(String(next));
  const { token, account } = await pool.signIn('github', user);
  expect((await pool.post('/v1/covenant/accept', acceptanceOf('v1'), token)).status).toBe(200);
  return { token, account, user };
};

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const putRaw = async (token: string, bytes: Uint8Array): Promise<{ hash: string; part: number; complete: number }> => {
  const hash = sha(bytes);
  const part = (await pool.send(`/v1/raw/${hash}/parts/1`, { method: 'PUT', body: bytes }, token, grant)).status;
  const complete = (await pool.send(`/v1/raw/${hash}/complete`, { method: 'POST', body: JSON.stringify({ parts: 1, bytes: bytes.length }) }, token, grant)).status;
  return { hash, part, complete };
};

/** The keys of one account's objects, staged or assembled. The bucket is shared by the whole file, so a test names the account it looks at. */
const rawKeys = async (account: string): Promise<string[]> => [...(await (await pool.rawBucket()).list()).objects.map((object) => object.key)].filter((key) => key.split('/')[1] === account);

/** A sample deposit whose first shell step names `program`, a name the pool stores in clear below the floor. */
const skeletonWith = (id: string, program?: string, model?: string, harnessVersion?: string): unknown => {
  const text = JSON.stringify(sampleSkeleton(id));
  const named = program === undefined ? text : text.replaceAll('"program":"git"', `"program":"${program}"`);
  const modeled = model === undefined ? named : named.replaceAll('"model":"claude-opus-5-5"', `"model":"${model}"`);
  return JSON.parse(harnessVersion === undefined ? modeled : modeled.replaceAll('"harnessVersion":"2.1.314"', `"harnessVersion":"${harnessVersion}"`));
};

const all = async (sql: string, ...binds: (string | number)[]): Promise<readonly unknown[]> => (await (await pool.db()).prepare(sql).bind(...binds).all()).results;

const count = async (sql: string, ...binds: (string | number)[]): Promise<number> => {
  const held = fieldOf((await all(sql, ...binds))[0], 'held');
  if (typeof held !== 'number') throw new Error(`no count from ${sql}`);
  return held;
};

/** Every row of every table in the pool's database, as one text: what a copy of the database would hold. */
const dump = async (): Promise<string> => {
  const tables = (await all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")).map((row) => String(fieldOf(row, 'name')));
  const parts: string[] = [];
  for (const table of tables) parts.push(JSON.stringify(await all(`SELECT * FROM ${table}`)));
  return parts.join('\n');
};

const aggregates = async (): Promise<string> => JSON.stringify([await all('SELECT key, sessions, clusters, ok, failed FROM cells ORDER BY key'), await all('SELECT key, sessions, clusters FROM strata ORDER BY key'), await all('SELECT kind, key, account, day FROM contributors ORDER BY kind, key, account, day')]);

/** The served totals alone: what an account's erasure must leave as it was. The contributor records are the link to them, and an erasure removes the account's. */
const totals = async (): Promise<string> => JSON.stringify([await all('SELECT key, sessions, clusters, ok, failed FROM cells ORDER BY key'), await all('SELECT key, sessions, clusters FROM strata ORDER BY key')]);

describe('erasing a raw object', () => {
  it('deletes the object, writes a tombstone and an audit row, and refuses the same object when it is deposited again', async () => {
    const { token, account } = await member();
    const bytes = new TextEncoder().encode(`a redacted transcript that kept ${FAKE_KEY}`);
    const first = await putRaw(token, bytes);
    expect([first.part, first.complete]).toEqual([200, 201]);
    expect(await rawKeys(account)).toEqual([`raw/${account}/${first.hash}`]);

    const erased = await eraseRawObject(await store(), `raw/${account}/${first.hash}`, NOW);
    expect(erased).toEqual({ rows: 0, objects: 1 });
    expect(await rawKeys(account)).toEqual([]);

    // The second deposit is refused, and R2 stays empty: not a staged part, not an object.
    const again = await putRaw(token, bytes);
    expect([again.part, again.complete]).toEqual([403, 403]);
    expect(await rawKeys(account)).toEqual([]);

    // The ledger row stays (a hash and a byte count) and says it was erased; nothing says what the object held.
    expect(await all('SELECT erased_on FROM raw_objects WHERE account = ? AND sha256 = ?', account, first.hash)).toEqual([{ erased_on: '2026-11-08' }]);
    expect(await all("SELECT kind, reason, erased_on FROM erasure_tombstones WHERE kind = 'raw-object'")).toContainEqual({ kind: 'raw-object', reason: 'raw', erased_on: '2026-11-08' });
    expect(await all("SELECT kind, reason, erased_on, rows_erased, objects_erased, account FROM erasure_audit WHERE kind = 'raw-object'")).toContainEqual({ kind: 'raw-object', reason: 'raw', erased_on: '2026-11-08', rows_erased: 0, objects_erased: 1, account });
    expect(await dump()).not.toContain(FAKE_KEY);
  }, 60_000);

  it('refuses a refused object by name and leaves another object of the same account alone', async () => {
    const { token, account } = await member();
    const gone = await putRaw(token, new TextEncoder().encode('first transcript'));
    const kept = await putRaw(token, new TextEncoder().encode('second transcript'));
    await eraseRawObject(await store(), `raw/${account}/${gone.hash}`, NOW);
    const refused = await pool.send(`/v1/raw/${gone.hash}/parts/1`, { method: 'PUT', body: 'first transcript' }, token, grant);
    expect(refused).toMatchObject({ status: 403, json: { error: 'erased' } });
    expect((await pool.send(`/v1/raw/${kept.hash}/parts/1`, { method: 'PUT', body: 'second transcript' }, token, grant)).status).toBe(200);
  }, 60_000);

  it('takes only a raw key', async () => {
    await expect(eraseRawObject(await store(), 'staging/a/b', NOW)).rejects.toThrow(/raw key/);
    await expect(eraseRawObject(await store(), `raw/a/${'F'.repeat(64)}`, NOW)).rejects.toThrow(/raw key/);
  });
});

describe('erasing a row that holds a leaked secret', () => {
  it('replaces the row in place, keeps the ledger and the aggregates whole, and leaves the value in no read, bundle, or raw object', async () => {
    // A pool whose public floor is 1 serves a single cluster's cells and motifs, so the bundle holds the value before the erasure; at the default floor it would not, and the bundle half could not go red.
    const shared = pool;
    pool = await startPool({ PUBLIC_FLOOR: '1' });
    try {
      const { token, account } = await member();
      const bystander = await member();
      expect((await pool.post('/v1/deposits', skeletonWith('00000000000071aa', FAKE_KEY), token)).status).toBe(201);
      expect((await pool.post('/v1/deposits', skeletonWith('00000000000071ab'), bystander.token)).status).toBe(201);
      const leaked = await putRaw(token, new TextEncoder().encode(`env dump: ${FAKE_KEY}`));
      // The value is in the pool before the erasure: the ledger row, the motifs, and the raw object.
      expect(await dump()).toContain(FAKE_KEY);
      expect((await (await pool.rawBucket()).get(`raw/${account}/${leaked.hash}`).then((object) => object?.text())) ?? '').toContain(FAKE_KEY);

      const rows = await count('SELECT COUNT(*) AS held FROM deposits');
      const bundleBefore = await pool.get('/bundle/claude-code/2.1.314/1', token);
      expect(bundleBefore.status).toBe(200);
      const before = await aggregates();
      const tier = await all("SELECT tier, counted_at, ingest FROM deposits WHERE id = '00000000000071aa'");
      const sessions = await all('SELECT sessions, clusters FROM cells ORDER BY key');

      const run = await store();
      expect((await eraseLeakedSecret(run, { account, id: '00000000000071aa', value: FAKE_KEY }, NOW)).rows).toBeGreaterThanOrEqual(2);
      await eraseRawObject(run, `raw/${account}/${leaked.hash}`, NOW);

      // No row is dropped; the row holds a marker, and its tier, count mark, and ingest mark stay.
      expect(await count('SELECT COUNT(*) AS held FROM deposits')).toBe(rows);
      expect(await all("SELECT skeleton, extensions, erased_on FROM deposits WHERE id = '00000000000071aa'")).toEqual([{ skeleton: '{"erased":"leaked-secret"}', extensions: '[]', erased_on: '2026-11-08' }]);
      expect(await all("SELECT tier, counted_at, ingest FROM deposits WHERE id = '00000000000071aa'")).toEqual(tier);
      // The aggregates keep their counts: the secret leaves the motif text and the cells and contributors stay as they were.
      expect(await aggregates()).toBe(before);
      expect(await all('SELECT sessions, clusters FROM cells ORDER BY key')).toEqual(sessions);
      // The bystander's row is untouched.
      expect(await count("SELECT COUNT(*) AS held FROM deposits WHERE id = '00000000000071ab' AND erased_on IS NULL")).toBe(1);

      // A copy of the database, a signed bundle, and R2 hold the value nowhere.
      expect(await dump()).not.toContain(FAKE_KEY);
      const bundle = await pool.get('/bundle/claude-code/2.1.314/1', token);
      expect(bundle.status).toBe(200);
      expect(JSON.stringify(bundle.json)).not.toContain(FAKE_KEY);
      expect(JSON.stringify(bundleBefore.json)).toContain(FAKE_KEY);
      expect((await Promise.all((await rawKeys(account)).map(async (key) => (await (await pool.rawBucket()).get(key).then((object) => object?.text())) ?? ''))).join('')).not.toContain(FAKE_KEY);
      expect(await all("SELECT kind, reason, rows_erased, objects_erased FROM erasure_audit WHERE kind = 'row'")).toContainEqual(expect.objectContaining({ kind: 'row', reason: 'leaked-secret' }));
    } finally {
      await pool.dispose();
      pool = shared;
    }
  }, 120_000);

  it('scrubs a value that sits in the model of a frame from the cells and contributors that name it, with every count unchanged', async () => {
    const { token, account } = await member();
    const bystander = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000078aa', undefined, MODEL_KEY), token)).status).toBe(201);
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000078ab'), bystander.token)).status).toBe(201);
    // A model name is stored in clear in the cell key and its frame bucket, and in the contributor record: the value is in the pool before the erasure.
    expect(await count('SELECT COUNT(*) AS held FROM cells WHERE key LIKE ? AND frame_bucket LIKE ?', `%${MODEL_KEY}%`, `%${MODEL_KEY}%`)).toBeGreaterThanOrEqual(1);
    expect(await count("SELECT COUNT(*) AS held FROM contributors WHERE key LIKE ?", `%${MODEL_KEY}%`)).toBeGreaterThanOrEqual(1);
    const shape = async (): Promise<string> =>
      JSON.stringify([
        await all('SELECT motif_id, grain, day, exposed, sessions, clusters, ok, failed, tokens FROM cells ORDER BY motif_id, grain, day, exposed, sessions, clusters, ok, failed, tokens'),
        await all('SELECT COUNT(*) AS held FROM strata'),
        await all('SELECT kind, account, day, COUNT(*) AS held FROM contributors GROUP BY kind, account, day ORDER BY kind, account, day'),
      ]);
    const before = await shape();

    const erased = await eraseLeakedSecret(await store(), { account, id: '00000000000078aa', value: MODEL_KEY }, NOW);
    expect(erased.rows).toBeGreaterThanOrEqual(2);
    expect(await dump()).not.toContain(MODEL_KEY);
    expect(await shape()).toBe(before);
    // The bystander's cells stand, with their own model.
    expect(await count("SELECT COUNT(*) AS held FROM cells WHERE frame_bucket LIKE '%claude-opus-5-5%'")).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it('keeps two leaked models apart: erasing both from otherwise identical deposits renames two cells to two keys, and loses none', async () => {
    const { token, account } = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000080aa', undefined, TWIN_A), token)).status).toBe(201);
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000080ab', undefined, TWIN_B), token)).status).toBe(201);
    const cells = await count('SELECT COUNT(*) AS held FROM cells');
    const contributors = await count('SELECT COUNT(*) AS held FROM contributors');
    const run = await store();
    // The second erasure used to meet the first one's key on the primary key and stop, with the rows still holding the value.
    expect((await eraseLeakedSecret(run, { account, id: '00000000000080aa', value: TWIN_A }, NOW)).rows).toBeGreaterThanOrEqual(2);
    expect((await eraseLeakedSecret(run, { account, id: '00000000000080ab', value: TWIN_B }, NOW)).rows).toBeGreaterThanOrEqual(2);
    expect(await count('SELECT COUNT(*) AS held FROM cells')).toBe(cells);
    expect(await count('SELECT COUNT(*) AS held FROM contributors')).toBe(contributors);
    const dumped = await dump();
    expect(dumped).not.toContain(TWIN_A);
    expect(dumped).not.toContain(TWIN_B);
    // The marker is the first 12 hex of each value's SHA-256, so each value has its own.
    expect(await count('SELECT COUNT(*) AS held FROM cells WHERE key LIKE ?', `%[erased:${sha(new TextEncoder().encode(TWIN_A)).slice(0, 12)}]%`)).toBeGreaterThanOrEqual(1);
    expect(await count('SELECT COUNT(*) AS held FROM cells WHERE key LIKE ?', `%[erased:${sha(new TextEncoder().encode(TWIN_B)).slice(0, 12)}]%`)).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it('scrubs a value that sits in a harness version, which the cell keeps in its harness bucket', async () => {
    const { token, account } = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000081aa', undefined, undefined, VERSION_KEY), token)).status).toBe(201);
    expect(await count('SELECT COUNT(*) AS held FROM cells WHERE harness_bucket LIKE ?', `%${VERSION_KEY}%`)).toBeGreaterThanOrEqual(1);
    const cells = await count('SELECT COUNT(*) AS held FROM cells');
    await eraseLeakedSecret(await store(), { account, id: '00000000000081aa', value: VERSION_KEY }, NOW);
    expect(await dump()).not.toContain(VERSION_KEY);
    expect(await count('SELECT COUNT(*) AS held FROM cells')).toBe(cells);
  }, 90_000);

  it('bumps the pool generation once when it scrubs an aggregate, so a client holding the old copy fetches the scrubbed one', async () => {
    const { token, account } = await member();
    const value = 'AKIAFAKEKEY0GENERATE';
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000082aa', undefined, value), token)).status).toBe(201);
    // The row goes first, without the value, so the one change the value-erasure makes is to cells and contributors, which move no count.
    await eraseLeakedSecret(await store(), { account, id: '00000000000082aa' }, NOW);
    const generation = await count('SELECT generation AS held FROM pool_generation');
    expect((await eraseLeakedSecret(await store(), { account, id: '00000000000082aa', value }, NOW)).rows).toBeGreaterThanOrEqual(2);
    expect(await count('SELECT generation AS held FROM pool_generation')).toBe(generation + 1);
    // Nothing left to scrub: no bump.
    await eraseLeakedSecret(await store(), { account, id: '00000000000082aa', value }, NOW);
    expect(await count('SELECT generation AS held FROM pool_generation')).toBe(generation + 1);
  }, 90_000);

  it('renames only the contributor record that holds the value when another differs from it in nothing else', async () => {
    const { account } = await member();
    const db = await pool.db();
    const value = 'AKIAFAKEKEY0AMBIGUOUS';
    const twin = 'AKIAFAKEKEY0AMBIGUOUT';
    for (const key of [`cell/${twin}/x`, `cell/${value}/x`, `cell/${'B'.repeat(value.length)}/x`]) await db.prepare("INSERT INTO contributors (kind, key, account, day) VALUES ('cell', ?, 'acct_ambiguous', '2026-11-08')").bind(key).run();
    await eraseLeakedSecret(await store(), { account, id: '00000000000083aa', value }, NOW);
    const marker = `[erased:${sha(new TextEncoder().encode(value)).slice(0, 12)}]`;
    expect((await all("SELECT key FROM contributors WHERE account = 'acct_ambiguous' ORDER BY key")).map((row) => String(fieldOf(row, 'key')))).toEqual([`cell/${twin}/x`, `cell/${'B'.repeat(value.length)}/x`, `cell/${marker}/x`]);
  }, 90_000);

  it('refuses the same value again, in any session and in the session that held it, and nothing else', async () => {
    const { token, account } = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000072aa', SECOND_KEY), token)).status).toBe(201);
    await eraseLeakedSecret(await store(), { account, id: '00000000000072aa', value: SECOND_KEY }, NOW);

    const other = await member();
    // The value in a new session of another account.
    expect(await pool.post('/v1/deposits', skeletonWith('00000000000072ab', SECOND_KEY), other.token)).toMatchObject({ status: 403, json: { error: 'erased' } });
    // The erased session, sent again without the value: its key is tombstoned too.
    expect(await pool.post('/v1/deposits', skeletonWith('00000000000072aa'), token)).toMatchObject({ status: 403, json: { error: 'erased' } });
    expect(await count("SELECT COUNT(*) AS held FROM deposits WHERE id = '00000000000072ab'")).toBe(0);
    // A deposit that carries neither is stored as before.
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000072ac'), other.token)).status).toBe(201);
    // Only the value's SHA-256 is kept.
    expect(await all("SELECT digest FROM erasure_tombstones WHERE kind = 'value'")).toContainEqual({ digest: sha(new TextEncoder().encode(SECOND_KEY)) });
  }, 60_000);

  it('erases the row alone when no value is given, and refuses a value too short to name a secret', async () => {
    const { token, account } = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000073aa'), token)).status).toBe(201);
    expect(await eraseLeakedSecret(await store(), { account, id: '00000000000073aa' }, NOW)).toEqual({ rows: 1, objects: 0 });
    // No value, no value tombstone for this session: only its own key.
    expect(await count("SELECT COUNT(*) AS held FROM erasure_tombstones WHERE kind = 'deposit' AND digest = ?", createHash('sha256').update(`${account}/00000000000073aa`).digest('hex'))).toBe(1);
    await expect(eraseLeakedSecret(await store(), { account, id: '00000000000073aa', value: 'git' }, NOW)).rejects.toThrow(/at least 8/);
    await expect(eraseLeakedSecret(await store(), { account: "a'; DROP TABLE x; --", id: '00000000000073aa' }, NOW)).rejects.toThrow(/not a pool id/);
  }, 60_000);

  it('refuses a selector that names no deposit row, and writes no tombstone or audit row for it', async () => {
    const { account } = await member();
    const before = await count('SELECT COUNT(*) AS held FROM erasure_tombstones');
    const audits = await count('SELECT COUNT(*) AS held FROM erasure_audit');
    await expect(eraseLeakedSecret(await store(), { account, id: '00000000000077ff' }, NOW)).rejects.toThrow(/no deposit row/);
    expect(await count('SELECT COUNT(*) AS held FROM erasure_tombstones')).toBe(before);
    expect(await count('SELECT COUNT(*) AS held FROM erasure_audit')).toBe(audits);
  }, 60_000);

  it('runs again to the end: a second run changes no row and still audits', async () => {
    const { token, account } = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000074aa', 'AKIAFAKEKEY0000AGAIN'), token)).status).toBe(201);
    const run = await store();
    const first = await eraseLeakedSecret(run, { account, id: '00000000000074aa', value: 'AKIAFAKEKEY0000AGAIN' }, NOW);
    const second = await eraseLeakedSecret(run, { account, id: '00000000000074aa', value: 'AKIAFAKEKEY0000AGAIN' }, NOW);
    expect(first.rows).toBeGreaterThanOrEqual(1);
    expect(second).toEqual({ rows: 0, objects: 0 });
  }, 60_000);
});

describe('erasing one account under a lawful request', () => {
  it('erases its per-account content and raw objects and keeps its contribution to the aggregate counts', async () => {
    const user = stubUser(String(next + 1));
    const { token, account } = await member();
    const other = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000075aa'), token)).status).toBe(201);
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000075ab'), token)).status).toBe(201);
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000075ac'), other.token)).status).toBe(201);
    const mine = await putRaw(token, new TextEncoder().encode('my transcript'));
    const theirs = await putRaw(other.token, new TextEncoder().encode('their transcript'));
    const before = await totals();
    const theirContributors = await all('SELECT kind, key, account, day FROM contributors WHERE account = ? ORDER BY kind, key, day', other.account);
    const bundleBefore = await pool.get('/bundle/claude-code/2.1.314/1', other.token);

    // The links to the totals this fixture's two deposits made: the count below is exact, so a step that stops counting a table fails here.
    const links = await count('SELECT (SELECT COUNT(*) FROM account_repo_keys WHERE account = ?) + (SELECT COUNT(*) FROM deposit_hours WHERE account = ?) + (SELECT COUNT(*) FROM contributors WHERE account = ?) AS held', account, account, account);
    expect(links).toBe(10);

    // The rewrite moves a deposit's account, id, and ingest mark, so the rows are counted by the marker they now hold under a random id.
    const markers = (): Promise<number> => count("SELECT COUNT(*) AS held FROM deposits WHERE account LIKE 'erased:%' AND json_extract(skeleton, '$.erased') = 'lawful-request' AND erased_on IS NULL");
    const markersBefore = await markers();
    const erased = await eraseAccount(await store(), account, NOW);
    expect(erased.objects).toBe(1);
    // 2 deposit rows, 1 token, and the 10 links.
    expect(erased.rows).toBe(13);

    // Per-account content: both rows are markers and tombstoned, the raw object is gone and tombstoned.
    expect(await markers()).toBe(markersBefore + 2);
    expect(await count('SELECT COUNT(*) AS held FROM deposits WHERE account = ?', account)).toBe(0);
    expect(await rawKeys(account)).toEqual([]);
    expect(await rawKeys(other.account)).toEqual([`raw/${other.account}/${theirs.hash}`]);
    expect(await count("SELECT COUNT(*) AS held FROM erasure_tombstones WHERE reason = 'lawful-request' AND kind <> 'account'")).toBe(3);
    // The other account's content stands.
    expect(await count("SELECT COUNT(*) AS held FROM deposits WHERE account = ? AND erased_on IS NULL", other.account)).toBe(1);
    // Totals: every served count and cluster is as it was. The account's own contributor records are gone and the other account's stand.
    expect(await totals()).toBe(before);
    expect(await count('SELECT COUNT(*) AS held FROM contributors WHERE account = ?', account)).toBe(0);
    expect(await all('SELECT kind, key, account, day FROM contributors WHERE account = ? ORDER BY kind, key, day', other.account)).toEqual(theirContributors);
    expect((await pool.get('/bundle/claude-code/2.1.314/1', other.token)).json).toEqual(bundleBefore.json);
    // The token it held is dead; the person signs in again to the same account, and the erased sessions and the erased object cannot come back.
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000075aa'), token)).status).toBe(401);
    const again = await pool.signIn('github', user);
    expect(again.account).toBe(account);
    expect(await pool.post('/v1/deposits', skeletonWith('00000000000075aa'), again.token)).toMatchObject({ status: 403, json: { error: 'erased' } });
    expect((await pool.send(`/v1/raw/${mine.hash}/parts/1`, { method: 'PUT', body: 'my transcript' }, again.token, grant)).status).toBe(403);
    // The audit row counts and names no content.
    expect(await all("SELECT kind, reason, erased_on, rows_erased, objects_erased, account FROM erasure_audit WHERE kind = 'account' AND account = ?", account)).toEqual([{ kind: 'account', reason: 'lawful-request', erased_on: '2026-11-08', rows_erased: erased.rows, objects_erased: 1, account }]);
  }, 90_000);

  it('scrubs the label and allow list of the account\'s machines and leaves the other account\'s and the hashes', async () => {
    const { token, account } = await member();
    const other = await member();
    const enroll = (bearer: string, label: string): Promise<{ status: number }> => pool.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label, allowRepos: ['acme/secret-repo'] }, bearer);
    expect((await enroll(token, 'a home server')).status).toBe(201);
    expect((await enroll(other.token, 'their box')).status).toBe(201);
    const scrubbed = (): Promise<number> => count("SELECT COUNT(*) AS held FROM machines WHERE label = '[erased]' AND allow_repos = '[]'");
    const scrubbedBefore = await scrubbed();
    // The machine row and the account's one token.
    expect((await eraseAccount(await store(), account, NOW)).rows).toBe(2);
    // The machine's account, id, and key hash are rewritten, so it is counted by the label and allow list it now holds.
    expect(await scrubbed()).toBe(scrubbedBefore + 1);
    expect(await count('SELECT COUNT(*) AS held FROM machines WHERE account = ?', account)).toBe(0);
    expect(await all('SELECT label FROM machines WHERE account = ?', other.account)).toEqual([{ label: 'their box' }]);
    expect((await eraseAccount(await store(), account, NOW)).rows).toBe(0);
    expect(await all("SELECT rows_erased FROM erasure_audit WHERE kind = 'account' AND account = ? ORDER BY id DESC LIMIT 1", account)).toEqual([{ rows_erased: 0 }]);
  }, 60_000);

  it('drops the account\'s staged parts', async () => {
    const { token, account } = await member();
    const body = JSON.stringify(skeletonWith('00000000000076aa'));
    const half = Math.floor(body.length / 2);
    const batch = createHash('sha256').update(body).digest('hex');
    const sent = await pool.send('/v1/deposits', { method: 'POST', body: body.slice(0, half) }, token, { 'oars-part': '1/2', 'oars-batch': batch });
    expect(sent.status).toBe(202);
    expect(await count('SELECT COUNT(*) AS held FROM deposit_parts WHERE account = ?', account)).toBe(1);
    // The staged part and the account's one token.
    expect((await eraseAccount(await store(), account, NOW)).rows).toBe(2);
    expect(await count('SELECT COUNT(*) AS held FROM deposit_parts WHERE account = ?', account)).toBe(0);
  }, 60_000);
});

describe('erasing one account removes its own rows and its link to the shared totals (GDPR Article 17)', () => {
  const telemetry = (day: string, install: string, account: string): Promise<unknown> =>
    pool.db().then((db) => db.prepare("INSERT INTO telemetry_install_days (day, install, account, batches, events, measures) VALUES (?, ?, ?, 2, 5, '[]')").bind(day, install, account).run());

  it('deletes its repo keys and deposit hours, clears its telemetry account, and leaves the other account\'s rows', async () => {
    const { token, account } = await member();
    const other = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('0000000000007a01'), token)).status).toBe(201);
    expect((await pool.post('/v1/deposits', skeletonWith('0000000000007a02'), other.token)).status).toBe(201);
    const db = await pool.db();
    for (const holder of [account, other.account]) await db.prepare('INSERT OR IGNORE INTO account_repo_keys (account, repo_key) VALUES (?, ?)').bind(holder, `key-${holder}`).run();
    await telemetry('2026-11-07', 'install-mine', account);
    await telemetry('2026-11-07', 'install-theirs', other.account);
    expect(await count('SELECT COUNT(*) AS held FROM deposit_hours WHERE account = ?', account)).toBeGreaterThan(0);

    await eraseAccount(await store(), account, NOW);

    expect(await count('SELECT COUNT(*) AS held FROM account_repo_keys WHERE account = ?', account)).toBe(0);
    expect(await count('SELECT COUNT(*) AS held FROM deposit_hours WHERE account = ?', account)).toBe(0);
    expect(await count('SELECT COUNT(*) AS held FROM account_repo_keys WHERE account = ?', other.account)).toBe(1);
    expect(await count('SELECT COUNT(*) AS held FROM deposit_hours WHERE account = ?', other.account)).toBeGreaterThan(0);
    // The row of the telemetry day stays with its counts; only the account id is gone, and the other account's id stands.
    expect(await count('SELECT COUNT(*) AS held FROM telemetry_install_days WHERE account = ?', account)).toBe(0);
    expect(await all("SELECT install, batches, events FROM telemetry_install_days WHERE install = 'install-mine'")).toEqual([{ install: 'install-mine', batches: 2, events: 5 }]);
    expect(await all("SELECT account FROM telemetry_install_days WHERE install = 'install-theirs'")).toEqual([{ account: other.account }]);
  }, 90_000);

  it('removes each item the covenant lists in 6.6(d): contributors, repository keys, deposit hours, and telemetry install days, and no other account\'s', async () => {
    const { token, account } = await member();
    const other = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('0000000000007c01'), token)).status).toBe(201);
    expect((await pool.post('/v1/deposits', skeletonWith('0000000000007c02'), other.token)).status).toBe(201);
    const db = await pool.db();
    for (const holder of [account, other.account]) await db.prepare('INSERT OR IGNORE INTO account_repo_keys (account, repo_key) VALUES (?, ?)').bind(holder, `key-${holder}`).run();
    await telemetry('2026-11-07', 'six-six-d-mine', account);
    await telemetry('2026-11-07', 'six-six-d-theirs', other.account);
    const held = (table: string, holder: string): Promise<number> => count(`SELECT COUNT(*) AS held FROM ${table} WHERE account = ?`, holder);
    for (const table of ['contributors', 'account_repo_keys', 'deposit_hours', 'telemetry_install_days']) {
      expect(await held(table, account)).toBeGreaterThan(0);
      expect(await held(table, other.account)).toBeGreaterThan(0);
    }
    const theirs = await Promise.all(['contributors', 'account_repo_keys', 'deposit_hours', 'telemetry_install_days'].map((table) => held(table, other.account)));

    await eraseAccount(await store(), account, NOW);

    for (const table of ['contributors', 'account_repo_keys', 'deposit_hours', 'telemetry_install_days']) expect(await held(table, account)).toBe(0);
    expect(await Promise.all(['contributors', 'account_repo_keys', 'deposit_hours', 'telemetry_install_days'].map((table) => held(table, other.account)))).toEqual(theirs);
    // The install day keeps its counts under a placeholder that names no account.
    expect(await all("SELECT batches, events FROM telemetry_install_days WHERE install = 'six-six-d-mine'")).toEqual([{ batches: 2, events: 5 }]);
  }, 90_000);

  it('clears the telemetry account of two installs of one day without colliding with each other or with an anonymous row', async () => {
    const { account } = await member();
    const other = await member();
    await telemetry('2026-11-06', 'shared-install', account);
    await telemetry('2026-11-06', 'shared-install', other.account);
    await telemetry('2026-11-06', 'shared-install', '');
    await eraseAccount(await store(), account, NOW);
    await eraseAccount(await store(), other.account, NOW);
    expect(await count("SELECT COUNT(*) AS held FROM telemetry_install_days WHERE install = 'shared-install'")).toBe(3);
    expect(await count("SELECT COUNT(*) AS held FROM telemetry_install_days WHERE install = 'shared-install' AND account IN (?, ?)", account, other.account)).toBe(0);
  }, 60_000);

  it('makes its tokens unusable and holds no credential, and keeps that a sign-in happened', async () => {
    const { token, account } = await member();
    const other = await member();
    const before = await all('SELECT hash, expires_at FROM tokens WHERE account = ? ORDER BY rowid', account);
    expect(before).toHaveLength(1);
    expect((await pool.get('/bundle/claude-code/2.1.314/1', token)).status).not.toBe(401);

    await eraseAccount(await store(), account, NOW);

    const after = await all('SELECT hash, expires_at FROM tokens WHERE account = ? ORDER BY rowid', account);
    expect(after).toHaveLength(1);
    expect(fieldOf(after[0], 'expires_at')).toBe(fieldOf(before[0], 'expires_at'));
    expect(fieldOf(after[0], 'hash')).not.toBe(fieldOf(before[0], 'hash'));
    expect(String(fieldOf(after[0], 'hash'))).toMatch(/^erased:/);
    expect((await pool.get('/bundle/claude-code/2.1.314/1', token)).status).toBe(401);
    expect((await pool.get('/bundle/claude-code/2.1.314/1', other.token)).status).not.toBe(401);
    expect(await count('SELECT COUNT(*) AS held FROM tokens WHERE account = ?', other.account)).toBe(1);
  }, 60_000);

  it('keeps the acceptance, the tombstones, and the hash, size, and date of what it erased', async () => {
    const { token, account } = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('0000000000007b01'), token)).status).toBe(201);
    const mine = await putRaw(token, new TextEncoder().encode('kept record transcript'));
    const marked = (): Promise<number> => count("SELECT COUNT(*) AS held FROM deposits WHERE account LIKE 'erased:%' AND json_extract(skeleton, '$.erased') = 'lawful-request'");
    const markedBefore = await marked();
    await eraseAccount(await store(), account, NOW);
    expect(await count('SELECT COUNT(*) AS held FROM covenant_acceptances WHERE account = ?', account)).toBe(1);
    expect(await count("SELECT COUNT(*) AS held FROM erasure_tombstones WHERE reason = 'lawful-request' AND kind = 'deposit'")).toBeGreaterThan(0);
    expect(await all("SELECT sha256, bytes, erased_on FROM raw_objects WHERE sha256 = ? AND account = ?", mine.hash, account)).toEqual([{ sha256: mine.hash, bytes: 'kept record transcript'.length, erased_on: '2026-11-08' }]);
    expect(await marked()).toBe(markedBefore + 1);
  }, 60_000);

  it('removes the account from the contributor records, leaves every total as it was, and moves the generation so the next bundle is built without it', async () => {
    const { token, account } = await member();
    const other = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('0000000000007c01', 'twinprog'), token)).status).toBe(201);
    expect((await pool.post('/v1/deposits', skeletonWith('0000000000007c02', 'twinprog'), other.token)).status).toBe(201);
    expect(await count('SELECT COUNT(*) AS held FROM contributors WHERE account = ?', account)).toBeGreaterThan(0);
    const before = await totals();
    const generation = await count('SELECT generation AS held FROM pool_generation');
    const theirs = await count('SELECT COUNT(*) AS held FROM contributors WHERE account = ?', other.account);

    await eraseAccount(await store(), account, NOW);

    expect(await count('SELECT COUNT(*) AS held FROM contributors WHERE account = ?', account)).toBe(0);
    expect(await count('SELECT COUNT(*) AS held FROM contributors WHERE account = ?', other.account)).toBe(theirs);
    expect(await totals()).toBe(before);
    expect(await count('SELECT generation AS held FROM pool_generation')).toBe(generation + 1);
    // A rerun finds nothing to remove and moves nothing.
    expect((await eraseAccount(await store(), account, NOW)).rows).toBe(0);
    expect(await count('SELECT generation AS held FROM pool_generation')).toBe(generation + 1);
    expect(await count('SELECT COUNT(*) AS held FROM cells WHERE key LIKE ?', '%')).toBeGreaterThan(0);
  }, 90_000);

  it('still moves the generation when a run stopped before it did, because the links are not yet gone to hide it', async () => {
    const { token, account } = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('0000000000007d01', 'stopprog'), token)).status).toBe(201);
    const generation = await count('SELECT generation AS held FROM pool_generation');
    const whole = await store();
    // The run stops at the statement that moves the generation (the process dies, the network drops).
    const stopping: EraseStore = {
      ...whole,
      run: (sql, binds) => (sql.startsWith('UPDATE pool_generation') ? Promise.reject(new Error('stopped')) : whole.run(sql, binds)),
    };
    await expect(eraseAccount(stopping, account, NOW)).rejects.toThrow('stopped');

    await eraseAccount(await store(), account, NOW);

    expect(await count('SELECT COUNT(*) AS held FROM contributors WHERE account = ?', account)).toBe(0);
    expect(await count('SELECT generation AS held FROM pool_generation')).toBe(generation + 1);
    // A run that finds nothing left moves nothing more.
    const settled = await count('SELECT generation AS held FROM pool_generation');
    await eraseAccount(await store(), account, NOW);
    expect(await count('SELECT generation AS held FROM pool_generation')).toBe(settled);
  }, 90_000);

  it('does not move the generation for an account that held no link to a total', async () => {
    const { account } = await member();
    const generation = await count('SELECT generation AS held FROM pool_generation');
    await eraseAccount(await store(), account, NOW);
    expect(await count('SELECT generation AS held FROM pool_generation')).toBe(generation);
  }, 60_000);
});

describe('unlinking the rows an erasure keeps (t1065, covenant 6.6(d))', () => {
  const SESSION = '00000000000090aa';
  const FINGERPRINT = 'fingerprint-of-the-erased-laptop';
  const COUNTED_AT = Date.UTC(2026, 10, 3, 14, 25, 36, 789);
  const MACHINE_TIMES = { created_at: Date.UTC(2026, 10, 1, 9, 15, 30, 111), activated_at: Date.UTC(2026, 10, 2, 8, 5, 4, 222), rotated_at: Date.UTC(2026, 10, 2, 20, 45, 59, 333), expires_at: Date.UTC(2027, 1, 1, 8, 5, 4, 222) };
  const retiredOf = (machine: string): string => `hash-of-the-key-a-rotation-replaced-${machine}`;
  const DAY = 86_400_000;
  const kept = ['machines', 'deposits', 'telemetry_install_days'];
  const proof = ['covenant_acceptances', 'accounts', 'tokens', 'erasure_tombstones', 'erasure_audit'];
  const RANDOM_ID = /^erased:[0-9a-f]{32}$/;

  const tableText = async (table: string): Promise<string> => JSON.stringify(await all(`SELECT * FROM ${table}`));

  /** Every random `erased:` id held now (the telemetry placeholder is the bare `erased:`, which this does not match). */
  const randomIds = async (): Promise<string[]> => (await all("SELECT id FROM accounts WHERE id LIKE 'erased:%'")).map((row) => String(fieldOf(row, 'id'))).filter((id) => RANDOM_ID.test(id));

  /** Erases one account and returns the one new `erased:` id that appears, so the id is never read from a value the rewrite keeps. */
  const erase = async (account: string, when: Date = NOW): Promise<string> => {
    const before = new Set(await randomIds());
    await eraseAccount(await store(), account, when);
    const added = (await randomIds()).filter((id) => !before.has(id));
    expect(added).toHaveLength(1);
    return added[0] ?? '';
  };

  /** An account with a machine, a token, a deposit stamped with the machine, a raw object, a telemetry day, and an acceptance. */
  const fixture = async (): Promise<{ account: string; machine: string; key: string; keyHash: string; retiredHash: string; ingest: string; values: string[] }> => {
    const { token, account } = await member();
    const enrolled = await pool.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label: 'unlink box', allowRepos: [] }, token);
    expect(enrolled.status).toBe(201);
    const key = String(fieldOf(enrolled.json, 'token'));
    const machine = String(fieldOf((await all('SELECT id FROM machines WHERE account = ?', account))[0], 'id'));
    expect((await pool.post('/v1/deposits', skeletonWith(SESSION), token)).status).toBe(201);
    await putRaw(token, new TextEncoder().encode('unlink transcript'));
    const db = await pool.db();
    await db.prepare('UPDATE machines SET fingerprint_hash = ?, created_at = ?, activated_at = ?, rotated_at = ?, expires_at = ?, retired_hash = ? WHERE id = ?').bind(FINGERPRINT, MACHINE_TIMES.created_at, MACHINE_TIMES.activated_at, MACHINE_TIMES.rotated_at, MACHINE_TIMES.expires_at, retiredOf(machine), machine).run();
    await db.prepare('UPDATE deposits SET machine = ?, counted_at = ? WHERE account = ?').bind(machine, COUNTED_AT, account).run();
    await db.prepare('UPDATE accounts SET provider_created = 1500000000123 WHERE id = ?').bind(account).run();
    await db.prepare("INSERT INTO telemetry_install_days (day, install, account, batches, events, measures) VALUES ('2026-11-03', 'unlink-install', ?, 1, 2, '[]')").bind(account).run();
    const keyHash = String(fieldOf((await all('SELECT key_hash FROM machines WHERE id = ?', machine))[0], 'key_hash'));
    const ingest = String(fieldOf((await all('SELECT ingest FROM deposits WHERE account = ?', account))[0], 'ingest'));
    return { account, machine, key, keyHash, retiredHash: retiredOf(machine), ingest, values: [account, machine, FINGERPRINT, SESSION] };
  };

  it('leaves no kept row outside 6.6(d) holding the old account, machine, fingerprint, session id, or a time finer than the day, and gives the rewritten rows one random id', async () => {
    const { account, values } = await fixture();
    const erasedId = await erase(account);

    for (const table of kept) {
      const text = await tableText(table);
      for (const value of values) expect(text, `${table} holds ${value}`).not.toContain(value);
    }
    expect(await count('SELECT COUNT(*) AS held FROM deposits WHERE counted_at = ?', Date.UTC(2026, 10, 2))).toBe(1);
    expect(await tableText('deposits')).not.toContain(String(COUNTED_AT));
    expect(await all('SELECT provider_created FROM accounts WHERE id = ?', account)).toEqual([{ provider_created: null }]);

    expect(await count('SELECT COUNT(*) AS held FROM machines WHERE account = ?', erasedId)).toBe(1);
    expect(await count('SELECT COUNT(*) AS held FROM deposits WHERE account = ?', erasedId)).toBe(1);
    expect(await count('SELECT COUNT(*) AS held FROM deposits WHERE account = ? AND machine IN (SELECT id FROM machines WHERE account = ?)', erasedId, erasedId)).toBe(1);
    // A raw object is 6.6(d)'s hash, size, and date, and its tombstone is the unkeyed hash of the pseudonym and the object's hash, so it stays on the pseudonym; the random id never reaches it.
    expect(await count('SELECT COUNT(*) AS held FROM raw_objects WHERE account = ?', account)).toBe(1);
    expect(await count('SELECT COUNT(*) AS held FROM raw_objects WHERE account = ?', erasedId)).toBe(0);
    // The random id is on no row the covenant keeps.
    for (const table of proof.filter((one) => one !== 'accounts')) expect(await tableText(table), `${table} holds the random id`).not.toContain(erasedId);
    // `accounts` holds it once, as the bare row the foreign keys need: nothing in it comes from the account but the input source, and the pseudonym's own row does not name it.
    expect(await all('SELECT first_seen, provider_created, covenant, access, raw_consent FROM accounts WHERE id = ?', erasedId)).toEqual([{ first_seen: null, provider_created: null, covenant: null, access: null, raw_consent: null }]);
    expect(JSON.stringify(await all('SELECT * FROM accounts WHERE id = ?', account))).not.toContain(erasedId);
    // The kept proof still names the account, as 6.6(d) allows.
    expect(await count('SELECT COUNT(*) AS held FROM covenant_acceptances WHERE account = ?', account)).toBe(1);
    expect(await count("SELECT COUNT(*) AS held FROM erasure_tombstones WHERE kind = 'account' AND digest = ?", account)).toBe(1);
  }, 90_000);

  it('cuts a machine created, activated, rotated, and expiry time to the Monday of its ISO week (UTC), as the counting time is', async () => {
    const { account } = await fixture();
    const erasedId = await erase(account);
    const week = (ms: number): number => (Math.floor(ms / DAY) - ((Math.floor(ms / DAY) + 3) % 7)) * DAY;
    expect(await all('SELECT created_at, activated_at, rotated_at, expires_at FROM machines WHERE account = ?', erasedId)).toEqual([{ created_at: week(MACHINE_TIMES.created_at), activated_at: week(MACHINE_TIMES.activated_at), rotated_at: week(MACHINE_TIMES.rotated_at), expires_at: week(MACHINE_TIMES.expires_at) }]);
  }, 90_000);

  it('leaves no exact identifier an export or the machine key held: not the deposit ingest mark, not the key hashes', async () => {
    const { account, ingest, keyHash, retiredHash } = await fixture();
    expect(ingest).not.toBe('');
    await eraseAccount(await store(), account, NOW);
    expect(await count('SELECT COUNT(*) AS held FROM deposits WHERE ingest = ?', ingest)).toBe(0);
    expect(await count('SELECT COUNT(*) AS held FROM machines WHERE key_hash IN (?, ?) OR retired_hash IN (?, ?)', keyHash, retiredHash, keyHash, retiredHash)).toBe(0);
    expect(await count("SELECT COUNT(*) AS held FROM machines WHERE account LIKE 'erased:%' AND retired_hash IS NOT NULL")).toBe(0);
  }, 90_000);

  it('moves an erased deposit off its place among live ones, and cuts the raw object date to the day', async () => {
    const first = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000090b1'), first.token)).status).toBe(201);
    const second = await fixture();
    const third = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000090b3'), third.token)).status).toBe(201);
    const rowidOf = async (account: string): Promise<number> => Number(fieldOf((await all('SELECT rowid AS n FROM deposits WHERE account = ?', account))[0], 'n'));
    // The fixture's deposit went in after the first member's and before the third's, so it sits between two live rows by rowid.
    const placed = [await rowidOf(first.account), await rowidOf(second.account), await rowidOf(third.account)];
    expect(placed[0]).toBeLessThan(placed[1] ?? 0);
    expect(placed[1]).toBeLessThan(placed[2] ?? 0);
    expect(await count('SELECT COUNT(*) AS held FROM raw_objects WHERE account = ? AND stored_at % ? <> 0', second.account, DAY)).toBe(1);
    const erasedId = await erase(second.account);
    expect(await rowidOf(erasedId)).toBeLessThan(0);
    expect(await rowidOf(first.account)).toBe(placed[0]);
    expect(await rowidOf(third.account)).toBe(placed[2]);
    expect(await count('SELECT COUNT(*) AS held FROM raw_objects WHERE account = ? AND stored_at % ? <> 0', second.account, DAY)).toBe(0);
    expect(await count('SELECT COUNT(*) AS held FROM raw_objects WHERE account = ?', second.account)).toBe(1);
  }, 90_000);

  it('lets no tombstone be recomputed from an audited account and a row under an erased id', async () => {
    const { account } = await fixture();
    await eraseAccount(await store(), account, NOW);
    const audited = (await all("SELECT account FROM erasure_audit WHERE kind = 'account'")).map((row) => String(fieldOf(row, 'account')));
    expect(audited).toContain(account);
    const tombstoned = new Set((await all("SELECT digest FROM erasure_tombstones WHERE kind IN ('raw-object', 'deposit')")).map((row) => String(fieldOf(row, 'digest'))));
    const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
    const deposits = (await all("SELECT id FROM deposits WHERE account LIKE 'erased:%'")).map((row) => String(fieldOf(row, 'id')));
    const objects = (await all("SELECT sha256 FROM raw_objects WHERE account LIKE 'erased:%'")).map((row) => String(fieldOf(row, 'sha256')));
    expect(deposits.length).toBeGreaterThan(0);
    for (const one of audited) {
      for (const id of deposits) expect(tombstoned.has(hash(`${one}/${id}`)), `${one} and deposit ${id}`).toBe(false);
      for (const sha256 of objects) expect(tombstoned.has(hash(`raw/${one}/${sha256}`)), `${one} and raw object ${sha256}`).toBe(false);
    }
    expect(objects).toEqual([]);
  }, 90_000);

  it('refuses the erased machine key with a 401 on deposit, activate, and rotate, and keeps the row revoked', async () => {
    const { account, key } = await fixture();
    await eraseAccount(await store(), account, NOW);
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000090af'), key)).status).toBe(401);
    expect((await pool.post('/v1/machines/activate', {}, key)).status).toBe(401);
    expect((await pool.post('/v1/machines/rotate', {}, key)).status).toBe(401);
    expect(await count("SELECT COUNT(*) AS held FROM machines WHERE account LIKE 'erased:%' AND state <> 'revoked'")).toBe(0);
  }, 90_000);

  it('rerun changes nothing: no new id, no new row', async () => {
    const { account } = await fixture();
    await eraseAccount(await store(), account, NOW);
    const accountsBefore = await count("SELECT COUNT(*) AS held FROM accounts WHERE id LIKE 'erased:%'");
    const snapshot = JSON.stringify([await all('SELECT * FROM machines WHERE account LIKE ?', 'erased:%'), await all('SELECT * FROM deposits WHERE account LIKE ?', 'erased:%'), await all('SELECT * FROM raw_objects WHERE account = ?', account)]);
    expect((await eraseAccount(await store(), account, NOW)).rows).toBe(0);
    expect(await count("SELECT COUNT(*) AS held FROM accounts WHERE id LIKE 'erased:%'")).toBe(accountsBefore);
    expect(JSON.stringify([await all('SELECT * FROM machines WHERE account LIKE ?', 'erased:%'), await all('SELECT * FROM deposits WHERE account LIKE ?', 'erased:%'), await all('SELECT * FROM raw_objects WHERE account = ?', account)])).toBe(snapshot);
  }, 90_000);

  it('replaces the machine id on a deposit whose machine row is gone, and rewrites what a later sign-in adds', async () => {
    const { token, account, user } = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000090ad'), token)).status).toBe(201);
    await (await pool.db()).prepare('UPDATE deposits SET machine = ? WHERE account = ?').bind('machine-swept-long-ago', account).run();
    await eraseAccount(await store(), account, NOW);
    expect(await tableText('deposits')).not.toContain('machine-swept-long-ago');
    const again = await pool.signIn('github', user);
    expect(again.account).toBe(account);
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000090ae'), again.token)).status).toBe(201);
    await eraseAccount(await store(), account, NOW);
    expect(await count('SELECT COUNT(*) AS held FROM deposits WHERE account = ?', account)).toBe(0);
  }, 90_000);

  it('keeps the panel count and the panel readable, with nothing new for a recount', async () => {
    const { account } = await fixture();
    const panel = (): Promise<number> => all(PANEL_COUNT, 0).then((rows) => Number(fieldOf(rows[0], 'accounts')));
    const before = await panel();
    expect(before).toBeGreaterThan(0);
    await eraseAccount(await store(), account, NOW);
    expect(await panel()).toBe(before);
    expect(await count('SELECT COUNT(*) AS held FROM contributors WHERE account LIKE ?', 'erased:%')).toBe(0);
    expect(await count('SELECT COUNT(*) AS held FROM account_repo_keys WHERE account LIKE ?', 'erased:%')).toBe(0);
    expect(await count('SELECT COUNT(*) AS held FROM deposit_hours WHERE account LIKE ?', 'erased:%')).toBe(0);
  }, 90_000);

  it('uses a different random id for each erasure, so two erased accounts are not joined to each other', async () => {
    const first = await fixture();
    const second = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000090ab'), second.token)).status).toBe(201);
    // One account at a time: the id of each erasure is the one new `erased:` id that appears, so no value the rewrite keeps is read.
    const ids = [await erase(first.account), await erase(second.account)];
    expect(ids[0]).toMatch(RANDOM_ID);
    expect(ids[1]).toMatch(RANDOM_ID);
    expect(ids[0]).not.toBe(ids[1]);
  }, 90_000);

  it('carries no erasure date and no insert order that maps an erased id to its audit row', async () => {
    const accounts = [await fixture(), await fixture(), await fixture()];
    const nextRowid = async (): Promise<number> => Number(fieldOf((await all('SELECT MAX(rowid) + 1 AS n FROM accounts'))[0], 'n'));
    const expected = await nextRowid();
    const erasedIds = [await erase(accounts[0]?.account ?? ''), await erase(accounts[1]?.account ?? ''), await erase(accounts[2]?.account ?? '', new Date('2026-11-09T12:00:00Z'))];
    // No row under a random id holds an erasure date, so the day cannot pick out the audit row of that day.
    for (const erased of erasedIds) expect(await count('SELECT COUNT(*) AS held FROM deposits WHERE account = ? AND erased_on IS NOT NULL', erased)).toBe(0);
    // The bare `accounts` row takes a random negative rowid, never the next free one, so the order of those rows is not the order of `erasure_audit.id` and a live account signed in later gets the rowid it would have had anyway.
    const rowids = await Promise.all(erasedIds.map(async (erased) => Number(fieldOf((await all('SELECT rowid AS n FROM accounts WHERE id = ?', erased))[0], 'n'))));
    for (const rowid of rowids) expect(rowid).toBeLessThan(0);
    expect(new Set(rowids).size).toBe(rowids.length);
    expect(await nextRowid()).toBe(expected);
    const later = await member();
    expect(Number(fieldOf((await all('SELECT rowid AS n FROM accounts WHERE id = ?', later.account))[0], 'n'))).toBe(expected);
  }, 120_000);

  it('does not scan a deposit under an erased id for a leaked value, so the sweep never dates it', async () => {
    const { account } = await fixture();
    const erased = await erase(account);
    const before = JSON.stringify(await all('SELECT * FROM deposits WHERE account = ?', erased));
    // The marker an erased deposit holds contains this text, so a scan that read the row would find it and date it.
    await eraseLeakedSecret(await store(), { account: 'nobody', id: 'nothing', value: 'lawful-request' }, NOW);
    expect(JSON.stringify(await all('SELECT * FROM deposits WHERE account = ?', erased))).toBe(before);
  }, 90_000);

  it('leaves another account\'s deposit, machine, and raw object as they were', async () => {
    const live = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000090ac'), live.token)).status).toBe(201);
    expect((await pool.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label: 'live box', allowRepos: [] }, live.token)).status).toBe(201);
    await putRaw(live.token, new TextEncoder().encode('live transcript'));
    const rows = async (): Promise<string> => JSON.stringify([await all('SELECT * FROM deposits WHERE account = ?', live.account), await all('SELECT * FROM machines WHERE account = ?', live.account), await all('SELECT * FROM raw_objects WHERE account = ?', live.account)]);
    const before = await rows();
    const { account } = await fixture();
    await eraseAccount(await store(), account, NOW);
    expect(await rows()).toBe(before);
  }, 90_000);
});

/** Stages one part of a two-part deposit through `oars-part`, as the client does. The pool seals the body before it is stored, so a row of `deposit_parts` is ciphertext. */
const stage = async (token: string, id: string, program: string, part: 1 | 2): Promise<number> => {
  const body = JSON.stringify(skeletonWith(id, program));
  const half = Math.floor(body.length / 2);
  const batch = createHash('sha256').update(body).digest('hex');
  return (await pool.send('/v1/deposits', { method: 'POST', body: part === 1 ? body.slice(0, half) : body.slice(half) }, token, { 'oars-part': `${String(part)}/2`, 'oars-batch': batch })).status;
};

describe('closing one account (covenant 6.1 and 7.2(a))', () => {
  const BOX = { hostClass: 'vps', launcher: 'scheduled', label: 'box' };

  it('revokes every token and machine key, records when it closed, writes one audit row, and keeps the Deposits byte for byte', async () => {
    const { token, account } = await member();
    const other = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('0000000000008a01'), token)).status).toBe(201);
    const raw = await putRaw(token, new TextEncoder().encode('transcript held through a close'));
    expect(raw.complete).toBe(201);
    const keys = await rawKeys(account);
    expect(keys.length).toBeGreaterThan(0);
    const enrolled = await pool.post('/v1/machines/enroll', BOX, token);
    const otherBox = await pool.post('/v1/machines/enroll', BOX, other.token);
    const deposits = JSON.stringify(await all('SELECT * FROM deposits WHERE account = ? ORDER BY id', account));
    const objects = JSON.stringify(await all('SELECT * FROM raw_objects WHERE account = ? ORDER BY sha256', account));
    const totalsBefore = await totals();
    const audits = await count('SELECT COUNT(*) AS held FROM erasure_audit');
    expect(await count('SELECT COUNT(*) AS held FROM tokens WHERE account = ?', account)).toBeGreaterThan(0);

    const closed = await closeAccount(await store(), account, NOW);

    expect(closed).toEqual({ rows: 3, objects: 0 });
    expect(await all('SELECT closed_at FROM accounts WHERE id = ?', account)).toEqual([{ closed_at: NOW.getTime() }]);
    expect(await count('SELECT COUNT(*) AS held FROM tokens WHERE account = ?', account)).toBe(0);
    expect(await all('SELECT state FROM machines WHERE account = ?', account)).toEqual([{ state: 'revoked' }]);
    expect(await pool.get('/bundle/claude-code/2.1.314/1', token)).toMatchObject({ status: 401 });
    expect(await pool.post('/v1/machines/activate', {}, textOf(enrolled.json, 'token'))).toMatchObject({ status: 401, json: { error: 'machine_revoked' } });
    expect(await count('SELECT COUNT(*) AS held FROM erasure_audit')).toBe(audits + 1);
    expect(await all("SELECT kind, reason, erased_on, rows_erased, objects_erased, account FROM erasure_audit WHERE kind = 'close' AND account = ?", account)).toEqual([{ kind: 'close', reason: 'account-close', erased_on: '2026-11-08', rows_erased: 3, objects_erased: 0, account }]);
    expect(JSON.stringify(await all('SELECT * FROM deposits WHERE account = ? ORDER BY id', account))).toBe(deposits);
    expect(JSON.stringify(await all('SELECT * FROM raw_objects WHERE account = ? ORDER BY sha256', account))).toBe(objects);
    expect(await rawKeys(account)).toEqual(keys);
    expect(await all('SELECT erased_on FROM raw_objects WHERE account = ? AND sha256 = ?', account, raw.hash)).toEqual([{ erased_on: null }]);
    expect(await totals()).toBe(totalsBefore);
    // Another account's credentials, machines, and closed-at record are not touched.
    expect(await all('SELECT closed_at FROM accounts WHERE id = ?', other.account)).toEqual([{ closed_at: null }]);
    expect(await count('SELECT COUNT(*) AS held FROM tokens WHERE account = ?', other.account)).toBe(1);
    expect(await all('SELECT state FROM machines WHERE account = ?', other.account)).toEqual([{ state: 'pending' }]);
    expect(otherBox.status).toBe(201);
  }, 90_000);

  it('changes nothing on a rerun, keeps the first closed-at time, and writes no second audit row', async () => {
    const { account } = await member();
    await closeAccount(await store(), account, NOW);
    const audits = await count('SELECT COUNT(*) AS held FROM erasure_audit');
    expect(await closeAccount(await store(), account, new Date('2026-12-01T00:00:00Z'))).toEqual({ rows: 0, objects: 0 });
    expect(await all('SELECT closed_at FROM accounts WHERE id = ?', account)).toEqual([{ closed_at: NOW.getTime() }]);
    expect(await count('SELECT COUNT(*) AS held FROM erasure_audit')).toBe(audits);
  }, 60_000);

  it('finishes a close that stopped after the closed-at record, then audits once', async () => {
    const { token, account } = await member();
    await (await pool.db()).prepare('UPDATE accounts SET closed_at = ? WHERE id = ?').bind(NOW.getTime(), account).run();
    expect((await pool.post('/v1/machines/enroll', BOX, token)).status).toBe(403);
    expect(await closeAccount(await store(), account, new Date('2026-12-01T00:00:00Z'))).toEqual({ rows: 1, objects: 0 });
    expect(await count('SELECT COUNT(*) AS held FROM tokens WHERE account = ?', account)).toBe(0);
  }, 60_000);

  it('refuses an account the pool has never seen, and leaves no audit row', async () => {
    const audits = await count('SELECT COUNT(*) AS held FROM erasure_audit');
    await expect(closeAccount(await store(), 'acct_nobody', NOW)).rejects.toThrow('No account acct_nobody in the pool.');
    expect(await count('SELECT COUNT(*) AS held FROM erasure_audit')).toBe(audits);
  });
});

describe('staged parts and a leaked secret', () => {
  it('drops the staged parts of the account that held the value, though the pool seals every part and the command cannot match its text', async () => {
    const { token, account } = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000079aa', PART_KEY), token)).status).toBe(201);
    expect(await stage(token, '00000000000079ab', PART_KEY, 1)).toBe(202);
    expect(await count('SELECT COUNT(*) AS held FROM deposit_parts WHERE account = ? AND deposit IS NULL', account)).toBe(1);
    // The staged text is ciphertext: the value is not in it, and so no scan of it could have found the value.
    expect(JSON.stringify(await all('SELECT body FROM deposit_parts WHERE account = ? AND deposit IS NULL', account))).not.toContain(PART_KEY);
    await eraseLeakedSecret(await store(), { account, id: '00000000000079aa', value: PART_KEY }, NOW);
    expect(await count('SELECT COUNT(*) AS held FROM deposit_parts WHERE account = ? AND deposit IS NULL', account)).toBe(0);
  }, 60_000);

  it('forgets the parts of a batch the pool refuses as erased, so they do not wait for a sweep', async () => {
    const { token, account } = await member();
    const value = 'AKIAFAKEKEY0000PARTB';
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000079ba', value), token)).status).toBe(201);
    await eraseLeakedSecret(await store(), { account, id: '00000000000079ba', value }, NOW);
    expect(await stage(token, '00000000000079bb', value, 1)).toBe(202);
    expect(await stage(token, '00000000000079bb', value, 2)).toBe(403);
    expect(await count('SELECT COUNT(*) AS held FROM deposit_parts WHERE account = ? AND deposit IS NULL', account)).toBe(0);
  }, 60_000);
});

describe('the tombstones and the audit', () => {
  it('are append-only: the database refuses to change or delete a row of either', async () => {
    const db = await pool.db();
    await eraseAccount(await store(), (await member()).account, NOW);
    await expect(db.prepare('DELETE FROM erasure_tombstones').run()).rejects.toThrow(/never deleted/);
    await expect(db.prepare("UPDATE erasure_tombstones SET reason = 'raw'").run()).rejects.toThrow(/never changed/);
    await expect(db.prepare('DELETE FROM erasure_audit').run()).rejects.toThrow(/never deleted/);
    await expect(db.prepare("UPDATE erasure_audit SET reason = 'raw'").run()).rejects.toThrow(/never changed/);
  }, 60_000);
});

describe('finding the raw objects that hold a text', () => {
  /** A name a third party would ask about: said in prose, so no redactor masked it. */
  const NAME = 'Jane Quentin Tenant';

  const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

  const find = async (selector: { account?: string; allAccounts?: boolean }, value: string, chunk?: number): Promise<{ hits: RawHit[]; read: number; matched: number; missing: number }> => {
    const hits: RawHit[] = [];
    const total = await findRawContaining(await store(chunk), selector, value, (hit) => hits.push(hit));
    return { hits, ...total };
  };

  /** Pieces of a stream the way a file read gives them, counting how many were asked for. */
  const streamOf = (bytes: Uint8Array, chunk: number, asked: { count: number }): AsyncIterable<Uint8Array> =>
    asyncPieces(
      (function* pieces() {
        for (let at = 0; at < bytes.length; at += chunk) {
          asked.count += 1;
          yield bytes.subarray(at, at + chunk);
        }
      })(),
    );

  it('reports the key, account, and size of an object that holds the text, and counts what it read', async () => {
    const holder = await member();
    const bystander = await member();
    const text = `{"role":"user","text":"my landlord ${NAME} said the deposit was fine"}`;
    const held = await putRaw(holder.token, bytesOf(text));
    await putRaw(bystander.token, bytesOf('{"role":"user","text":"nothing about anyone"}'));
    const found = await find({ account: holder.account }, NAME);
    expect(found).toEqual({ hits: [{ key: `raw/${holder.account}/${held.hash}`, account: holder.account, bytes: bytesOf(text).length }], read: 1, matched: 1, missing: 0 });
  }, 60_000);

  it('misses an object that does not hold it, and a near miss', async () => {
    const { token, account } = await member();
    await putRaw(token, bytesOf('Jane Quentin Tenan and jane quentin tenant'));
    expect(await find({ account }, NAME)).toMatchObject({ hits: [], read: 1, matched: 0 });
  }, 60_000);

  it('looks in every account with --all-accounts, and in one account only with an account', async () => {
    const first = await member();
    const second = await member();
    const third = await member();
    const a = await putRaw(first.token, bytesOf(`first: ${NAME}`));
    const b = await putRaw(second.token, bytesOf(`second: ${NAME}!`));
    await putRaw(third.token, bytesOf('third: no one'));
    const everywhere = await find({ allAccounts: true }, NAME);
    expect(everywhere.hits.map((hit) => hit.key)).toEqual(expect.arrayContaining([`raw/${first.account}/${a.hash}`, `raw/${second.account}/${b.hash}`]));
    expect(everywhere.hits.every((hit) => hit.key.startsWith('raw/'))).toBe(true);
    expect(everywhere.read).toBeGreaterThanOrEqual(3);
    expect((await find({ account: second.account }, NAME)).hits.map((hit) => hit.account)).toEqual([second.account]);
  }, 60_000);

  it('does not read an object that was erased, and counts a ledger row whose object is gone', async () => {
    const { token, account } = await member();
    const erased = await putRaw(token, bytesOf(`erased: ${NAME}`));
    const lost = await putRaw(token, bytesOf(`lost: ${NAME}`));
    await eraseRawObject(await store(), `raw/${account}/${erased.hash}`, NOW);
    // The object vanished from R2 while its ledger row stands: the find says so and goes on.
    await (await pool.rawBucket()).delete([`raw/${account}/${lost.hash}`]);
    expect(await find({ account }, NAME)).toEqual({ hits: [], read: 0, matched: 0, missing: 1 });
  }, 60_000);

  it('finds a match that straddles a read boundary, at every offset', async () => {
    const needle = [Buffer.from(NAME)];
    for (const chunk of [1, 2, 5, 19, 64]) {
      for (let before = 0; before <= chunk + 2; before += 1) {
        const bytes = bytesOf(`${'x'.repeat(before)}${NAME}${'y'.repeat(chunk)}`);
        expect(await holdsValue(streamOf(bytes, chunk, { count: 0 }), needle)).toBe(true);
      }
    }
    // One byte short of the value in the last chunk, and one byte wrong, are not matches.
    expect(await holdsValue(streamOf(bytesOf(`aaaa${NAME.slice(0, -1)}`), 5, { count: 0 }), needle)).toBe(false);
    expect(await holdsValue(streamOf(bytesOf(`aaaa${NAME.slice(0, -1)}X`), 5, { count: 0 }), needle)).toBe(false);
  });

  it('finds a straddling match in an object read through the store', async () => {
    const { token, account } = await member();
    const text = `0123456789${NAME}0123456789`;
    await putRaw(token, bytesOf(text));
    // 7-byte reads put the name across three of them.
    expect((await find({ account }, NAME, 7)).matched).toBe(1);
  }, 60_000);

  it('reads an object larger than its buffer a piece at a time, and stops at the first match', async () => {
    const chunk = 64 * 1024;
    const big = new Uint8Array(40 * chunk + 100).fill(0x61);
    big.set(bytesOf(NAME), 3 * chunk - 5);
    const early = { count: 0 };
    expect(await holdsValue(streamOf(big, chunk, early), [Buffer.from(NAME)])).toBe(true);
    // The match starts in the third piece and ends in the fourth: the other 36 pieces were never asked for.
    expect(early.count).toBe(4);
    const tail = new Uint8Array(40 * chunk + 100).fill(0x61);
    tail.set(bytesOf(NAME), tail.length - NAME.length);
    const whole = { count: 0 };
    expect(await holdsValue(streamOf(tail, chunk, whole), [Buffer.from(NAME)])).toBe(true);
    const sizes: number[] = [];
    const original = Buffer.concat.bind(Buffer);
    const concat = vi.spyOn(Buffer, 'concat').mockImplementation((list, length) => {
      const joined = original(list, length);
      sizes.push(joined.length);
      return joined;
    });
    expect(await holdsValue(streamOf(tail, chunk, { count: 0 }), [Buffer.from(NAME)])).toBe(true);
    // Memory is one piece and the kept tail, never the object read so far.
    const largest = Math.max(...sizes);
    concat.mockRestore();
    expect(largest).toBeLessThanOrEqual(chunk + NAME.length - 1);
    expect(whole.count).toBe(41);
    expect(await holdsValue(streamOf(new Uint8Array(40 * chunk).fill(0x61), chunk, { count: 0 }), [Buffer.from(NAME)])).toBe(false);
  });

  it('finds a text in an object that went up in several parts', async () => {
    const { token, account } = await member();
    const pieces = [new Uint8Array(1024 * 1024).fill(0x61), new Uint8Array(1024 * 1024).fill(0x62), bytesOf(`tail ${NAME}`)];
    const bytes = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
    let at = 0;
    for (const piece of pieces) {
      bytes.set(piece, at);
      at += piece.length;
    }
    const hash = sha(bytes);
    for (const [index, piece] of pieces.entries()) expect((await pool.send(`/v1/raw/${hash}/parts/${String(index + 1)}`, { method: 'PUT', body: piece }, token, grant)).status).toBe(200);
    expect((await pool.send(`/v1/raw/${hash}/complete`, { method: 'POST', body: JSON.stringify({ parts: 3, bytes: bytes.length }) }, token, grant)).status).toBe(201);
    expect((await find({ account }, NAME, 64 * 1024)).hits).toEqual([{ key: `raw/${account}/${hash}`, account, bytes: bytes.length }]);
  }, 120_000);

  it('matches the text as a transcript writes it: JSON escapes a quote and a backslash', async () => {
    const { token, account } = await member();
    const value = 'Mary "Mo" O\\Brien-Smith';
    await putRaw(token, bytesOf(`{"text":${JSON.stringify(`hello ${value} there`)}}`));
    expect((await find({ account }, value)).matched).toBe(1);
    // The literal form matches too, for a transcript that is not JSON.
    await putRaw(token, bytesOf(`plain: ${value}`));
    expect((await find({ account }, value)).matched).toBe(2);
  }, 60_000);

  it('refuses a value under 8 characters without echoing it, and a selector with neither or both account flags', async () => {
    const { account } = await member();
    const refusal = await find({ account }, 'Jane Do').then(
      () => 'no refusal',
      (error: unknown) => (error instanceof Error ? error.message : 'not an error'),
    );
    expect(refusal).toMatch(/at least 8 characters/);
    expect(refusal).not.toContain('Jane Do');
    await expect(find({ account }, 'Jane Doe')).resolves.toMatchObject({ matched: 0 });
    await expect(find({}, NAME)).rejects.toThrow(/exactly one of/);
    await expect(find({ account, allAccounts: true }, NAME)).rejects.toThrow(/exactly one of/);
    await expect(find({ account: 'not an id!' }, NAME)).rejects.toThrow(/not a pool id/);
  });

  it('only reads: the store sees SELECTs and object reads, and the database and bucket are as they were', async () => {
    const { token, account } = await member();
    await putRaw(token, bytesOf(`kept: ${NAME}`));
    const before = [await dump(), await rawKeys(account)];
    const inner = await store();
    const seen: string[] = [];
    const watched: EraseStore = {
      rows: (sql, binds) => {
        seen.push(sql);
        return inner.rows(sql, binds);
      },
      run: () => Promise.reject(new Error('the find wrote to D1')),
      deleteObject: () => Promise.reject(new Error('the find deleted from R2')),
      telemetry: inner.telemetry,
      readObject: (key) => {
        seen.push(`READ ${key}`);
        return inner.readObject(key);
      },
    };
    const total = await findRawContaining(watched, { account }, NAME, () => undefined);
    expect(total.matched).toBe(1);
    expect(seen.filter((entry) => !entry.startsWith('READ ')).every((sql) => sql.startsWith('SELECT'))).toBe(true);
    expect(seen.some((entry) => entry.startsWith('READ raw/'))).toBe(true);
    expect([await dump(), await rawKeys(account)]).toEqual(before);
    // Nothing the find asks D1 holds the text, so no wrangler argument or log carries it.
    expect(seen.join('\n')).not.toContain(NAME);
  }, 60_000);

  it('hands the caller keys and counts, and nothing the objects said', async () => {
    const { token, account } = await member();
    const around = 'AROUNDTEXT-before ';
    await putRaw(token, bytesOf(`${around}${NAME} after-AROUNDTEXT`));
    const lines: string[] = [];
    const total = await findRawContaining(await store(), { account }, NAME, (hit) => lines.push(JSON.stringify(hit)));
    lines.push(JSON.stringify(total));
    const printed = lines.join('\n');
    for (const forbidden of [NAME, 'AROUNDTEXT', 'Quentin']) expect(printed).not.toContain(forbidden);
  }, 60_000);
});

/** The strings a deposit is planted with: each is a value of a class an erased deposit must not keep, and none of them may be in the row after the erasure. */
const PLANTED = ['feedfacecafebeef', 'acme-finetune-7', 'acmetool', 'acme-flag', 'janedoe-notes', 'acme-private-mcp', 'acme-skill', '2026-11-04T10:11:12.123Z', 'deadbeefdeadbeefdeadbeefdeadbeef', 'cafebabecafebabecafebabecafebabe', '5555555555555a5a'];
const FIRST_ERROR = [...ERROR_CODES][0] ?? 'other';
const WEEK_OF_PLANTED_DAY = '2026-11-02';

/** The deposit of a person whose session holds a value of every class t1069 found: ids, hashes, free-text names, exact times, an off-list model, and a digest. */
const richSkeleton = (id: string): unknown => {
  const skeleton = JSON.parse(JSON.stringify(sampleSkeleton(id)));
  const [transcript] = skeleton.transcripts;
  const frame = { ...transcript.frame, day: '2026-11-04', repoKey: 'feedfacecafebeef', hour: 13, reach: { filled: true, mcp: ['github', 'acme-private-mcp'], skills: ['acme-skill'], plugins: ['acme-plugin'] } };
  transcript.frame = frame;
  transcript.frames = [{ ...frame, model: 'acme-finetune-7' }];
  transcript.prompts[0].frame = { ...transcript.prompts[0].frame, day: '2026-11-04' };
  transcript.tools.push(...Array.from({ length: 50 }, () => structuredClone(transcript.tools[1])));
  const [call] = transcript.tools;
  Object.assign(call, { status: 'error', errorCode: FIRST_ERROR, durationMs: 1234, keys: ['file_path', 'acme_secret_key'], names: [{ kind: 'file', name: 'janedoe-notes' }], templates: ['acmetool deploy'], digests: [{ old: 'deadbeefdeadbeefdeadbeefdeadbeef', new: 'cafebabecafebabecafebabecafebabe' }] });
  call.steps[0].identity = { program: 'acmetool', sub: 'deploy', flags: ['--acme-flag'] };
  call.steps[0].status = 'error';
  skeleton.timingPrint = '5555555555555a5a';
  skeleton.recommendations = [{ id: 'feedfacecafebeef', arm: 'shown', poolVersion: '2026-11-04T10:11:12.123Z', from: 0, to: 1 }];
  return skeleton;
};

type Leaf = { path: string; key: string; value: unknown };

/** Every leaf of a JSON value with its path and the key it sits under (an array item sits under its array's key). */
const leavesOf = (value: unknown, path = '$', key = ''): Leaf[] => {
  if (Array.isArray(value)) return value.flatMap((item, at) => leavesOf(item, `${path}[${String(at)}]`, key));
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([name, item]) => leavesOf(item, `${path}.${name}`, name));
  return [{ path, key, value }];
};

const isMonday = (value: unknown): boolean => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && new Date(`${value}T00:00:00Z`).getUTCDay() === 1;
const gated = (field: string) => (value: unknown): boolean => typeof value === 'string' && (value === 'other' || isListed(field, value));
const tag = (value: unknown): boolean => typeof value === 'string' && /^[A-Za-z0-9<>.+_-]{1,32}$/.test(value);

/** The one allow list: a kept leaf is a number or boolean (a bucket, an ordinal, a flag), null, or a string under a key named here whose value passes its check. Any other key is a leaf the erasure should have dropped. */
const ALLOWED: { readonly [key: string]: (value: unknown) => boolean } = {
  erased: (value) => value === 'lawful-request',
  vocabVersion: tag, harness: tag, harnessVersion: gated('harnessVersion'), model: gated('model'), effort: tag, day: isMonday, platform: tag, shell: tag, languages: tag, frameworks: tag, size: tag, language: tag, languageShare: tag,
  mcp: gated('mcp'), skills: gated('skills'), plugins: (value) => value === 'other', orgSize: tag, team: tag, repoVisibility: tag, cls: tag, intervention: tag, status: tag,
  errorCode: (value) => typeof value === 'string' && ERROR_CODES.has(value), next: tag, action: tag, native: tag, targetClass: tag, argClass: tag, key: gated('key'), enumValue: tag, valueSize: tag, pathDepth: tag, extension: tag, dirKind: tag, patternFeatures: tag, changeKind: tag, diffShape: tag,
  program: gated('program'), sub: tag, flags: gated('flags'), target: tag, server: gated('server'), tool: tag, skill: gated('skill'), agentType: tag, kind: tag, deltaKind: tag, field: tag, name: gated('name'), registry: tag, metric: tag, arm: tag, hostClass: tag, launcher: tag,
  keys: gated('key'),
};

/** The paths of every kept leaf that is not on the allow list, each with why. */
const offList = (value: unknown): string[] =>
  leavesOf(value).flatMap(({ path, key, value: leaf }) => {
    if (leaf === null || typeof leaf === 'number' || typeof leaf === 'boolean') return [];
    const check = ALLOWED[key];
    if (check === undefined) return [`${path}: no allow-list entry for ${key}`];
    return check(leaf) ? [] : [`${path}: ${String(leaf)} fails the ${key} check`];
  });

const randomHex = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const mondayMidnight = (value: unknown): boolean => typeof value === 'number' && value % 86_400_000 === 0 && isMonday(new Date(value).toISOString().slice(0, 10));
/** The allow list of the deposit row's own columns (`skeleton` is walked on its own): every column a kept row may hold, with what its value may be. A new column fails until it is named here. */
const COLUMNS: { readonly [column: string]: (value: unknown) => boolean } = {
  account: (value) => typeof value === 'string' && /^erased:[0-9a-f]{32}$/.test(value),
  id: randomHex, machine: (value) => value === null || randomHex(value), ingest: randomHex,
  skeleton: () => true, extensions: (value) => value === '[]', deltas: (value) => value === '[]', erased_on: (value) => value === null,
  tier: tag, vocab_version: tag, host_class: tag, launcher: tag, claimed_host_class: (value) => value === null || tag(value), claimed_launcher: (value) => value === null || tag(value),
  counted_at: mondayMidnight, format: (value) => typeof value === 'number', fields_version: (value) => typeof value === 'number', other_values: (value) => typeof value === 'number',
};

/** Every column of a kept deposit row that is not on the allow list, named. */
const columnsOffList = (row: unknown): string[] =>
  Object.entries(typeof row === 'object' && row !== null ? row : {}).flatMap(([column, value]) => {
    const check = COLUMNS[column];
    if (check === undefined) return [`${column}: no allow-list entry`];
    return check(value) ? [] : [`${column}: ${String(value)} fails its check`];
  });

describe('an erased deposit keeps its anonymous shape', () => {
  const SESSION = '00000000000090aa';

  it('holds only closed-list, bucketed, and listed leaves, in the order it was sent, and no id, hash, name, or exact time', async () => {
    const { token, account } = await member();
    const posted = await pool.post('/v1/deposits', richSkeleton(SESSION), token);
    expect(posted.status).toBe(201);
    const before = String(fieldOf((await all('SELECT skeleton FROM deposits WHERE account = ? AND id = ?', account, SESSION))[0], 'skeleton'));
    for (const planted of PLANTED) expect(before, `the fixture holds ${planted}`).toContain(planted);
    // A time that is not a Monday at midnight: the erasure must cut it to the Monday of its week (Wednesday 14 October 2026 to Monday 12 October).
    await (await pool.db()).prepare('UPDATE deposits SET counted_at = ? WHERE account = ? AND id = ?').bind(Date.UTC(2026, 9, 14, 9, 8, 7, 123), account, SESSION).run();
    await eraseAccount(await store(), account, NOW);

    const kept = await all('SELECT * FROM deposits WHERE counted_at = ?', Date.UTC(2026, 9, 12));
    expect(kept.length).toBe(1);
    for (const row of kept) {
      expect(columnsOffList(row)).toEqual([]);
      const skeleton: unknown = JSON.parse(textOf(row, 'skeleton'));
      expect(offList(skeleton)).toEqual([]);
      expect(JSON.stringify(row)).not.toContain(SESSION);
      for (const planted of PLANTED) expect(JSON.stringify(row), `the kept row holds ${planted}`).not.toContain(planted);
      const text = JSON.stringify(skeleton);
      expect(text).toContain(WEEK_OF_PLANTED_DAY);
      expect(text).not.toContain('2026-11-04');
      expect(text).toContain('git');
    }
  }, 60_000);
});

describe('anonymizing a skeleton', () => {
  it('cuts a day to the Monday of its ISO week (UTC)', () => {
    expect([null, '2026-11-02', '2026-11-04', '2026-11-08', '2026-11-09', '2026-01-01'].map(weekOf)).toEqual([null, '2026-11-02', '2026-11-02', '2026-11-02', '2026-11-09', '2025-12-29']);
  });

  it('turns an off-list model, harness version, program, flag, mcp server, and skill into other, and keeps the listed ones', () => {
    const kept = JSON.stringify(anonymizeSkeleton(richSkeleton('00000000000091aa'), 'lawful-request'));
    for (const planted of PLANTED) expect(kept).not.toContain(planted);
    expect(kept).toContain('"model":"claude-opus-5-5"');
    expect(kept).toContain('"model":"other"');
    expect(kept).toContain('"program":"other"');
    expect(kept).toContain('"mcp":["github","other"]');
    expect(kept).toContain('"skills":["other"]');
    expect(kept).toContain('"flags":["other"]');
    expect(kept).toContain('"erased":"lawful-request"');
  });

  it('is null for text that is no skeleton, and a lawful erasure then keeps the marker alone, as it does for text that is no JSON', async () => {
    expect(anonymizeSkeleton({ format: 7 }, 'lawful-request')).toBeNull();
    const { token, account } = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000092aa'), token)).status).toBe(201);
    expect((await pool.post('/v1/deposits', skeletonWith('00000000000092ab'), token)).status).toBe(201);
    const db = await pool.db();
    await db.prepare("UPDATE deposits SET skeleton = '{\"format\":7}' WHERE account = ? AND id = '00000000000092aa'").bind(account).run();
    await db.prepare("UPDATE deposits SET skeleton = 'not json' WHERE account = ? AND id = '00000000000092ab'").bind(account).run();
    await eraseAccount(await store(), account, NOW);
    expect(await all("SELECT skeleton FROM deposits WHERE account LIKE 'erased:%' AND skeleton = ?", '{"erased":"lawful-request"}')).toEqual(expect.arrayContaining([{ skeleton: '{"erased":"lawful-request"}' }]));
    expect((await all("SELECT skeleton FROM deposits WHERE account LIKE 'erased:%' AND skeleton = ?", '{"erased":"lawful-request"}')).length).toBeGreaterThanOrEqual(2);
  });
});
