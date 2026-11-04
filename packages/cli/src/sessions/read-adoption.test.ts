import { describe, expect, it } from 'vitest';
import { frame, poolFrom, prompt, session, store, tool } from './pool-fixture.js';
import { deriveAdoption } from './read-adoption.js';
import type { Store } from './store.js';

const adoption = (from: Store) => deriveAdoption({ pool: poolFrom(from), store: from });

describe('adoption', () => {
  it('states first week, last week, weeks seen, weeks since last, and a share of all steps, each week named by its Monday', () => {
    const reads = adoption(
      store({
        sessions: [session('s1')],
        prompts: [prompt('s1', 0, { frame: frame({ day: '2026-10-20' }) }), prompt('s1', 1)],
        tools: [tool('s1', 0, 'Read'), tool('s1', 1, 'Edit'), tool('s1', 2, 'Read', { prompt: 1 }), tool('s1', 3, 'Read', { prompt: 1 })],
      }),
    );
    const of = (motif: string) => reads.find((read) => read.slice.motif === motif);
    expect(reads).toHaveLength(2);
    expect(of('file.read')?.value).toEqual({ share: 0.75, of: 4, firstWeek: '2026-10-19', lastWeek: '2026-10-26', weeks: 2, weeksSinceLast: 0 });
    expect(of('file.edit')?.value).toEqual({ share: 0.25, of: 4, firstWeek: '2026-10-19', lastWeek: '2026-10-19', weeks: 1, weeksSinceLast: 1 });
    expect(of('file.read')?.n).toBe(3);
  });

  it('states no weeks when none is known, and nothing of a tool with no settled step', () => {
    const reads = adoption(store({ sessions: [session('s1')], prompts: [prompt('s1', 0, { frame: frame({ day: 'unknown' }) })], tools: [tool('s1', 0, 'Read'), tool('s1', 1, 'Edit', { status: 'none' })] }));
    expect(reads.map((read) => read.value)).toEqual([{ share: 1, of: 1, firstWeek: null, lastWeek: null, weeks: 0, weeksSinceLast: null }]);
  });
});
