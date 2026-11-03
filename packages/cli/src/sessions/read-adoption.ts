// Adoption (t752, rank 6): when a tool was first and last seen, on how many days, and its share of all steps. Confounders: the operator's own rules move these, and
// a program name can be noise.
import { UNKNOWN } from './cells.js';
import { motifName } from './motif.js';
import { body, firstDayOf, groupBy, lastDayOf, rate, settled, shapeUnits, total, unitCells, wilson, type DeriveFamily } from './read-support.js';

const DAY_MS = 86_400_000;

const daysBetween = (from: string | null, to: string | null): number | null => (from === null || to === null ? null : Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS));

export const deriveAdoption: DeriveFamily = ({ pool }) => {
  const of = total(shapeUnits(pool), settled);
  return [...groupBy(unitCells(pool), ({ cell }) => cell.motifId).values()].flatMap((group) => {
    const [first] = group;
    const cells = group.map(({ cell }) => cell);
    const n = total(cells, settled);
    if (first === undefined || n === 0) return [];
    const days = cells.map((cell) => cell.day).filter((day) => day !== UNKNOWN);
    const lastDay = lastDayOf(days);
    return [
      body('adoption', 'share-and-span', '1', cells, {
        slice: { motif: motifName(first.motif), level: first.motif.level },
        value: { share: rate(n, of), of, firstDay: firstDayOf(days), lastDay, days: new Set(days).size, daysSinceLast: daysBetween(lastDay, pool.lastDay) },
        n,
        interval: wilson(n, of),
      }),
    ];
  });
};
