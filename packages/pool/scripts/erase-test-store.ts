// The erasure store as the tests reach it: the pool's local D1 and raw bucket, as `wrangler --local` would reach them.
import { fieldOf, type TestBucket, type TestDb } from '../src/test-pool.js';
import type { EraseStore } from './erase.js';
import { telemetryOf } from './erase-test-telemetry.js';

/** The pieces handed out one at a time, as a stream: each is made only when asked for. */
export const asyncPieces = (pieces: Iterable<Uint8Array>): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator]: () => {
    const next = pieces[Symbol.iterator]();
    return { next: () => Promise.resolve(next.next()) };
  },
});

/** The erasure store over the pool's local D1 and raw bucket, as `wrangler --local` would reach them. */
export const storeOf = (db: TestDb, bucket: TestBucket, telemetry: TestBucket, chunk = 64 * 1024): EraseStore => ({
  telemetry: telemetryOf(telemetry),
  // Two keys to a page, as the telemetry listing is, so a prefix that spans pages is read whole.
  listRaw: async (prefix) => {
    const keys: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await bucket.list({ prefix, limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      keys.push(...page.objects.map((object) => object.key));
      if (page.truncated !== true) return keys;
      cursor = page.cursor;
    }
  },
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

