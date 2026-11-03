import { describe, expect, it } from 'vitest';
import { firstOrderOf, tools } from './order-fixture.js';
import { frame, prompt, session, store } from './pool-fixture.js';
import { deriveSubstitution } from './read-substitution.js';
import type { Store } from './store.js';

const twoBuckets = (counts: { [tool: string]: readonly [number, number] }): Store =>
  store({
    sessions: [session('s1')],
    prompts: [prompt('s1', 0, { frame: frame({ harnessVersion: '2.1.305', day: '2026-10-20' }) }), prompt('s1', 1, { frame: frame({ harnessVersion: '2.1.312', day: '2026-10-25' }) })],
    tools: [
      ...tools('s1', 0, Object.entries(counts).map(([name, [count]]) => ({ name, count }))),
      ...tools('s1', 1, Object.entries(counts).map(([name, [, count]]) => ({ name, count }))),
    ],
  });

const reads = (from: Store) => deriveSubstitution(firstOrderOf(from));

describe('substitution', () => {
  it('finds one tool rising as a named other falls, and leaves the bystander alone', () => {
    const found = reads(twoBuckets({ Grep: [300, 100], Write: [100, 300], Read: [600, 600] }));
    expect(found.map((read) => [read.slice.rising, read.slice.falling])).toEqual([['file.write', 'file.search']]);
    expect(found).toHaveLength(1);
    const [read] = found;
    expect(read?.slice.harness).toBe('claude-code');
    expect(read?.slice.from).toBe('2.1.30x');
    expect(read?.slice.to).toBe('2.1.31x');
    expect(read?.value.rise).toBeCloseTo(0.2);
    expect(read?.value.fall).toBeCloseTo(0.2);
    expect(read?.value.offset).toBeCloseTo(0.2);
    expect(read?.interval?.low).toBeGreaterThan(0);
    expect(read?.n).toBe(1000);
    expect(read?.inputs.length).toBeGreaterThanOrEqual(2);
  });

  it('finds nothing with shares unchanged', () => {
    expect(reads(twoBuckets({ Grep: [300, 300], Write: [100, 100], Read: [600, 600] }))).toEqual([]);
  });

  it('finds nothing when one tool rises and all the rest shrink in proportion: shares sum to one, so that fall is arithmetic', () => {
    // Read goes from 20 to 60 percent. Grep and Write each fall by half, and among steps other than Read they hold 75 and 25 percent on both sides.
    expect(reads(twoBuckets({ Read: [200, 600], Grep: [600, 300], Write: [200, 100] }))).toEqual([]);
  });

  it('pairs two tools rising together only with the tool that fell, never with each other', () => {
    const found = reads(twoBuckets({ Grep: [100, 300], Write: [100, 300], Read: [800, 400] }));
    expect(found.map((read) => [read.slice.rising, read.slice.falling]).sort()).toEqual([
      ['file.search', 'file.read'],
      ['file.write', 'file.read'],
    ]);
  });

  it('does not exist below the floor', () => {
    expect(reads(twoBuckets({ Grep: [20, 5], Write: [5, 20] }))).toEqual([]);
  });
});
