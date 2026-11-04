import { describe, expect, it } from 'vitest';
import { frame, printOf, prompt, session, sessionsFrom, store, storedNames } from './pool-fixture.js';
import { parseSkeleton, skeletonOf, type DeltaEntry, type SessionSkeleton } from './pool-wire.js';
import { PRIVATE } from './public-vocabulary.js';

// The delta entries a batch carries (spec Section 2, "Deltas"), as the skeleton builds them and the parser reads them. The parser is the closed list: a name outside its row is refused, never read as text.
const framed = frame({ shell: 'bash' });

const skeletonWith = (deltas?: readonly DeltaEntry[]): SessionSkeleton => {
  const [only] = sessionsFrom(store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })] }));
  if (only === undefined) throw new Error('no session');
  const skeleton = skeletonOf(only, '0123456789abcdef', storedNames, printOf, deltas);
  if (skeleton === null) throw new Error('no skeleton');
  return skeleton;
};

/** The skeleton as plain JSON with `deltas` set to `value`, the way a hostile client would send it. */
const sentWith = (value: unknown): unknown => ({ ...JSON.parse(JSON.stringify(skeletonWith())), deltas: value });

const refusedField = (value: unknown): string => {
  const parsed = parseSkeleton(value);
  return parsed.ok ? 'accepted' : parsed.field;
};

const ENTRY = { deltaKind: 'removed', field: 'package', name: 'typescript', registry: 'npm', metric: 'callsPerSession', change: -3 };
const PLUGIN = { deltaKind: 'added', field: 'plugin', name: PRIVATE, registry: null, metric: 'callsPerSession', change: 0 };
const MODE = { deltaKind: 'changed', field: 'permissionMode', name: null, registry: null, metric: 'callsPerSession', change: 1 };
const EFFORT = { deltaKind: 'changed', field: 'effort', name: null, registry: null, metric: 'thinking', change: 1 };

describe('a delta entry on the wire', () => {
  it('carries the entries it is given, and the parser reads them back unchanged', () => {
    const entries: DeltaEntry[] = [
      { deltaKind: 'added', field: 'plugin', name: PRIVATE, registry: null, metric: 'callsPerSession', change: 2 },
      { deltaKind: 'changed', field: 'permissionMode', name: null, registry: null, metric: 'callsPerSession', change: 0 },
      { deltaKind: 'changed', field: 'effort', name: null, registry: null, metric: 'thinking', change: -11 },
      { deltaKind: 'removed', field: 'package', name: 'typescript', registry: 'npm', metric: 'callsPerSession', change: -7 },
      { deltaKind: 'removed', field: 'package', name: PRIVATE, registry: null, metric: 'callsPerSession', change: 1 },
    ];
    const skeleton = skeletonWith(entries);
    expect(skeleton.deltas).toEqual(entries);
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton)))).toEqual({ ok: true, skeleton });
  });

  it('holds none when none is given', () => {
    expect(skeletonWith().deltas).toEqual([]);
    expect(skeletonWith([]).deltas).toEqual([]);
  });

  it('refuses a deltas field that is not a list, and names an entry that is not one', () => {
    expect(refusedField(sentWith('none'))).toBe('deltas');
    expect(refusedField(sentWith(undefined))).toBe('deltas');
    expect(refusedField(sentWith([{}]))).toBe('deltas[0].deltaKind');
    expect(refusedField(sentWith([ENTRY, { ...ENTRY, name: 'my-secret-lib' }]))).toBe('deltas[1].name');
  });

  it('accepts a public package with its registry, and refuses the rest of what a package entry could say', () => {
    expect(refusedField(sentWith([ENTRY]))).toBe('accepted');
    expect(refusedField(sentWith([{ ...ENTRY, name: 'my-secret-lib' }]))).toBe('deltas[0].name');
    expect(refusedField(sentWith([{ ...ENTRY, name: null }]))).toBe('deltas[0].name');
    expect(refusedField(sentWith([{ ...ENTRY, registry: null }]))).toBe('deltas[0].registry');
    expect(refusedField(sentWith([{ ...ENTRY, registry: 'plugin' }]))).toBe('deltas[0].registry');
    expect(refusedField(sentWith([{ ...ENTRY, name: PRIVATE }]))).toBe('deltas[0].registry');
    expect(refusedField(sentWith([{ ...ENTRY, name: PRIVATE, registry: null }]))).toBe('accepted');
    expect(refusedField(sentWith([{ ...ENTRY, deltaKind: 'added' }]))).toBe('deltas[0].deltaKind');
    expect(refusedField(sentWith([{ ...ENTRY, metric: 'thinking' }]))).toBe('deltas[0].metric');
  });

  it('accepts a plugin only as the word private, with no registry', () => {
    expect(refusedField(sentWith([PLUGIN]))).toBe('accepted');
    expect(refusedField(sentWith([{ ...PLUGIN, deltaKind: 'removed' }]))).toBe('accepted');
    expect(refusedField(sentWith([{ ...PLUGIN, deltaKind: 'changed' }]))).toBe('deltas[0].deltaKind');
    expect(refusedField(sentWith([{ ...PLUGIN, name: 'superpowers' }]))).toBe('deltas[0].name');
    expect(refusedField(sentWith([{ ...PLUGIN, name: null }]))).toBe('deltas[0].name');
    expect(refusedField(sentWith([{ ...PLUGIN, registry: 'plugin' }]))).toBe('deltas[0].registry');
    expect(refusedField(sentWith([{ ...PLUGIN, metric: 'thinking' }]))).toBe('deltas[0].metric');
  });

  it('accepts a permission mode and an effort by field alone, never by value', () => {
    expect(refusedField(sentWith([MODE, EFFORT]))).toBe('accepted');
    expect(refusedField(sentWith([{ ...MODE, name: 'plan' }]))).toBe('deltas[0].name');
    expect(refusedField(sentWith([{ ...EFFORT, name: 'high' }]))).toBe('deltas[0].name');
    expect(refusedField(sentWith([{ ...MODE, deltaKind: 'added' }]))).toBe('deltas[0].deltaKind');
    expect(refusedField(sentWith([{ ...MODE, registry: 'npm' }]))).toBe('deltas[0].registry');
    expect(refusedField(sentWith([{ ...MODE, metric: 'thinking' }]))).toBe('deltas[0].metric');
    expect(refusedField(sentWith([{ ...EFFORT, metric: 'callsPerSession' }]))).toBe('deltas[0].metric');
  });

  it('refuses a field outside the four, and a key the entry does not hold: a session id, a root, a date', () => {
    expect(refusedField(sentWith([{ ...ENTRY, field: 'model' }]))).toBe('deltas[0].field');
    for (const stray of ['sid', 'session', 'merkleRoot', 'day', 'value']) expect(refusedField(sentWith([{ ...ENTRY, [stray]: 'x' }]))).toBe(`deltas[0].${stray}`);
    const { deltaKind, field, name, registry, metric } = ENTRY;
    expect(refusedField(sentWith([{ deltaKind, field, name, registry, metric }]))).toBe('deltas[0].change');
  });

  it('holds a change to its own metric edges, signed: 7 for a count and 11 for tokens', () => {
    expect(refusedField(sentWith([{ ...ENTRY, change: -7 }]))).toBe('accepted');
    expect(refusedField(sentWith([{ ...ENTRY, change: 8 }]))).toBe('deltas[0].change');
    expect(refusedField(sentWith([{ ...ENTRY, change: -8 }]))).toBe('deltas[0].change');
    expect(refusedField(sentWith([{ ...ENTRY, change: 1.5 }]))).toBe('deltas[0].change');
    expect(refusedField(sentWith([{ ...ENTRY, change: '1' }]))).toBe('deltas[0].change');
    expect(refusedField(sentWith([{ ...EFFORT, change: 11 }]))).toBe('accepted');
    expect(refusedField(sentWith([{ ...EFFORT, change: 12 }]))).toBe('deltas[0].change');
    expect(refusedField(sentWith([{ ...EFFORT, change: -12 }]))).toBe('deltas[0].change');
  });
});
