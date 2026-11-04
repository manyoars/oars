// Live (rank 5): an action's share of one day's steps, beside its share over the trailing week. Confounders: the day's mix, and no multiple-test control, which
// is why this states the two shares and flags nothing.
import { UNKNOWN, type Cell } from './cells.js';
import { motifName } from './motif.js';
import { body, groupBy, rate, settled, total, unitCells, wilson, type DeriveFamily } from './read-support.js';

/** The baseline: the seven days before the day read. */
export const LIVE_BASELINE_DAYS = 7;

const DAY_MS = 86_400_000;

const dayBefore = (day: string, back: number): string => new Date(Date.parse(day) - back * DAY_MS).toISOString().slice(0, 10);

/** The days a read of `day` takes its baseline from, so a pool that serves the baseline separately names the same cells. */
export const baselineDaysOf = (day: string): string[] => Array.from({ length: LIVE_BASELINE_DAYS }, (_, index) => dayBefore(day, index + 1));

export const deriveLive: DeriveFamily = ({ pool }) => {
  const units = unitCells(pool).filter(({ cell, motif }) => motif.level === 'shape' && cell.day !== UNKNOWN);
  const stepsOn = new Map([...groupBy(units, ({ cell }) => cell.day)].map(([day, group]) => [day, total(group.map(({ cell }) => cell), settled)]));
  return [...groupBy(units, ({ cell }) => cell.motifId).values()].flatMap((group) => {
    const motif = group[0]?.motif;
    if (motif === undefined) return [];
    const byDay = groupBy(group.map(({ cell }) => cell), (cell: Cell) => cell.day);
    return [...byDay].flatMap(([day, cells]) => {
      const n = total(cells, settled);
      if (n === 0) return [];
      const of = stepsOn.get(day) ?? 0;
      const trailing = baselineDaysOf(day);
      const baselineCells = trailing.flatMap((earlier) => byDay.get(earlier) ?? []);
      const baselineOf = trailing.reduce((sum, earlier) => sum + (stepsOn.get(earlier) ?? 0), 0);
      const share = rate(n, of);
      const baseline = rate(total(baselineCells, settled), baselineOf);
      return [
        // The read cites the day's cells only: a pool counts accounts over a read's inputs, and the baseline must not lift the floor of a day it does not hold (spec Section 4 rule 1).
        body('live', cells, {
          slice: { motif: motifName(motif), day },
          value: { share, baseline, of, ratio: share === null || baseline === null || baseline === 0 ? null : rate(share, baseline) },
          n,
          interval: wilson(n, of),
        }),
      ];
    });
  });
};
