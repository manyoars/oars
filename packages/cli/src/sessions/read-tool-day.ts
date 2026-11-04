// A tool on a day, at order 1: its failure rate, which the interval is on, and its share of that day's steps. The reads above it need both on a time axis, because this store
// has too few version boundaries to cut in time. Shape level only, so a day's steps are counted once. Confounders: the day's mix of work, effort, and rule commits.
import { motifName } from './motif.js';
import { body, groupBy, rate, settled, total, unitCells, wilson, type DeriveFamily } from './read-support.js';

export const deriveToolDay: DeriveFamily = ({ pool }) => {
  const known = unitCells(pool, 'day').filter(({ motif }) => motif.level === 'shape');
  const steps = new Map([...groupBy(known, ({ cell }) => cell.day)].map(([day, group]) => [day, total(group.map(({ cell }) => cell), settled)]));
  return [...groupBy(known, ({ cell }) => `${cell.motifId}/${cell.day}`).values()].flatMap((group) => {
    const [first] = group;
    const cells = group.map(({ cell }) => cell);
    const n = total(cells, settled);
    if (first === undefined || n === 0) return [];
    const failed = total(cells, (cell) => cell.failed);
    const of = steps.get(first.cell.day) ?? 0;
    return [
      body('tool-day', cells, {
        slice: { motif: motifName(first.motif), level: first.motif.level, day: first.cell.day },
        // `steps` and not `of`: this read's interval rests on the tool's own calls, and `of` would hold it to the floor by the day's.
        value: { failureRate: rate(failed, n), failed, share: rate(n, of), steps: of },
        n,
        interval: wilson(failed, n),
      }),
    ];
  });
};
