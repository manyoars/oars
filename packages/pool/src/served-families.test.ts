// The families a bundle does not serve, pinned at the boundary that keeps them out: the wire. Recovery reads error rows (a signature, an error class, an outcome), and fit's call-shape
// method reads a tool's input key names; no skeleton field carries any of them, so neither can be derived from stored cells. The refusing tests below fail if a later wire gains one of these fields.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSkeleton, verifyBundle, VOCAB_VERSION } from '../../cli/src/sessions/pool-wire.js';
import { sampleSkeleton } from './sample.js';
import { startPool, stubUser, type TestPool } from './test-pool.js';

describe('the wire holds no field a withheld family needs', () => {
  const withTool = (extra: { [field: string]: unknown }): unknown => {
    const skeleton = sampleSkeleton('0000000000000001');
    const [first] = skeleton.transcripts;
    if (first === undefined) throw new Error('no transcript');
    return { ...skeleton, transcripts: [{ ...first, tools: first.tools.map((entry) => ({ ...entry, ...extra })) }] };
  };

  it('accepts the sample skeleton', () => {
    expect(parseSkeleton(withTool({})).ok).toBe(true);
  });

  it.each(['keys', 'errorCode', 'sigHash', 'outcome', 'recoveryCalls'])('refuses a tool that carries `%s`', (field) => {
    expect(parseSkeleton(withTool({ [field]: field === 'keys' ? ['command'] : 'x' })).ok).toBe(false);
  });

  it('refuses a skeleton that carries error rows', () => {
    expect(parseSkeleton({ ...sampleSkeleton('0000000000000002'), errors: [] }).ok).toBe(false);
  });
});

describe('a bundle over five accounts', () => {
  let pool: TestPool;

  beforeAll(async () => {
    pool = await startPool();
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  it('serves tool-day and holds no recovery read and no call-shape read', async () => {
    let last = '';
    for (const id of ['4001', '4002', '4003', '4004', '4005']) {
      const { token } = await pool.signIn('github', stubUser(id));
      await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
      expect((await pool.post('/v1/deposits', sampleSkeleton(id.padStart(16, '0')), token)).status).toBe(201);
      last = token;
    }
    const verified = await verifyBundle((await pool.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, last)).json, pool.signingKey(), 'claude-code', '2.1.314');
    if (!verified.ok) throw new Error(verified.reason);
    const families = new Set(verified.bundle.reads.map((read) => read.family));
    expect(families.has('tool-day')).toBe(true);
    expect(families.has('recovery')).toBe(false);
    expect(verified.bundle.reads.some((read) => read.method === 'call-shape')).toBe(false);
  }, 60_000);
});
