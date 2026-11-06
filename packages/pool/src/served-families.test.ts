// The families a bundle does not serve, pinned at the boundary that keeps them out: the wire. Recovery reads error rows (a signature, an error class, an outcome), and fit's call-shape
// method reads a tool's input key names; no skeleton field carries any of them, so neither can be derived from stored cells. The tests below (a tool, a step, a transcript, and the
// skeleton's top level) fail if a later wire gains one of these fields: the name would stop landing in the bag.
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

  // The wire no longer refuses a name it does not know: the field lands in the extensions bag, which nothing serves, and the stored skeleton and every cell stay as without it.
  const keptInBag = (parsed: ReturnType<typeof parseSkeleton>, field: string, value: unknown): void => {
    if (!parsed.ok) throw new Error(`refused: ${parsed.field} ${parsed.reason}`);
    expect(parsed.extensions.some(({ at, kind }) => kind === 'field' && at.endsWith(field))).toBe(true);
    expect(JSON.stringify(parsed.skeleton)).not.toContain(`"${field}":${JSON.stringify(value)}`);
  };

  it.each(WITHHELD)('keeps a tool that carries `%s` in the bag, out of the skeleton', (field, value) => {
    keptInBag(parseSkeleton(withTool({ [field]: value })), field, value);
  });

  it.each(WITHHELD)('keeps a step that carries `%s` in the bag, out of the skeleton', (field, value) => {
    keptInBag(parseSkeleton(withStep({ [field]: value })), field, value);
  });

  it.each(WITHHELD)('keeps a transcript that carries `%s` in the bag, out of the skeleton', (field, value) => {
    keptInBag(parseSkeleton(withTranscript({ [field]: value })), field, value);
  });

  it('keeps a transcript that carries error rows in the bag', () => {
    const { first } = firstOf('0000000000000005');
    keptInBag(parseSkeleton({ ...sampleSkeleton('0000000000000005'), transcripts: [{ ...first, errors: [] }] }), 'errors', []);
  });

  it('keeps a skeleton that carries error rows at its top level in the bag', () => {
    keptInBag(parseSkeleton({ ...sampleSkeleton('0000000000000002'), errors: [] }), 'errors', []);
  });

  it.each(WITHHELD)('keeps a skeleton that carries `%s` at its top level in the bag', (field, value) => {
    keptInBag(parseSkeleton({ ...sampleSkeleton('0000000000000006'), [field]: value }), field, value);
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
