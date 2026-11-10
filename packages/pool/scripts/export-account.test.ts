// The operator's export (`erase export`): the pages the route gives a signed-in account and the files the script writes for the same account are one thing, built by one function.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptanceOf, fieldOf, startPool, stubUser, textOf, type TestPool } from '../src/test-pool.js';
import { eraseRawObject } from './erase.js';
import { storeOf } from './erase-test-store.js';
import { exportAccount, type ExportFolder } from './export-account.js';

let pool: TestPool;
let next = 9100;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const grant = { 'oars-redaction-version': '1', 'oars-capture-version': 'cap-1', 'oars-raw-consent': 'granted', 'oars-raw-consent-version': 'v1' };
const NOW = new Date('2026-11-10T12:00:00Z');

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const store = async () => storeOf(await pool.db(), await pool.rawBucket(), await pool.bucket());

/** A folder in memory: each file's bytes by its name under the folder. */
const memory = (): { folder: ExportFolder; files: Map<string, Buffer> } => {
  const files = new Map<string, Buffer>();
  return {
    files,
    folder: {
      write: async (name, content) => {
        if (typeof content === 'string') files.set(name, Buffer.from(content, 'utf8'));
        else {
          const chunks: Buffer[] = [];
          for await (const piece of content) chunks.push(Buffer.from(piece));
          files.set(name, Buffer.concat(chunks));
        }
      },
      remove: (name) => {
        files.delete(name);
        return Promise.resolve();
      },
    },
  };
};

const member = async (): Promise<{ token: string; account: string }> => {
  next += 1;
  const { token, account } = await pool.signIn('github', stubUser(String(next)));
  expect((await pool.post('/v1/covenant/accept', acceptanceOf('v1'), token)).status).toBe(200);
  return { token, account };
};

const putRaw = async (token: string, text: string): Promise<string> => {
  const bytes = Buffer.from(text);
  const hash = sha(bytes);
  expect((await pool.send(`/v1/raw/${hash}/parts/1`, { method: 'PUT', body: bytes }, token, grant)).status).toBe(200);
  expect((await pool.send(`/v1/raw/${hash}/complete`, { method: 'POST', body: JSON.stringify({ parts: 1, bytes: bytes.length }) }, token, grant)).status).toBe(201);
  return hash;
};

/** Every page the route gives the account, following its cursor to the end. */
const routePages = async (token: string): Promise<unknown[]> => {
  const pages: unknown[] = [];
  let cursor: string | null = null;
  do {
    const answered = await pool.get(cursor === null ? '/v1/account/export' : `/v1/account/export?cursor=${encodeURIComponent(cursor)}`, token);
    expect(answered.status).toBe(200);
    pages.push(answered.json);
    const following = fieldOf(answered.json, 'next');
    cursor = typeof following === 'string' ? following : null;
  } while (cursor !== null);
  return pages;
};

const pageFiles = (files: Map<string, Buffer>): string[] => [...files.keys()].filter((name) => name.startsWith('account-export-')).sort();

/** Gives an account rows in the tables the export reads, enough deposits that they run past one page. */
const seed = async (account: string, tag: string, deposits: number): Promise<void> => {
  const db = await pool.db();
  for (let n = 1; n <= deposits; n += 1) {
    await db
      .prepare("INSERT INTO deposits (account, id, skeleton, tier, counted_at, format, vocab_version, fields_version, extensions, other_values, deltas, ingest) VALUES (?, ?, ?, 'skeleton', ?, 2, 'vocab-1', 3, '[]', 0, '[]', ?)")
      .bind(account, `${tag}-s${String(n)}`, JSON.stringify({ id: `${tag}-s${String(n)}`, harness: 'claude-code' }), 1_700_000_000_000 + n, `ingest-${tag}-${String(n)}`)
      .run();
  }
  await db.prepare('INSERT INTO account_repo_keys (account, repo_key) VALUES (?, ?)').bind(account, `repo-${tag}`).run();
  await db.prepare('INSERT INTO deposit_hours (account, day, hour) VALUES (?, ?, ?)').bind(account, '2026-11-01', 9).run();
  await db.prepare('INSERT INTO deposit_parts (account, batch, part, count, body, deposit, staged_at) VALUES (?, ?, 0, 3, ?, ?, 1700000400000)').bind(account, `batch-${tag}`, `body-${tag}`, `${tag}-s1`).run();
  await db.prepare("INSERT INTO erasure_audit (kind, reason, erased_on, rows_erased, objects_erased, account) VALUES ('account', ?, '2026-11-03', 4, 2, ?)").bind(`reason-${tag}`, account).run();
};

describe('erase export', () => {
  it('writes the pages the route gives the account, file for file, and nothing of another account', async () => {
    const mine = await member();
    const theirs = await member();
    await pool.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label: 'my box', allowRepos: ['acme/api'] }, mine.token);
    // Twelve deposits run past the ten a deposit page holds, so the cursor is followed across a section.
    await seed(mine.account, 'mine', 12);
    await seed(theirs.account, 'theirs', 3);
    await putRaw(mine.token, 'my transcript');
    await putRaw(theirs.token, 'their transcript');

    const expected = await routePages(mine.token);
    expect(expected.length).toBeGreaterThan(8);
    const out = memory();
    const done = await exportAccount(await store(), out.folder, mine.account, false);

    expect(done).toEqual({ pages: expected.length, rawObjects: 0, rawErased: 0, failed: [] });
    expect(pageFiles(out.files)).toEqual(expected.map((_, at) => `account-export-${String(at + 1).padStart(4, '0')}.json`));
    expect(pageFiles(out.files).map((name) => JSON.parse(out.files.get(name)?.toString('utf8') ?? 'null'))).toEqual(expected);
    // The same text the client writes: two-space JSON and a final newline.
    expect(out.files.get('account-export-0001.json')?.toString('utf8')).toBe(`${JSON.stringify(expected[0], null, 2)}\n`);
    // Without --raw nothing but pages is written, and nothing of the other account is in any of them.
    expect([...out.files.keys()].every((name) => name.startsWith('account-export-'))).toBe(true);
    const everything = [...out.files.values()].map((bytes) => bytes.toString('utf8')).join('');
    expect(everything).not.toContain(theirs.account);
    expect(everything).not.toContain('theirs');
  }, 60_000);

  it('with raw, writes each object not erased, byte for byte, and none that was, and none of another account', async () => {
    const mine = await member();
    const theirs = await member();
    const kept = await putRaw(mine.token, 'a transcript that stays');
    const gone = await putRaw(mine.token, 'a transcript that was erased');
    const other = await putRaw(theirs.token, 'someone else\'s transcript');
    await eraseRawObject(await store(), `raw/${mine.account}/${gone}`, NOW);

    const out = memory();
    const done = await exportAccount(await store(), out.folder, mine.account, true);

    expect(done).toMatchObject({ rawObjects: 1, rawErased: 1, failed: [] });
    expect([...out.files.keys()].filter((name) => name.startsWith('raw/'))).toEqual([`raw/${kept}`]);
    expect(out.files.get(`raw/${kept}`)?.toString('utf8')).toBe('a transcript that stays');
    expect(out.files.has(`raw/${gone}`)).toBe(false);
    expect(out.files.has(`raw/${other}`)).toBe(false);
    // The ledger page still names the erased object, marked.
    const ledger = [...out.files.entries()].flatMap(([name, bytes]) => (name.startsWith('account-export-') ? [JSON.parse(bytes.toString('utf8'))] : [])).find((page) => textOf(page, 'section') === 'rawLedger');
    const rows = fieldOf(ledger, 'rows');
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ sha256: kept, tombstone: null }), expect.objectContaining({ sha256: gone, tombstone: '2026-11-10' })]));
  }, 60_000);

  it('names an object the ledger lists and the bucket does not hold, and one whose bytes do not hash to its name, and writes neither', async () => {
    const mine = await member();
    const held = await putRaw(mine.token, 'the bytes that were stored');
    const lost = sha(Buffer.from('never uploaded'));
    const db = await pool.db();
    await db.prepare('INSERT INTO raw_objects (account, sha256, bytes, capture_version, redaction_version, stored_at) VALUES (?, ?, 14, ?, ?, ?)').bind(mine.account, lost, 'cap-1', 'red-1', 1_700_000_100_000).run();
    // The object under `held` is swapped for other bytes, as a bucket that lost integrity would answer.
    await (await pool.rawBucket()).put(`raw/${mine.account}/${held}`, 'different bytes');

    const out = memory();
    const done = await exportAccount(await store(), out.folder, mine.account, true);

    expect(done.rawObjects).toBe(0);
    expect(done.failed).toHaveLength(2);
    expect(done.failed.join('\n')).toContain(`${lost} is not in the bucket`);
    expect(done.failed.join('\n')).toContain(`${held} does not hash to its name`);
    expect([...out.files.keys()].filter((name) => name.startsWith('raw/'))).toEqual([]);
  }, 60_000);

  it('refuses an account the pool has never seen, and a name that is not an account id, and writes nothing', async () => {
    const out = memory();
    await expect(exportAccount(await store(), out.folder, 'acct_nobody', false)).rejects.toThrow(/No account acct_nobody in the pool/);
    await expect(exportAccount(await store(), out.folder, "x' OR '1'='1", false)).rejects.toThrow(/the account/);
    expect(out.files.size).toBe(0);
  }, 60_000);
});
