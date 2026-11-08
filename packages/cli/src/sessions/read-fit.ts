// Fit (rank 2): how often a tool fails on this frame, by harness version bucket and model. Effort is not in a cell (rule 3), so it is not a slice. Confounders it does not remove: a failure is not a
// misfit, red tests can be the method, effort, and prompt class is not adjusted for.
import { bucketFields, environmentFieldsOf, parseShapeClass } from './cells.js';
import { motifName } from './motif.js';
import { atGrain, body, environmentCells, groupBy, rate, settled, total, unitCells, wilson, type DeriveFamily } from './read-support.js';

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

/**
 * Fit by call shape: how often calls of an action fail when they hold one facet of shape (a target class, an argument class, a count of unsent key names, a set of key names, or a value feature, closed value, or change kind of a sent key), by harness version bucket, from the
 * shape cells (`shapeClass`). A cell counts each call once per facet it holds, so the facets of one action are never summed into one rate. Same confounders as the reads above, and a facet is not the failure's cause.
 */
export const deriveFitShape: DeriveFamily = ({ pool }) =>
  [...groupBy(atGrain(pool, 'week'), (cell) => `${cell.motifId}/${cell.frameBucket}`).values()].flatMap((group) => {
    const [first] = group;
    const shape = first === undefined ? null : parseShapeClass(pool.motifs.get(first.motifId)?.cls ?? '');
    const n = total(group, settled);
    if (first === undefined || shape === null || n === 0) return [];
    const failed = total(group, (cell) => cell.failed);
    const { harness, harnessBucket } = bucketFields(first.frameBucket);
    return [
      body('fit', group, {
        slice: { action: shape.action, facet: shape.facet, value: shape.value, harness, harnessBucket },
        value: { failureRate: rate(failed, n), failed, ok: n - failed },
        n,
        interval: wilson(failed, n),
      }),
    ];
  });
