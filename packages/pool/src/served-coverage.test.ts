// A served cell carries how many of its prompts and sessions recorded input (t921), so the cost read divides by those and not by every settled prompt (V7: an unrecorded field is absent, never a measured zero).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyBundle, VOCAB_VERSION } from '../../cli/src/sessions/pool-wire.js';
import { poolOf } from '../../cli/src/sessions/cells.js';
import { deriveCost } from '../../cli/src/sessions/read-cost.js';
import { bucketOf, floorOf, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { store } from '../../cli/src/sessions/pool-fixture.js';
import type { Env } from './http.js';
import { sampleSkeleton } from './sample.js';
import { storedOf } from './stored.js';
import { fieldOf, startPool, stubUser, type TestPool } from './test-pool.js';

let pool: TestPool;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const NOTHING = { input: null, cacheWrite: null, cacheRead: null, output: null, thinking: null };

/** The sample session with every prompt's usage replaced: `null` per category is what a source that never recorded it sends. */
const withUsage = (skeleton: SessionSkeleton, usage: SessionSkeleton['transcripts'][number]['prompts'][number]['usage'], usageResponses: number): SessionSkeleton => ({
  ...skeleton,
  transcripts: skeleton.transcripts.map((transcript) => ({ ...transcript, prompts: transcript.prompts.map((prompt) => ({ ...prompt, usage, usageResponses })) })),
});

// The wire holds a bucket per category; the cell counts the bucket's floor.
const RECORDED = { input: bucketOf('tokens', 64_000), cacheWrite: 0, cacheRead: 0, output: bucketOf('tokens', 2_000), thinking: 0 };

const deposit = async (target: TestPool, id: string, skeletons: SessionSkeleton[]): Promise<void> => {
  const { token } = await target.signIn('github', stubUser(id));
  await target.post('/v1/covenant/accept', { version: 'v1' }, token);
  for (const skeleton of skeletons) expect((await target.post('/v1/deposits', skeleton, token)).status).toBe(201);
};

/** The cost reads the pool serves for the batch's week, from the stored cells alone. */
const costOf = async (target: TestPool): Promise<{ value: unknown; n: number }[]> => {
  const db = await target.db();
  // `storedOf` keeps the day's panel count in one row, so `run` is real; `batch` is never reached.
  const env: Env = {
    DB: {
      prepare: (sql) => ({
        bind: (...values) => {
          const bound = db.prepare(sql).bind(...values);
          return { first: () => bound.first(), all: () => bound.all(), run: async () => ({ meta: { changes: Number(fieldOf(await bound.run(), 'changes') ?? 0) } }) };
        },
      }),
      batch: () => Promise.reject(new Error('the read writes nothing')),
    },
  };
  const stored = await storedOf(env, 'claude-code', '2.1.314', Date.parse('2026-11-03T00:00:00Z'));
  const motifs = new Map(stored.motifs.map((motif) => [motif.motifId, motif]));
  return deriveCost({ pool: poolOf({ cells: stored.cells, motifs: stored.motifs }, []), store: store({}) }).filter((read) => motifs.size > 0 && read.slice.class === 'edit-verify');
};

describe('a served class cell carries the coverage of its input', () => {
  it('divides tokensPerPrompt by the prompts that recorded input: an unrecorded session does not dilute it', async () => {
    const own = await startPool();
    try {
      await deposit(own, '9101', [withUsage(sampleSkeleton('0000000000009101'), RECORDED, 1), withUsage(sampleSkeleton('0000000000009102'), NOTHING, 0)]);
      const [read] = await costOf(own);
      expect(read?.n).toBe(2);
      expect(read?.value).toMatchObject({ tokensPerPrompt: floorOf('tokens', bucketOf('tokens', 64_000)) + floorOf('tokens', bucketOf('tokens', 2_000)) });
      const row = await (await own.db()).prepare("SELECT token_sessions, token_prompts FROM cells WHERE motif_id = (SELECT motif_id FROM motifs WHERE json_extract(motif, '$.cls') = 'edit-verify') AND grain = 'week'").first();
      expect(fieldOf(row, 'token_sessions')).toBe(1);
      expect(fieldOf(row, 'token_prompts')).toBe(1);
    } finally {
      await own.dispose();
    }
  }, 60_000);

  it('gives an absent tokensPerPrompt, never 0, when no session of the cell recorded input', async () => {
    const own = await startPool();
    try {
      await deposit(own, '9103', [withUsage(sampleSkeleton('0000000000009103'), NOTHING, 0), withUsage(sampleSkeleton('0000000000009104'), NOTHING, 0)]);
      const [read] = await costOf(own);
      expect(read?.value).toMatchObject({ tokensPerPrompt: null });
    } finally {
      await own.dispose();
    }
  }, 60_000);
});

describe('rows written before the coverage columns', () => {
  it('read as coverage unknown, stay unknown when a batch adds to them, and never take the whole cell to be covered', async () => {
    const own = await startPool();
    try {
      await deposit(own, '9105', [withUsage(sampleSkeleton('0000000000009105'), RECORDED, 1)]);
      const db = await own.db();
      // What a row written under migration 0012 holds: no coverage.
      await db.prepare('UPDATE cells SET token_sessions = NULL, token_prompts = NULL').run();
      await deposit(own, '9106', [withUsage(sampleSkeleton('0000000000009106'), RECORDED, 1)]);
      expect(fieldOf(await db.prepare('SELECT COUNT(*) AS n FROM cells WHERE token_prompts IS NOT NULL AND key IN (SELECT key FROM cells WHERE sessions = 2)').first(), 'n')).toBe(0);
      const [read] = await costOf(own);
      expect(read?.value).toMatchObject({ tokensPerPrompt: null, tokenCoverage: 'unknown' });
    } finally {
      await own.dispose();
    }
  }, 60_000);
});

describe('the bundle carries the coverage on its cells (additive and optional on the wire)', () => {
  const PATH = `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`;

  it('serves tokenSessions and tokenPrompts on a class cell, and the cost read divides by them', async () => {
    const own = await startPool();
    try {
      for (let at = 0; at < 6; at += 1) await deposit(own, String(9110 + at), [withUsage(sampleSkeleton(String(9110 + at).padStart(16, '0')), at % 2 === 0 ? RECORDED : NOTHING, at % 2 === 0 ? 1 : 0)]);
      const { token } = await own.signIn('github', stubUser('9120'));
      const answer = await own.raw(PATH, token);
      const verified = await verifyBundle(answer.json, own.signingKey(), 'claude-code', '2.1.314');
      if (!verified.ok) throw new Error(verified.reason);
      const classCells = verified.bundle.cells.filter((cell) => cell.grain === 'week' && verified.bundle.motifs.some((motif) => motif.motifId === cell.motifId && motif.level === 'class' && motif.cls === 'edit-verify'));
      expect(classCells).toMatchObject([{ sessions: 6, tokenSessions: 3, tokenPrompts: 3 }]);
      const served = verified.bundle.reads.find((read) => read.family === 'cost' && read.slice.class === 'edit-verify');
      expect(served?.value).toMatchObject({ tokensPerPrompt: floorOf('tokens', bucketOf('tokens', 64_000)) + floorOf('tokens', bucketOf('tokens', 2_000)) });
    } finally {
      await own.dispose();
    }
  }, 120_000);
});
