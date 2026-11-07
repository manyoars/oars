// A session past the request cap deposits in parts that the server keeps as one deposit (t880).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { frame, printOf, prompt, session, sessionsFrom, step, storedNames, store, tool } from '../../cli/src/sessions/pool-fixture.js';
import { canonicalBytes, partsOf } from '../../cli/src/sessions/pool-outbox.js';
import { parseSkeleton, skeletonOf, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { receivePart } from './parts.js';
import type { Bound, Env } from './http.js';
import { startPool, stubUser, type Answer, type TestPool } from './test-pool.js';

const CAP = 1024 * 1024;

/** One session with `calls` shell calls: each a few hundred bytes of skeleton, so a few thousand pass the request cap. */
const bigSkeleton = (id: string, calls: number): SessionSkeleton => {
  const framed = frame({ shell: 'bash' });
  const shell = (n: number) => step(n, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: [] } });
  const [only] = sessionsFrom(
    store({
      sessions: [session('s1', { frame: framed })],
      prompts: [prompt('s1', 0, { frame: framed })],
      tools: Array.from({ length: calls }, (_, n) => tool('s1', n, 'Bash', { steps: [shell(n)] })),
    }),
  );
  const built = only === undefined ? null : skeletonOf(only, id, storedNames, printOf);
  if (built === null) throw new Error('no skeleton');
  return built;
};

const signedIn = async (pool: TestPool, id: string): Promise<string> => {
  const { token } = await pool.signIn('github', stubUser(id));
  await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
  return token;
};

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const partHeaders = (hash: string, index: number, count: number): { [name: string]: string } => ({ 'oars-batch': hash, 'oars-part': `${String(index)}/${String(count)}` });

/** The one text a `SELECT body` row holds. */
const bodyText = (row: unknown): string => (typeof row === 'object' && row !== null && 'body' in row && typeof row.body === 'string' ? row.body : '');

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
    // A staged part is sealed text: the base64 of a 12-byte IV, the piece, and a 16-byte tag. The stand-in never opens it, only counts its bytes.
    const sealedLike = Buffer.alloc(1_000_028).toString('base64');
    let reads = 0;
    const prepare = (sql: string) => ({
      bind: (...values: (string | number | null)[]): Bound => ({
        first: () => Promise.resolve(null),
        all: () => {
          reads += 1;
          const seen = staged.map((row) => ({ part: row.part, count: 3, body: row.body, deposit: null }));
          if (reads === 1) staged.push({ part: 2, body: sealedLike });
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
    const answered = await receivePart(request, env, 'account', 'a-secret', piece, () => Promise.resolve(new Response('stored', { status: 201 })));
    // Part 2 landed after part 1 read nothing: both bodies now sit staged, and 2,000,000 bytes cannot join under 1,800,000.
    expect(answered.status).toBe(413);
    expect(staged).toEqual([]);
  });

  it('refuses a join whose staged part was sealed under another key as a part_mismatch, and keeps nothing staged; the same parts under one key join', async () => {
    // A stand-in for the one table the parts path touches, so the two secrets meet in one batch without a deploy changing its secret mid-test.
    interface Row {
      part: number;
      count: number;
      body: string;
      deposit: string | null;
    }
    const staging = (): { env: Env; rows: Row[] } => {
      const rows: Row[] = [];
      const prepare = (sql: string) => ({
        bind: (...values: (string | number | null)[]): Bound => ({
          first: () => Promise.resolve(null),
          all: () => Promise.resolve({ results: [...rows].sort((a, b) => a.part - b.part) }),
          run: () => {
            if (sql.startsWith('INSERT')) rows.push({ part: Number(values[2]), count: Number(values[3]), body: String(values[4]), deposit: null });
            if (sql.startsWith('DELETE')) rows.length = 0;
            return Promise.resolve({ meta: { changes: 1 } });
          },
        }),
      });
      return { env: { DB: { prepare, batch: () => Promise.resolve([]) } }, rows };
    };
    const parts = ['{"a":', '1}'];
    const batch = sha(parts.join(''));
    const send = (env: Env, secret: string, index: number, joined: string[]): Promise<Response> =>
      receivePart(new Request('http://pool.test/v1/deposits', { method: 'POST', headers: partHeaders(batch, index, 2), body: parts[index - 1] ?? '' }), env, 'account', secret, parts[index - 1] ?? '', (text) => {
        joined.push(text);
        return Promise.resolve(Response.json({ ok: true, id: 'deposit-1' }, { status: 201 }));
      });

    const apart = staging();
    const refusedJoin: string[] = [];
    expect((await send(apart.env, 'secret-a', 1, refusedJoin)).status).toBe(202);
    expect(apart.rows).toHaveLength(1);
    const refused = await send(apart.env, 'secret-b', 2, refusedJoin);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'part_mismatch' });
    expect(apart.rows).toEqual([]);
    expect(refusedJoin).toEqual([]);

    const together = staging();
    const joined: string[] = [];
    expect((await send(together.env, 'secret-a', 1, joined)).status).toBe(202);
    expect((await send(together.env, 'secret-a', 2, joined)).status).toBe(201);
    expect(joined).toEqual([parts.join('')]);
  });

  it('stages no host in clear: a host in an early part is unreadable in every deposit_parts row until the join (t907)', async () => {
    const pool = await startPool();
    try {
      const token = await signedIn(pool, '9010');
      const host = 'private-host.internal.example.com';
      const batch = sha('a batch with a host in its first part');
      const early = `{"identity":{"host":"${host}"},"hostLiteral":"${host}"`;
      expect((await pool.post('/v1/deposits', early, token, partHeaders(batch, 1, 3))).status).toBe(202);
      expect((await pool.post('/v1/deposits', ',"more":1', token, partHeaders(batch, 2, 3))).status).toBe(202);
      const db = await pool.db();
      const staged = (await db.prepare('SELECT body FROM deposit_parts').all()).results;
      expect(staged).toHaveLength(2);
      for (const row of staged) {
        const body = bodyText(row);
        expect(body).not.toContain(host);
        expect(body).not.toContain(early.slice(0, 12));
      }
    } finally {
      await pool.dispose();
    }
  }, 120_000);

  it('seals each staged part under its own IV, so the same text staged twice reads differently', async () => {
    const pool = await startPool();
    try {
      const token = await signedIn(pool, '9011');
      const piece = 'x'.repeat(64);
      const batch = sha(piece + piece);
      await pool.post('/v1/deposits', piece, token, partHeaders(batch, 1, 3));
      await pool.post('/v1/deposits', piece, token, partHeaders(batch, 2, 3));
      const bodies = (await (await pool.db()).prepare('SELECT body FROM deposit_parts ORDER BY part').all()).results.map(bodyText);
      expect(bodies[0]).not.toBe(bodies[1]);
    } finally {
      await pool.dispose();
    }
  }, 120_000);

  it('refuses a join whose staged part was tampered with, or never sealed, as a part_mismatch, and forgets the batch', async () => {
    const pool = await startPool();
    try {
      const token = await signedIn(pool, '9012');
      const parts = ['{"a":', '1}'];
      const batch = sha(parts.join(''));
      expect((await pool.post('/v1/deposits', parts[0] ?? '', token, partHeaders(batch, 1, 2))).status).toBe(202);
      const db = await pool.db();
      const sealed = String(await db.prepare('SELECT body FROM deposit_parts WHERE part = 1').first('body'));
      // Flip one character of the sealed text: the tag no longer verifies.
      const flipped = `${sealed.slice(0, -2)}${sealed.at(-2) === 'A' ? 'B' : 'A'}${sealed.slice(-1)}`;
      await db.prepare('UPDATE deposit_parts SET body = ? WHERE part = 1').bind(flipped).run();
      expect(await pool.post('/v1/deposits', parts[1] ?? '', token, partHeaders(batch, 2, 2))).toMatchObject({ status: 400, json: { error: 'part_mismatch' } });
      expect(await rows(pool, `SELECT COUNT(*) AS count FROM deposit_parts WHERE batch = '${batch}'`)).toBe(0);
      // Text that is not a sealed part at all fails the same way.
      expect((await pool.post('/v1/deposits', parts[0] ?? '', token, partHeaders(batch, 1, 2))).status).toBe(202);
      await db.prepare('UPDATE deposit_parts SET body = ? WHERE part = 1').bind('{"a":').run();
      expect(await pool.post('/v1/deposits', parts[1] ?? '', token, partHeaders(batch, 2, 2))).toMatchObject({ status: 400, json: { error: 'part_mismatch' } });
    } finally {
      await pool.dispose();
    }
  }, 120_000);

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
