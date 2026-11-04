import { describe, expect, it } from 'vitest';
import { VOCAB_VERSION, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { batchCounts, LEDGER_DAYS } from './access.js';
import { incrementsOf } from './ingest.js';
import { sampleSkeleton } from './sample.js';
import { fieldOf, startPool, stubUser, type TestPool, textOf } from './test-pool.js';

const PATH = `/bundle/2.1.314/${VOCAB_VERSION}`;
const DAY_MS = 24 * 60 * 60 * 1000;

const ONE = 1;
const NONE = 0;

const without = (skeleton: SessionSkeleton, part: 'prompts' | 'tools'): SessionSkeleton => ({ ...skeleton, transcripts: skeleton.transcripts.map((transcript) => ({ ...transcript, [part]: [] })) });

describe('batchCounts', () => {
  const cursor = sampleSkeleton('0000000000000001', undefined, undefined, 'cursor');
  const claude = sampleSkeleton('0000000000000002');

  it('counts a rooted tier for any harness, and a skeleton only when every harness writes no raw file', () => {
    for (const tier of ['committed', 'audited', 'attested'] as const) expect(batchCounts(tier, claude, ONE), tier).toBe(true);
    expect(batchCounts('skeleton', cursor, ONE)).toBe(true);
    expect(batchCounts('skeleton', claude, ONE)).toBe(false);
    expect(batchCounts('none', cursor, ONE)).toBe(false);
    expect(batchCounts('none', claude, ONE)).toBe(false);
  });

  it('holds a mixed batch to its strictest harness, subagents folded in', () => {
    const mixed: SessionSkeleton = { ...cursor, transcripts: [...cursor.transcripts, ...claude.transcripts.map((transcript) => ({ ...transcript, spawnedIn: 0 }))] };
    expect(batchCounts('skeleton', mixed, ONE)).toBe(false);
    expect(batchCounts('committed', mixed, ONE)).toBe(true);
  });

  it('needs one prompt and one tool step over the whole batch, and a cell increment written', () => {
    expect(batchCounts('committed', without(claude, 'prompts'), ONE)).toBe(false);
    expect(batchCounts('committed', without(claude, 'tools'), ONE)).toBe(false);
    expect(batchCounts('committed', claude, NONE)).toBe(false);
    expect(batchCounts('committed', claude, incrementsOf(claude).cells.size)).toBe(true);
  });

  it('finds the prompt in one transcript and the step in another', () => {
    const [main] = claude.transcripts;
    if (main === undefined) throw new Error('no transcript');
    const split: SessionSkeleton = { ...claude, transcripts: [{ ...main, tools: [] }, { ...main, spawnedIn: 0, prompts: [] }] };
    expect(batchCounts('committed', split, ONE)).toBe(true);
  });
});

describe('the access flag over the routes', () => {
  const accessOfAccount = async (pool: TestPool, account: string): Promise<unknown> => fieldOf(await (await pool.db()).prepare('SELECT access FROM accounts WHERE id = ?').bind(account).first(), 'access');

  const depositor = async (pool: TestPool, id: string, harness?: 'cursor'): Promise<{ token: string; account: string }> => {
    const signed = await pool.signIn('github', stubUser(id));
    await pool.post('/v1/covenant/accept', { version: 'v1' }, signed.token);
    expect((await pool.post('/v1/deposits', sampleSkeleton(id.padStart(16, '0'), undefined, undefined, harness), signed.token)).status).toBe(201);
    return signed;
  };

  const fetches = async (pool: TestPool, token: string, times: number): Promise<number[]> => {
    const statuses: number[] = [];
    for (let at = 0; at < times; at += 1) statuses.push((await pool.get(PATH, token)).status);
    return statuses;
  };

  // The default cap is one a week, so the second fetch is where access shows.
  const inPool = async (run: (pool: TestPool) => Promise<void>): Promise<void> => {
    const pool = await startPool({ FETCH_CAP: '' });
    try {
      await run(pool);
    } finally {
      await pool.dispose();
    }
  };

  it('does not lift the cap for a claude-code batch at the ingest tier, whatever the skeleton holds', async () => {
    await inPool(async (pool) => {
      const { token, account } = await depositor(pool, '3001');
      expect(await fetches(pool, token, 2)).toEqual([200, 429]);
      expect(await accessOfAccount(pool, account)).toBeNull();
    });
  }, 60_000);

  it('lifts it, pending, for a counting batch: a cursor batch with a prompt, a tool step, and a cell', async () => {
    await inPool(async (pool) => {
      const { token, account } = await depositor(pool, '3002', 'cursor');
      expect(await fetches(pool, token, 3)).toEqual([200, 200, 200]);
      expect(await accessOfAccount(pool, account)).toBe('pending');
      const row = await (await pool.db()).prepare('SELECT tier, counted_at AS counted FROM deposits WHERE account = ?').bind(account).first();
      expect(fieldOf(row, 'tier')).toBe('skeleton');
      expect(typeof fieldOf(row, 'counted')).toBe('number');
    });
  }, 60_000);

  it('lifts it for a batch at committed, set by a row edit since no wire carries a root yet', async () => {
    await inPool(async (pool) => {
      const { token, account } = await depositor(pool, '3003');
      await (await pool.db()).prepare("UPDATE deposits SET tier = 'committed', counted_at = ? WHERE account = ?").bind(Date.now(), account).run();
      expect(await fetches(pool, token, 2)).toEqual([200, 200]);
      expect(await accessOfAccount(pool, account)).toBe('pending');
    });
  }, 60_000);

  it('clears when every counting batch falls to none, and a resend does not bring it back', async () => {
    await inPool(async (pool) => {
      const { token, account } = await depositor(pool, '3004', 'cursor');
      expect(await fetches(pool, token, 2)).toEqual([200, 200]);
      await (await pool.db()).prepare("UPDATE deposits SET tier = 'none' WHERE account = ?").bind(account).run();
      expect(await fetches(pool, token, 2)).toEqual([200, 429]);
      expect(await accessOfAccount(pool, account)).toBeNull();
      expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000003004', undefined, undefined, 'cursor'), token)).status).toBe(201);
      expect(await fetches(pool, token, 1)).toEqual([429]);
    });
  }, 60_000);

  it('stays pending while one of two counting batches is left, and clears when the second falls to none', async () => {
    await inPool(async (pool) => {
      const { token, account } = await depositor(pool, '3007', 'cursor');
      expect((await pool.post('/v1/deposits', sampleSkeleton('00000000000a3007', undefined, undefined, 'cursor'), token)).status).toBe(201);
      const ids = (await (await pool.db()).prepare('SELECT id FROM deposits WHERE account = ? ORDER BY id').bind(account).all()).results.map((row) => textOf(row, 'id'));
      const [first, second] = ids;
      if (first === undefined || second === undefined) throw new Error('two batches were not stored');
      expect(await fetches(pool, token, 2)).toEqual([200, 200]);
      await (await pool.db()).prepare("UPDATE deposits SET tier = 'none' WHERE account = ? AND id = ?").bind(account, first).run();
      expect(await fetches(pool, token, 2)).toEqual([200, 200]);
      expect(await accessOfAccount(pool, account)).toBe('pending');
      await (await pool.db()).prepare("UPDATE deposits SET tier = 'none' WHERE account = ? AND id = ?").bind(account, second).run();
      expect(await fetches(pool, token, 2)).toEqual([200, 429]);
      expect(await accessOfAccount(pool, account)).toBeNull();
    });
  }, 60_000);

  it('clears the date when a resend no longer counts, so the cap comes back', async () => {
    await inPool(async (pool) => {
      const { token, account } = await depositor(pool, '3008', 'cursor');
      expect(await fetches(pool, token, 2)).toEqual([200, 200]);
      // The same id again on another day, now from a harness whose batch does not count at the ingest tier: it moves cells, so the date is judged again.
      expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000003008', undefined, '2026-11-02'), token)).status).toBe(201);
      const row = await (await pool.db()).prepare('SELECT counted_at AS counted FROM deposits WHERE account = ?').bind(account).first();
      expect(fieldOf(row, 'counted')).toBeNull();
      expect(await fetches(pool, token, 2)).toEqual([200, 429]);
      expect(await accessOfAccount(pool, account)).toBeNull();
    });
  }, 60_000);

  it('leaves the flag and the date alone when a resend writes no cell increment', async () => {
    await inPool(async (pool) => {
      const { token, account } = await depositor(pool, '3009');
      const sent = sampleSkeleton('0000000000003009');
      // A claude-code batch does not count at the ingest tier, so its row is raised by hand, as the root check will (Brief 2).
      await (await pool.db()).prepare("UPDATE deposits SET tier = 'committed', counted_at = ? WHERE account = ?").bind(Date.now() - DAY_MS, account).run();
      const before = await (await pool.db()).prepare('SELECT counted_at AS counted FROM deposits WHERE account = ?').bind(account).first();
      expect(typeof fieldOf(before, 'counted')).toBe('number');
      expect(await fetches(pool, token, 2)).toEqual([200, 200]);
      // The identical batch again nets no increment: nothing was written, so the date it had stays and the account keeps its access.
      expect((await pool.post('/v1/deposits', sent, token)).status).toBe(201);
      const after = await (await pool.db()).prepare('SELECT counted_at AS counted FROM deposits WHERE account = ?').bind(account).first();
      expect(fieldOf(after, 'counted')).toBe(fieldOf(before, 'counted'));
      expect(await fetches(pool, token, 2)).toEqual([200, 200]);
      expect(await accessOfAccount(pool, account)).toBe('pending');
    });
  }, 60_000);

  // `ledger_days` is 90 (spec Section 1.4): a batch that counted 89 days ago has not stood it yet.
  it('is still pending for a batch that counted 89 days ago', async () => {
    await inPool(async (pool) => {
      const { token, account } = await depositor(pool, '3010', 'cursor');
      await (await pool.db()).prepare('UPDATE deposits SET counted_at = ? WHERE account = ?').bind(Date.now() - 89 * DAY_MS, account).run();
      expect((await pool.get(PATH, token)).status).toBe(200);
      expect(await accessOfAccount(pool, account)).toBe('pending');
    });
  }, 60_000);

  it('stands once a counting batch has stood the ledger days, and stays when that batch later falls to none', async () => {
    await inPool(async (pool) => {
      const { token, account } = await depositor(pool, '3005', 'cursor');
      await (await pool.db()).prepare('UPDATE deposits SET counted_at = ? WHERE account = ?').bind(Date.now() - (LEDGER_DAYS + 1) * DAY_MS, account).run();
      expect((await pool.get(PATH, token)).status).toBe(200);
      expect(await accessOfAccount(pool, account)).toBe('standing');
      await (await pool.db()).prepare("UPDATE deposits SET tier = 'none' WHERE account = ?").bind(account).run();
      expect(await fetches(pool, token, 2)).toEqual([200, 200]);
      expect(await accessOfAccount(pool, account)).toBe('standing');
    });
  }, 60_000);

  it('keeps the first date a batch counted when the client sends it again, so it can reach standing', async () => {
    await inPool(async (pool) => {
      const { token, account } = await depositor(pool, '3006', 'cursor');
      await (await pool.db()).prepare('UPDATE deposits SET counted_at = ? WHERE account = ?').bind(1_000, account).run();
      expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000003006', undefined, undefined, 'cursor'), token)).status).toBe(201);
      const row = await (await pool.db()).prepare('SELECT counted_at AS counted FROM deposits WHERE account = ?').bind(account).first();
      expect(fieldOf(row, 'counted')).toBe(1_000);
    });
  }, 60_000);
});
