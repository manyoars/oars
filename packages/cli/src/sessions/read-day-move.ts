// Day move (spec Section 6, order 2): a tool's failure rate and share from one calendar day to the next, for every tool above the floor on both days. Unlike the other order 2
// families this is not screened: it is the input lead-lag stands on, and keeping only the large moves would select that read on its outcome. So a row here is not a finding.
import { UNKNOWN } from './cells.js';
import { differenceOf, estimateOf, relate, type DeriveRelation, type Estimate } from './read-order.js';
import type { Read } from './read.js';
import { groupBy, wilson, type ReadBody } from './read-support.js';

const DAY_MS = 86_400_000;
const ISO_DAY_LENGTH = 10;

export const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, ISO_DAY_LENGTH);

/** The read's interval is on its failure rate, so a share's comes from the same read's counts. */
const shareOf = (read: Read): Estimate | undefined => {
  const { share, steps } = read.value;
  if (typeof share !== 'number' || typeof steps !== 'number') return undefined;
  const interval = wilson(read.n, steps);
  return interval === null ? undefined : { value: share, interval };
};

const ESTIMATES = { failureRate: (read: Read) => estimateOf(read, 'failureRate'), share: shareOf } as const;

const moveOf = (metric: keyof typeof ESTIMATES, earlier: Read, later: Read): ReadBody[] => {
  const before = ESTIMATES[metric](earlier);
  const after = ESTIMATES[metric](later);
  if (before === undefined || after === undefined) return [];
  const move = differenceOf(after, before);
  const read = relate('day-move', 'move-to-next-day', '1', [earlier, later], {
    slice: { motif: earlier.slice.motif ?? UNKNOWN, level: earlier.slice.level ?? UNKNOWN, metric, from: earlier.slice.day ?? UNKNOWN, to: later.slice.day ?? UNKNOWN },
    value: { before: before.value, after: after.value, move: move.value },
    interval: move.interval,
  });
  return read === undefined ? [] : [read];
};

export const deriveDayMove: DeriveRelation = (reads) =>
  [...groupBy(reads.filter((read) => read.family === 'tool-day'), (read) => read.slice.motif)].flatMap(([, group]) => {
    const byDay = new Map(group.map((read) => [read.slice.day, read]));
    return group.flatMap((earlier) => {
      const later = byDay.get(nextDay(earlier.slice.day ?? UNKNOWN));
      return later === undefined ? [] : [...moveOf('failureRate', earlier, later), ...moveOf('share', earlier, later)];
    });
  });
