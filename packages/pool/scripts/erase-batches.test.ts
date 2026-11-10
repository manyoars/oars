// The telemetry batches of an erased account: found by their own records, rewritten with the placeholder and a fresh install id, and left alone when they name someone else, no one, or sit past retention.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fieldOf, textOf, startPool, type TestBucket, type TestDb, type TestPool } from '../src/test-pool.js';
import { eraseBatches, findBatches, rewriteKeyOf, type BatchStore, type TelemetryStore } from './erase-batches.js';
import { telemetryOf } from './erase-test-telemetry.js';
import { eraseAccount, type EraseStore } from './erase.js';

let pool: TestPool;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const NOW = new Date('2026-11-09T12:00:00Z');
const INSTALL_A = '11111111-1111-4111-8111-111111111111';
const INSTALL_B = '22222222-2222-4222-8222-222222222222';
const INSTALL_C = '33333333-3333-4333-8333-333333333333';
const INSTALL_D = '44444444-4444-4444-8444-444444444444';

const storeOf = (db: TestDb, telemetry: TelemetryStore): BatchStore => ({
  run: async (sql, binds) => Number(fieldOf(fieldOf(await db.prepare(sql).bind(...binds).run(), 'meta'), 'changes')),
  telemetry,
});

const installOf = (text: string): string => textOf(fieldOf(JSON.parse(text), 'batch'), 'install');

interface Seen {
  key: string;
  text: string;
}

const all = async (bucket: TestBucket): Promise<Seen[]> => {
  const seen: Seen[] = [];
  for (const { key } of (await bucket.list({ prefix: 'telemetry/' })).objects) seen.push({ key, text: (await (await bucket.get(key))?.text()) ?? '' });
  return seen.sort((a, b) => a.key.localeCompare(b.key));
};

const events = (n: number, tag: string): object[] => Array.from({ length: n }, (_, at) => ({ v: 1, type: 'command', at: `2026-11-0${String(at + 1)}T00:00:00Z`, cli: tag, os: 'linux', data: { path: ['sessions', 'list'], durationMs: 10 + at, exitCode: 0 } }));

const batchText = (day: string, install: string, account: string | undefined, tag: string, n = 2): string =>
  JSON.stringify({ received: `${day}T10:00:00.000Z`, ...(account === undefined ? {} : { account }), batch: { install, events: events(n, tag) } });

/** A fresh account name per test, so tests that share the pool's bucket keep to their own batches (each seeds its own keys under days only it uses). */
let nameN = 0;
const accountName = (): string => {
  nameN += 1;
  return `acct-batches-${String(nameN)}`;
};

interface Fixture {
  account: string;
  other: string;
  keys: { a1: string; a2: string; b1: string; boundary: string; other: string; anonymous: string; past: string; anonA: string; index: string };
}

/** Batches that name the account (two installs, three days, one at the edge of retention), one that names another account, one that names none, and one past retention that names the account too. */
const seed = async (bucket: TestBucket, db: TestDb): Promise<Fixture> => {
  const account = accountName();
  const other = `bystander-${account.slice(-2)}`;
  const keys = {
    a1: 'telemetry/2026-11-08/a1.json',
    a2: 'telemetry/2026-11-07/a2.json',
    b1: 'telemetry/2026-11-07/b1.json',
    boundary: 'telemetry/2026-08-11/boundary.json',
    other: 'telemetry/2026-11-08/other.json',
    anonymous: 'telemetry/2026-11-08/anonymous.json',
    past: 'telemetry/2026-08-10/past.json',
    anonA: 'telemetry/2026-11-08/a-anon.json',
    index: 'telemetry/2026-11-08/index.json',
  };
  await bucket.put(keys.a1, batchText('2026-11-08', INSTALL_A, account, 'a1'));
  await bucket.put(keys.a2, batchText('2026-11-07', INSTALL_A, account, 'a2', 1));
  await bucket.put(keys.b1, batchText('2026-11-07', INSTALL_B, account, 'b1', 3));
  await bucket.put(keys.boundary, batchText('2026-08-11', INSTALL_A, account, 'boundary'));
  await bucket.put(keys.other, batchText('2026-11-08', INSTALL_C, other, 'other'));
  await bucket.put(keys.anonymous, batchText('2026-11-08', INSTALL_D, undefined, 'anonymous'));
  await bucket.put(keys.past, batchText('2026-08-10', INSTALL_A, account, 'past'));
  // A batch of install A that names no account (sent before sign-in), and an index-looking object that lists the account but is not a batch.
  await bucket.put(keys.anonA, batchText('2026-11-08', INSTALL_A, undefined, 'anonA'));
  await bucket.put(keys.index, JSON.stringify({ account, batches: [keys.a1, keys.a2, keys.b1] }));
  // The rollup's rows as eraseAccount leaves them: the erased account's rows hold a placeholder, the others their account.
  for (const [day, install, who] of [['2026-11-08', INSTALL_A, 'erased:1'], ['2026-11-07', INSTALL_A, 'erased:2'], ['2026-11-07', INSTALL_B, 'erased:3'], ['2026-08-11', INSTALL_A, 'erased:4'], ['2026-11-08', INSTALL_C, other], ['2026-11-08', INSTALL_D, ''], ['2026-11-08', INSTALL_A, '']] as const) {
    await db.prepare("INSERT INTO telemetry_install_days (day, install, account, batches, events, measures) VALUES (?, ?, ?, 1, 2, '[]')").bind(day, install, who).run();
  }
  return { account, other, keys };
};

const installsPerDay = async (db: TestDb): Promise<readonly unknown[]> => (await db.prepare('SELECT day, COUNT(DISTINCT install) AS installs FROM telemetry_install_days GROUP BY day ORDER BY day').all()).results;

const clean = async (bucket: TestBucket, db: TestDb): Promise<void> => {
  await bucket.delete((await bucket.list({ prefix: 'telemetry/' })).objects.map((object) => object.key));
  await db.prepare('DELETE FROM telemetry_install_days').run();
};

describe('finding the batches of an account (Item 1)', () => {
  it('lists the batches within retention whose own record names the account, past a page of the listing, and nothing else', async () => {
    const [bucket, db] = [await pool.bucket(), await pool.db()];
    await clean(bucket, db);
    const fixture = await seed(bucket, db);
    // The index-looking object that lists the account is not a batch and is not returned.
    const found = await findBatches(telemetryOf(bucket), fixture.account, NOW);
    expect(found.map((batch) => batch.key).sort()).toEqual([fixture.keys.a2, fixture.keys.a1, fixture.keys.b1, fixture.keys.boundary].sort());
    expect(found.find((batch) => batch.key === fixture.keys.a1)?.install).toBe(INSTALL_A);
    // The batch past retention is left to its lifecycle rule, and another account's is not found.
    expect(found.map((batch) => batch.key)).not.toContain(fixture.keys.past);
    expect(found.map((batch) => batch.key)).not.toContain(fixture.keys.other);
    expect(found.map((batch) => batch.key)).not.toContain(fixture.keys.index);
  });

  it('skips an object that is not a batch, and a batch without a usable install id', async () => {
    const [bucket, db] = [await pool.bucket(), await pool.db()];
    await clean(bucket, db);
    const account = accountName();
    await bucket.put('telemetry/2026-11-08/junk.json', 'not json');
    await bucket.put('telemetry/2026-11-08/no-install.json', JSON.stringify({ account, batch: { install: 'x', events: [] } }));
    await bucket.put('telemetry/2026-11-08/no-batch.json', JSON.stringify({ account }));
    expect(await findBatches(telemetryOf(bucket), account, NOW)).toEqual([]);
  });
});

describe('rewriting them (Items 2 and 3)', () => {
  it('puts the placeholder and one fresh install id per old install in each found batch, record by record, and nowhere else', async () => {
    const [bucket, db] = [await pool.bucket(), await pool.db()];
    await clean(bucket, db);
    const fixture = await seed(bucket, db);
    const before = await all(bucket);
    const countsBefore = await installsPerDay(db);
    let made = 0;
    const rewritten = await eraseBatches(storeOf(db, telemetryOf(bucket)), fixture.account, NOW, () => {
      made += 1;
      return `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${String(made)}`;
    });
    expect(rewritten).toBe(5);
    // One id per old install: A has three batches and gets one id, B gets another.
    expect(made).toBe(2);
    const after = await all(bucket);
    const keys = after.map((one) => one.key);
    for (const key of [fixture.keys.a1, fixture.keys.a2, fixture.keys.b1, fixture.keys.boundary]) {
      expect(keys).not.toContain(key);
      expect(keys).toContain(rewriteKeyOf(key));
    }
    for (const key of [fixture.keys.other, fixture.keys.anonymous, fixture.keys.past, fixture.keys.index]) expect(after.find((one) => one.key === key)).toEqual(before.find((one) => one.key === key));
    const record = (text: string): { received: unknown; account: unknown; install: string; events: unknown } => {
      const parsed: unknown = JSON.parse(text);
      const batch = fieldOf(parsed, 'batch');
      return { received: fieldOf(parsed, 'received'), account: fieldOf(parsed, 'account'), install: textOf(batch, 'install'), events: fieldOf(batch, 'events') };
    };
    const ids = new Set<string>();
    for (const key of [fixture.keys.a1, fixture.keys.a2, fixture.keys.b1, fixture.keys.boundary]) {
      const was = record(before.find((one) => one.key === key)?.text ?? '');
      const now = record(after.find((one) => one.key === rewriteKeyOf(key))?.text ?? '');
      expect(now.account).toBe('erased:');
      // The times are cut to a Monday 00:00 UTC (t1075); everything else in an event comes as it was.
      expect(new Date(String(now.received)).getUTCDay()).toBe(1);
      expect(String(now.received)).toMatch(/T00:00:00\.000Z$/);
      expect(Date.parse(String(now.received))).toBeLessThanOrEqual(Date.parse(String(was.received)));
      const untimed = (list: unknown): string => JSON.stringify(list, (name, value: unknown) => (name === 'at' ? undefined : value));
      expect(untimed(now.events)).toBe(untimed(was.events));
      expect(now.install).not.toBe(was.install);
      ids.add(`${was.install}>${now.install}`);
    }
    expect(ids.size).toBe(2);
    // The old ids stand in no batch that names the account or the placeholder, and in no row of the rollup that names an erased account.
    for (const one of after.filter((seen) => seen.key.endsWith('-erased.json'))) expect(one.text).not.toMatch(new RegExp(`${INSTALL_A}|${INSTALL_B}|${fixture.account}`));
    // The anonymous batch of install A is rewritten too, with the same fresh id as A's other batches and no account added.
    const anonText = after.find((one) => one.key === rewriteKeyOf(fixture.keys.anonA))?.text ?? '{}';
    expect(fieldOf(JSON.parse(anonText), 'account')).toBeUndefined();
    expect(installOf(anonText)).toBe(installOf(after.find((one) => one.key === rewriteKeyOf(fixture.keys.a1))?.text ?? ''));
    // The old ids stand in no object within retention (the past one is left to its lifecycle rule) and in no row of the rollup.
    for (const one of after.filter((seen) => seen.key !== fixture.keys.past)) expect(one.text).not.toMatch(new RegExp(`${INSTALL_A}|${INSTALL_B}`));
    const oldRows = (await db.prepare('SELECT install FROM telemetry_install_days WHERE install IN (?, ?)').bind(INSTALL_A, INSTALL_B).all()).results;
    expect(oldRows).toHaveLength(0);
    expect(await installsPerDay(db)).toEqual(countsBefore);
    const rows = (await db.prepare("SELECT install FROM telemetry_install_days WHERE account LIKE 'erased:%'").all()).results.map((row) => fieldOf(row, 'install'));
    expect(rows).toHaveLength(4);
    expect(rows).not.toContain(INSTALL_A);
    expect(rows).not.toContain(INSTALL_B);
    // The other account's and the anonymous install's rows stand as they were.
    expect((await db.prepare('SELECT install FROM telemetry_install_days WHERE account = ?').bind(fixture.other).all()).results.map((row) => fieldOf(row, 'install'))).toEqual([INSTALL_C]);
    const anonymousRows = (await db.prepare("SELECT install FROM telemetry_install_days WHERE account = '' ORDER BY install").all()).results.map((row) => fieldOf(row, 'install'));
    expect(anonymousRows).toHaveLength(2);
    expect(anonymousRows).toContain(INSTALL_D);
    // Each old batch is tombstoned by the hash of its key and the date of the erasure.
    expect((await db.prepare("SELECT erased_on FROM erasure_tombstones WHERE kind = 'telemetry-batch'").all()).results.map((row) => fieldOf(row, 'erased_on'))).toEqual(['2026-11-09', '2026-11-09', '2026-11-09', '2026-11-09', '2026-11-09']);
  });

  it('draws a different install id on each erasure', async () => {
    const [bucket, db] = [await pool.bucket(), await pool.db()];
    await clean(bucket, db);
    const first = accountName();
    const second = accountName();
    await bucket.put('telemetry/2026-11-08/one.json', batchText('2026-11-08', INSTALL_A, first, 'one'));
    await bucket.put('telemetry/2026-11-08/two.json', batchText('2026-11-08', INSTALL_B, second, 'two'));
    await eraseBatches(storeOf(db, telemetryOf(bucket)), first, NOW);
    await eraseBatches(storeOf(db, telemetryOf(bucket)), second, NOW);
    const ids = (await all(bucket)).map((one) => installOf(one.text));
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('rerunning (Item 4)', () => {
  it('a second run after a full run finds nothing and moves nothing', async () => {
    const [bucket, db] = [await pool.bucket(), await pool.db()];
    await clean(bucket, db);
    const fixture = await seed(bucket, db);
    const store = storeOf(db, telemetryOf(bucket));
    await eraseBatches(store, fixture.account, NOW);
    const bucketAfter = await all(bucket);
    const rowsAfter = (await db.prepare('SELECT day, install, account FROM telemetry_install_days ORDER BY day, install, account').all()).results;
    expect(await eraseBatches(store, fixture.account, NOW)).toBe(0);
    expect(await all(bucket)).toEqual(bucketAfter);
    expect((await db.prepare('SELECT day, install, account FROM telemetry_install_days ORDER BY day, install, account').all()).results).toEqual(rowsAfter);
  });

  it.each([
    ['before the second rewrite is written', 'write', 2, 5],
    ['after every rewrite and the rows, before the first delete', 'remove', 1, 5],
    ['in the middle of the deletes', 'remove', 3, 3],
  ] as const)('a stop %s runs again to the same end as a run that did not stop, with no batch twice', async (_name, where, onCall, expected) => {
    const [bucket, db] = [await pool.bucket(), await pool.db()];
    await clean(bucket, db);
    const fixture = await seed(bucket, db);
    const countsBefore = await installsPerDay(db);
    let calls = 0;
    const stop = (): void => {
      calls += 1;
      if (calls === onCall) throw new Error('stopped');
    };
    const stopping = telemetryOf(bucket, where === 'write' ? { beforeWrite: stop } : { beforeRemove: stop });
    await expect(eraseBatches(storeOf(db, stopping), fixture.account, NOW)).rejects.toThrow('stopped');
    expect(await eraseBatches(storeOf(db, telemetryOf(bucket)), fixture.account, NOW)).toBe(expected);
    const after = await all(bucket);
    // Exactly the five rewrites and the four objects that were never the account's batches.
    expect(after.map((one) => one.key).sort()).toEqual([...[fixture.keys.a1, fixture.keys.a2, fixture.keys.b1, fixture.keys.boundary, fixture.keys.anonA].map(rewriteKeyOf), fixture.keys.other, fixture.keys.anonymous, fixture.keys.past, fixture.keys.index].sort());
    // The rollup's rows and the batches carry the same ids, and the daily counts held.
    const batchInstalls = new Set(after.filter((one) => one.key.endsWith('-erased.json')).map((one) => installOf(one.text)));
    expect(batchInstalls.size).toBe(2);
    const rowInstalls = new Set((await db.prepare("SELECT install FROM telemetry_install_days WHERE account LIKE 'erased:%'").all()).results.map((row) => fieldOf(row, 'install')));
    expect(rowInstalls).toEqual(batchInstalls);
    expect(await installsPerDay(db)).toEqual(countsBefore);
  });
});

describe('eraseAccount runs it (Item 4)', () => {
  it('rewrites the account\'s batches inside the account erasure and counts them with the objects it replaced', async () => {
    const [bucket, db] = [await pool.bucket(), await pool.db()];
    await clean(bucket, db);
    const fixture = await seed(bucket, db);
    const telemetry = telemetryOf(bucket);
    const store: EraseStore = {
      rows: async (sql, binds) => (await db.prepare(sql).bind(...binds).all()).results,
      run: async (sql, binds) => Number(fieldOf(fieldOf(await db.prepare(sql).bind(...binds).run(), 'meta'), 'changes')),
      deleteObject: () => Promise.resolve(),
      readObject: () => Promise.resolve(null),
      telemetry,
    };
    const erased = await eraseAccount(store, fixture.account, NOW);
    expect(erased.objects).toBe(5);
    expect((await all(bucket)).filter((one) => one.text.includes(fixture.account))).toHaveLength(2);
    expect((await all(bucket)).filter((one) => one.key.endsWith('-erased.json'))).toHaveLength(5);
    // A rerun of the whole erasure moves no batch a second time.
    const settled = await all(bucket);
    expect((await eraseAccount(store, fixture.account, NOW)).objects).toBe(0);
    expect(await all(bucket)).toEqual(settled);
  });
});

describe('an install shared by two accounts (fix round 2)', () => {
  it('erases P, then Q: no object names Q, the counts per day hold, and no object or row keeps P\'s fresh id', async () => {
    const [bucket, db] = [await pool.bucket(), await pool.db()];
    await clean(bucket, db);
    const [p, q] = [accountName(), accountName()];
    await bucket.put('telemetry/2026-11-08/p.json', batchText('2026-11-08', INSTALL_A, p, 'p'));
    await bucket.put('telemetry/2026-11-08/q.json', batchText('2026-11-08', INSTALL_A, q, 'q'));
    await bucket.put('telemetry/2026-11-08/c.json', batchText('2026-11-08', INSTALL_C, undefined, 'c'));
    for (const [install, who] of [[INSTALL_A, p], [INSTALL_A, q], [INSTALL_C, '']] as const) {
      await db.prepare("INSERT INTO telemetry_install_days (day, install, account, batches, events, measures) VALUES ('2026-11-08', ?, ?, 1, 2, '[]')").bind(install, who).run();
    }
    const countsBefore = await installsPerDay(db);
    const store = storeOf(db, telemetryOf(bucket));
    let made = 0;
    const newId = (): string => {
      made += 1;
      return `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${String(made)}`;
    };
    await eraseBatches(store, p, NOW, newId);
    const firstId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
    await eraseBatches(store, q, NOW, newId);
    const after = await all(bucket);
    expect(after.filter((one) => one.text.includes(q))).toEqual([]);
    expect(after.filter((one) => one.text.includes(firstId))).toEqual([]);
    expect(after.filter((one) => one.text.includes(INSTALL_A))).toEqual([]);
    expect((await db.prepare('SELECT install FROM telemetry_install_days WHERE install = ?').bind(firstId).all()).results).toEqual([]);
    expect(await installsPerDay(db)).toEqual(countsBefore);
    // Every batch of the shared install carries the one id the rows carry now.
    const ids = new Set(after.filter((one) => one.text.includes('"cli":"p"') || one.text.includes('"cli":"q"')).map((one) => installOf(one.text)));
    expect(ids.size).toBe(1);
  });

  it('reads each batch of the window once, and only the carriers again', async () => {
    const [bucket, db] = [await pool.bucket(), await pool.db()];
    await clean(bucket, db);
    const fixture = await seed(bucket, db);
    const reads: string[] = [];
    const inner = telemetryOf(bucket);
    const counting: TelemetryStore = { ...inner, read: (key) => { reads.push(key); return inner.read(key); } };
    await eraseBatches(storeOf(db, counting), fixture.account, NOW);
    const own = reads.filter((key) => !key.endsWith('-erased.json'));
    // Survey reads each in-window object once; the carriers (5 batches) are read once more for their text; nothing a third time.
    expect(Math.max(...own.reduce((m, key) => m.set(key, (m.get(key) ?? 0) + 1), new Map<string, number>()).values())).toBeLessThanOrEqual(2);
    expect(reads.filter((key) => key === rewriteKeyOf(fixture.keys.a1))).toHaveLength(1);
  });
});

describe('cutting the times of a rewrite (t1075 Item 2)', () => {
  it('cuts received and every event\'s at to the Monday 00:00 UTC of its week, and keeps counts, commands, and durations', async () => {
    const [bucket, db] = [await pool.bucket(), await pool.db()];
    await clean(bucket, db);
    const account = accountName();
    const key = 'telemetry/2026-11-08/cut.json';
    const event = (at: string, durationMs: number): object => ({ v: 1, type: 'command', at, cli: 'cut', os: 'linux', data: { path: ['sessions', 'list'], durationMs, exitCode: 0 } });
    await bucket.put(key, JSON.stringify({ received: '2026-11-08T23:59:59.000Z', account, batch: { install: INSTALL_A, events: [event('2026-11-04T13:45:10Z', 12), event('2026-11-08T23:59:59Z', 34), event('2026-11-02T00:00:00Z', 56), event('not a time', 78)] } }));
    await eraseBatches(storeOf(db, telemetryOf(bucket)), account, NOW);
    const held: unknown = JSON.parse((await (await bucket.get(rewriteKeyOf(key)))?.text()) ?? '{}');
    expect(fieldOf(held, 'received')).toBe('2026-11-02T00:00:00.000Z');
    const events = fieldOf(fieldOf(held, 'batch'), 'events') as object[];
    expect(events.map((one) => fieldOf(one, 'at'))).toEqual(['2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'not a time']);
    expect(events.map((one) => fieldOf(fieldOf(one, 'data'), 'durationMs'))).toEqual([12, 34, 56, 78]);
    expect(events.map((one) => fieldOf(fieldOf(one, 'data'), 'path'))).toEqual(Array(4).fill(['sessions', 'list']));
  });
});
