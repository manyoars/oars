import { describe, expect, it } from 'vitest';
import { DELTA_DAYS, DELTA_MIN_SESSIONS, windowsOf } from './pool-delta.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-10-01T09:00:00Z');

/** `count` sessions spread over the `index`th window (a window is `DELTA_DAYS` long, counted from the first session), named `<prefix><n>`. */
const run = (prefix: string, index: number, count: number): { id: string; at: number }[] =>
  Array.from({ length: count }, (_, n) => ({ id: `${prefix}${String(n)}`, at: START + index * DELTA_DAYS * DAY + n * 60 * 60 * 1000 }));

describe('the windows of a delta', () => {
  it('hold the values the spec names', () => {
    expect(DELTA_DAYS).toBe(7);
    expect(DELTA_MIN_SESSIONS).toBe(5);
  });

  it('build no delta while the after window holds 4 sessions, and one at 5', () => {
    expect(windowsOf([...run('b', 0, 5), ...run('a', 1, 4)])).toEqual([]);
    const [only, ...rest] = windowsOf([...run('b', 0, 5), ...run('a', 1, 5)]);
    expect(rest).toEqual([]);
    expect(only?.before.map(({ id }) => id)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
    expect(only?.after.map(({ id }) => id)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
  });

  it('build no delta while the before window holds 4 sessions, and one at 5', () => {
    expect(windowsOf([...run('b', 0, 4), ...run('a', 1, 5)])).toEqual([]);
    expect(windowsOf([...run('b', 0, 5), ...run('a', 1, 5)])).toHaveLength(1);
  });

  it('name the session that fills the after window: the fifth in time order, whatever the order given', () => {
    const [only] = windowsOf([...run('a', 1, 8), ...run('b', 0, 5)].reverse());
    expect(only?.filler.id).toBe('a4');
    expect(only?.after).toHaveLength(8);
  });

  it('compare only windows next to each other, so a gap of a window builds nothing', () => {
    expect(windowsOf([...run('b', 0, 5), ...run('a', 2, 5)])).toEqual([]);
  });

  it('chain windows: each full window is the after of one pair and the before of the next', () => {
    const pairs = windowsOf([...run('w0', 0, 5), ...run('w1', 1, 5), ...run('w2', 2, 6)]);
    expect(pairs.map(({ filler }) => filler.id)).toEqual(['w14', 'w24']);
    expect(pairs[1]?.before.map(({ id }) => id)).toEqual(['w10', 'w11', 'w12', 'w13', 'w14']);
  });

  it('take the minimum and the span as arguments', () => {
    expect(windowsOf([...run('b', 0, 2), ...run('a', 1, 2)], DELTA_DAYS, 2)).toHaveLength(1);
    expect(windowsOf([{ id: 'x', at: START }, { id: 'y', at: START + DAY }], 1, 1)).toHaveLength(1);
    expect(windowsOf([{ id: 'x', at: START }, { id: 'y', at: START + 2 * DAY }], 1, 1)).toEqual([]);
  });

  it('order sessions of one instant by id, so two runs agree', () => {
    const same = ['d', 'c', 'b', 'a', 'e'].map((id) => ({ id, at: START }));
    const [only] = windowsOf([...same, ...run('z', 1, 5)]);
    expect(only?.before.map(({ id }) => id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
