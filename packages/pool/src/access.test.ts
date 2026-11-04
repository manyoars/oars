import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { VOCAB_VERSION, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { batchCounts, batchTier, LEDGER_DAYS } from './access.js';
import { incrementsOf } from './ingest.js';
import { sampleSkeleton } from './sample.js';
import { fieldOf, startPool, stubUser, type TestPool, textOf } from './test-pool.js';

const PATH = `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`;
const DAY_MS = 24 * 60 * 60 * 1000;

const ONE = 1;
const NONE = 0;

const without = (skeleton: SessionSkeleton, part: 'prompts' | 'tools'): SessionSkeleton => ({ ...skeleton, transcripts: skeleton.transcripts.map((transcript) => ({ ...transcript, [part]: [] })) });

const EMPTY_ROOT = createHash('sha256').update('').digest('hex');

const withRoot = (skeleton: SessionSkeleton, root: { merkleRoot: string; leaves: number }): SessionSkeleton => ({ ...skeleton, transcripts: skeleton.transcripts.map((transcript) => ({ ...transcript, ...root })) });

describe('batchTier', () => {
  const claude = sampleSkeleton('0000000000000002');
  const cursor = sampleSkeleton('0000000000000001', undefined, undefined, 'cursor');

  it('is committed for a claude-code batch that carries roots, and skeleton for a harness that writes no raw file', () => {
    expect(batchTier(claude)).toBe('committed');
    expect(batchTier(cursor)).toBe('skeleton');
  });

  it('is the lowest tier of its transcripts, subagents folded in', () => {
    const [main] = claude.transcripts;
    const [other] = cursor.transcripts;
    if (main === undefined || other === undefined) throw new Error('no transcript');
    expect(batchTier({ ...claude, transcripts: [main, other] })).toBe('skeleton');
    expect(batchTier({ ...claude, transcripts: [main, { ...main, leaves: 0 }] })).toBe('none');
    expect(batchTier({ ...cursor, transcripts: [other, { ...other, leaves: 0 }] })).toBe('none');
  });

  it('is none for a root that cannot be real: no leaves without the empty hash, or the empty hash with leaves', () => {
    const real = { merkleRoot: createHash('sha256').update('x').digest('hex'), leaves: 12 };
    expect(batchTier(withRoot(claude, real))).toBe('committed');
    expect(batchTier(withRoot(claude, { ...real, leaves: 0 }))).toBe('none');
    expect(batchTier(withRoot(claude, { merkleRoot: EMPTY_ROOT, leaves: 12 }))).toBe('none');
    expect(batchTier(withRoot(claude, { merkleRoot: EMPTY_ROOT, leaves: 0 }))).toBe('committed');
  });
});

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
    const mixed: SessionSkeleton = { ...cursor, transcripts: [...cursor.transcripts, ...claude.transcripts.map((transcript) => ({ ...transcript }))] };
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
    const split: SessionSkeleton = { ...claude, transcripts: [{ ...main, tools: [] }, { ...main, prompts: [] }] };
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

  const tierOf = async (pool: TestPool, account: string): Promise<unknown> => fieldOf(await (await pool.db()).prepare('SELECT tier FROM deposits WHERE account = ?').bind(account).first(), 'tier');

  it('lifts the cap, pending, for a claude-code batch with one prompt and one tool step over the whole batch', async () => {
    await inPool(async (pool) => {
      const { token, account } = await depositor(pool, '3001');
      expect(await fetches(pool, token, 3)).toEqual([200, 200, 200]);
      expect(await accessOfAccount(pool, account)).toBe('pending');
      expect(await tierOf(pool, account)).toBe('committed');
    });
  }, 60_000);

  it('does not lift the cap for a claude-code batch without a tool step', async () => {
    await inPool(async (pool) => {
      const signed = await pool.signIn('github', stubUser('3011'));
      await pool.post('/v1/covenant/accept', { version: 'v1' }, signed.token);
      expect((await pool.post('/v1/deposits', without(sampleSkeleton('0000000000003011'), 'tools'), signed.token)).status).toBe(201);
      expect(await fetches(pool, signed.token, 2)).toEqual([200, 429]);
    });
  }, 60_000);

  it('writes none for a batch whose root cannot be real, and the cap stays', async () => {
    await inPool(async (pool) => {
      const signed = await pool.signIn('github', stubUser('3012'));
      await pool.post('/v1/covenant/accept', { version: 'v1' }, signed.token);
      const failed = withRoot(sampleSkeleton('0000000000003012'), { merkleRoot: createHash('sha256').update('x').digest('hex'), leaves: 0 });
      expect((await pool.post('/v1/deposits', failed, signed.token)).status).toBe(201);
      const { account } = signed;
      expect(await tierOf(pool, account)).toBe('none');
      expect(await fetches(pool, signed.token, 2)).toEqual([200, 429]);
      expect(await accessOfAccount(pool, account)).toBeNull();
    });
  }, 60_000);

  it('keeps the rule on a resend: the tier of the row follows the batch sent last', async () => {
    await inPool(async (pool) => {
      const { token, account } = await depositor(pool, '3013');
      expect(await tierOf(pool, account)).toBe('committed');
      const failed = withRoot(sampleSkeleton('0000000000003013'), { merkleRoot: createHash('sha256').update('x').digest('hex'), leaves: 0 });
      expect((await pool.post('/v1/deposits', failed, token)).status).toBe(201);
      expect(await tierOf(pool, account)).toBe('none');
      expect(await fetches(pool, token, 2)).toEqual([200, 429]);
      expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000003013'), token)).status).toBe(201);
      expect(await tierOf(pool, account)).toBe('committed');
      expect(await fetches(pool, token, 2)).toEqual([200, 200]);
    });
  }, 60_000);

  it('counts a batch first ingested at none once a resend fixes its root, though its cells are unchanged', async () => {
    await inPool(async (pool) => {
      const signed = await pool.signIn('github', stubUser('3014'));
      await pool.post('/v1/covenant/accept', { version: 'v1' }, signed.token);
      const failed = withRoot(sampleSkeleton('0000000000003014'), { merkleRoot: createHash('sha256').update('x').digest('hex'), leaves: 0 });
      expect((await pool.post('/v1/deposits', failed, signed.token)).status).toBe(201);
      expect(await tierOf(pool, signed.account)).toBe('none');
      expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000003014'), signed.token)).status).toBe(201);
      expect(await tierOf(pool, signed.account)).toBe('committed');
      expect(await fetches(pool, signed.token, 2)).toEqual([200, 200]);
      expect(await accessOfAccount(pool, signed.account)).toBe('pending');
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

  it('clears when every counting batch falls to none, and a resend that still fails does not bring it back', async () => {
    await inPool(async (pool) => {
      const { token, account } = await depositor(pool, '3004', 'cursor');
      expect(await fetches(pool, token, 2)).toEqual([200, 200]);
      const failed = withRoot(sampleSkeleton('0000000000003004', undefined, undefined, 'cursor'), { merkleRoot: createHash('sha256').update('x').digest('hex'), leaves: 0 });
      expect((await pool.post('/v1/deposits', failed, token)).status).toBe(201);
      expect(await tierOf(pool, account)).toBe('none');
      expect(await fetches(pool, token, 2)).toEqual([200, 429]);
      expect(await accessOfAccount(pool, account)).toBeNull();
      expect((await pool.post('/v1/deposits', failed, token)).status).toBe(201);
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
      // The same id again on another day, now with a root that cannot be real: it moves cells, so the date is judged again and the batch no longer counts.
      const failed = withRoot(sampleSkeleton('0000000000003008', undefined, '2026-11-02'), { merkleRoot: createHash('sha256').update('x').digest('hex'), leaves: 0 });
      expect((await pool.post('/v1/deposits', failed, token)).status).toBe(201);
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
      // Move the date back, so a rewrite of it would show.
      await (await pool.db()).prepare('UPDATE deposits SET counted_at = ? WHERE account = ?').bind(Date.now() - DAY_MS, account).run();
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
