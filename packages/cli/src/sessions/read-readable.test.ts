import { describe, expect, it } from 'vitest';
import { firstOrderOf, tools } from './order-fixture.js';
import { frame, prompt, session, store } from './pool-fixture.js';
import { notReadable, whatOf } from './read-readable.js';
import { makeRead } from './read.js';

const singleVersion = store({
  sessions: [session('s1')],
  prompts: [prompt('s1', 0, { frame: frame({ harnessVersion: '2.1.305', day: '2026-10-20' }) })],
  tools: tools('s1', 0, [{ name: 'Read', count: 50 }]),
});

const twoVersionsOf = (count: number) =>
  store({
    sessions: [session('s1')],
    prompts: [prompt('s1', 0, { frame: frame({ harnessVersion: '2.1.305', day: '2026-10-20' }) }), prompt('s1', 1, { frame: frame({ harnessVersion: '2.1.312', day: '2026-10-25' }) })],
    tools: [...tools('s1', 0, [{ name: 'Read', count }, { name: 'Edit', count }]), ...tools('s1', 1, [{ name: 'Read', count }, { name: 'Edit', count }])],
  });

const twoVersions = twoVersionsOf(50);

const twoTiers = store({
  sessions: [session('s1')],
  prompts: [prompt('s1', 0, { frame: frame({ model: 'claude-opus-5-5' }) }), prompt('s1', 1, { frame: frame({ model: 'claude-haiku-5-5' }) })],
  tools: [...tools('s1', 0, [{ name: 'Read', count: 50 }, { name: 'Edit', count: 50 }]), ...tools('s1', 1, [{ name: 'Read', count: 50 }, { name: 'Edit', count: 50 }])],
});

const leadLag = makeRead(
  { family: 'lead-lag', method: 'm', methodVersion: '1', inputs: ['cell:a'], slice: {}, value: { label: 'experimental' }, n: 60, clusters: 1, interval: null, asOf: { pool: 'p', day: null }, basis: 'all' },
  () => 0,
);

describe('what a store cannot read', () => {
  it('always says a model version boundary is not readable, because a cell holds no version of a model', () => {
    const rows = notReadable([]);
    expect(rows.find((row) => row.family === 'version-boundary' && row.what === 'a model version boundary')?.why).toBe('a cell holds a model name and no version of it');
  });

  it('says no harness boundary and no substitution with one version bucket, and neither with two', () => {
    const one = notReadable(firstOrderOf(singleVersion));
    expect(whatOf(one, 'version-boundary')).toContain('a harness version boundary');
    expect(whatOf(one, 'substitution')).toHaveLength(1);
    const two = notReadable(firstOrderOf(twoVersions));
    expect(whatOf(two, 'version-boundary')).not.toContain('a harness version boundary');
    expect(whatOf(two, 'substitution')).toEqual([]);
  });

  it('says why when two version buckets are both below the floor, so an empty family does not read as nothing moved', () => {
    const rows = notReadable(firstOrderOf(twoVersionsOf(3)));
    const why = (family: string) => rows.find((row) => row.family === family && row.what !== 'a model version boundary')?.why;
    expect(why('version-boundary')).toBe('no comparison clears the floor');
    expect(why('substitution')).toBe('no comparison clears the floor');
  });

  it('keeps the reason with no boundary at all apart from the reason with one below the floor', () => {
    const rows = notReadable(firstOrderOf(singleVersion));
    expect(rows.find((row) => row.what === 'a harness version boundary')?.why).toBe('no harness has two version buckets');
    expect(rows.find((row) => row.family === 'substitution')?.why).toBe('no harness has two version buckets');
  });

  it('says no interaction until one tool clears the floor on two tiers in one frame', () => {
    expect(whatOf(notReadable(firstOrderOf(singleVersion)), 'interaction')).toHaveLength(1);
    expect(whatOf(notReadable(firstOrderOf(twoTiers)), 'interaction')).toEqual([]);
  });

  it('says how many pairs lead-lag had when it does not exist, and nothing once it does', () => {
    const [row] = notReadable([]).filter((one) => one.family === 'lead-lag');
    expect(row?.why).toBe('0 pairs, and it needs 30 on each side of the cut');
    expect(whatOf(notReadable([leadLag]), 'lead-lag')).toEqual([]);
  });
});
