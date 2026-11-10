// The operator's erasure against a local pool under Miniflare: each kind leaves a tombstone, the same content is refused when it comes back, an audit row holds no content, and the aggregates keep their counts.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sampleSkeleton } from '../src/sample.js';
import { acceptanceOf, fieldOf, startPool, stubUser, textOf, type TestBucket, type TestDb, type TestPool } from '../src/test-pool.js';
import { telemetryOf } from './erase-test-telemetry.js';
import { closeAccount, eraseAccount, eraseLeakedSecret, eraseRawObject, findRawContaining, holdsValue, type EraseStore, type RawHit } from './erase.js';

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

const member = async (): Promise<{ token: string; account: string }> => {
  next += 1;
  const { token, account } = await pool.signIn('github', stubUser(String(next)));
  expect((await pool.post('/v1/covenant/accept', acceptanceOf('v1'), token)).status).toBe(200);
  return { token, account };
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

    const erased = await eraseAccount(await store(), account, NOW);
    expect(erased.objects).toBe(1);
    // 2 deposit rows, 1 token, and the 10 links.
    expect(erased.rows).toBe(13);

    // Per-account content: both rows are markers and tombstoned, the raw object is gone and tombstoned.
    expect(await all('SELECT id, skeleton, erased_on FROM deposits WHERE account = ? ORDER BY id', account)).toEqual([
      { id: '00000000000075aa', skeleton: '{"erased":"lawful-request"}', erased_on: '2026-11-08' },
      { id: '00000000000075ab', skeleton: '{"erased":"lawful-request"}', erased_on: '2026-11-08' },
    ]);
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
    const hashes = await all('SELECT id, key_hash FROM machines WHERE account = ?', account);
    // The machine row and the account's one token.
    expect((await eraseAccount(await store(), account, NOW)).rows).toBe(2);
    expect(await all('SELECT label, allow_repos FROM machines WHERE account = ?', account)).toEqual([{ label: '[erased]', allow_repos: '[]' }]);
    expect(await all('SELECT id, key_hash FROM machines WHERE account = ?', account)).toEqual(hashes);
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
    await eraseAccount(await store(), account, NOW);
    expect(await count('SELECT COUNT(*) AS held FROM covenant_acceptances WHERE account = ?', account)).toBe(1);
    expect(await count("SELECT COUNT(*) AS held FROM erasure_tombstones WHERE reason = 'lawful-request' AND kind = 'deposit'")).toBeGreaterThan(0);
    expect(await all('SELECT sha256, bytes, erased_on FROM raw_objects WHERE account = ?', account)).toEqual([{ sha256: mine.hash, bytes: 'kept record transcript'.length, erased_on: '2026-11-08' }]);
    expect(await count('SELECT COUNT(*) AS held FROM deposits WHERE account = ? AND erased_on IS NOT NULL', account)).toBe(1);
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

/** Stages one part of a two-part deposit through `oars-part`, as the client does. The pool seals the body before it is stored, so a row of `deposit_parts` is ciphertext. */
describe('closing one account (covenant 6.1 and 7.2(a))', () => {
  const BOX = { hostClass: 'vps', launcher: 'scheduled', label: 'box' };

  it('revokes every token and machine key, records when it closed, writes one audit row, and keeps the Deposits byte for byte', async () => {
    const { token, account } = await member();
    const other = await member();
    expect((await pool.post('/v1/deposits', skeletonWith('0000000000008a01'), token)).status).toBe(201);
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

const stage = async (token: string, id: string, program: string, part: 1 | 2): Promise<number> => {
  const body = JSON.stringify(skeletonWith(id, program));
  const half = Math.floor(body.length / 2);
  const batch = createHash('sha256').update(body).digest('hex');
  return (await pool.send('/v1/deposits', { method: 'POST', body: part === 1 ? body.slice(0, half) : body.slice(half) }, token, { 'oars-part': `${String(part)}/2`, 'oars-batch': batch })).status;
};

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
