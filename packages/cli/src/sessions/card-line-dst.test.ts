// The ISO week where January 1 is in daylight saving time (southern hemisphere): every standard-time Thursday is an hour past a whole day from January 1.
process.env.TZ = 'Australia/Sydney';
import { expect, it } from 'vitest';
import { isoWeekOf } from './card-line.js';

it('counts whole days, so the weeks around the October clock change are not bumped', () => {
  expect(isoWeekOf(new Date(2027, 8, 30, 12).getTime())).toBe('2027-W39');
  expect(isoWeekOf(new Date(2027, 9, 7, 12).getTime())).toBe('2027-W40');
});
