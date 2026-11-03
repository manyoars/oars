import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifySlice, type Slice } from '../../cli/src/sessions/pool-wire.js';
import { sampleSkeleton } from './sample.js';
import { startPool, stubUser, type TestPool } from './test-pool.js';

// The sample's three depositors clear the floor with more reads than this, so the cap is what a reader runs into.
const CAP = 3;

let pool: TestPool;
let depositorToken: string;
let everyRead: number;

const deposit = async (id: string): Promise<string> => {
  const { token } = await pool.signIn('github', stubUser(id));
  await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
  expect((await pool.post('/v1/deposits', sampleSkeleton(id.padStart(16, '0')), token)).status).toBe(201);
  return token;
};

const slice = async (token: string): Promise<Slice> => {
  const { status, json } = await pool.get('/v1/slices/all', token);
  expect(status).toBe(200);
  const verified = await verifySlice(json, pool.signingKey(), 'all');
  if (!verified.ok) throw new Error(verified.reason);
  return verified.slice;
};

beforeAll(async () => {
  pool = await startPool({ READ_CAP: String(CAP) });
  depositorToken = await deposit('2001');
  await deposit('2002');
  await deposit('2003');
  everyRead = (await slice(depositorToken)).reads.length;
  expect(everyRead).toBeGreaterThan(CAP + 1);
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

describe('deposit or capped access (V12)', () => {
  it('gives an account that has deposited the whole pool, on every pull, with no count kept', async () => {
    for (let pull = 0; pull < CAP + 2; pull += 1) {
      const served = await slice(depositorToken);
      expect(served.reads).toHaveLength(everyRead);
      expect(served.cells.length).toBeGreaterThan(0);
      expect(served.capped).toBeNull();
    }
  });

  it('gives an account with no deposit reads up to the cap, then a named refusal, and no cells at any point', async () => {
    const { token } = await pool.signIn('github', stubUser('2004'));
    const first = await slice(token);
    expect(first.reads).toHaveLength(CAP);
    expect(first.cells).toEqual([]);
    expect(first.motifs).toEqual([]);
    expect(first.capped).toEqual({ limit: CAP, served: CAP });
    expect(await pool.get('/v1/slices/all', token)).toMatchObject({ status: 403, json: { error: 'read_cap', message: expect.stringContaining('oars pool deposit') } });
  });

  it('counts across pulls below the cap: a stack with fewer reads than the cap leaves the rest', async () => {
    const { token } = await pool.signIn('github', stubUser('2005'));
    const none = await pool.get('/v1/slices/python', token);
    expect(none.status).toBe(200);
    const after = await slice(token);
    expect(after.reads).toHaveLength(CAP);
    expect(after.capped).toEqual({ limit: CAP, served: CAP });
  });

  it('opens up once the capped account deposits', async () => {
    const { token } = await pool.signIn('github', stubUser('2006'));
    await slice(token);
    expect((await pool.get('/v1/slices/all', token)).status).toBe(403);
    await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000002006'), token)).status).toBe(201);
    const opened = await slice(token);
    expect(opened.capped).toBeNull();
    expect(opened.reads.length).toBeGreaterThan(CAP);
  });

  it('does not double-serve under two pulls at once: together they stay within the cap', async () => {
    const { token } = await pool.signIn('github', stubUser('2007'));
    const answers = await Promise.all([pool.get('/v1/slices/all', token), pool.get('/v1/slices/all', token)]);
    const served = await Promise.all(
      answers.map(async ({ status, json }) => {
        if (status !== 200) return 0;
        const verified = await verifySlice(json, pool.signingKey(), 'all');
        return verified.ok ? verified.slice.reads.length : 0;
      }),
    );
    expect(served[0] ?? 0).toBeLessThanOrEqual(CAP);
    expect((served[0] ?? 0) + (served[1] ?? 0)).toBeLessThanOrEqual(CAP);
  });

  it('falls back to its default cap when READ_CAP is not a positive whole number', async () => {
    const bare = await startPool({ READ_CAP: 'many' });
    try {
      const { token } = await bare.signIn('github', stubUser('2008'));
      const { status, json } = await bare.get('/v1/slices/all', token);
      expect(status).toBe(200);
      const verified = await verifySlice(json, bare.signingKey(), 'all');
      if (!verified.ok) throw new Error(verified.reason);
      expect(verified.slice.capped).toEqual({ limit: 50, served: 0 });
    } finally {
      await bare.dispose();
    }
  }, 60_000);
});
