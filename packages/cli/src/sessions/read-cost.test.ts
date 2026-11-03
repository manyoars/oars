import { describe, expect, it } from 'vitest';
import { frame, poolFrom, prompt, session, store } from './pool-fixture.js';
import { deriveCost, isoWeek } from './read-cost.js';
import type { Store } from './store.js';

const cost = (from: Store) => deriveCost({ pool: poolFrom(from), store: from });
const usage = (input: number, output: number) => ({ input, cacheWrite: 0, cacheRead: 0, output, thinking: 0 });

describe('isoWeek', () => {
  it.each([
    ['2026-11-01', '2026-W44'],
    ['2026-11-02', '2026-W45'],
    ['2021-01-03', '2020-W53'],
    ['2024-12-30', '2025-W01'],
    ['2026-01-01', '2026-W01'],
  ])('reads %s as %s', (day, week) => {
    expect(isoWeek(day)).toBe(week);
  });
});

describe('cost', () => {
  it('states tokens and seconds per prompt, by class, model, and week', () => {
    const reads = cost(
      store({
        sessions: [session('s1')],
        prompts: [
          prompt('s1', 0, { usage: usage(100, 50), wallSec: 10 }),
          prompt('s1', 1, { usage: usage(300, 150), wallSec: 30, errors: 1 }),
          prompt('s1', 2, { usage: usage(1, 1), frame: frame({ day: '2026-11-02' }) }),
          prompt('s1', 3, { usage: usage(1, 1), frame: frame({ model: 'claude-sonnet-5-5' }) }),
          prompt('s1', 4, { usage: usage(1, 1), cls: 'explore-only' }),
        ],
      }),
    );
    expect(reads).toHaveLength(4);
    const read = reads.find((one) => one.slice.class === 'edit-verify' && one.slice.model === 'claude-opus-5-5' && one.slice.week === '2026-W44');
    expect(read?.value).toEqual({ tokensPerPrompt: 300, secondsPerPrompt: 20, errorShare: 0.5 });
    expect(read?.n).toBe(2);
    expect(read?.interval).toBeNull();
  });

  it('reads no tool windows', () => {
    expect(cost(store({ sessions: [session('s1')] }))).toEqual([]);
  });

  it('names an unknown week rather than inventing one', () => {
    const [read] = cost(store({ sessions: [session('s1')], prompts: [prompt('s1', 0, { frame: frame({ day: 'unknown' }) })] }));
    expect(read?.slice.week).toBe('unknown');
  });
});
