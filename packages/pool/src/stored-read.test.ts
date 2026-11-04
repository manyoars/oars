// Item 4 of the stored form (t813): the bundle is read from the stored `index` cells, never from the ledger plane. These tests delete or ignore the ledger and the contributor records and
// look for any change in what is served, and count the rows a read touches.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VOCAB_VERSION } from '../../cli/src/sessions/pool-wire.js';
import { sampleSkeleton } from './sample.js';
import { storedOf } from './stored.js';
import type { PoolDb } from './http.js';
import { fieldOf, startPool, stubUser, type TestPool } from './test-pool.js';

const PATH = `/bundle/2.1.314/${VOCAB_VERSION}`;

let pool: TestPool;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const depositor = async (target: TestPool, id: string, extra = 0): Promise<string> => {
  const { token } = await target.signIn('github', stubUser(id));
  await target.post('/v1/covenant/accept', { version: 'v1' }, token);
  for (let session = 0; session <= extra; session += 1) expect((await target.post('/v1/deposits', sampleSkeleton(`${session === 0 ? '' : String(session)}${id}`.padStart(16, '0')), token)).status).toBe(201);
  return token;
};

describe('the bundle reads the stored cells', () => {
  it('serves the same bytes and ETag after the batch\'s ledger rows and contributor records are deleted', async () => {
    const own = await startPool();
    try {
      for (const id of ['7001', '7002', '7003', '7004']) await depositor(own, id);
      const token = await depositor(own, '7005');
      const before = await own.raw(PATH, token);
      expect(before.status).toBe(200);

      const db = await own.db();
      await db.prepare('DELETE FROM deposits').run();
      await db.prepare('DELETE FROM contributors').run();
      // The account now holds no ledger row, so it has no access and its cap is spent: another account takes the second fetch.
      const reader = await own.signIn('github', stubUser('7006'));
      const after = await own.raw(PATH, reader.token);
      expect(after.status).toBe(200);
      expect(after.json).toEqual(before.json);
      expect(after.headers.get('etag')).toBe(before.headers.get('etag'));
    } finally {
      await own.dispose();
    }
  }, 60_000);

  it('reads the same number of rows when the pool holds many more deposits', async () => {
    const own = await startPool();
    try {
      // The rows D1 says a read scanned, summed over the statements it makes (its returned rows when the runtime reports none).
      const reads = async (): Promise<number> => {
        const db = await own.db();
        let rows = 0;
        const counted: PoolDb = {
          prepare: (sql) => ({
            bind: (...values) => {
              const bound = db.prepare(sql).bind(...values);
              return {
                first: () => bound.first(),
                all: async () => {
                  const answered = await bound.all();
                  const read = fieldOf(fieldOf(answered, 'meta'), 'rows_read');
                  rows += typeof read === 'number' ? read : answered.results.length;
                  return answered;
                },
                run: () => Promise.reject(new Error('a read writes nothing')),
              };
            },
          }),
          batch: () => Promise.reject(new Error('a read writes nothing')),
        };
        await storedOf({ DB: counted }, '2.1.314');
        return rows;
      };
      for (const id of ['7101', '7102', '7103', '7104', '7105']) await depositor(own, id);
      const small = await reads();
      expect(small).toBeGreaterThan(0);
      // Ten more accounts and three more sessions each: the same cells, many more ledger rows and contributor records.
      for (const id of ['7106', '7107', '7108', '7109', '7110', '7111', '7112', '7113', '7114', '7115']) await depositor(own, id, 3);
      expect(await (await own.db()).prepare('SELECT COUNT(*) AS count FROM deposits').first('count')).toBeGreaterThan(30);
      expect(await reads()).toBe(small);
    } finally {
      await own.dispose();
    }
  }, 120_000);
});
