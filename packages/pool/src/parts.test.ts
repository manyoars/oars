// A session past the request cap deposits in parts that the server keeps as one deposit (t880).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bigSkeleton } from '../../cli/src/sessions/pool-fixture.js';
import { canonicalBytes, partsOf } from '../../cli/src/sessions/pool-outbox.js';
import { parseSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { receivePart } from './parts.js';
import type { Bound, Env } from './http.js';
import { startPool, stubUser, type Answer, type TestPool } from './test-pool.js';

const CAP = 1024 * 1024;

const signedIn = async (pool: TestPool, id: string): Promise<string> => {
  const { token } = await pool.signIn('github', stubUser(id));
  await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
  return token;
};

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const partHeaders = (hash: string, index: number, count: number): { [name: string]: string } => ({ 'oars-batch': hash, 'oars-part': `${String(index)}/${String(count)}` });

const rows = async (pool: TestPool, sql: string): Promise<unknown> => (await pool.db()).prepare(sql).first('count');

describe('a deposit past the request cap', () => {
  const big = canonicalBytes(bigSkeleton('0000000000000001', 5000));
  const hash = sha(big);

  const sendParts = async (pool: TestPool, token: string, parts: readonly string[], order: readonly number[]): Promise<Answer[]> => {
    const answers: Answer[] = [];
    for (const at of order) answers.push(await pool.post('/v1/deposits', parts[at] ?? '', token, partHeaders(hash, at + 1, parts.length)));
    return answers;
  };

  it('is still refused whole, so the request cap stays a cap on one request', async () => {
    const pool = await startPool();
    try {
      expect(big.length).toBeGreaterThan(CAP);
      expect((await pool.post('/v1/deposits', big, await signedIn(pool, '9001'))).status).toBe(413);
    } finally {
      await pool.dispose();
    }
  }, 60_000);

  it('round trips in parts as one deposit, with no loss and no double count, and a retried part changes nothing', async () => {
    const pool = await startPool();
    try {
      const token = await signedIn(pool, '9002');
      const parts = partsOf(big);
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThan(CAP);
      expect(parts.join('')).toBe(big);
      const answers = await sendParts(pool, token, parts, parts.map((_, at) => at));
      expect(answers.slice(0, -1).map((answer) => answer.status)).toEqual(parts.slice(1).map(() => 202));
      expect(answers.at(-1)).toMatchObject({ status: 201, json: { ok: true, id: '0000000000000001' } });
      const db = await pool.db();
      expect(await rows(pool, 'SELECT COUNT(*) AS count FROM deposits')).toBe(1);
      const parsed = parseSkeleton(JSON.parse(big));
      if (!parsed.ok) throw new Error('the fixture does not parse');
      expect(await db.prepare('SELECT skeleton FROM deposits').first('skeleton')).toBe(JSON.stringify(parsed.skeleton));
      const counted = (): Promise<unknown> => db.prepare('SELECT COALESCE(SUM(sessions), 0) AS count FROM cells').first('count');
      const once = await counted();
      expect(once).toBeGreaterThan(0);
      // The same parts again, first and last: the server answers from the finished deposit and writes nothing.
      const again = await sendParts(pool, token, parts, [0, parts.length - 1, 0]);
      expect(again.map((answer) => answer.status)).toEqual([201, 201, 201]);
      expect(await rows(pool, 'SELECT COUNT(*) AS count FROM deposits')).toBe(1);
      expect(await counted()).toBe(once);
      expect(await rows(pool, "SELECT COUNT(*) AS count FROM deposit_parts WHERE body <> ''")).toBe(0);
    } finally {
      await pool.dispose();
    }
  }, 120_000);

  it('takes its parts in any order, and waits while one is missing', async () => {
    const pool = await startPool();
    try {
      const token = await signedIn(pool, '9003');
      const parts = partsOf(big);
      const order = parts.map((_, at) => at).reverse();
      const answers = await sendParts(pool, token, parts, order.slice(0, -1));
      expect(answers.map((answer) => answer.status)).toEqual(order.slice(0, -1).map(() => 202));
      expect(answers.at(-1)).toMatchObject({ json: { ok: true, pending: 1 } });
      expect(await rows(pool, 'SELECT COUNT(*) AS count FROM deposits')).toBe(0);
      expect((await sendParts(pool, token, parts, order.slice(-1)))[0]?.status).toBe(201);
      expect(await rows(pool, 'SELECT COUNT(*) AS count FROM deposits')).toBe(1);
    } finally {
      await pool.dispose();
    }
  }, 120_000);

  it('refuses parts that do not add up to the batch they name, and forgets them', async () => {
    const pool = await startPool();
    try {
      const token = await signedIn(pool, '9004');
      const parts = partsOf(big);
      const bad = (index: number, count: number, batch: string = hash): Promise<Answer> => pool.post('/v1/deposits', 'x', token, partHeaders(batch, index, count));
      for (const [index, count] of [[0, 2], [3, 2], [1, 9], [1, 0]] as const) expect(await bad(index, count)).toMatchObject({ status: 400, json: { error: 'bad_part' } });
      expect(await bad(1, 2, 'not-a-hash')).toMatchObject({ status: 400, json: { error: 'bad_part' } });
      expect(await pool.post('/v1/deposits', 'x', token, { 'oars-part': '1/2' })).toMatchObject({ status: 400, json: { error: 'bad_part' } });
      // A second part that says another count than the first is not part of the same batch.
      expect((await bad(1, 2)).status).toBe(202);
      expect(await bad(2, 3)).toMatchObject({ status: 400, json: { error: 'bad_part' } });
      // The whole batch under a hash it does not have.
      const wrong = sha('another batch');
      const answers: Answer[] = [];
      for (const [at, part] of parts.entries()) answers.push(await pool.post('/v1/deposits', part, token, partHeaders(wrong, at + 1, parts.length)));
      expect(answers.at(-1)).toMatchObject({ status: 400, json: { error: 'part_mismatch' } });
      expect(await rows(pool, 'SELECT COUNT(*) AS count FROM deposits')).toBe(0);
      expect(await rows(pool, `SELECT COUNT(*) AS count FROM deposit_parts WHERE batch = '${wrong}'`)).toBe(0);
    } finally {
      await pool.dispose();
    }
  }, 120_000);

  it('writes nothing for a part naming another count: the batch is forgotten, and the full, correct parts of that hash then finish', async () => {
    const pool = await startPool();
    try {
      const token = await signedIn(pool, '9006');
      const parts = partsOf(big);
      // A client with another part size got part 1 of 2 staged before this one arrived.
      expect((await pool.post('/v1/deposits', 'x', token, partHeaders(hash, 1, 2))).status).toBe(202);
      expect(await pool.post('/v1/deposits', parts[0] ?? '', token, partHeaders(hash, 1, parts.length))).toMatchObject({ status: 400, json: { error: 'bad_part' } });
      expect(await rows(pool, `SELECT COUNT(*) AS count FROM deposit_parts WHERE batch = '${hash}'`)).toBe(0);
      const answers = await sendParts(pool, token, parts, parts.map((_, at) => at));
      expect(answers.slice(0, -1).map((answer) => answer.status)).toEqual(parts.slice(1).map(() => 202));
      expect(answers.at(-1)).toMatchObject({ status: 201, json: { ok: true, id: '0000000000000001' } });
      expect(await rows(pool, 'SELECT COUNT(*) AS count FROM deposits')).toBe(1);
      // Once the deposit is finished, a part naming another count is still answered from it and forgets nothing.
      expect((await pool.post('/v1/deposits', 'x', token, partHeaders(hash, 1, 2))).status).toBe(201);
      expect(await rows(pool, `SELECT COUNT(*) AS count FROM deposit_parts WHERE batch = '${hash}' AND deposit IS NOT NULL`)).toBe(parts.length);
    } finally {
      await pool.dispose();
    }
  }, 120_000);

  it('answers a part sent twice before the batch is complete the same both times, keeps one row for it, and still makes one deposit', async () => {
    const pool = await startPool();
    try {
      const token = await signedIn(pool, '9007');
      const parts = partsOf(big);
      const answers = await sendParts(pool, token, parts, [0, 0, ...parts.map((_, at) => at).slice(1)]);
      expect(answers.slice(0, 2).map((answer) => answer.status)).toEqual([202, 202]);
      expect(answers.slice(0, 2)[0]).toEqual(answers.slice(0, 2)[1]);
      expect(answers.at(-1)).toMatchObject({ status: 201 });
      expect(await rows(pool, 'SELECT COUNT(*) AS count FROM deposits')).toBe(1);
      expect(await rows(pool, `SELECT COUNT(*) AS count FROM deposit_parts WHERE batch = '${hash}' AND part = 1`)).toBe(1);
    } finally {
      await pool.dispose();
    }
  }, 120_000);

  it('refuses at once the part that takes the staged bytes past the join cap, and keeps nothing of the batch', async () => {
    const pool = await startPool();
    try {
      const token = await signedIn(pool, '9008');
      const piece = 'x'.repeat(1_000_000);
      const batch = sha('a batch that will not fit');
      expect((await pool.post('/v1/deposits', piece, token, partHeaders(batch, 1, 3))).status).toBe(202);
      expect(await rows(pool, `SELECT COUNT(*) AS count FROM deposit_parts WHERE batch = '${batch}'`)).toBe(1);
      // 2,000,000 staged bytes cannot join under 1,800,000, so the second part is refused before the third is sent.
      expect(await pool.post('/v1/deposits', piece, token, partHeaders(batch, 2, 3))).toMatchObject({ status: 413, json: { error: 'too_large' } });
      expect(await rows(pool, `SELECT COUNT(*) AS count FROM deposit_parts WHERE batch = '${batch}'`)).toBe(0);
    } finally {
      await pool.dispose();
    }
  }, 120_000);

  it('never stores a join past the cap when two parts of one batch arrive together, however their checks interleave', async () => {
    const pool = await startPool();
    try {
      const token = await signedIn(pool, '9009');
      const piece = 'x'.repeat(1_000_000);
      const batch = sha('two parts at once');
      const answers = await Promise.all([1, 2].map((at) => pool.post('/v1/deposits', piece, token, partHeaders(batch, at, 2))));
      // Whichever part's check ran first may have answered 202 before the other arrived; the other refuses, and the batch is gone.
      expect(answers.map((answer) => answer.status).sort()).toContain(413);
      for (const answer of answers) expect([202, 413]).toContain(answer.status);
      expect(await rows(pool, 'SELECT COUNT(*) AS count FROM deposits')).toBe(0);
      expect(await rows(pool, `SELECT COUNT(*) AS count FROM deposit_parts WHERE batch = '${batch}'`)).toBe(0);
    } finally {
      await pool.dispose();
    }
  }, 120_000);

  it('keeps nothing staged past the join cap when parts of an unfinished batch land between a part first read and its insert', async () => {
    // Miniflare runs one request at a time here, so the interleave is scripted: a stand-in for D1 that lets the other parts land right after this part's first read.
    const staged: { part: number; body: string }[] = [];
    const piece = 'x'.repeat(1_000_000);
    let reads = 0;
    const prepare = (sql: string) => ({
      bind: (...values: (string | number | null)[]): Bound => ({
        first: () => Promise.resolve(null),
        all: () => {
          reads += 1;
          const seen = staged.map((row) => ({ part: row.part, count: 3, body: row.body, deposit: null }));
          if (reads === 1) staged.push({ part: 2, body: piece });
          return Promise.resolve({ results: seen });
        },
        run: () => {
          if (sql.startsWith('INSERT')) staged.push({ part: Number(values[2]), body: String(values[4]) });
          if (sql.startsWith('DELETE')) staged.length = 0;
          return Promise.resolve({ meta: { changes: 1 } });
        },
      }),
    });
    const request = new Request('http://pool.test/v1/deposits', { method: 'POST', headers: partHeaders(sha('three parts, one read behind'), 1, 3), body: piece });
    const env: Env = { DB: { prepare, batch: () => Promise.resolve([]) } };
    const answered = await receivePart(request, env, 'account', piece, () => Promise.resolve(new Response('stored', { status: 201 })));
    // Part 2 landed after part 1 read nothing: both bodies now sit staged, and 2,000,000 bytes cannot join under 1,800,000.
    expect(answered.status).toBe(413);
    expect(staged).toEqual([]);
  });

  it('is refused past what one stored row can hold, and a body that is not a skeleton is refused by name', async () => {
    const pool = await startPool();
    try {
      const token = await signedIn(pool, '9005');
      const huge = 'x'.repeat(2_000_000);
      const pieces = [huge.slice(0, 1_000_000), huge.slice(1_000_000)];
      const send = async (whole: string, split: readonly string[]): Promise<Answer[]> => {
        const batch = sha(whole);
        const answers: Answer[] = [];
        for (const [at, piece] of split.entries()) answers.push(await pool.post('/v1/deposits', piece, token, partHeaders(batch, at + 1, split.length)));
        return answers;
      };
      expect((await send(huge, pieces)).at(-1)).toMatchObject({ status: 413, json: { error: 'too_large' } });
      expect((await send('not json', ['not ', 'json'])).at(-1)).toMatchObject({ status: 400, json: { error: 'closed_vocabulary' } });
      expect(await rows(pool, 'SELECT COUNT(*) AS count FROM deposit_parts')).toBe(0);
    } finally {
      await pool.dispose();
    }
  }, 120_000);
});

describe('partsOf', () => {
  it('splits on characters, each part within the byte limit, and joins back to the batch', () => {
    const text = 'a€😀b'.repeat(50);
    for (const limit of [4, 5, 7, 64]) {
      const parts = partsOf(text, limit);
      expect(parts.join('')).toBe(text);
      for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(limit);
    }
    expect(partsOf('short')).toEqual(['short']);
    expect(partsOf('')).toEqual(['']);
  });
});
