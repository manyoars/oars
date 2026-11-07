// Every size or count figure in docs/pool.md that the code determines is computed here and compared with the number the doc prints (t913). A merge or a
// new field that moves a size now fails this test, so the doc is fixed before review. The figure sits in the doc as `887,140<!-- figure:skeleton -->`; a
// rounded one names its step, `1,900<!-- figure:sample~100 -->`, and must equal the computed value rounded to that step, so it stays true within its rounding.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BIG_CALLS, bigSkeleton, COVERAGE_KEY, coverageBytesSkeleton, envelopeBytes, LARGE_STEPS, largeSkeleton, REGISTER_FIXTURE } from '../../cli/src/sessions/pool-fixture.js';
import { canonicalBytes } from '../../cli/src/sessions/pool-outbox.js';
import type { SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { incrementsOf } from './ingest.js';
import { MAX_ASSEMBLED_BYTES } from './parts.js';
import { sampleSkeleton } from './sample.js';
import { startPool, stubUser } from './test-pool.js';

const DOC = readFileSync(fileURLToPath(new URL('../../../docs/pool.md', import.meta.url)), 'utf8');

/** The three `unknown` coverage bands a skeleton with no repo, no hour, and no org context still carries on each frame. */
const BANDS = ['orgSize', 'team', 'repoVisibility'];

/** What the bands cost on a skeleton: its JSON length minus the same skeleton with the bands deleted from the transcript's frame and each frame in its list. */
const bandBytes = (built: SessionSkeleton): { bytes: number; frames: number } => {
  const bare: SessionSkeleton = structuredClone(built);
  let frames = 0;
  for (const transcript of bare.transcripts) {
    for (const held of [transcript.frame, ...transcript.frames]) {
      frames += 1;
      for (const band of BANDS) Reflect.deleteProperty(held, band);
    }
  }
  return { bytes: JSON.stringify(built).length - JSON.stringify(bare).length, frames };
};

/** The row the worker stores for the large deposit, measured the way `ingest.test.ts` does: post it to a pool and read the bytes of the columns the account's byte limit counts. */
const storedRow = async (built: SessionSkeleton): Promise<{ stored: number; extensions: number }> => {
  const target = await startPool();
  try {
    const { token } = await target.signIn('github', stubUser('9201'));
    await target.post('/v1/covenant/accept', { version: 'v1' }, token);
    const posted = await target.post('/v1/deposits', built, token);
    if (posted.status !== 201) throw new Error(`the large deposit was refused with ${String(posted.status)}`);
    const db = await target.db();
    const column = async (name: string): Promise<number> => Number(await db.prepare(`SELECT LENGTH(CAST(${name} AS BLOB)) AS bytes FROM deposits`).first('bytes'));
    return { stored: (await column('skeleton')) + (await column('deltas')) + (await column('extensions')), extensions: await column('extensions') };
  } finally {
    await target.dispose();
  }
};

/** The coverage-bytes fixture's costs, from the one builder `pool-wire-coverage.test.ts` pins them on. */
const coverageBytes = (): { bare: number; keyOnly: number; hourOnly: number; both: number; frames: number; timedFrames: number } => {
  const size = (repo: string | null, timed: boolean): number => JSON.stringify(coverageBytesSkeleton(repo, timed)).length;
  const framesOf = (timed: boolean): number => {
    const transcript = coverageBytesSkeleton(COVERAGE_KEY, timed).transcripts[0];
    return transcript === undefined ? 0 : 1 + transcript.frames.length;
  };
  const bare = size(null, false);
  return { bare, keyOnly: size(COVERAGE_KEY, false) - bare, hourOnly: size(null, true) - bare, both: size(COVERAGE_KEY, true) - bare, frames: framesOf(false), timedFrames: framesOf(true) };
};

const figures = async () => {
  const large = largeSkeleton('0000000000009101');
  const cells = incrementsOf(large).cells;
  const cellJson = JSON.stringify([...cells.values()]).length;
  const skeleton = JSON.stringify(large).length;
  const coverage = coverageBytes();
  const row = await storedRow(large);
  const bands = bandBytes(large);
  const register = Buffer.byteLength(canonicalBytes(REGISTER_FIXTURE), 'utf8');
  const sample = JSON.stringify(sampleSkeleton('0000000000009103')).length;
  const big = Buffer.byteLength(canonicalBytes(bigSkeleton('0000000000000001', BIG_CALLS)), 'utf8');
  const perCall = big / BIG_CALLS;
  return {
    'large-steps': LARGE_STEPS,
    'big-calls': BIG_CALLS,
    'join-limit': MAX_ASSEMBLED_BYTES,
    skeleton,
    cells: cells.size,
    'cell-json': cellJson,
    'cell-ratio': cellJson / skeleton,
    stored: row.stored,
    extensions: row.extensions,
    bands: bands.bytes,
    'bands-per-frame': bands.bytes / bands.frames,
    'coverage-bare': coverage.bare,
    'key-cost': coverage.keyOnly,
    'key-per-frame': coverage.keyOnly / coverage.frames,
    'key-timed': coverage.both - coverage.hourOnly,
    'hour-cost': coverage.hourOnly,
    register,
    envelope: envelopeBytes(REGISTER_FIXTURE),
    sample,
    'per-call': perCall,
    big,
    'row-calls': MAX_ASSEMBLED_BYTES / perCall,
    'sample-sessions': 10_000_000_000 / sample,
  };
};

interface Marked {
  id: string;
  step: number | null;
  value: number;
  line: number;
}

const computed = await figures();

/** The ids of the figures this test computes; a marker naming any other id is a typo. */
type FigureId = keyof typeof computed;
const isFigure = (id: string): id is FigureId => id in computed;

const MARKER = /(\d[\d,.]*)( million)?<!-- figure:([\w-]+)(?:~([\d.]+))? -->/gu;

const markedFigures = (doc: string): Marked[] =>
  [...doc.matchAll(MARKER)].map((found) => ({
    id: found[3] ?? '',
    step: found[4] === undefined ? null : Number(found[4]),
    value: Number((found[1] ?? '').replaceAll(',', '')) * (found[2] === undefined ? 1 : 1_000_000),
    line: doc.slice(0, found.index).split('\n').length,
  }));

/** A comma-grouped figure with no marker must be a limit the doc names that no fixture sets (the git log's 5,000 commits, at docs/pool.md:22), or follow "about" (a rounded statement, or history of code that no longer exists). */
const CONSTANTS = new Set(['1,000', '5,000', '2,000,000', '999,999', '100,000', '4,096']);

/** A bare number with a unit that is a limit, a count of kinds, or an example the doc states, not a size the code determines. */
const UNIT_CONSTANTS = new Set(['64 cells']); // "A row keeps at most 64 cells" (docs/pool.md:294): the telemetry rollup's limit.

describe('the figures in docs/pool.md', () => {
  const marked = markedFigures(DOC);

  it('equal what the code computes now, exact or within the stated rounding', () => {
    expect(marked.length).toBeGreaterThan(0);
    for (const one of marked) {
      if (!isFigure(one.id)) throw new Error(`docs/pool.md:${String(one.line)} names figure "${one.id}", which this test does not compute`);
      const real = computed[one.id];
      const expected = one.step === null ? real : Math.round(real / one.step) * one.step;
      expect(Math.abs(one.value - expected) < 1e-6, `docs/pool.md:${String(one.line)} states ${String(one.value)} for "${one.id}", the code computes ${String(real)}`).toBe(true);
    }
  });

  it('holds every figure this test computes, so removing a marker is not silent', () => {
    const named = new Set(marked.map((one) => one.id));
    expect(Object.keys(computed).filter((id) => !named.has(id))).toEqual([]);
  });

  // The words "two frames" and "four frames" at docs/pool.md:35 count the frames the key costs are divided over, so they are held to the fixture too.
  it('names the frame counts of the coverage fixture', () => {
    const coverage = coverageBytes();
    expect(DOC).toContain('on each of the two frames');
    expect(DOC).toContain('across the four frames');
    expect([coverage.frames, coverage.timedFrames]).toEqual([2, 4]);
    // 116 across four frames is the same 29 a frame as 58 across two.
    expect(computed['key-timed'] / coverage.timedFrames).toBe(computed['key-per-frame']);
  });

  it('has no comma-grouped or unit-bearing figure left without a marker', () => {
    const grouped = [...DOC.matchAll(/(?<!about )(?<![\d,])\d{1,3}(?:,\d{3})+(?![\d,])(?! million)(?!<!-- figure)/gu)].map((found) => found[0]).filter((text) => !CONSTANTS.has(text));
    // A bare number before a unit: `278 bytes`, `9 cells`, `2-byte`. A marked figure has its comment between the number and the unit, so it does not match.
    const unit = [...DOC.matchAll(/(?<!about )(?<![\d,.])\d+(?:\.\d+)?[ -](?:bytes?|cells?|calls?|frames?)\b/gu)].map((found) => found[0]).filter((text) => !UNIT_CONSTANTS.has(text));
    expect({ grouped, unit }).toEqual({ grouped: [], unit: [] });
  });
});
