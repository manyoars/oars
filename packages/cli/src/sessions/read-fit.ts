// Fit (rank 2): how often a tool fails on this frame, by harness version bucket and model. Effort is not in a cell (rule 3), so it is not a slice. Confounders it does not remove: a failure is not a
// misfit, red tests can be the method, effort, and prompt class is not adjusted for.
import { bucketFields, environmentFieldsOf } from './cells.js';
import { motifName } from './motif.js';
import { body, environmentCells, groupBy, rate, settled, total, unitCells, wilson, type DeriveFamily } from './read-support.js';

export const deriveFit: DeriveFamily = ({ pool }) =>
  [...groupBy(unitCells(pool, 'week'), ({ cell }) => `${cell.motifId}/${cell.frameBucket}`).values()].flatMap((group) => {
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

/**
 * Fit by environment: how often a name fails on a platform and shell, from the version-free cells beside the versioned ones. The two sets count the same calls and are never summed, so
 * this read is its own, and a read of the version cells does not see these cells (`atGrain`). A shell the frame does not name reads as `unknown`, as a missing model does.
 */
export const deriveFitEnvironment: DeriveFamily = ({ pool }) =>
  [...groupBy(environmentCells(pool), (cell) => `${cell.motifId}/${cell.frameBucket}`).values()].flatMap((group) => {
    const [first] = group;
    const motif = first === undefined ? undefined : pool.motifs.get(first.motifId);
    const n = total(group, settled);
    if (first === undefined || motif === undefined || n === 0) return [];
    const failed = total(group, (cell) => cell.failed);
    return [
      body('fit', group, {
        slice: { motif: motifName(motif), level: motif.level, ...environmentFieldsOf(first.frameBucket) },
        value: { failureRate: rate(failed, n), failed, ok: n - failed },
        n,
        interval: wilson(failed, n),
      }),
    ];
  });
