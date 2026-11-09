// Formats 4 and 5: format 4 added a call's value features, closed values, and change kind; format 5 added the names its values held. The client builds format 5 only; the pool reads formats 3, 4, and 5, so a client
// that has not moved yet is still served, and a batch that holds a name its format does not define holds a field its format does not know: it goes to the bag and is served from nowhere. Every name and value here is invented.
import { describe, expect, it } from 'vitest';
import { cellsOf, storeOf } from './cell-increments.js';
import { SHAPE_CLASS } from './cells.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';
import { FORMAT_4_TOOL_FIELDS, FORMAT_5_TOOL_FIELDS, parseSkeleton, READ_FORMATS, skeletonOf, SKELETON_FORMAT, type SessionSkeleton } from './pool-wire.js';

const framed = frame({ shell: 'bash' });
const NAMES = [{ kind: 'dir', name: 'billing' }, { kind: 'file', name: 'plan.md' }];

const built = (): SessionSkeleton => {
  const grep = tool('s1', 0, 'Grep', {
    keys: ['output_mode', 'pattern'],
    argFeatures: [{ key: 'pattern', valueSize: '1-8', patternFeatures: ['anchor'] }],
    argValues: [{ key: 'output_mode', enumValue: 'count' }],
    changeKind: ['value-changed'],
    names: [{ kind: 'dir', name: 'billing' }, { kind: 'file', name: 'plan.md' }],
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
  it('builds format 5 and reads formats 3, 4, and 5, refusing any other', () => {
    expect(SKELETON_FORMAT).toBe(5);
    expect(READ_FORMATS).toEqual([3, 4, 5]);
    expect(built().format).toBe(5);
    expect(parseSkeleton({ ...built(), format: 6 })).toMatchObject({ ok: false, field: 'format', reason: 'not a format this version reads' });
    expect(parseSkeleton({ ...built(), format: 2 })).toMatchObject({ ok: false, field: 'format', reason: 'the format 2 form is no longer read; send format 5' });
  });

  it('reads the format 4 and format 5 fields of a format 5 batch, keeps its format, and keeps the names with their kinds', () => {
    const parsed = parseSkeleton(built());
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed).toMatchObject({ others: 0, extensions: [] });
    expect(parsed.skeleton.format).toBe(5);
    expect(parsed.skeleton.transcripts[0]?.tools[0]).toMatchObject({ argFeatures: [{ key: 'pattern', valueSize: '1-8', patternFeatures: ['anchor'] }], argValues: [{ key: 'output_mode', enumValue: 'count' }], changeKind: ['value-changed'], names: NAMES });
    expect(layerOne(parsed.skeleton)).toEqual(['shape:file.search/change/value-changed', 'shape:file.search/enum/output_mode=count', 'shape:file.search/pattern/pattern=anchor', 'shape:file.search/size/pattern=1-8']);
  });

  it('reads a name of a kind this reader does not know, or one with no name shape, as other, and counts and bags it', () => {
    const odd = built();
    const call = odd.transcripts[0]?.tools[0];
    if (call === undefined) throw new Error('no call');
    Reflect.set(call, 'names', [{ kind: 'planet', name: 'billing' }, { kind: 'file', name: 'a b' }]);
    const parsed = parseSkeleton(odd);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.skeleton.transcripts[0]?.tools[0]?.names).toEqual([{ kind: 'other', name: 'billing' }, { kind: 'file', name: 'other' }]);
    expect(parsed.others).toBe(2);
    expect(parsed.extensions.map(({ at, kind, value }) => `${kind} ${at} ${String(value)}`)).toEqual(['value transcripts[0].tools[0].names[0].kind planet', 'value transcripts[0].tools[0].names[1].name a b']);
  });

  it('refuses a name that is no object, or that lacks its kind or its name', () => {
    for (const bad of ['plan.md', {}, { kind: 'file' }, { name: 'plan.md' }, { kind: 'file', name: 3 }]) {
      const sent = built();
      const call = sent.transcripts[0]?.tools[0];
      if (call === undefined) throw new Error('no call');
      Reflect.set(call, 'names', [bad]);
      expect(parseSkeleton(sent)).toMatchObject({ ok: false });
    }
  });

  it('reads a format 4 batch as before: layer 1 is served, and a name in it goes to the bag and counts in no cell', () => {
    const older = { ...built(), format: 4 };
    const parsed = parseSkeleton(older);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.skeleton.format).toBe(4);
    const call = parsed.skeleton.transcripts[0]?.tools[0];
    for (const name of FORMAT_5_TOOL_FIELDS) expect(call).not.toHaveProperty(name);
    expect(call).toMatchObject({ changeKind: ['value-changed'], status: 'ok' });
    expect(parsed.extensions.map(({ at, kind }) => `${kind} ${at}`).sort()).toEqual(FORMAT_5_TOOL_FIELDS.map((name) => `field transcripts[0].tools[0].${name}`).sort());
    expect(layerOne(parsed.skeleton)).toEqual(['shape:file.search/change/value-changed', 'shape:file.search/enum/output_mode=count', 'shape:file.search/pattern/pattern=anchor', 'shape:file.search/size/pattern=1-8']);
  });

  it('reads a format 3 batch as before: the rest is served, and a later name in it goes to the bag and counts in no cell', () => {
    const old = { ...built(), format: 3 };
    const parsed = parseSkeleton(old);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.skeleton.format).toBe(3);
    const call = parsed.skeleton.transcripts[0]?.tools[0];
    const later = [...FORMAT_4_TOOL_FIELDS, ...FORMAT_5_TOOL_FIELDS];
    for (const name of later) expect(call).not.toHaveProperty(name);
    expect(call).toMatchObject({ keys: ['output_mode', 'pattern'], status: 'ok' });
    expect(parsed.extensions.map(({ at, kind }) => `${kind} ${at}`).sort()).toEqual(later.map((name) => `field transcripts[0].tools[0].${name}`).sort());
    expect(layerOne(parsed.skeleton)).toEqual([]);
    expect(cellsOf(storeOf([parsed.skeleton])).cells.length).toBeGreaterThan(0);
  });

  it('reads a format 4 or format 3 batch that holds none of the later fields with no bag at all', () => {
    const skeleton = built();
    const call = skeleton.transcripts[0]?.tools[0];
    for (const name of FORMAT_5_TOOL_FIELDS) Reflect.deleteProperty(call ?? {}, name);
    expect(parseSkeleton({ ...skeleton, format: 4 })).toMatchObject({ ok: true, others: 0, extensions: [], skeleton: { format: 4 } });
    for (const name of FORMAT_4_TOOL_FIELDS) Reflect.deleteProperty(call ?? {}, name);
    expect(parseSkeleton({ ...skeleton, format: 3 })).toMatchObject({ ok: true, others: 0, extensions: [], skeleton: { format: 3 } });
  });
});
