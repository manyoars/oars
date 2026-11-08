// Format 4: a call may carry its value features, closed values, and change kind. The client builds format 4 only; the pool reads format 3 and format 4, so a client that has not moved yet is still served,
// and a format 3 batch that holds one of the three names holds a field its format does not define: it goes to the bag and is served from nowhere. Every name and value here is invented.
import { describe, expect, it } from 'vitest';
import { cellsOf, storeOf } from './cell-increments.js';
import { SHAPE_CLASS } from './cells.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';
import { FORMAT_4_TOOL_FIELDS, parseSkeleton, READ_FORMATS, skeletonOf, SKELETON_FORMAT, type SessionSkeleton } from './pool-wire.js';

const framed = frame({ shell: 'bash' });

const built = (): SessionSkeleton => {
  const grep = tool('s1', 0, 'Grep', {
    keys: ['output_mode', 'pattern'],
    argFeatures: [{ key: 'pattern', valueSize: '1-8', patternFeatures: ['anchor'] }],
    argValues: [{ key: 'output_mode', enumValue: 'count' }],
    changeKind: ['value-changed'],
    steps: [step(0, 0, 'file.search', { native: 'Grep' })],
  });
  const [only] = sessionsFrom(store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })], tools: [grep] }));
  const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
  if (skeleton === null) throw new Error('no skeleton');
  return structuredClone(skeleton);
};

const layerOne = (skeleton: SessionSkeleton): string[] =>
  cellsOf(storeOf([skeleton]))
    .motifs.map(({ cls }) => cls ?? '')
    .filter((cls) => cls.startsWith(SHAPE_CLASS) && /\/(size|pattern|enum|change)\//.test(cls))
    .sort();

describe('the wire formats', () => {
  it('builds format 4 and reads formats 3 and 4, refusing any other', () => {
    expect(SKELETON_FORMAT).toBe(4);
    expect(READ_FORMATS).toEqual([3, 4]);
    expect(built().format).toBe(4);
    expect(parseSkeleton({ ...built(), format: 5 })).toMatchObject({ ok: false, field: 'format', reason: 'not a format this version reads' });
    expect(parseSkeleton({ ...built(), format: 2 })).toMatchObject({ ok: false, field: 'format', reason: 'the format 2 form is no longer read; send format 4' });
  });

  it('reads the three format 4 fields of a format 4 batch and keeps its format', () => {
    const parsed = parseSkeleton(built());
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed).toMatchObject({ others: 0, extensions: [] });
    expect(parsed.skeleton.format).toBe(4);
    expect(parsed.skeleton.transcripts[0]?.tools[0]).toMatchObject({ argFeatures: [{ key: 'pattern', valueSize: '1-8', patternFeatures: ['anchor'] }], argValues: [{ key: 'output_mode', enumValue: 'count' }], changeKind: ['value-changed'] });
    expect(layerOne(parsed.skeleton)).toEqual(['shape:file.search/change/value-changed', 'shape:file.search/enum/output_mode=count', 'shape:file.search/pattern/pattern=anchor', 'shape:file.search/size/pattern=1-8']);
  });

  it('reads a format 3 batch as before: the rest is served, and a format 4 name in it goes to the bag and counts in no cell', () => {
    const old = { ...built(), format: 3 };
    const parsed = parseSkeleton(old);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.skeleton.format).toBe(3);
    const call = parsed.skeleton.transcripts[0]?.tools[0];
    for (const name of FORMAT_4_TOOL_FIELDS) expect(call).not.toHaveProperty(name);
    expect(call).toMatchObject({ keys: ['output_mode', 'pattern'], status: 'ok' });
    expect(parsed.extensions.map(({ at, kind }) => `${kind} ${at}`).sort()).toEqual(FORMAT_4_TOOL_FIELDS.map((name) => `field transcripts[0].tools[0].${name}`).sort());
    expect(layerOne(parsed.skeleton)).toEqual([]);
    expect(cellsOf(storeOf([parsed.skeleton])).cells.length).toBeGreaterThan(0);
  });

  it('reads a format 3 batch that holds none of them with no bag at all', () => {
    const skeleton = built();
    const call = skeleton.transcripts[0]?.tools[0];
    for (const name of FORMAT_4_TOOL_FIELDS) Reflect.deleteProperty(call ?? {}, name);
    expect(parseSkeleton({ ...skeleton, format: 3 })).toMatchObject({ ok: true, others: 0, extensions: [], skeleton: { format: 3 } });
  });
});
