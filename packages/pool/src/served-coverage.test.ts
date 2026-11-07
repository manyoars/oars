// A served cell carries how many of its prompts and sessions recorded input (t921), so the cost read divides by those and not by every settled prompt (V7: an unrecorded field is absent, never a measured zero).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  const env: Env = { DB: { prepare: (sql) => db.prepare(sql), batch: () => Promise.reject(new Error('the read writes nothing')) } };
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
