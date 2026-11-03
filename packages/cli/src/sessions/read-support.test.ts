import { describe, expect, it } from 'vitest';
import { firstDayOf, groupBy, lastDayOf, rate, wilson } from './read-support.js';

describe('rate', () => {
  it('rounds to four places, and is null with nothing to divide by', () => {
    expect(rate(1, 3)).toBe(0.3333);
    expect(rate(1, 0)).toBeNull();
  });
});

describe('wilson', () => {
  it('is null with no observations', () => {
    expect(wilson(0, 0)).toBeNull();
  });

  it('stays inside 0 and 1 at both edges, and is wide on a small sample', () => {
    const none = wilson(0, 5);
    const all = wilson(5, 5);
    expect(none?.low).toBe(0);
    expect(all?.high).toBe(1);
    expect(none?.high).toBeGreaterThan(0.4);
    expect(all?.low).toBeLessThan(0.6);
  });

  it('matches a worked value and narrows as the sample grows', () => {
    expect(wilson(50, 100)).toEqual({ low: 0.4038, high: 0.5962, level: 0.95 });
    const small = wilson(5, 10);
    const large = wilson(500, 1000);
    expect((large?.high ?? 1) - (large?.low ?? 0)).toBeLessThan((small?.high ?? 0) - (small?.low ?? 1));
  });
});

describe('the small helpers', () => {
  it('groups in first-seen order', () => {
    expect([...groupBy(['a1', 'b1', 'a2'], (item) => item[0])]).toEqual([
      ['a', ['a1', 'a2']],
      ['b', ['b1']],
    ]);
  });

  it('finds the first and last day, and null among none', () => {
    expect(firstDayOf(['2026-11-02', '2026-11-01'])).toBe('2026-11-01');
    expect(lastDayOf(['2026-11-01', '2026-11-02'])).toBe('2026-11-02');
    expect(firstDayOf([])).toBeNull();
    expect(lastDayOf([])).toBeNull();
  });
});
