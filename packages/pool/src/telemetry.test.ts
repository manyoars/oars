// POST /v1/telemetry: a batch of the CLI's own usage events, kept whole in R2 and indexed in Analytics Engine. Two layers: the route under Miniflare's workerd (real R2 and D1),
// and the handler against fakes of both bindings, which is where a failing store is made to fail.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Env, PoolDb } from './http.js';
import { MAX_BATCH_BYTES, MAX_BATCH_EVENTS, MAX_BATCHES_PER_INSTALL_DAY, telemetry, type DataPoint, type TelemetryEnv } from './telemetry.js';
import { fieldOf, startPool, stubUser, textOf, type TestPool } from './test-pool.js';

const INSTALL = '3f2b8c1e-5d4a-4b6f-9c7e-1a2b3c4d5e6f';
const today = (): string => new Date().toISOString().slice(0, 10);

const command = (more: object = {}): object => ({ v: 1, id: INSTALL, at: '2026-11-06T12:00:00.000Z', type: 'command', cli: '0.3.0', os: 'win32', data: { path: ['pool', 'fetch'], flags: ['json', 'server'], durationMs: 412, exitCode: 0 }, ...more });

const kept = async (pool: TestPool): Promise<{ key: string; text: string }[]> => {
  const bucket = await pool.bucket();
  const { objects } = await bucket.list({ prefix: 'telemetry/' });
  return Promise.all(objects.map(async ({ key }) => ({ key, text: (await (await bucket.get(key))?.text()) ?? '' })));
};

describe('POST /v1/telemetry on the Worker', () => {
  let pool: TestPool;

  // Deposits are closed here (no covenant version): the route must answer all the same.
  beforeAll(async () => {
    pool = await startPool({ COVENANT_VERSION: '' });
  });

  afterEach(async () => {
    const bucket = await pool.bucket();
    await bucket.delete((await kept(pool)).map(({ key }) => key));
  });

  afterAll(async () => {
    await pool.dispose();
  });

  it('keeps a batch with deposits closed and no covenant version, and answers how many events it kept', async () => {
    const sent = await pool.post('/v1/telemetry', { install: INSTALL, events: [command(), command({ type: 'future-kind', novel: { deep: [1, 2] } })] });
    expect(sent.status).toBe(201);
    expect(fieldOf(sent.json, 'ok')).toBe(true);
    expect(fieldOf(sent.json, 'kept')).toBe(2);
    const objects = await kept(pool);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.key).toMatch(new RegExp(`^telemetry/${today()}/[0-9a-f-]{36}\\.json$`));
    const held: unknown = JSON.parse(objects[0]?.text ?? '');
    expect(fieldOf(held, 'account')).toBeUndefined();
    const batch = fieldOf(held, 'batch');
    expect(fieldOf(batch, 'install')).toBe(INSTALL);
    // Whole: an event type and a field the server has never seen are kept as sent.
    expect(fieldOf(batch, 'events')).toEqual([command(), command({ type: 'future-kind', novel: { deep: [1, 2] } })]);
  });

  // S23: a bearer on the request would join an install id to an account, though the CLI never sends one. The route reads no credential, keeps none, and indexes no account.
  it('ignores a sent bearer: no account in the record, none in the index, and the credential is never read', async () => {
    const { token } = await pool.signIn('github', stubUser('7001'));
    for (const bearer of [token, 'not-a-token']) {
      const sent = await pool.post('/v1/telemetry', { install: INSTALL, events: [command()] }, bearer);
      expect(sent.status).toBe(201);
    }
    const texts = (await kept(pool)).map(({ text }) => text);
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(fieldOf(JSON.parse(text), 'account')).toBeUndefined();
      expect(text).not.toContain(token);
      expect(text).not.toContain('acct_');
    }
  });

  it('stores no address and no user agent', async () => {
    const sent = await pool.miniflare.dispatchFetch('http://pool.test/v1/telemetry', {
      method: 'POST',
      body: JSON.stringify({ install: INSTALL, events: [command()] }),
      headers: { 'content-type': 'application/json', 'user-agent': 'secret-agent/9.9', 'cf-connecting-ip': '203.0.113.77', 'x-forwarded-for': '203.0.113.78', 'x-real-ip': '203.0.113.79' },
    });
    expect(sent.status).toBe(201);
    const text = (await kept(pool)).map((one) => one.text).join('');
    for (const trace of ['secret-agent', '203.0.113', 'user-agent', 'cf-connecting-ip']) expect(text).not.toContain(trace);
  });

  it('refuses a shape error with 400 naming the field, and keeps nothing', async () => {
    const events = (count: number): object[] => Array.from({ length: count }, () => command());
    const cases: [string, unknown, string][] = [
      ['a body that is not JSON', '{nope', 'body'],
      ['a body that is not an object', [], 'body'],
      ['no install id', { events: events(1) }, 'install'],
      ['an install id that is not a UUID', { install: 'my-laptop', events: events(1) }, 'install'],
      ['events that are not a list', { install: INSTALL, events: 'many' }, 'events'],
      ['an empty batch', { install: INSTALL, events: [] }, 'events'],
      ['one more event than the limit', { install: INSTALL, events: events(MAX_BATCH_EVENTS + 1) }, 'events'],
      ['an event that is not an object', { install: INSTALL, events: [command(), 'text'] }, 'events[1]'],
      ['an event that is a list', { install: INSTALL, events: [[]] }, 'events[0]'],
      ['an event with no type', { install: INSTALL, events: [{ v: 1 }] }, 'events[0].type'],
      ['an event whose type is empty', { install: INSTALL, events: [command({ type: '' })] }, 'events[0].type'],
      ['an event whose type is a number', { install: INSTALL, events: [command({ type: 5 })] }, 'events[0].type'],
      ['an event whose type is very long', { install: INSTALL, events: [command({ type: 'x'.repeat(65) })] }, 'events[0].type'],
    ];
    for (const [name, body, field] of cases) {
      const answered = await pool.post('/v1/telemetry', body);
      expect(answered.status, name).toBe(400);
      expect(fieldOf(answered.json, 'error'), name).toBe('invalid_telemetry');
      expect(fieldOf(answered.json, 'field'), name).toBe(field);
    }
    expect(await kept(pool)).toEqual([]);
  });

  it('accepts exactly the event limit', async () => {
    const sent = await pool.post('/v1/telemetry', { install: INSTALL, events: Array.from({ length: MAX_BATCH_EVENTS }, () => command()) });
    expect(sent.status).toBe(201);
    expect(fieldOf(sent.json, 'kept')).toBe(MAX_BATCH_EVENTS);
  });

  it('refuses a body over the byte limit as too_large, declared or not', async () => {
    const padding = 'x'.repeat(MAX_BATCH_BYTES);
    const sent = await pool.post('/v1/telemetry', { install: INSTALL, events: [command({ padding })] });
    expect(sent.status).toBe(413);
    expect(textOf(sent.json, 'error')).toBe('too_large');
    expect(await kept(pool)).toEqual([]);
  });

  // S6: a page's visitors can send a simple cross-origin POST, but only as text/plain, form-urlencoded, or multipart, with no preflight. Only application/json, which needs a preflight the route never answers, gets in.
  it.each([['text/plain'], ['text/plain;charset=UTF-8'], ['application/x-www-form-urlencoded'], ['multipart/form-data; boundary=x'], ['application/jsonp'], ['']])('refuses the content type %j with 415, and keeps nothing', async (type) => {
    const sent = await pool.post('/v1/telemetry', { install: INSTALL, events: [command()] }, undefined, { 'content-type': type });
    expect(sent.status).toBe(415);
    expect(textOf(sent.json, 'error')).toBe('unsupported_media_type');
    expect(await kept(pool)).toEqual([]);
  });

  it.each([['application/json'], ['Application/JSON'], ['application/json; charset=utf-8']])('takes the content type %j', async (type) => {
    const sent = await pool.post('/v1/telemetry', { install: 'a1b2c3d4-0000-4000-8000-00000000000a', events: [command()] }, undefined, { 'content-type': type });
    expect(sent.status).toBe(201);
  });

  it('holds a batch to a cap sized from the CLI: the largest batch it can send (11 wire events and 239 maximal commands) fits, and the cap is half the old megabyte', async () => {
    // The CLI's own writers measure these at 2,254 bytes (a `wire` event) and 1,767 bytes (a command at its schema's limit) in `packages/cli/src/telemetry/wire.test.ts`; the events here are larger still (a 90-name wire event with the widest
    // counts is about 4.3 KB), so passing is conservative. `telemetry/send.ts` sends at most 250 events a request, and a pass writes one `wire` event for each of the 11 harnesses at most.
    const wire = command({ type: 'wire', data: { fields: Array.from({ length: 90 }, (_, at) => `fieldName${String(at)}xx`), present: Array.from({ length: 90 }, () => 1_000_000_000), fieldBytes: Array.from({ length: 90 }, () => 2 ** 50) } });
    const token = 'a'.repeat(32);
    const widest = command({ data: { path: [token, token, token, token], flags: Array.from({ length: 40 }, () => token), durationMs: 86_400_000, exitCode: 255 } });
    const batch = { install: 'a1b2c3d4-0000-4000-8000-00000000000b', events: [...Array.from({ length: 11 }, () => wire), ...Array.from({ length: MAX_BATCH_EVENTS - 11 }, () => widest)] };
    expect(JSON.stringify(batch).length).toBeLessThan(MAX_BATCH_BYTES);
    expect(MAX_BATCH_BYTES).toBeLessThanOrEqual(512 * 1024);
    expect((await pool.post('/v1/telemetry', batch)).status).toBe(201);
  });

  // The install id is a claim, so the quota bounds one install, not a determined sender: the WAF rate rule (docs/pool.md, deploy step 6) bounds the rest.
  it('answers 429 with Retry-After once an install has sent its daily batches, and keeps no more', async () => {
    const install = 'a1b2c3d4-0000-4000-8000-00000000000c';
    for (let sent = 0; sent < MAX_BATCHES_PER_INSTALL_DAY; sent += 1) expect((await pool.post('/v1/telemetry', { install, events: [command()] })).status, String(sent)).toBe(201);
    const over = await pool.send('/v1/telemetry', { method: 'POST', body: JSON.stringify({ install, events: [command()] }) }, undefined, { 'content-type': 'application/json' });
    expect(over.status).toBe(429);
    expect(textOf(over.json, 'error')).toBe('quota_exceeded');
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(Number(over.headers.get('retry-after'))).toBeLessThanOrEqual(86_400);
    expect((await kept(pool)).filter(({ text }) => text.includes(install))).toHaveLength(MAX_BATCHES_PER_INSTALL_DAY);
    // Another install is not held to this one's count.
    expect((await pool.post('/v1/telemetry', { install: 'a1b2c3d4-0000-4000-8000-00000000000d', events: [command()] })).status).toBe(201);
  });

  it('spends no quota on a request it refuses for its shape', async () => {
    const install = 'a1b2c3d4-0000-4000-8000-00000000000e';
    for (let sent = 0; sent < MAX_BATCHES_PER_INSTALL_DAY + 2; sent += 1) expect((await pool.post('/v1/telemetry', { install, events: [] })).status).toBe(400);
    expect((await pool.post('/v1/telemetry', { install, events: [command()] })).status).toBe(201);
  });

  it('answers 404 to any other method on the route', async () => {
    expect((await pool.get('/v1/telemetry')).status).toBe(404);
  });
});

interface FakeStores {
  env: Env & TelemetryEnv;
  objects: Map<string, string>;
  points: DataPoint[];
  /** The quota rows, keyed `install|day`. */
  counts: Map<string, number>;
}

/** The two bindings as plain objects. `failR2` and `failIndex` make a store throw; `bare` leaves the named binding unset. */
const fakes = (options: { failR2?: boolean; failIndex?: boolean; bare?: 'TELEMETRY' | 'TELEMETRY_EVENTS'; db?: 'down' | 'no-count' | 'no-refund' } = {}): FakeStores => {
  const objects = new Map<string, string>();
  const points: DataPoint[] = [];
  const refused = (): never => {
    throw new Error('the database is down');
  };
  // The one statement the route runs: it counts a batch for an install and day and answers the count. `no-count` answers a row without one.
  const counts = new Map<string, number>();
  const database: PoolDb = {
    prepare: () => ({
      bind: (...values) => ({
        first: () => {
          if (options.db === 'no-count') return Promise.resolve(null);
          const key = values.join('|');
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return Promise.resolve({ count: counts.get(key) });
        },
        all: refused,
        // The refund of a spent slot is the one write: `no-refund` makes it fail, as a database that is down would.
        run: () => {
          if (options.db === 'no-refund') return refused();
          const key = values.join('|');
          counts.set(key, (counts.get(key) ?? 0) - 1);
          return Promise.resolve({ meta: { changes: 1 } });
        },
      }),
    }),
    batch: refused,
  };
  const unused: PoolDb = options.db === 'down' ? { prepare: refused, batch: refused } : database;
  const env: Env & TelemetryEnv = {
    DB: unused,
    ...(options.bare === 'TELEMETRY' ? {} : { TELEMETRY: { put: (key: string, value: string): Promise<unknown> => (options.failR2 === true ? Promise.reject(new Error('R2 is down')) : Promise.resolve(objects.set(key, value))) } }),
    ...(options.bare === 'TELEMETRY_EVENTS'
      ? {}
      : {
          TELEMETRY_EVENTS: {
            writeDataPoint: (point: DataPoint): void => {
              if (options.failIndex === true) throw new Error('Analytics Engine is down');
              points.push(point);
            },
          },
        }),
  };
  return { env, objects, points, counts };
};

const send = (stores: FakeStores, body: unknown, now: () => number = () => Date.parse('2026-11-07T08:00:00Z'), headers: { [name: string]: string } = {}): Promise<Response> =>
  telemetry(new Request('http://pool.test/v1/telemetry', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }), stores.env, now);

describe('the telemetry handler against fake stores', () => {
  it('writes a batch to R2 under its day and to Analytics Engine, one data point per event', async () => {
    const stores = fakes();
    const answered = await send(stores, { install: INSTALL, events: [command(), command({ type: 'doctor', data: {} })] });
    expect(answered.status).toBe(201);
    expect(await answered.json()).toEqual({ ok: true, kept: 2, indexed: true });
    expect([...stores.objects.keys()]).toHaveLength(1);
    expect([...stores.objects.keys()][0]).toMatch(/^telemetry\/2026-11-07\/[0-9a-f-]{36}\.json$/);
    expect(stores.points).toHaveLength(2);
    // Index: the install (the sampling key). Blobs: type, cli, os, path, errorClass, account, flags. Doubles: schema version, event time, duration, exit code.
    expect(stores.points[0]).toEqual({
      indexes: [INSTALL],
      blobs: ['command', '0.3.0', 'win32', 'pool fetch', '', '', 'json,server'],
      doubles: [1, Date.parse('2026-11-06T12:00:00.000Z'), 412, 0],
    });
    expect(stores.points[1]).toEqual({ indexes: [INSTALL], blobs: ['doctor', '0.3.0', 'win32', '', '', '', ''], doubles: [1, Date.parse('2026-11-06T12:00:00.000Z'), 0, 0] });
  });

  it('accepts the first-run and covenant-shown events with their closed words, keeps them whole, and indexes their envelope', async () => {
    const stores = fakes();
    const first = { v: 1, at: '2026-11-06T12:00:00.000Z', type: 'first-run', cli: '0.3.0', os: 'linux', data: { ci: 'github-actions', surface: 'npx' } };
    const shown = { v: 1, at: '2026-11-06T12:00:01.000Z', type: 'covenant-shown', cli: '0.3.0', os: 'linux', data: { version: '2026-11-10' } };
    const answered = await send(stores, { install: INSTALL, events: [first, shown] });
    expect(answered.status).toBe(201);
    expect(await answered.json()).toEqual({ ok: true, kept: 2, indexed: true });
    expect([...stores.objects.values()].join('')).toContain('"surface":"npx"');
    expect(stores.points.map((point) => point.blobs[0])).toEqual(['first-run', 'covenant-shown']);
  });

  it('keeps the R2 object when Analytics Engine fails, and says it did not index', async () => {
    const stores = fakes({ failIndex: true });
    const answered = await send(stores, { install: INSTALL, events: [command()] });
    expect(answered.status).toBe(201);
    expect(await answered.json()).toEqual({ ok: true, kept: 1, indexed: false });
    expect(stores.objects.size).toBe(1);
  });

  it('reads no credential: a sent bearer reaches neither the database nor the record', async () => {
    const stores = fakes({ db: 'down' });
    // The quota statement is the only database call, and it is down here, so this also shows no credential lookup is tried: the answer is the quota's 503, not a kept batch with a lookup swallowed.
    const down = await send(stores, { install: INSTALL, events: [command()] }, undefined, { authorization: 'Bearer some-token' });
    expect(down.status).toBe(503);
    expect(fieldOf(await down.json(), 'error')).toBe('telemetry_unavailable');
    expect(stores.objects.size).toBe(0);
    const up = fakes();
    expect((await send(up, { install: INSTALL, events: [command()] }, undefined, { authorization: 'Bearer some-token' })).status).toBe(201);
    expect(fieldOf(JSON.parse([...up.objects.values()][0] ?? ''), 'account')).toBeUndefined();
    expect([...up.objects.values()].join('')).not.toContain('some-token');
    expect(up.points[0]?.blobs[5]).toBe('');
  });

  it('answers 503 and keeps nothing when the quota cannot be counted, so a database fault never opens the bound', async () => {
    for (const db of ['down', 'no-count'] as const) {
      const stores = fakes({ db });
      expect((await send(stores, { install: INSTALL, events: [command()] })).status, db).toBe(503);
      expect(stores.objects.size, db).toBe(0);
    }
  });

  it('counts the quota by UTC day: a new day starts at one', async () => {
    const stores = fakes();
    const days = [Date.parse('2026-11-07T23:59:00Z'), Date.parse('2026-11-08T00:01:00Z')];
    for (let sent = 0; sent < MAX_BATCHES_PER_INSTALL_DAY; sent += 1) expect((await send(stores, { install: INSTALL, events: [command()] }, () => days[0] ?? 0)).status).toBe(201);
    const over = await send(stores, { install: INSTALL, events: [command()] }, () => days[0] ?? 0);
    expect(over.status).toBe(429);
    // Two minutes to midnight: the answer says to wait about that long.
    expect(over.headers.get('retry-after')).toBe('60');
    expect((await send(stores, { install: INSTALL, events: [command()] }, () => days[1] ?? 0)).status).toBe(201);
  });

  it('keeps the object and skips the index when no dataset is bound', async () => {
    const stores = fakes({ bare: 'TELEMETRY_EVENTS' });
    const answered = await send(stores, { install: INSTALL, events: [command()] });
    expect(await answered.json()).toEqual({ ok: true, kept: 1, indexed: false });
    expect(stores.objects.size).toBe(1);
  });

  it('answers 503 and indexes nothing when R2 fails, so a resend does not count twice', async () => {
    const stores = fakes({ failR2: true });
    const answered = await send(stores, { install: INSTALL, events: [command()] });
    expect(answered.status).toBe(503);
    expect(fieldOf(await answered.json(), 'error')).toBe('telemetry_unavailable');
    expect(stores.points).toEqual([]);
  });

  it("refunds the install's quota slot when R2 fails, so an outage does not spend the day", async () => {
    const stores = fakes({ failR2: true });
    for (let resend = 0; resend < 3; resend += 1) expect((await send(stores, { install: INSTALL, events: [command()] })).status).toBe(503);
    expect([...stores.counts.values()]).toEqual([0]);
  });

  it('still answers 503 when the refund itself fails', async () => {
    const stores = fakes({ failR2: true, db: 'no-refund' });
    const answered = await send(stores, { install: INSTALL, events: [command()] });
    expect(answered.status).toBe(503);
    expect(fieldOf(await answered.json(), 'error')).toBe('telemetry_unavailable');
    expect([...stores.counts.values()]).toEqual([1]);
  });

  it('answers 503 not_configured when no bucket is bound', async () => {
    const stores = fakes({ bare: 'TELEMETRY' });
    const answered = await send(stores, { install: INSTALL, events: [command()] });
    expect(answered.status).toBe(503);
    expect(fieldOf(await answered.json(), 'error')).toBe('not_configured');
    expect(stores.points).toEqual([]);
  });

  it('indexes only strings and numbers, cut to a length, and an event time it cannot read as zero', async () => {
    const stores = fakes();
    await send(stores, {
      install: INSTALL,
      events: [{ type: 'command', at: 'yesterday', cli: 'c'.repeat(300), os: 4, data: { path: ['a', 7, 'b'], flags: 'json', durationMs: 'slow', exitCode: 1, errorClass: 'usage' } }],
    });
    expect(stores.points[0]).toEqual({ indexes: [INSTALL], blobs: ['command', 'c'.repeat(128), '', 'a b', 'usage', '', ''], doubles: [0, 0, 0, 1] });
  });

  it('puts an event with no data object in the index with its envelope only', async () => {
    const stores = fakes();
    await send(stores, { install: INSTALL, events: [{ type: 'bare', data: [1, 2] }] });
    expect(stores.points[0]).toEqual({ indexes: [INSTALL], blobs: ['bare', '', '', '', '', '', ''], doubles: [0, 0, 0, 0] });
  });

  it('refuses a content type that is not application/json before it reads the body or the database', async () => {
    const stores = fakes({ db: 'down' });
    const request = new Request('http://pool.test/v1/telemetry', { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } });
    expect((await telemetry(request, stores.env, Date.now)).status).toBe(415);
    expect((await telemetry(new Request('http://pool.test/v1/telemetry', { method: 'POST', body: '{}' }), stores.env, Date.now)).status).toBe(415);
  });

  it('refuses a declared length over the limit without reading the body', async () => {
    const stores = fakes();
    const request = new Request('http://pool.test/v1/telemetry', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'content-length': String(MAX_BATCH_BYTES + 1) } });
    const answered = await telemetry(request, stores.env, Date.now);
    expect(answered.status).toBe(413);
  });
});
