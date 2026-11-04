// ISO weeks in UTC, for the fetch cap: the count a fetch spends belongs to one week and starts again at the next Monday 00:00 UTC.
const DAY_MS = 24 * 60 * 60 * 1000;

/** Monday is 0. */
const weekdayOf = (day: Date): number => (day.getUTCDay() + 6) % 7;

/** The ISO week a moment falls in, as `YYYY-Www`. The year is the Thursday's, so 2021-01-03 is 2020-W53 and 2024-12-30 is 2025-W01. */
export const isoWeekOf = (ms: number): string => {
  const moment = new Date(ms);
  const thursday = new Date(Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate()) + (3 - weekdayOf(moment)) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const dayOfYear = Math.round((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS);
  return `${String(year)}-W${String(Math.floor(dayOfYear / 7) + 1).padStart(2, '0')}`;
};

/** Seconds from a moment to the next Monday 00:00 UTC, which is when a spent week starts over: a `Retry-After`. */
export const secondsToNextWeek = (ms: number): number => {
  const moment = new Date(ms);
  const midnight = Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate());
  return Math.ceil((midnight + (7 - weekdayOf(moment)) * DAY_MS - ms) / 1000);
};
