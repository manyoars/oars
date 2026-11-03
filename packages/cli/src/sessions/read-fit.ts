// Fit (t752, rank 2): how often a tool fails on this frame, by harness version bucket, model, and effort. Confounders it does not remove: a failure is not a
// misfit, red tests can be the method, and prompt class is not adjusted for.
import { bucketFields } from './cells.js';
import { motifName } from './motif.js';
import { body, groupBy, rate, settled, total, unitCells, wilson, type DeriveFamily } from './read-support.js';

export const deriveFit: DeriveFamily = ({ pool }) =>
  [...groupBy(unitCells(pool), ({ cell }) => `${cell.motifId}/${cell.frameBucket}`).values()].flatMap((group) => {
    const [first] = group;
    const cells = group.map(({ cell }) => cell);
    const n = total(cells, settled);
    if (first === undefined || n === 0) return [];
    const failed = total(cells, (cell) => cell.failed);
    return [
      body('fit', cells, {
        slice: { motif: motifName(first.motif), level: first.motif.level, ...bucketFields(first.cell.frameBucket) },
        value: { failureRate: rate(failed, n), failed, ok: n - failed },
        n,
        interval: wilson(failed, n),
      }),
    ];
  });
