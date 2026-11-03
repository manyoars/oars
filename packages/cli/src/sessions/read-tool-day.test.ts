import { describe, expect, it } from 'vitest';
import { tools } from './order-fixture.js';
import { frame, poolFrom, prompt, session, store } from './pool-fixture.js';
import { deriveToolDay } from './read-tool-day.js';

const on = (day: string) => frame({ day });

describe('tool on a day', () => {
  it('states a tool failure rate and its interval, and its share of that day alone', () => {
    const from = store({
      sessions: [session('s1')],
      prompts: [prompt('s1', 0, { frame: on('2026-10-20') }), prompt('s1', 1, { frame: on('2026-10-21') })],
      tools: [...tools('s1', 0, [{ name: 'Read', count: 30 }, { name: 'Edit', count: 10 }], 3), ...tools('s1', 1, [{ name: 'Read', count: 5 }])],
    });
    const reads = deriveToolDay({ pool: poolFrom(from), store: from });
    const first = reads.find((read) => read.slice.motif === 'file.read' && read.slice.day === '2026-10-20');
    expect(first?.slice).toEqual({ motif: 'file.read', level: 'shape', day: '2026-10-20' });
    expect(first?.value).toEqual({ failureRate: 0.1, failed: 3, share: 0.75, steps: 40 });
    expect(first?.n).toBe(30);
    expect(first?.interval?.low).toBeGreaterThan(0);
    expect(first?.interval?.high).toBeLessThan(0.3);
    expect(reads.find((read) => read.slice.motif === 'file.read' && read.slice.day === '2026-10-21')?.value.share).toBe(1);
    expect(reads).toHaveLength(3);
  });

  it('has no read for a day it cannot place', () => {
    const from = store({
      sessions: [session('s1')],
      prompts: [prompt('s1', 0, { frame: frame({ day: null }) })],
      tools: tools('s1', 0, [{ name: 'Read', count: 5 }]),
    });
    expect(deriveToolDay({ pool: poolFrom(from), store: from })).toEqual([]);
  });
});
