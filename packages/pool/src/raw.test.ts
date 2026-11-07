// The raw tier: an authenticated, redacted transcript goes to R2 in parts and a ledger row lands in D1; the bytes never reach D1 and nothing serves them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fieldOf, startPool, stubUser, textOf, type TestPool } from './test-pool.js';

const MEGABYTE = 1024 * 1024;

let pool: TestPool;
let closed: TestPool;
let unbound: TestPool;
let next = 9000;

beforeAll(async () => {
  pool = await startPool();
  // An empty COVENANT_VERSION counts as unset: this pool keeps deposits closed.
  closed = await startPool({ COVENANT_VERSION: '' });
  // A pool deployed before its bucket exists: everything else is configured, RAW is not.
  unbound = await startPool({}, { raw: false });
}, 60_000);

afterAll(async () => {
  await pool.dispose();
  await closed.dispose();
  await unbound.dispose();
});

/** Bytes that hit every value, so a part cut at the wrong place or a text round trip shows. */
const transcript = (length: number, seed: number): Uint8Array => Uint8Array.from({ length }, (_, at) => (at * 31 + seed + (at >> 8)) % 256);

const hex = async (bytes: Uint8Array): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const grant = { 'oars-redaction-version': '1', 'oars-capture-version': 'cap-7', 'oars-raw-consent': 'granted' };

interface Account {
  token: string;
  account: string;
}

/** A signed-in account that has accepted the covenant. */
const member = async (target: TestPool = pool): Promise<Account> => {
  next += 1;
  const { token, account } = await target.signIn('github', stubUser(String(next)));
  expect((await target.post('/v1/covenant/accept', { version: 'v1' }, token)).status).toBe(200);
  return { token, account };
};

const partPath = (hash: string, at: number): string => `/v1/raw/${hash}/parts/${String(at)}`;

const sendParts = async (hash: string, bytes: Uint8Array, token: string, headers: { [name: string]: string } = grant, size = MEGABYTE): Promise<number> => {
  let count = 0;
  for (let from = 0; from < bytes.length; from += size) {
    count += 1;
    const sent = await pool.send(partPath(hash, count), { method: 'PUT', body: bytes.subarray(from, from + size) }, token, headers);
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
  }
  return count;
};

const complete = (hash: string, parts: number, bytes: number, token: string, headers: { [name: string]: string } = grant): ReturnType<TestPool['send']> =>
  pool.send(`/v1/raw/${hash}/complete`, { method: 'POST', body: JSON.stringify({ parts, bytes }) }, token, headers);

const rowsOf = async (account: string): Promise<readonly unknown[]> => (await (await pool.db()).prepare('SELECT * FROM raw_objects WHERE account = ?').bind(account).all()).results;

const keysIn = async (prefix: string, target: TestPool = pool): Promise<string[]> => (await (await target.rawBucket()).list({ prefix })).objects.map(({ key }) => key);

describe('a transcript over the 1 MB request cap', () => {
  it('round trips byte for byte through R2, in parts of at most 1 MB', async () => {
    const { token, account } = await member();
    const bytes = transcript(Math.round(2.5 * MEGABYTE), 3);
    const hash = await hex(bytes);
    const parts = await sendParts(hash, bytes, token);
    expect(parts).toBe(3);
    const done = await complete(hash, parts, bytes.length, token);
    expect(done.status, JSON.stringify(done.json)).toBe(201);
    const stored = await (await pool.rawBucket()).get(`raw/${account}/${hash}`);
    expect(stored).not.toBeNull();
    expect(Buffer.from((await stored?.arrayBuffer()) ?? new ArrayBuffer(0)).equals(Buffer.from(bytes))).toBe(true);
    // The staged parts are gone once the object stands.
    expect(await keysIn(`staging/${account}/`)).toEqual([]);
  }, 60_000);

  it('assembles an object past R2\'s 5 MiB minimum part, in equal parts and a short last one', async () => {
    const { token, account } = await member();
    const bytes = transcript(11 * MEGABYTE + 12_345, 9);
    const hash = await hex(bytes);
    const parts = await sendParts(hash, bytes, token);
    const done = await complete(hash, parts, bytes.length, token);
    expect(done.status, JSON.stringify(done.json)).toBe(201);
    const stored = await (await pool.rawBucket()).get(`raw/${account}/${hash}`);
    expect(Buffer.from((await stored?.arrayBuffer()) ?? new ArrayBuffer(0)).equals(Buffer.from(bytes))).toBe(true);
  }, 120_000);

  it('refuses a part over 1 MB, unread when it declares its length', async () => {
    const { token, account } = await member();
    const bytes = transcript(MEGABYTE + 1, 1);
    const sent = await pool.send(partPath(await hex(bytes), 1), { method: 'PUT', body: bytes }, token, grant);
    expect(sent.status).toBe(413);
    expect(fieldOf(sent.json, 'error')).toBe('too_large');
    expect(await keysIn(`staging/${account}/`)).toEqual([]);
  });

  it('refuses a part over 1 MB that declares no length, once it has been read', async () => {
    const { token, account } = await member();
    const bytes = transcript(MEGABYTE + 1, 1);
    // A stream body goes out chunked, with no content-length, so only the size of what was read can refuse it.
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const sent = await pool.miniflare.dispatchFetch(`http://pool.test${partPath(await hex(bytes), 1)}`, { method: 'PUT', body: stream, duplex: 'half', headers: { authorization: `Bearer ${token}`, ...grant } });
    expect(sent.status).toBe(413);
    expect(fieldOf(JSON.parse(await sent.text()), 'error')).toBe('too_large');
    expect(await keysIn(`staging/${account}/`)).toEqual([]);
  });

  it('refuses an empty part', async () => {
    const { token } = await member();
    const sent = await pool.send(partPath('a'.repeat(64), 1), { method: 'PUT', body: new Uint8Array(0) }, token, grant);
    expect(sent.status).toBe(422);
    expect(fieldOf(sent.json, 'error')).toBe('empty_part');
  });
});

describe('what the raw tier refuses', () => {
  const hash = 'b'.repeat(64);
  const body = transcript(100, 5);

  it('refuses everything while COVENANT_VERSION is unset', async () => {
    const { token } = await closed.signIn('github', stubUser('9901'));
    const sent = await closed.send(partPath(hash, 1), { method: 'PUT', body }, token, grant);
    expect(sent.status).toBe(403);
    expect(fieldOf(sent.json, 'error')).toBe('deposits_closed');
    const done = await closed.send(`/v1/raw/${hash}/complete`, { method: 'POST', body: JSON.stringify({ parts: 1, bytes: 100 }) }, token, grant);
    expect(fieldOf(done.json, 'error')).toBe('deposits_closed');
    expect(await keysIn('', closed)).toEqual([]);
  });

  it('answers 503 not_configured, naming RAW, while the pool has no RAW binding', async () => {
    const { token, account } = await member(unbound);
    const part = await unbound.send(partPath(hash, 1), { method: 'PUT', body }, token, grant);
    expect(part.status).toBe(503);
    expect(fieldOf(part.json, 'error')).toBe('not_configured');
    expect(textOf(part.json, 'message')).toContain('RAW');
    const done = await unbound.send(`/v1/raw/${hash}/complete`, { method: 'POST', body: JSON.stringify({ parts: 1, bytes: 100 }) }, token, grant);
    expect(done.status).toBe(503);
    expect(fieldOf(done.json, 'error')).toBe('not_configured');
    expect(textOf(done.json, 'message')).toContain('RAW');
    expect(((await (await unbound.db()).prepare('SELECT * FROM raw_objects WHERE account = ?').bind(account).all()).results)).toEqual([]);
  });

  it('refuses a request with no sign-in', async () => {
    const sent = await pool.send(partPath(hash, 1), { method: 'PUT', body }, undefined, grant);
    expect(sent.status).toBe(401);
    expect(fieldOf(sent.json, 'error')).toBe('unauthorized');
  });

  it('refuses an account that has not accepted the current covenant', async () => {
    const { token } = await pool.signIn('github', stubUser('9902'));
    const sent = await pool.send(partPath(hash, 1), { method: 'PUT', body }, token, grant);
    expect(sent.status).toBe(403);
    expect(fieldOf(sent.json, 'error')).toBe('covenant_not_accepted');
    const done = await complete(hash, 1, 100, token);
    expect(fieldOf(done.json, 'error')).toBe('covenant_not_accepted');
  });

  it('refuses a request that states no redaction version, or one that is not a version', async () => {
    const { token } = await member();
    for (const value of [undefined, '', 'has space', 'x'.repeat(65)]) {
      const headers: { [name: string]: string } = { ...grant };
      if (value === undefined) delete headers['oars-redaction-version'];
      else headers['oars-redaction-version'] = value;
      const sent = await pool.send(partPath(hash, 1), { method: 'PUT', body }, token, headers);
      expect(sent.status, String(value)).toBe(422);
      expect(fieldOf(sent.json, 'error')).toBe('redaction_required');
      expect(fieldOf(sent.json, 'field')).toBe('oars-redaction-version');
    }
    const done = await complete(hash, 1, 100, token, { 'oars-capture-version': 'cap-7', 'oars-raw-consent': 'granted' });
    expect(fieldOf(done.json, 'error')).toBe('redaction_required');
  });

  it('refuses a request that states no capture version', async () => {
    const { token } = await member();
    const sent = await pool.send(partPath(hash, 1), { method: 'PUT', body }, token, { 'oars-redaction-version': '1', 'oars-raw-consent': 'granted' });
    expect(sent.status).toBe(422);
    expect(fieldOf(sent.json, 'error')).toBe('capture_required');
  });

  it('refuses a raw part from an account with no recorded raw consent, and records the consent the first time it is stated', async () => {
    const { token, account } = await member();
    const withoutConsent = { 'oars-redaction-version': '1', 'oars-capture-version': 'cap-7' };
    const refused = await pool.send(partPath(hash, 1), { method: 'PUT', body }, token, withoutConsent);
    expect(refused.status).toBe(403);
    expect(fieldOf(refused.json, 'error')).toBe('raw_consent_required');
    const declined = await pool.send(partPath(hash, 1), { method: 'PUT', body }, token, { ...grant, 'oars-raw-consent': 'declined' });
    expect(fieldOf(declined.json, 'error')).toBe('raw_consent_required');
    expect(await keysIn(`staging/${account}/`)).toEqual([]);

    // Stated once, it is recorded: a later part need not repeat it. Covenant acceptance is a separate record.
    expect((await pool.send(partPath(hash, 1), { method: 'PUT', body }, token, grant)).status).toBe(200);
    expect((await pool.send(partPath(hash, 2), { method: 'PUT', body }, token, withoutConsent)).status).toBe(200);
    // A later "declined" refuses even with the consent held.
    expect((await pool.send(partPath(hash, 3), { method: 'PUT', body }, token, { ...grant, 'oars-raw-consent': 'declined' })).status).toBe(403);

    // With the record gone the part is refused again: the gate reads the account, not the request.
    await (await pool.db()).prepare('UPDATE accounts SET raw_consent = NULL WHERE id = ?').bind(account).run();
    const gone = await pool.send(partPath(hash, 4), { method: 'PUT', body }, token, withoutConsent);
    expect(fieldOf(gone.json, 'error')).toBe('raw_consent_required');
  });

  it('keeps the covenant and the raw consent apart: accepting one records nothing of the other', async () => {
    const { account } = await member();
    const row = await (await pool.db()).prepare('SELECT covenant, raw_consent FROM accounts WHERE id = ?').bind(account).first();
    expect(fieldOf(row, 'covenant')).toBe('v1');
    expect(fieldOf(row, 'raw_consent')).toBeNull();
  });

  it('refuses a part number that is not a positive whole number as no route', async () => {
    const { token } = await member();
    for (const at of ['0', '01', '-1', '1000000', 'x']) {
      const sent = await pool.send(`/v1/raw/${hash}/parts/${at}`, { method: 'PUT', body }, token, grant);
      expect(sent.status, at).toBe(404);
    }
  });
});

describe('retries and completion', () => {
  it('takes a retried part again and a retried completion as already stored', async () => {
    const { token, account } = await member();
    const bytes = transcript(Math.round(1.5 * MEGABYTE), 11);
    const hash = await hex(bytes);
    const parts = await sendParts(hash, bytes, token);
    // The first part again, as a client retry does after a lost answer.
    expect((await pool.send(partPath(hash, 1), { method: 'PUT', body: bytes.subarray(0, MEGABYTE) }, token, grant)).status).toBe(200);
    expect((await complete(hash, parts, bytes.length, token)).status).toBe(201);
    const again = await complete(hash, parts, bytes.length, token);
    expect(again.status).toBe(200);
    expect(fieldOf(again.json, 'stored')).toBe(true);
    expect(await rowsOf(account)).toHaveLength(1);
    // A part sent after the object stands writes nothing.
    expect((await pool.send(partPath(hash, 1), { method: 'PUT', body: bytes.subarray(0, MEGABYTE) }, token, grant)).status).toBe(200);
    expect(await keysIn(`staging/${account}/`)).toEqual([]);
    expect(await keysIn(`raw/${account}/`)).toEqual([`raw/${account}/${hash}`]);
  }, 60_000);

  it('names the part that never arrived, and leaves no object and no row', async () => {
    const { token, account } = await member();
    const bytes = transcript(3 * MEGABYTE, 2);
    const hash = await hex(bytes);
    for (const at of [1, 3]) expect((await pool.send(partPath(hash, at), { method: 'PUT', body: bytes.subarray((at - 1) * MEGABYTE, at * MEGABYTE) }, token, grant)).status).toBe(200);
    const done = await complete(hash, 3, bytes.length, token);
    expect(done.status).toBe(409);
    expect(fieldOf(done.json, 'error')).toBe('part_missing');
    expect(textOf(done.json, 'message')).toContain('Part 2');
    expect(await rowsOf(account)).toEqual([]);
    expect(await keysIn(`raw/${account}/`)).toEqual([]);
    // The missing part sent late completes it.
    expect((await pool.send(partPath(hash, 2), { method: 'PUT', body: bytes.subarray(MEGABYTE, 2 * MEGABYTE) }, token, grant)).status).toBe(200);
    expect((await complete(hash, 3, bytes.length, token)).status).toBe(201);
  }, 60_000);

  it('refuses a completion whose byte count is not what arrived', async () => {
    const { token, account } = await member();
    const bytes = transcript(2000, 4);
    const hash = await hex(bytes);
    await sendParts(hash, bytes, token);
    const done = await complete(hash, 1, bytes.length + 1, token);
    expect(done.status).toBe(422);
    expect(fieldOf(done.json, 'error')).toBe('bytes_mismatch');
    expect(await rowsOf(account)).toEqual([]);
    expect(await keysIn(`raw/${account}/`)).toEqual([]);
  });

  it('refuses a completion whose parts do not hash to the path, and leaves no object and no row', async () => {
    const { token, account } = await member();
    const bytes = transcript(Math.round(1.5 * MEGABYTE), 6);
    const other = await hex(transcript(10, 6));
    const parts = await sendParts(other, bytes, token);
    const done = await complete(other, parts, bytes.length, token);
    expect(done.status).toBe(422);
    expect(fieldOf(done.json, 'error')).toBe('hash_mismatch');
    expect(fieldOf(done.json, 'field')).toBe('sha256');
    expect(await rowsOf(account)).toEqual([]);
    expect(await keysIn(`raw/${account}/`)).toEqual([]);
    // The same parts under their own hash complete: the refusal cost the client nothing but the label.
    const hash = await hex(bytes);
    await sendParts(hash, bytes, token);
    expect((await complete(hash, parts, bytes.length, token)).status).toBe(201);
  }, 60_000);

  it('refuses a completion with no parts or bytes named', async () => {
    const { token } = await member();
    for (const body of ['{}', '{"parts":0,"bytes":5}', '{"parts":1}', '{"parts":1.5,"bytes":5}', 'not json']) {
      const done = await pool.send(`/v1/raw/${'c'.repeat(64)}/complete`, { method: 'POST', body }, token, grant);
      expect(done.status, body).toBe(400);
      expect(fieldOf(done.json, 'error')).toBe('missing_field');
    }
  });
});

describe('a ledger row, never the bytes', () => {
  it('holds one row per object: account, hash, bytes, versions, time', async () => {
    const { token, account } = await member();
    const bytes = transcript(5000, 6);
    const hash = await hex(bytes);
    const before = Date.now();
    await sendParts(hash, bytes, token);
    expect((await complete(hash, 1, bytes.length, token)).status).toBe(201);
    const [row] = await rowsOf(account);
    expect(row).toMatchObject({ account, sha256: hash, bytes: 5000, capture_version: 'cap-7', redaction_version: '1' });
    expect(Number(fieldOf(row, 'stored_at'))).toBeGreaterThanOrEqual(before);
  });

  it('puts no raw body in D1: no table, in any column, holds the transcript', async () => {
    const { token } = await member();
    const marker = 'RAW-MARKER-the-user-said-this-secret-sentence';
    const bytes = new TextEncoder().encode(`{"turn":"${marker}"}`.repeat(20));
    const hash = await hex(bytes);
    await sendParts(hash, bytes, token);
    expect((await complete(hash, 1, bytes.length, token)).status).toBe(201);
    const db = await pool.db();
    const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'").all()).results.map((row) => textOf(row, 'name'));
    expect(tables).toContain('raw_objects');
    for (const table of tables) {
      const dump = JSON.stringify((await db.prepare(`SELECT * FROM ${table}`).all()).results);
      expect(dump, table).not.toContain(marker);
      expect(dump, table).not.toContain(Buffer.from(marker).toString('base64'));
    }
    // The ledger table has no column that could hold a body.
    const columns = (await db.prepare("SELECT name FROM pragma_table_info('raw_objects')").all()).results.map((row) => textOf(row, 'name'));
    expect(columns.sort()).toEqual(['account', 'bytes', 'capture_version', 'redaction_version', 'sha256', 'stored_at']);
  });
});

describe('no limits on contribution', () => {
  it('takes every transcript from an account whose deposit limits are one row and one byte', async () => {
    const limited = await startPool({ MAX_DEPOSITS_PER_ACCOUNT: '1', MAX_DEPOSIT_BYTES_PER_ACCOUNT: '1' });
    try {
      next += 1;
      const { token, account } = await limited.signIn('github', stubUser(String(next)));
      await limited.post('/v1/covenant/accept', { version: 'v1' }, token);
      for (let at = 1; at <= 3; at += 1) {
        const bytes = transcript(2000 + at, at);
        const hash = await hex(bytes);
        expect((await limited.send(partPath(hash, 1), { method: 'PUT', body: bytes }, token, grant)).status).toBe(200);
        const done = await limited.send(`/v1/raw/${hash}/complete`, { method: 'POST', body: JSON.stringify({ parts: 1, bytes: bytes.length }) }, token, grant);
        expect(done.status).toBe(201);
      }
      expect(fieldOf(await (await limited.db()).prepare('SELECT COUNT(*) AS held FROM raw_objects WHERE account = ?').bind(account).first(), 'held')).toBe(3);
    } finally {
      await limited.dispose();
    }
  }, 60_000);
});
