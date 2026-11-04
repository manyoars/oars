// The stored form: the bundle is read from the stored `index` cells, never from the ledger plane. These tests rewrite or ignore the ledger and the contributor records (the ledger takes no delete: a trigger aborts it) and
// look for any change in what is served, and count the rows a read touches.
import { webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyBundle, VOCAB_VERSION } from '../../cli/src/sessions/pool-wire.js';
import { sampleSkeleton } from './sample.js';
import { EARLIEST_COUNTED } from './access.js';
import type { Harness } from '../../cli/src/sessions/schema.js';
import { fetchBundle, WEEK_RESET } from './bundle.js';
import { ENVIRONMENT_CELLS } from './stored.js';
import type { PoolDb } from './http.js';
import { fieldOf, startPool, stubUser, type TestPool } from './test-pool.js';

const PATH = `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`;

let pool: TestPool;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const depositor = async (target: TestPool, id: string, extra = 0, harness: Harness = 'claude-code'): Promise<string> => {
  const { token } = await target.signIn('github', stubUser(id));
  await target.post('/v1/covenant/accept', { version: 'v1' }, token);
  for (let session = 0; session <= extra; session += 1) expect((await target.post('/v1/deposits', sampleSkeleton(`${session === 0 ? '' : String(session)}${id}`.padStart(16, '0'), undefined, '2026-11-01', harness), token)).status).toBe(201);
  return token;
};

describe('the bundle reads the stored cells', () => {
  it('serves the same bytes and ETag after the batch\'s ledger rows and contributor records are rewritten', async () => {
    const own = await startPool();
    try {
      for (const id of ['7001', '7002', '7003', '7004']) await depositor(own, id);
      const token = await depositor(own, '7005');
      const before = await own.raw(PATH, token);
      expect(before.status).toBe(200);
      // Served something, or an empty bundle before and after would pass this test for nothing.
      const verified = await verifyBundle(before.json, own.signingKey(), 'claude-code', '2.1.314');
      if (!verified.ok) throw new Error(verified.reason);
      expect(verified.bundle.cells.length).toBeGreaterThan(0);
      expect(verified.bundle.reads.length).toBeGreaterThan(0);

      const db = await own.db();
      await db.prepare("UPDATE deposits SET skeleton = '{}'").run();
      await db.prepare("UPDATE contributors SET day = '2000-01-01'").run();
      // The ledger no longer holds the batch, and another account takes the second fetch, so the read does not lean on the first account's rows.
      const reader = await own.signIn('github', stubUser('7006'));
      const after = await own.raw(PATH, reader.token);
      expect(after.status).toBe(200);
      expect(after.json).toEqual(before.json);
      expect(after.headers.get('etag')).toBe(before.headers.get('etag'));
    } finally {
      await own.dispose();
    }
  }, 60_000);

  it('a whole fetch reads the same number of rows when the pool holds many more deposits and accounts', async () => {
    const own = await startPool();
    try {
      const signing = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      if (!('privateKey' in signing)) throw new Error('no key pair');
      const BUNDLE_SIGNING_KEY = JSON.stringify(await webcrypto.subtle.exportKey('jwk', signing.privateKey));
      // The rows D1 says each statement of a fetch scanned, summed over `first`, `all`, and `run` (a statement's returned rows when the runtime reports none).
      const rowsOf = (answered: unknown): number => {
        const read = fieldOf(fieldOf(answered, 'meta'), 'rows_read');
        const results = fieldOf(answered, 'results');
        return typeof read === 'number' ? read : Array.isArray(results) ? results.length : 0;
      };
      const fetched = async (token: string): Promise<{ status: number; rows: number }> => {
        const db = await own.db();
        let rows = 0;
        const counted: PoolDb = {
          prepare: (sql) => ({
            bind: (...values) => {
              const bound = db.prepare(sql).bind(...values);
              return {
                first: async () => {
                  const answered = await bound.all();
                  rows += rowsOf(answered);
                  return answered.results[0] ?? null;
                },
                all: async () => {
                  const answered = await bound.all();
                  rows += rowsOf(answered);
                  return answered;
                },
                run: async () => {
                  const done = await bound.run();
                  rows += rowsOf(done);
                  const changes = fieldOf(fieldOf(done, 'meta'), 'changes');
                  return { meta: { changes: typeof changes === 'number' ? changes : 0 } };
                },
              };
            },
          }),
          batch: () => Promise.reject(new Error('a read writes nothing')),
        };
        const answered = await fetchBundle(new Request('https://pool.test/bundle', { headers: { authorization: `Bearer ${token}` } }), { DB: counted, BUNDLE_SIGNING_KEY, FETCH_CAP: '1000' }, 'claude-code', '2.1.314', VOCAB_VERSION);
        return { status: answered.status, rows };
      };
      for (const id of ['7101', '7102', '7103', '7104']) await depositor(own, id);
      // One account with a ledger row (its access is read from it) and one with none (its cap is spent, and the week's reset runs).
      const holder = await depositor(own, '7105');
      const bare = (await own.signIn('github', stubUser('7106'))).token;
      // Every account's batches here count toward access (a claude-code batch at committed, a cursor batch at skeleton), so its ledger rows carry a `counted_at` that the `deposits_counted` index holds; the first fetch writes its flag, so measure the second (the holder's batches count too).
      const counting = await depositor(own, '7122', 0, 'cursor');
      await fetched(holder);
      await fetched(counting);
      const small = { holder: await fetched(holder), bare: await fetched(bare), counting: await fetched(counting) };
      expect(small.holder.status).toBe(200);
      expect(small.bare.status).toBe(200);
      expect(small.counting.status).toBe(200);
      expect(small.holder.rows).toBeGreaterThan(0);
      expect(small.bare.rows).toBeGreaterThan(0);
      expect(small.counting.rows).toBeGreaterThan(0);
      // The fetching account's own ledger grows, and so do the other accounts and their rows: the same cells, many more ledger rows, contributor records, and accounts.
      for (let session = 1; session <= 6; session += 1) expect((await own.post('/v1/deposits', sampleSkeleton(`${String(session)}7105`.padStart(16, '0')), holder)).status).toBe(201);
      for (let session = 1; session <= 6; session += 1) expect((await own.post('/v1/deposits', sampleSkeleton(`${String(session)}7122`.padStart(16, '0'), undefined, '2026-11-01', 'cursor'), counting)).status).toBe(201);
      expect(await (await own.db()).prepare("SELECT COUNT(*) AS count FROM deposits WHERE counted_at IS NOT NULL").first('count')).toBe(18);
      for (const id of ['7107', '7108', '7109', '7110', '7111', '7112', '7113', '7114', '7115', '7116']) await depositor(own, id, 3);
      for (const id of ['7117', '7118', '7119', '7120']) await own.signIn('github', stubUser(id));
      expect(await (await own.db()).prepare('SELECT COUNT(*) AS count FROM deposits').first('count')).toBeGreaterThan(40);
      // The week count of the bare account is spent already; a second fetch spends another, so compare a fresh bare account.
      const fresh = (await own.signIn('github', stubUser('7121'))).token;
      expect(await fetched(holder)).toEqual(small.holder);
      expect(await fetched(fresh)).toEqual(small.bare);
      expect(await fetched(counting)).toEqual(small.counting);
    } finally {
      await own.dispose();
    }
  }, 120_000);

  // An index bounds the rows a statement scans, which a count over the PoolDb cannot show: ask SQLite for the plan of the two statements a fetch runs that grow with the pool.
  it('the statements of a fetch that could scan a table use their index', async () => {
    const db = await pool.db();
    const planOf = async (sql: string, ...values: (string | number)[]): Promise<string> => {
      const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values).all();
      return results.map((row) => String(fieldOf(row, 'detail'))).join('; ');
    };
    expect(await planOf(EARLIEST_COUNTED, 'acct')).toContain('USING INDEX deposits_counted');
    expect(await planOf(WEEK_RESET, '2026-W45')).toContain('USING INDEX accounts_by_fetch_week');
    // The environment cells are found by their bucket, and the other cells of each motif through the key's index (a key starts with its motif), so no statement of the fetch scans the table.
    const environment = await planOf(ENVIRONMENT_CELLS, 'env:', 5, 5);
    expect(environment).toContain('USING INDEX cells_by_harness');
    expect(environment).toMatch(/SEARCH other USING (COVERING )?INDEX sqlite_autoindex_cells_1/);
    expect(environment).not.toContain('SCAN other');
  });
});
