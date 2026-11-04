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
    expect(read?.slice).toEqual({ motif: 'file.edit', level: 'shape', harness: 'claude-code', harnessBucket: '2.1.31x', tierA: OPUS, tierB: SONNET });
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

  it('finds nothing for a tool that one tier resists: it still fails more on that tier, only less than the main effect says', () => {
    // Opus fails far more on Read (0.9 against 0.02) and on Edit (0.4 against 0.05). Edit's gap is +0.35 and the rest's is +0.88, so its interaction is -0.53: a large move in the
    // opposite direction from the gap. Only Read moves with the main effect, so only Read is a tool that fails more on the tier beyond how the tiers differ elsewhere.
    const found = reads(
      tiers(
        [
          { name: 'Edit', count: 200, failed: 80 },
          { name: 'Read', count: 400, failed: 360 },
        ],
        [
          { name: 'Edit', count: 200, failed: 10 },
          { name: 'Read', count: 400, failed: 8 },
        ],
      ),
    );
    expect(found.map((read) => read.slice.motif)).toEqual(['file.read']);
    expect(found[0]?.value.gap).toBeGreaterThan(0);
    expect(found[0]?.value.interaction).toBeGreaterThan(0);
  });

  it('does not hold effort constant: effort is not in a cell (rule 3), so two tiers at different efforts are compared and the slice names no effort', () => {
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
        'low',
      ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.slice).not.toHaveProperty('effort');
  });

  it('compares nothing in an unknown frame: an unknown version bucket holds no frame constant, and an unknown effort does not matter', () => {
    const planted = (both: Partial<Frame>) =>
      reads(tiers([{ name: 'Edit', count: 200, failed: 120 }, { name: 'Read', count: 400, failed: 8 }], [{ name: 'Edit', count: 200, failed: 6 }, { name: 'Read', count: 400, failed: 8 }], 'high', both));
    expect(planted({})).toHaveLength(1);
    expect(planted({ effort: null })).toHaveLength(1);
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
