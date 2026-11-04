// Adoption (t752, rank 6): when a tool was first and last seen (as the Monday of its UTC week, the grain of an index cell, rule 6), in how many weeks, and its share of all steps. Confounders: the operator's own rules move these, and
// a program name can be noise.
import { UNKNOWN, weekStartOf } from './cells.js';
import { motifName } from './motif.js';
import { body, firstDayOf, groupBy, lastDayOf, rate, settled, shapeUnits, total, unitCells, wilson, type DeriveFamily } from './read-support.js';

const WEEK_MS = 7 * 86_400_000;

const weeksBetween = (from: string | null, to: string | null): number | null => (from === null || to === null ? null : Math.floor((Date.parse(weekStartOf(to)) - Date.parse(from)) / WEEK_MS));

export const deriveAdoption: DeriveFamily = ({ pool }) => {
  const of = total(shapeUnits(pool, 'week'), settled);
  return [...groupBy(unitCells(pool, 'week'), ({ cell }) => cell.motifId).values()].flatMap((group) => {
    const [first] = group;
    const cells = group.map(({ cell }) => cell);
    const n = total(cells, settled);
    if (first === undefined || n === 0) return [];
    const weeks = cells.map((cell) => cell.day).filter((week) => week !== UNKNOWN);
    const lastWeek = lastDayOf(weeks);
    return [
      body('adoption', cells, {
        slice: { motif: motifName(first.motif), level: first.motif.level },
        value: { share: rate(n, of), of, firstWeek: firstDayOf(weeks), lastWeek, weeks: new Set(weeks).size, weeksSinceLast: weeksBetween(lastWeek, pool.lastDay) },
        n,
        interval: wilson(n, of),
      }),
    ];
  });
};
