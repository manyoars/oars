// The families a bundle serves and does not serve. Recovery is served from cells (t868): what others did next after a failed call, by (failed action, `errorCode`, next action), at the floor of 5 accounts.
// What stays out is pinned at the boundary that keeps it out, the wire: a signature hash, an outcome, and a tool's input key names are on no skeleton field, so fit's call-shape method and a
// signature record cannot be derived from stored cells. The tests below (a tool, a step, a transcript, and the skeleton's top level) fail if a later wire gains one of these fields: the name would
// stop landing in the bag.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { incrementsOf } from './ingest.js';
import { parseSkeleton, skeletonOf, verifyBundle, VOCAB_VERSION, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { CALL_SHAPE_METHOD } from '../../cli/src/sessions/read.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from '../../cli/src/sessions/pool-fixture.js';
import { sampleSkeleton } from './sample.js';
import { startPool, stubUser, type TestPool } from './test-pool.js';

// The fields a withheld family would read, none of them on the wire today.
interface WithheldFields {
  keys?: string[];
  sigHash?: string;
  outcome?: string;
}

const WITHHELD: readonly (readonly [keyof WithheldFields, string[] | string])[] = [
  ['keys', ['command']],
  ['sigHash', 'x'],
  ['outcome', 'x'],
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

  it('serves tool-day and holds no recovery read when no call failed, and no call-shape read', async () => {
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

/** A session whose first call failed with a 429 and was followed by a read and then an edit. */
const failingSkeleton = (id: string) => {
  const framed = frame({ harnessVersion: '2.1.314', shell: 'bash', day: '2026-11-01' });
  const shell = step(0, 0, 'shell.exec', { native: 'Bash', status: 'error', identity: { program: 'git', sub: 'push', flags: [] } });
  const [only] = sessionsFrom(
    store({
      sessions: [session('s1', { frame: framed })],
      prompts: [prompt('s1', 0, { frame: framed })],
      tools: [
        tool('s1', 0, 'Bash', { status: 'error', errorCode: '429', steps: [shell] }),
        tool('s1', 1, 'Read', { steps: [step(1, 0, 'file.read', { native: 'Read' })] }),
        tool('s1', 2, 'Edit', { steps: [step(2, 0, 'file.edit', { native: 'Edit' })] }),
      ],
    }),
  );
  const built = only === undefined ? null : skeletonOf(only, id, storedNames, printOf);
  if (built === null) throw new Error('no skeleton');
  return built;
};

describe('the recovery family in a bundle', () => {
  let pool: TestPool;

  beforeAll(async () => {
    pool = await startPool();
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  it('reads an off-list errorCode as other and keeps the value in the extensions bag, never in a cell', async () => {
    const { token } = await pool.signIn('github', stubUser('5099'));
    await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
    const skeleton = failingSkeleton('0000000000005099');
    const response = await pool.post('/v1/deposits', {
      ...skeleton,
      transcripts: skeleton.transcripts.map((transcript) => ({ ...transcript, tools: transcript.tools.map((entry, index) => (index === 0 ? { ...entry, errorCode: 'off-list' } : entry)) })),
    }, token);
    expect(response.status).toBe(201);
    const db = await pool.db();
    expect(JSON.parse(String(await db.prepare('SELECT extensions FROM deposits').first('extensions')))).toEqual([{ at: 'transcripts[0].tools[0].errorCode', kind: 'value', value: 'off-list' }]);
    expect(String(await db.prepare('SELECT skeleton FROM deposits').first('skeleton'))).toContain('"errorCode":"other"');
    expect(await db.prepare("SELECT COUNT(*) AS count FROM motifs WHERE motif LIKE '%off-list%'").first('count')).toBe(0);
  });

  it('refuses an errorCode that is no text, and one on a call that succeeded, with the field named', async () => {
    const { token } = await pool.signIn('github', stubUser('5098'));
    await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
    const skeleton = failingSkeleton('0000000000005098');
    const sentWith = (index: number, errorCode: unknown) => ({
      ...skeleton,
      transcripts: skeleton.transcripts.map((transcript) => ({ ...transcript, tools: transcript.tools.map((entry, at) => (at === index ? { ...entry, errorCode } : entry)) })),
    });
    const noText = await pool.post('/v1/deposits', sentWith(0, 7), token);
    expect(noText.status).toBe(422);
    expect(noText.json).toMatchObject({ error: 'closed_vocabulary', field: 'transcripts[0].tools[0].errorCode' });
    const onSuccess = await pool.post('/v1/deposits', sentWith(1, '429'), token);
    expect(onSuccess.status).toBe(422);
    expect(onSuccess.json).toMatchObject({ error: 'closed_vocabulary', field: 'transcripts[0].tools[1].errorCode' });
  });

  const bundleAfter = async (ids: readonly string[]) => {
    let last = '';
    for (const id of ids) {
      const { token } = await pool.signIn('github', stubUser(id));
      await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
      expect((await pool.post('/v1/deposits', failingSkeleton(id.padStart(16, '0')), token)).status).toBe(201);
      last = token;
    }
    const verified = await verifyBundle((await pool.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, last)).json, pool.signingKey(), 'claude-code', '2.1.314');
    if (!verified.ok) throw new Error(verified.reason);
    return verified.bundle;
  };

  it('is withheld at 4 accounts and served at 5, and states what followed, never a fix', async () => {
    const four = await bundleAfter(['5001', '5002', '5003', '5004']);
    expect(four.reads.some((read) => read.family === 'recovery')).toBe(false);
    expect(four.cells.some((cell) => cell.failed > 0 && cell.grain === 'week' && cell.frameBucket.endsWith('/-'))).toBe(false);
    const five = await bundleAfter(['5005']);
    const modelMotifs = new Set(five.motifs.filter((motif) => motif.cls?.startsWith('error:')).map((motif) => motif.motifId));
    expect(five.cells.filter((cell) => modelMotifs.has(cell.motifId)).map((cell) => cell.frameBucket)).toEqual(['claude-code/-/claude-opus-5-5', 'claude-code/-/claude-opus-5-5']);
    const recovery = five.reads.filter((read) => read.family === 'recovery');
    expect(recovery.map(({ slice, value }) => [slice.action, slice.errorCode, slice.next, value.followed, value.of])).toEqual([['shell.exec', '429', 'file.read', 5, 5]]);
    expect(JSON.stringify(recovery)).not.toMatch(/fix|outcome|sig/i);
  }, 120_000);
});

/** `skeleton` with the same intervention on every prompt: an outcome row that a pool holds for a later test and serves to nothing. */
const withIntervention = (skeleton: SessionSkeleton, intervention: 'none' | 'after-error' | 'redo' | 'revert' | 'unknown'): SessionSkeleton => ({
  ...skeleton,
  transcripts: skeleton.transcripts.map((transcript) => ({ ...transcript, prompts: transcript.prompts.map((held) => ({ ...held, intervention })) })),
});

describe('the intervention outcome is held per prompt and served by nothing (t882)', () => {
  let pool: TestPool;

  beforeAll(async () => {
    pool = await startPool();
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  it('stores the bucket on each prompt of the skeleton, and not in the extensions bag', async () => {
    const { token } = await pool.signIn('github', stubUser('6001'));
    await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
    expect((await pool.post('/v1/deposits', withIntervention(sampleSkeleton('0000000000006001'), 'revert'), token)).status).toBe(201);
    const db = await pool.db();
    const stored = parseSkeleton(JSON.parse(String(await db.prepare('SELECT skeleton FROM deposits').first('skeleton'))));
    if (!stored.ok) throw new Error(`stored skeleton refused: ${stored.field}`);
    expect(stored.skeleton.transcripts.flatMap((transcript) => transcript.prompts.map((held) => held.intervention))).toEqual(['revert']);
    expect(String(await db.prepare('SELECT extensions FROM deposits').first('extensions'))).toBe('[]');
  });

  it('derives the same cells, motifs, and strata with the bucket as without it: no cell reads it', () => {
    const plain = incrementsOf(sampleSkeleton('0000000000006002'));
    for (const value of ['none', 'after-error', 'redo', 'revert', 'unknown'] as const) {
      const held = incrementsOf(withIntervention(sampleSkeleton('0000000000006002'), value));
      expect([...held.cells]).toEqual([...plain.cells]);
      expect([...held.strata]).toEqual([...plain.strata]);
      expect(held.motifs).toEqual(plain.motifs);
    }
  });

  it('serves it in no bundle: five accounts deposit it and the signed bundle names no intervention, in a cell, a motif, a read, or a family', async () => {
    let last = '';
    for (const id of ['6101', '6102', '6103', '6104', '6105']) {
      const { token } = await pool.signIn('github', stubUser(id));
      await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
      expect((await pool.post('/v1/deposits', withIntervention(sampleSkeleton(id.padStart(16, '0')), 'redo'), token)).status).toBe(201);
      last = token;
    }
    const response = await pool.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, last);
    const verified = await verifyBundle(response.json, pool.signingKey(), 'claude-code', '2.1.314');
    if (!verified.ok) throw new Error(verified.reason);
    expect(verified.bundle.reads.length).toBeGreaterThan(0);
    expect(JSON.stringify(response.json)).not.toMatch(/intervention|after-error|revert/);
    expect(verified.bundle.reads.map((read) => read.family)).not.toContain('intervention');
  }, 60_000);
});
