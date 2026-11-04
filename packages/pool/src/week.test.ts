import { describe, expect, it } from 'vitest';
import { isoWeekOf, secondsToNextWeek } from './week.js';

const at = (iso: string): number => Date.parse(iso);

describe('isoWeekOf', () => {
  it.each([
    ['2021-01-03T12:00:00Z', '2020-W53'],
    ['2021-01-04T00:00:00Z', '2021-W01'],
    ['2024-12-29T23:59:59Z', '2024-W52'],
    ['2024-12-30T00:00:00Z', '2025-W01'],
    ['2026-01-01T00:00:00Z', '2026-W01'],
    ['2026-11-01T23:59:59Z', '2026-W44'],
    ['2026-11-02T00:00:00Z', '2026-W45'],
    ['2026-11-04T06:00:00Z', '2026-W45'],
  ])('%s is %s', (iso, week) => {
    expect(isoWeekOf(at(iso))).toBe(week);
  });
});

describe('secondsToNextWeek', () => {
  it('counts to the next Monday 00:00 UTC', () => {
    expect(secondsToNextWeek(at('2026-11-02T00:00:00Z'))).toBe(7 * 24 * 3600);
    expect(secondsToNextWeek(at('2026-11-04T06:00:00Z'))).toBe(4 * 24 * 3600 + 18 * 3600);
    expect(secondsToNextWeek(at('2026-11-08T23:59:59Z'))).toBe(1);
  });

  it('rounds a partial second up, so a client that waits that long is in the new week', () => {
    expect(secondsToNextWeek(at('2026-11-08T23:59:59.500Z'))).toBe(1);
  });
});
