import { describe, expect, it } from 'vitest';
import { firstOrderOf, tools } from './order-fixture.js';
import { frame, prompt, session, store } from './pool-fixture.js';
import { boundariesOf, deriveVersionBoundary, toolKey } from './read-version-boundary.js';
import { TRIALS_FLOOR } from './read-order.js';
import type { Store } from './store.js';

const OLDER = frame({ harnessVersion: '2.1.305', day: '2026-10-20' });
const NEWER = frame({ harnessVersion: '2.1.312', day: '2026-10-25' });

/** Counts per tool in two adjacent version buckets, as `[tool, older, newer]`. */
const twoBuckets = (counts: readonly (readonly [string, number, number])[], failedInNewer = 0): Store => {
  const older = counts.map(([name, count]) => ({ name, count }));
  const newer = counts.map(([name, , count]) => ({ name, count }));
  return store({
    sessions: [session('s1')],
    prompts: [prompt('s1', 0, { frame: OLDER }), prompt('s1', 1, { frame: NEWER })],
    tools: [...tools('s1', 0, older), ...tools('s1', 1, newer, failedInNewer)],
  });
};

const reads = (from: Store) => deriveVersionBoundary(firstOrderOf(from));

describe('version boundary', () => {
  it('finds a planted share shift between adjacent buckets, naming both buckets, the move, and an interval that excludes zero', () => {
    const found = reads(twoBuckets([['Read', 800, 200], ['Edit', 200, 800]]));
    const read = found.find((one) => one.slice.motif === 'file.read' && one.slice.metric === 'share');
    expect(read?.slice).toEqual({ motif: 'file.read', level: 'shape', harness: 'claude-code', from: '2.1.30x', to: '2.1.31x', metric: 'share' });
    expect(read?.value.before).toBe(0.8);
    expect(read?.value.after).toBe(0.2);
    expect(read?.value.move).toBe(-0.6);
    expect(read?.value.fromLastDay).toBe('2026-10-20');
    expect(read?.value.toFirstDay).toBe('2026-10-25');
    expect(read?.n).toBe(1000);
    expect(read?.clusters).toBe(1);
    expect(read?.interval?.high).toBeLessThan(0);
    expect(read?.interval?.low).toBeGreaterThan(-0.7);
  });

  it('finds nothing when no share or failure rate moved', () => {
    expect(reads(twoBuckets([['Read', 500, 500], ['Edit', 500, 500]]))).toEqual([]);
  });

  it('finds nothing in a small wobble, however large the sample: a move has to matter', () => {
    // A move of 0.008 on 100,000 steps a side: it clears the screen, and it is still under the smallest move worth stating.
    expect(reads(twoBuckets([['Read', 50_000, 50_800], ['Edit', 50_000, 49_200]]))).toEqual([]);
  });

  it('finds a planted failure-rate shift with shares unchanged', () => {
    const found = reads(twoBuckets([['Read', 500, 500], ['Edit', 500, 500]], 100));
    // The failed calls are the first of each tool in the newer bucket.
    expect(found.map((read) => [read.slice.motif, read.slice.metric, read.value.after])).toEqual(
      expect.arrayContaining([
        ['file.read', 'failureRate', 0.2],
        ['file.edit', 'failureRate', 0.2],
      ]),
    );
    expect(found.every((read) => read.slice.metric === 'failureRate')).toBe(true);
  });

  it('finds a tool that vanished at the boundary: its share went to zero in a bucket with no read of it', () => {
    const found = reads(twoBuckets([['Read', 500, 1000], ['Edit', 500, 0]]));
    const read = found.find((one) => one.slice.motif === 'file.edit' && one.slice.metric === 'share');
    expect(read?.value.after).toBe(0);
    expect(read?.value.move).toBe(-0.5);
    expect(read?.inputs).toHaveLength(2);
  });

  it('finds a tool that appeared at the boundary', () => {
    const found = reads(twoBuckets([['Read', 1000, 500], ['Edit', 0, 500]]));
    expect(found.find((one) => one.slice.motif === 'file.edit' && one.slice.metric === 'share')?.value.before).toBe(0);
  });

  it('does not exist below the floor: a thin bucket reads as nothing, however far it moved', () => {
    const under = TRIALS_FLOOR - 1;
    expect(reads(twoBuckets([['Read', under, 0], ['Edit', 0, under]]))).toEqual([]);
  });

  it('does not read a failure rate below the floor, though the share above it does read', () => {
    const found = reads(twoBuckets([['Read', 990, 500], ['Edit', 10, 500]], 5));
    expect(found.some((read) => read.slice.motif === 'file.edit' && read.slice.metric === 'failureRate')).toBe(false);
    expect(found.some((read) => read.slice.motif === 'file.edit' && read.slice.metric === 'share')).toBe(true);
  });

  it('states how many comparisons were screened, so a reader can size what chance would find', () => {
    const [first] = reads(twoBuckets([['Read', 800, 200], ['Edit', 200, 800]]));
    // Two tools, two metrics, one boundary.
    expect(first?.value.tested).toBe(4);
  });

  it('orders buckets as versions, not as text, and compares only neighbors', () => {
    const version = (harnessVersion: string) => frame({ harnessVersion, day: '2026-10-20' });
    const from = store({
      sessions: [session('s1')],
      prompts: [prompt('s1', 0, { frame: version('2.1.95') }), prompt('s1', 1, { frame: version('2.1.100') }), prompt('s1', 2, { frame: version('2.1.310') })],
      tools: [...tools('s1', 0, [{ name: 'Read', count: 40 }]), ...tools('s1', 1, [{ name: 'Read', count: 40 }]), ...tools('s1', 2, [{ name: 'Read', count: 40 }])],
    });
    expect(boundariesOf(firstOrderOf(from)).map(({ from: a, to: b }) => [a.name, b.name])).toEqual([
      ['2.1.9x', '2.1.10x'],
      ['2.1.10x', '2.1.31x'],
    ]);
  });

  it('leaves an unknown version bucket out of the order', () => {
    const from = store({
      sessions: [session('s1')],
      prompts: [prompt('s1', 0, { frame: frame({ harnessVersion: null }) }), prompt('s1', 1, { frame: OLDER })],
      tools: [...tools('s1', 0, [{ name: 'Read', count: 40 }]), ...tools('s1', 1, [{ name: 'Read', count: 40 }])],
    });
    expect(boundariesOf(firstOrderOf(from))).toEqual([]);
  });

  it('keys a read that lacks its level or motif by the UNKNOWN placeholder, not an empty string', () => {
    const found = reads(twoBuckets([['Read', 800, 200], ['Edit', 200, 800]]));
    const read = found[0];
    if (read === undefined) throw new Error('expected a read');
    expect(toolKey({ ...read, slice: Object.fromEntries(Object.entries(read.slice).filter(([name]) => name !== 'level' && name !== 'motif')) })).toBe('unknown\nunknown');
  });
});
