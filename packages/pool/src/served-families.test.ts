// The families a bundle does not serve, pinned at the boundary that keeps them out: the wire. Recovery reads error rows (a signature, an error class, an outcome), and fit's call-shape
// method reads a tool's input key names; no skeleton field carries any of them, so neither can be derived from stored cells. The refusing tests below (a tool, a step, a transcript, and the
// skeleton's top level) fail if a later wire gains one of these fields.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSkeleton, verifyBundle, VOCAB_VERSION } from '../../cli/src/sessions/pool-wire.js';
import { CALL_SHAPE_METHOD } from '../../cli/src/sessions/read.js';
import { sampleSkeleton } from './sample.js';
import { startPool, stubUser, type TestPool } from './test-pool.js';

// The fields a withheld family would read, none of them on the wire today.
interface WithheldFields {
  keys?: string[];
  errorCode?: string;
  sigHash?: string;
  outcome?: string;
  recoveryCalls?: string;
}

const WITHHELD: readonly (readonly [keyof WithheldFields, string[] | string])[] = [
  ['keys', ['command']],
  ['errorCode', 'x'],
  ['sigHash', 'x'],
  ['outcome', 'x'],
  ['recoveryCalls', 'x'],
];

describe('the wire holds no field a withheld family needs', () => {
  const firstOf = (id: string) => {
    const skeleton = sampleSkeleton(id);
    const [first] = skeleton.transcripts;
    if (first === undefined) throw new Error('no transcript');
    return { skeleton, first };
  };
  const withTool = (extra: WithheldFields): unknown => {
    const { skeleton, first } = firstOf('0000000000000001');
    return { ...skeleton, transcripts: [{ ...first, tools: first.tools.map((entry) => ({ ...entry, ...extra })) }] };
  };
  const withStep = (extra: WithheldFields): unknown => {
    const { skeleton, first } = firstOf('0000000000000003');
    return { ...skeleton, transcripts: [{ ...first, tools: first.tools.map((entry) => ({ ...entry, steps: entry.steps.map((step) => ({ ...step, ...extra })) })) }] };
  };
  const withTranscript = (extra: WithheldFields): unknown => {
    const { skeleton, first } = firstOf('0000000000000004');
    return { ...skeleton, transcripts: [{ ...first, ...extra }] };
  };

  it('accepts the sample skeleton, with and without an empty extra', () => {
    expect(parseSkeleton(withTool({})).ok).toBe(true);
    expect(parseSkeleton(withStep({})).ok).toBe(true);
    expect(parseSkeleton(withTranscript({})).ok).toBe(true);
  });

  it.each(WITHHELD)('refuses a tool that carries `%s`', (field, value) => {
    expect(parseSkeleton(withTool({ [field]: value })).ok).toBe(false);
  });

  it.each(WITHHELD)('refuses a step that carries `%s`', (field, value) => {
    expect(parseSkeleton(withStep({ [field]: value })).ok).toBe(false);
  });

  it.each(WITHHELD)('refuses a transcript that carries `%s`', (field, value) => {
    expect(parseSkeleton(withTranscript({ [field]: value })).ok).toBe(false);
  });

  it('refuses a transcript that carries error rows', () => {
    const { first } = firstOf('0000000000000005');
    expect(parseSkeleton({ ...sampleSkeleton('0000000000000005'), transcripts: [{ ...first, errors: [] }] }).ok).toBe(false);
  });

  it('refuses a skeleton that carries error rows at its top level', () => {
    expect(parseSkeleton({ ...sampleSkeleton('0000000000000002'), errors: [] }).ok).toBe(false);
  });

  it.each(WITHHELD)('refuses a skeleton that carries %s at its top level', (field, value) => {
    expect(parseSkeleton({ ...sampleSkeleton('0000000000000006'), [field]: value }).ok).toBe(false);
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
    expect(verified.bundle.reads.some((read) => read.method === CALL_SHAPE_METHOD.name)).toBe(false);
  }, 60_000);
});

describe('a bundle for a harness with no version on record', () => {
  let pool: TestPool;

  beforeAll(async () => {
    pool = await startPool();
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  it('serves the families a numbered bundle serves, none it does not, and nothing under the floor', async () => {
    // Four accounts with no version and five on 2.1.314, the same harness: the `unknown` bundle sits under the floor, the numbered one at it.
    let token = '';
    for (const [id, version] of [['5001', null], ['5002', null], ['5003', null], ['5004', null], ['5101', '2.1.314'], ['5102', '2.1.314'], ['5103', '2.1.314'], ['5104', '2.1.314'], ['5105', '2.1.314']] as const) {
      ({ token } = await pool.signIn('github', stubUser(id)));
      await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
      expect((await pool.post('/v1/deposits', sampleSkeleton(id.padStart(16, '0'), { languages: ['typescript'] }, '2026-11-01', 'cursor', { program: 'git', sub: 'push' }, version), token)).status).toBe(201);
    }
    const bundleAt = async (version: string) => {
      const verified = await verifyBundle((await pool.get(`/bundle/cursor/${version}/${VOCAB_VERSION}`, token)).json, pool.signingKey(), 'cursor', version);
      if (!verified.ok) throw new Error(verified.reason);
      return verified.bundle;
    };
    const numbered = await bundleAt('2.1.314');
    expect(numbered.reads.length).toBeGreaterThan(0);
    // Four accounts: nothing of its own, and the environment cells (five accounts across both) are the only thing it holds.
    const four = await bundleAt('unknown');
    expect(four.cells.every((cell) => cell.frameBucket.startsWith('env:'))).toBe(true);
    expect(four.reads.every((read) => read.family === 'fit' && read.slice.platform !== undefined)).toBe(true);
    // A fifth account lifts the unknown bundle to the floor.
    ({ token } = await pool.signIn('github', stubUser('5005')));
    await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
    expect((await pool.post('/v1/deposits', sampleSkeleton('5005'.padStart(16, '0'), { languages: ['typescript'] }, '2026-11-01', 'cursor', { program: 'git', sub: 'push' }, null), token)).status).toBe(201);
    const unknown = await bundleAt('unknown');
    const families = new Set(unknown.reads.map((read) => read.family));
    expect(families.has('tool-day')).toBe(true);
    expect(families.has('recovery')).toBe(false);
    expect(unknown.reads.some((read) => read.method === CALL_SHAPE_METHOD.name)).toBe(false);
    // The same derivation as a numbered bundle, so no family appears here that a numbered bundle would not serve.
    const numberedFamilies = new Set((await bundleAt('2.1.314')).reads.map((read) => read.family));
    for (const family of families) expect(numberedFamilies.has(family)).toBe(true);
    for (const read of unknown.reads) expect(read.clusters).toBeGreaterThanOrEqual(5);
  }, 60_000);
});
