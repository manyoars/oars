// A signed-in person's copy of what the pool holds about their account (GDPR Articles 15(3) and 20): `GET /v1/account/export`, paged, and `GET /v1/account/export/raw/:hash`, one raw object of their own. Both read and write nothing.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptanceOf, fieldOf, startPool, stubUser, textOf, type TestDb, type TestPool } from './test-pool.js';

let pool: TestPool;
let db: TestDb;

beforeAll(async () => {
  pool = await startPool();
  db = await pool.db();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Page {
  format: string;
  version: number;
  account: string;
  section: string;
  rows: readonly unknown[];
  next: string | null;
}

const pageOf = (json: unknown): Page => {
  const rows = fieldOf(json, 'rows');
  const next = fieldOf(json, 'next');
  return {
    format: textOf(json, 'format'),
    version: Number(fieldOf(json, 'version')),
    account: textOf(json, 'account'),
    section: textOf(json, 'section'),
    rows: Array.isArray(rows) ? rows : [],
    next: typeof next === 'string' ? next : null,
  };
};

/** Every page of an export in order, following the cursor until it ends. */
const everyPage = async (token: string, limit?: number): Promise<Page[]> => {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    const query: string = [limit === undefined ? '' : `limit=${String(limit)}`, cursor === null ? '' : `cursor=${encodeURIComponent(cursor)}`].filter((part) => part !== '').join('&');
    const answered = await pool.get(`/v1/account/export${query === '' ? '' : `?${query}`}`, token);
    expect(answered.status).toBe(200);
    const page = pageOf(answered.json);
    pages.push(page);
    cursor = page.next;
  } while (cursor !== null);
  return pages;
};

/** The rows of one section across every page. */
const rowsOf = (pages: readonly Page[], section: string): unknown[] => pages.filter((page) => page.section === section).flatMap((page) => [...page.rows]);

const skeleton = (id: string): string => JSON.stringify({ id, harness: 'claude-code' });

/** Gives an account a row in every table the export reads. */
const seed = async (account: string, tag: string): Promise<void> => {
  for (const n of [1, 2, 3]) {
    await db
      .prepare("INSERT INTO deposits (account, id, skeleton, tier, counted_at, format, vocab_version, fields_version, extensions, other_values, deltas, ingest) VALUES (?, ?, ?, 'skeleton', ?, 2, 'vocab-1', 3, '[]', 0, '[]', ?)")
      .bind(account, `${tag}-s${String(n)}`, skeleton(`${tag}-s${String(n)}`), 1_700_000_000_000 + n, `ingest-${tag}-${String(n)}`)
      .run();
  }
  // One deposit carries the provenance migration 0025 stamps: the machine that sent it, its class and launcher, and what the batch claimed.
  await db.prepare("UPDATE deposits SET machine = ?, host_class = 'vps', launcher = 'scheduled', claimed_host_class = 'cloud', claimed_launcher = 'cron' WHERE account = ? AND id = ?").bind(`machine-${tag}`, account, `${tag}-s1`).run();
  await db.prepare("INSERT INTO deposits (account, id, skeleton, tier, extensions, deltas, erased_on) VALUES (?, ?, ?, 'skeleton', '[]', '[]', '2026-11-01')").bind(account, `${tag}-gone`, '{"erased":"lawful-request"}').run();
  await db.prepare('INSERT INTO raw_objects (account, sha256, bytes, capture_version, redaction_version, stored_at) VALUES (?, ?, 11, ?, ?, ?)').bind(account, sha256(`${tag}-held`), 'cap-1', 'red-1', 1_700_000_100_000).run();
  await db.prepare('INSERT INTO raw_objects (account, sha256, bytes, capture_version, redaction_version, stored_at, erased_on) VALUES (?, ?, 7, ?, ?, ?, ?)').bind(account, sha256(`${tag}-erased`), 'cap-1', 'red-1', 1_700_000_200_000, '2026-11-02').run();
  await db.prepare('INSERT INTO account_repo_keys (account, repo_key) VALUES (?, ?)').bind(account, `repo-${tag}`).run();
  await db.prepare('INSERT INTO deposit_hours (account, day, hour) VALUES (?, ?, ?)').bind(account, '2026-11-01', 9).run();
  await db.prepare('INSERT INTO deposit_hours (account, day, hour) VALUES (?, ?, ?)').bind(account, '2026-11-01', 14).run();
  await db.prepare('INSERT INTO telemetry_install_days (day, install, account, batches, events, measures) VALUES (?, ?, ?, 2, 5, ?)').bind('2026-11-01', `install-${tag}`, account, '{"a":1}').run();
  await db.prepare('INSERT INTO deposit_parts (account, batch, part, count, body, deposit, staged_at) VALUES (?, ?, 0, 3, ?, ?, 1700000400000)').bind(account, `batch-${tag}`, `body-${tag}`, `${tag}-s1`).run();
  await db.prepare("INSERT INTO erasure_audit (kind, reason, erased_on, rows_erased, objects_erased, account) VALUES ('account', ?, '2026-11-03', 4, 2, ?)").bind(`reason-${tag}`, account).run();
};

describe('GET /v1/account/export', () => {
  it('refuses a caller with no sign-in and one with a credential the pool does not know', async () => {
    expect((await pool.get('/v1/account/export')).status).toBe(401);
    expect((await pool.get('/v1/account/export', 'not-a-token')).status).toBe(401);
  });

  it('states its format and version on every page, and names the account', async () => {
    const { token, account } = await pool.signIn('github', stubUser('5401'));
    const pages = await everyPage(token);
    for (const page of pages) expect(page).toMatchObject({ format: 'oars-pool-account-export', version: 1, account });
  });

  it('returns every table the pool keeps about the account, and nothing of another account, with no credential material', async () => {
    const mine = await pool.signIn('github', stubUser('5402'));
    const theirs = await pool.signIn('github', stubUser('5403'));
    expect((await pool.post('/v1/covenant/accept', acceptanceOf('v1'), mine.token)).status).toBe(200);
    expect((await pool.post('/v1/covenant/accept', acceptanceOf('v1'), theirs.token)).status).toBe(200);
    const enrolled = await pool.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label: 'my box', allowRepos: ['acme/api'] }, mine.token);
    await pool.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label: 'their box' }, theirs.token);
    await db.prepare('UPDATE accounts SET raw_consent = ?, raw_consent_version = ?, raw_consent_withdrawn_at = ?, raw_consent_withdrawn_version = ? WHERE id = ?').bind(1_700_000_300_000, 'v2', 1_700_000_350_000, 'v1', mine.account).run();
    await db.prepare('UPDATE machines SET last_deposit_day = ?, key_days = ? WHERE account = ?').bind('2026-11-05', 30, mine.account).run();
    await seed(mine.account, 'mine');
    await seed(theirs.account, 'theirs');

    const pages = await everyPage(mine.token);
    const text = JSON.stringify(pages);
    expect(text).not.toContain('theirs');
    expect(text).not.toContain(theirs.account);
    expect(text).not.toContain(mine.token);
    expect(text).not.toContain(sha256(mine.token));
    expect(text).not.toContain(textOf(enrolled.json, 'token'));
    expect(text).not.toContain(sha256(textOf(enrolled.json, 'token')));

    expect(rowsOf(pages, 'account')).toEqual([expect.objectContaining({ id: mine.account, rawConsent: 1_700_000_300_000, rawConsentVersion: 'v2', rawConsentWithdrawnAt: 1_700_000_350_000, rawConsentWithdrawnVersion: 'v1', access: 'standing' })]);
    expect(rowsOf(pages, 'covenant')).toEqual([expect.objectContaining({ version: 'v1', textSha256: acceptanceOf('v1').textSha256, input: acceptanceOf('v1').input, client: acceptanceOf('v1').client })]);
    expect(rowsOf(pages, 'machines')).toEqual([expect.objectContaining({ id: textOf(fieldOf(enrolled.json, 'machine'), 'id'), label: 'my box', hostClass: 'vps', launcher: 'scheduled', allowRepos: ['acme/api'], state: 'pending', lastDepositDay: '2026-11-05', keyDays: 30 })]);
    expect(rowsOf(pages, 'repoKeys')).toEqual([{ repoKey: 'repo-mine' }]);
    expect(rowsOf(pages, 'depositHours')).toEqual([
      { day: '2026-11-01', hour: 9 },
      { day: '2026-11-01', hour: 14 },
    ]);
    expect(rowsOf(pages, 'telemetry')).toEqual([{ day: '2026-11-01', install: 'install-mine', batches: 2, events: 5, measures: { a: 1 } }]);
    expect(rowsOf(pages, 'depositParts')).toEqual([{ batch: 'batch-mine', part: 0, count: 3, stagedAt: 1_700_000_400_000, deposit: 'mine-s1', body: 'body-mine' }]);
    expect(rowsOf(pages, 'erasures')).toEqual([{ kind: 'account', reason: 'reason-mine', erasedOn: '2026-11-03', rowsErased: 4, objectsErased: 2 }]);
    // The ledger lists the held object and the tombstoned one, each by the key it is stored under.
    expect(rowsOf(pages, 'rawLedger')).toEqual(
      expect.arrayContaining([
        { key: `raw/${mine.account}/${sha256('mine-held')}`, sha256: sha256('mine-held'), bytes: 11, captureVersion: 'cap-1', redactionVersion: 'red-1', storedAt: 1_700_000_100_000, tombstone: null },
        { key: `raw/${mine.account}/${sha256('mine-erased')}`, sha256: sha256('mine-erased'), bytes: 7, captureVersion: 'cap-1', redactionVersion: 'red-1', storedAt: 1_700_000_200_000, tombstone: '2026-11-02' },
      ]),
    );
    expect(rowsOf(pages, 'rawLedger')).toHaveLength(2);
    // Token metadata is a count of when each credential ends, never the credential or its hash.
    const tokens = rowsOf(pages, 'tokens');
    expect(tokens).toHaveLength(1);
    for (const row of tokens) expect(Object.keys(row === null || typeof row !== 'object' ? {} : row).sort()).toEqual(['expiresAt']);
    // Deposits come as stored, the erased one as it now reads, marked.
    const deposits = rowsOf(pages, 'deposits');
    expect(deposits).toHaveLength(4);
    expect(deposits).toContainEqual({ id: 'mine-s1', tier: 'skeleton', countedAt: 1_700_000_000_001, format: 2, vocabVersion: 'vocab-1', fieldsVersion: 3, extensions: [], otherValues: 0, deltas: [], ingest: 'ingest-mine-1', skeleton: { id: 'mine-s1', harness: 'claude-code' }, tombstone: null, machine: 'machine-mine', hostClass: 'vps', launcher: 'scheduled', claimedHostClass: 'cloud', claimedLauncher: 'cron' });
    expect(deposits).toContainEqual(expect.objectContaining({ id: 'mine-gone', skeleton: { erased: 'lawful-request' }, tombstone: '2026-11-01' }));
  }, 60_000);

  it('pages every row once, in order, across sections and within one', async () => {
    const { token, account } = await pool.signIn('github', stubUser('5404'));
    await seed(account, 'paged');
    const whole = await everyPage(token);
    const small = await everyPage(token, 1);
    expect(small.length).toBeGreaterThan(whole.length);
    // Page by page, every section reads the same rows as the whole read, none twice and none missing.
    for (const section of new Set(whole.map((page) => page.section))) expect(rowsOf(small, section), section).toEqual(rowsOf(whole, section));
    const ids = rowsOf(small, 'deposits').map((row) => textOf(row, 'id'));
    expect(ids).toEqual(['paged-gone', 'paged-s1', 'paged-s2', 'paged-s3']);
    // No page holds more rows than asked.
    for (const page of small) expect(page.rows.length).toBeLessThanOrEqual(1);
    // The last page ends the cursor.
    expect(small.at(-1)?.next).toBeNull();
  }, 60_000);

  it('holds a deposits page to 10 rows however many are asked for, and the cursor yields the rest', async () => {
    const { token, account } = await pool.signIn('github', stubUser('5410'));
    for (let n = 1; n <= 11; n += 1) {
      const id = `cap-${String(n).padStart(2, '0')}`;
      await db.prepare("INSERT INTO deposits (account, id, skeleton, tier, extensions, deltas) VALUES (?, ?, ?, 'skeleton', '[]', '[]')").bind(account, id, skeleton(id)).run();
    }
    // Asking for 1000 still gets the 10-deposit cap, and the 11th waits behind the cursor.
    for (const limit of [undefined, 1000]) {
      const pages = (await everyPage(token, limit)).filter((page) => page.section === 'deposits');
      expect(pages.map((page) => page.rows.length), String(limit)).toEqual([10, 1]);
      expect(pages[0]?.next, String(limit)).not.toBeNull();
      expect(rowsOf(pages, 'deposits').map((row) => textOf(row, 'id')), String(limit)).toHaveLength(11);
      expect(pages[1]?.rows.map((row) => textOf(row, 'id')), String(limit)).toEqual(['cap-11']);
    }
  }, 60_000);

  it('answers an account with nothing held as a short export and not an error', async () => {
    const { token, account } = await pool.signIn('github', stubUser('5405'));
    const pages = await everyPage(token);
    expect(rowsOf(pages, 'account')).toEqual([expect.objectContaining({ id: account })]);
    expect(rowsOf(pages, 'deposits')).toEqual([]);
  });

  it.each([['limit=0'], ['limit=-1'], ['limit=abc'], ['limit=1.5'], ['cursor=%%%'], ['cursor=bm90IGpzb24'], [`cursor=${Buffer.from(JSON.stringify({ s: 'nope', a: [] })).toString('base64url')}`], [`cursor=${Buffer.from(JSON.stringify({ s: 'deposits', a: [1, 2] })).toString('base64url')}`]])('refuses %s by name', async (query) => {
    const { token } = await pool.signIn('github', stubUser('5406'));
    const answered = await pool.get(`/v1/account/export?${query}`, token);
    expect(answered.status).toBe(400);
    expect(fieldOf(answered.json, 'error')).toBe(query.startsWith('limit') ? 'bad_limit' : 'bad_cursor');
  });

  it('reads a cursor taken from one account as a position in the caller\'s own rows only', async () => {
    const mine = await pool.signIn('github', stubUser('5407'));
    const theirs = await pool.signIn('github', stubUser('5408'));
    await seed(mine.account, 'cmine');
    await seed(theirs.account, 'ctheirs');
    const first = pageOf((await pool.get('/v1/account/export?limit=1', theirs.token)).json);
    // The cursor is a position; the account always comes from the sign-in.
    const stolen = first.next ?? '';
    const replay = await pool.get(`/v1/account/export?limit=1&cursor=${encodeURIComponent(stolen)}`, mine.token);
    expect(replay.status).toBe(200);
    expect(JSON.stringify(replay.json)).not.toContain('ctheirs');
    expect(JSON.stringify(replay.json)).not.toContain(theirs.account);
  }, 60_000);

  it('writes nothing', async () => {
    const { token, account } = await pool.signIn('github', stubUser('5409'));
    await seed(account, 'quiet');
    const count = async (): Promise<number> => Number(fieldOf(await db.prepare('SELECT (SELECT COUNT(*) FROM tokens) + (SELECT COUNT(*) FROM deposits) + (SELECT COUNT(*) FROM raw_objects) + (SELECT COUNT(*) FROM covenant_acceptances) + (SELECT COUNT(*) FROM machines) + (SELECT COUNT(*) FROM covenant_served) + (SELECT COUNT(*) FROM accounts) + (SELECT COUNT(*) FROM deposit_parts) + (SELECT COUNT(*) FROM erasure_audit) + (SELECT COUNT(*) FROM telemetry_install_days) + (SELECT COUNT(*) FROM account_repo_keys) + (SELECT COUNT(*) FROM deposit_hours) AS n').first(), 'n'));
    const before = await count();
    await everyPage(token);
    expect(await count()).toBe(before);
  }, 60_000);

  it('answers a machine key 403 and reads no row for it', async () => {
    const { token } = await pool.signIn('github', stubUser('5411'));
    const enrolled = await pool.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label: 'box' }, token);
    const key = textOf(enrolled.json, 'token');
    const refused = await pool.get('/v1/account/export', key);
    expect(refused).toMatchObject({ status: 403, json: { error: 'deposit_only' } });
    const raw = await pool.get(`/v1/account/export/raw/${'a'.repeat(64)}`, key);
    expect(raw).toMatchObject({ status: 403, json: { error: 'deposit_only' } });
  });
});

/** The bytes of a GET, read as the Worker sends them (a raw copy is not JSON). */
const rawCopy = async (path: string, token?: string): Promise<{ status: number; bytes: Buffer; headers: Headers }> => {
  const sent = await pool.miniflare.dispatchFetch(`http://pool.test${path}`, { method: 'GET', ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }) });
  return { status: sent.status, bytes: Buffer.from(await sent.arrayBuffer()), headers: sent.headers };
};

describe('GET /v1/account/export/raw/:hash', () => {
  const put = async (account: string, text: string): Promise<string> => {
    const hash = sha256(text);
    await (await pool.rawBucket()).put(`raw/${account}/${hash}`, text);
    await db.prepare('INSERT INTO raw_objects (account, sha256, bytes, capture_version, redaction_version, stored_at) VALUES (?, ?, ?, ?, ?, ?)').bind(account, hash, Buffer.byteLength(text), 'cap-1', 'red-1', 1_700_000_000_000).run();
    return hash;
  };

  it('streams the account\'s own object byte for byte, as a download that is not cached', async () => {
    const { token, account } = await pool.signIn('github', stubUser('5421'));
    const text = 'line one\nline two\n';
    const hash = await put(account, text);
    const copy = await rawCopy(`/v1/account/export/raw/${hash}`, token);
    expect(copy.status).toBe(200);
    expect(copy.bytes.toString('utf8')).toBe(text);
    expect(copy.headers.get('content-type')).toBe('application/octet-stream');
    expect(copy.headers.get('cache-control')).toBe('private, no-store');
  });

  it('refuses a caller with no sign-in', async () => {
    const { account } = await pool.signIn('github', stubUser('5422'));
    const hash = await put(account, 'no sign-in');
    expect((await rawCopy(`/v1/account/export/raw/${hash}`)).status).toBe(401);
  });

  it('answers another account the same as an object nobody holds, and sends none of its bytes', async () => {
    const owner = await pool.signIn('github', stubUser('5423'));
    const other = await pool.signIn('github', stubUser('5424'));
    const hash = await put(owner.account, 'OWNER-ONLY-MARKER');
    const refused = await rawCopy(`/v1/account/export/raw/${hash}`, other.token);
    const nobody = await rawCopy(`/v1/account/export/raw/${'b'.repeat(64)}`, other.token);
    expect(refused.status).toBe(404);
    expect(nobody.status).toBe(404);
    expect(refused.bytes.toString('utf8')).toBe(nobody.bytes.toString('utf8'));
    expect(refused.bytes.toString('utf8')).not.toContain('OWNER-ONLY-MARKER');
  });

  it('refuses a tombstoned object, by its ledger row and by its tombstone', async () => {
    const { token, account } = await pool.signIn('github', stubUser('5425'));
    const marked = await put(account, 'marked by the ledger');
    await db.prepare("UPDATE raw_objects SET erased_on = '2026-11-02' WHERE account = ? AND sha256 = ?").bind(account, marked).run();
    const stoned = await put(account, 'marked by the tombstone');
    await db.prepare("INSERT INTO erasure_tombstones (kind, digest, reason, erased_on) VALUES ('raw-object', ?, 'lawful-request', '2026-11-02')").bind(sha256(`raw/${account}/${stoned}`)).run();
    for (const hash of [marked, stoned]) {
      const copy = await rawCopy(`/v1/account/export/raw/${hash}`, token);
      expect(copy.status, hash).toBe(410);
      expect(JSON.parse(copy.bytes.toString('utf8'))).toMatchObject({ error: 'erased' });
    }
  });

  it('answers 404 for a ledger row whose object is gone, and for a name that is not a SHA-256', async () => {
    const { token, account } = await pool.signIn('github', stubUser('5426'));
    const hash = sha256('never stored');
    await db.prepare('INSERT INTO raw_objects (account, sha256, bytes, capture_version, redaction_version, stored_at) VALUES (?, ?, 1, ?, ?, 1)').bind(account, hash, 'cap-1', 'red-1').run();
    expect((await rawCopy(`/v1/account/export/raw/${hash}`, token)).status).toBe(404);
    expect((await rawCopy('/v1/account/export/raw/not-a-hash', token)).status).toBe(404);
  });

  it('answers 503 when the pool has no raw bucket', async () => {
    const bare = await startPool({}, { raw: false });
    try {
      const { token } = await bare.signIn('github', stubUser('5427'));
      const sent = await bare.miniflare.dispatchFetch(`http://pool.test/v1/account/export/raw/${'c'.repeat(64)}`, { headers: { authorization: `Bearer ${token}` } });
      expect(sent.status).toBe(503);
    } finally {
      await bare.dispose();
    }
  }, 60_000);

  it('answers a machine key 403', async () => {
    const { token, account } = await pool.signIn('github', stubUser('5428'));
    const hash = await put(account, 'machine cannot read');
    const enrolled = await pool.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label: 'box' }, token);
    const copy = await rawCopy(`/v1/account/export/raw/${hash}`, textOf(enrolled.json, 'token'));
    expect(copy.status).toBe(403);
  });
});
