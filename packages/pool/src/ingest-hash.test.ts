// Item 3 of t881: a host is replaced by an HMAC under the pool's `INGEST_HASH_KEY` before anything is written, so no stored row holds it, and an unset key refuses the deposit.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { textField } from './http.js';
import { sampleSkeleton } from './sample.js';
import { startPool, stubUser, type Answer, type TestPool } from './test-pool.js';

const HOST = 'internal.corp.example';
const LITERAL_HOST = 'literal.corp.example';
const NESTED_HOST = 'nested.corp.example';

/** A sample deposit whose first tool's steps are web fetches: one names the host, one sends `other` with a literal, and one carries an unknown field that holds a host at depth. */
const withHosts = (id: string, host = HOST): unknown => {
  const sample = sampleSkeleton(id);
  const [transcript] = sample.transcripts;
  const [tool, ...rest] = transcript?.tools ?? [];
  const [first] = tool?.steps ?? [];
  if (transcript === undefined || tool === undefined || first === undefined) throw new Error('the sample holds no step');
  const fetched = { ...first, action: 'web.fetch', native: 'WebFetch' };
  const steps = [{ ...fetched, identity: { host } }, { ...fetched, identity: { host: 'other', hostLiteral: LITERAL_HOST } }, { ...fetched, identity: { host: null }, mirror: { host: NESTED_HOST, list: [{ hostLiteral: NESTED_HOST }] } }];
  return { ...sample, transcripts: [{ ...transcript, tools: [{ ...tool, steps }, ...rest] }] };
};

const signedIn = async (pool: TestPool, id: string): Promise<string> => {
  const { token } = await pool.signIn('github', stubUser(id));
  await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
  return token;
};

/** Every stored value of every table, as one text. */
const everythingStored = async (pool: TestPool): Promise<string> => {
  const db = await pool.db();
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all();
  const parts: string[] = [];
  for (const table of tables.results) parts.push(JSON.stringify((await db.prepare(`SELECT * FROM "${textField(table, 'name') ?? ''}"`).all()).results));
  return parts.join('\n');
};

describe('a host at ingest', () => {
  let pool: TestPool;
  beforeAll(async () => {
    pool = await startPool();
  }, 60_000);
  afterAll(async () => {
    await pool.dispose();
  });

  it('is stored as a hash in the rows, the literal, and the bag, and never in clear', async () => {
    const token = await signedIn(pool, '7001');
    expect((await pool.post('/v1/deposits', withHosts('0000000000000001'), token)).status).toBe(201);
    const stored = await everythingStored(pool);
    for (const clear of [HOST, LITERAL_HOST, NESTED_HOST]) expect(stored).not.toContain(clear);
    // The stored text is JSON inside JSON; the escapes come out before the shapes are matched.
    const flat = stored.replaceAll(String.fromCharCode(92), '');
    expect(flat).toMatch(/"host":"h:[0-9a-f]{64}/);
    expect(flat).toMatch(/hostLiteral","kind":"literal","value":"h:[0-9a-f]{64}/);
    // `other` names no host, so it is not hashed.
    expect(flat).toMatch(/"host":"other"/);
  });

  it('hashes one host to one value across accounts, and two hosts to two', async () => {
    const first = await signedIn(pool, '7002');
    const second = await signedIn(pool, '7003');
    expect((await pool.post('/v1/deposits', withHosts('0000000000000002'), first)).status).toBe(201);
    expect((await pool.post('/v1/deposits', withHosts('0000000000000003'), second)).status).toBe(201);
    expect((await pool.post('/v1/deposits', withHosts('0000000000000004', 'other.corp.example'), second)).status).toBe(201);
    const db = await pool.db();
    const hostOf = async (id: string): Promise<string> => {
      const row = await db.prepare('SELECT skeleton FROM deposits WHERE id = ?').bind(id).first('skeleton');
      return /"host":"(h:[0-9a-f]{64})"/.exec(typeof row === 'string' ? row : '')?.[1] ?? '';
    };
    const [a, b, c] = [await hostOf('0000000000000002'), await hostOf('0000000000000003'), await hostOf('0000000000000004')];
    expect(a).not.toBe('');
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});

describe('a pool with no INGEST_HASH_KEY', () => {
  it('refuses the deposit as not configured and writes nothing', async () => {
    const bare = await startPool({ INGEST_HASH_KEY: '' });
    try {
      const token = await signedIn(bare, '7004');
      const answer: Answer = await bare.post('/v1/deposits', withHosts('0000000000000005'), token);
      expect(answer).toMatchObject({ status: 503, json: { error: 'not_configured' } });
      expect(JSON.stringify(answer.json)).toContain('INGEST_HASH_KEY');
      const db = await bare.db();
      expect(await db.prepare('SELECT COUNT(*) AS count FROM deposits').first('count')).toBe(0);
      expect(await everythingStored(bare)).not.toContain(HOST);
    } finally {
      await bare.dispose();
    }
  }, 60_000);
});
