import { describe, expect, it } from 'vitest';
import { firstOrderOf, tools } from './order-fixture.js';
import { frame, prompt, session, store } from './pool-fixture.js';
import { deriveInteraction } from './read-interaction.js';
import type { Frame } from './schema.js';
import type { Store } from './store.js';

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

interface Plant {
  name: string;
  count: number;
  failed: number;
}

/** One prompt per tier, each with the tools planted for it, in one version bucket and at one effort unless told otherwise. */
const tiers = (opus: readonly Plant[], sonnet: readonly Plant[], sonnetEffort = 'high', both: Partial<Frame> = {}): Store =>
  store({
    sessions: [session('s1')],
    prompts: [
      prompt('s1', 0, { model: OPUS, frame: frame({ model: OPUS, effort: 'high', ...both }) }),
      prompt('s1', 1, { model: SONNET, frame: frame({ model: SONNET, effort: sonnetEffort, ...both }) }),
    ],
    tools: [...opus.flatMap((plant) => tools('s1', 0, [plant], plant.failed)), ...sonnet.flatMap((plant) => tools('s1', 1, [plant], plant.failed))],
  });

const reads = (from: Store) => deriveInteraction(firstOrderOf(from));

describe('interaction', () => {
  it('finds a tool that works on one tier and not the other, labeling the axis as the tier assigned', () => {
    const found = reads(
      tiers(
        [
          { name: 'Edit', count: 200, failed: 120 },
          { name: 'Read', count: 400, failed: 8 },
        ],
        [
          { name: 'Edit', count: 200, failed: 6 },
          { name: 'Read', count: 400, failed: 8 },
        ],
      ),
    );
    expect(found).toHaveLength(1);
    const [read] = found;
    expect(read?.slice).toEqual({ motif: 'file.edit', level: 'shape', harness: 'claude-code', harnessBucket: '2.1.31x', effort: 'high', tierA: OPUS, tierB: SONNET });
    expect(read?.method).toBe('failure-gap-across-tier-assigned');
    expect(read?.value.failureA).toBe(0.6);
    expect(read?.value.failureB).toBe(0.03);
    expect(read?.value.gap).toBeCloseTo(0.57);
    expect(read?.value.restGap).toBe(0);
    expect(read?.value.interaction).toBeCloseTo(0.57);
    expect(read?.interval?.low).toBeGreaterThan(0.4);
    expect(read?.n).toBe(200);
  });

  it('finds nothing when both tiers fail alike', () => {
    const plant = [
      { name: 'Edit', count: 200, failed: 10 },
      { name: 'Read', count: 400, failed: 8 },
    ];
    expect(reads(tiers(plant, plant))).toEqual([]);
  });

  it('finds nothing when a tier fails more on everything: that is a main effect, not an interaction', () => {
    expect(
      reads(
        tiers(
          [
            { name: 'Edit', count: 400, failed: 160 },
            { name: 'Read', count: 400, failed: 160 },
          ],
          [
            { name: 'Edit', count: 400, failed: 16 },
            { name: 'Read', count: 400, failed: 16 },
          ],
        ),
      ),
    ).toEqual([]);
  });

  it('holds effort constant: two tiers at different efforts are not compared', () => {
    expect(
      reads(
        tiers(
          [
            { name: 'Edit', count: 200, failed: 120 },
            { name: 'Read', count: 400, failed: 8 },
          ],
          [
            { name: 'Edit', count: 200, failed: 6 },
            { name: 'Read', count: 400, failed: 8 },
          ],
          'low',
        ),
      ),
    ).toEqual([]);
  });

  it('compares nothing in an unknown frame: an unknown effort or version bucket holds neither constant', () => {
    const planted = (both: Partial<Frame>) =>
      reads(tiers([{ name: 'Edit', count: 200, failed: 120 }, { name: 'Read', count: 400, failed: 8 }], [{ name: 'Edit', count: 200, failed: 6 }, { name: 'Read', count: 400, failed: 8 }], 'high', both));
    expect(planted({})).toHaveLength(1);
    expect(planted({ effort: null })).toEqual([]);
    expect(planted({ harnessVersion: null })).toEqual([]);
  });

  it('does not exist below the floor, on the tool or on the rest', () => {
    expect(
      reads(
        tiers(
          [
            { name: 'Edit', count: 20, failed: 18 },
            { name: 'Read', count: 400, failed: 8 },
          ],
          [
            { name: 'Edit', count: 20, failed: 0 },
            { name: 'Read', count: 400, failed: 8 },
          ],
        ),
      ),
    ).toEqual([]);
    expect(reads(tiers([{ name: 'Edit', count: 200, failed: 120 }], [{ name: 'Edit', count: 200, failed: 6 }]))).toEqual([]);
  });
});
