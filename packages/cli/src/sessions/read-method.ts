// Method (t752, rank 7): a shape's share of all windows of its length, per model. t752 reads this by class as well; a cell holds no class, because a step has none, so
// the class axis waits for a field on the cell. Confounders: task assignment by tier, effort, and no outcome label, so nothing here says a method is better.
import { bucketFields, type Cell } from './cells.js';
import { motifName } from './motif.js';
import { body, atGrain, groupBy, rate, settled, total, wilson, type DeriveFamily } from './read-support.js';

export const deriveMethod: DeriveFamily = ({ pool }) => {
  const windows = atGrain(pool, 'week').flatMap((cell) => {
    const motif = pool.motifs.get(cell.motifId);
    return motif?.level === 'shape' && motif.steps.length >= 2 ? [{ cell, motif, model: bucketFields(cell.frameBucket).model }] : [];
  });
  const scopeTotals = new Map([...groupBy(windows, ({ motif, model }) => `${String(motif.steps.length)}/${model}`)].map(([scope, group]) => [scope, total(group.map(({ cell }) => cell), settled)]));
  return [...groupBy(windows, ({ cell, model }) => `${cell.motifId}/${model}`).values()].flatMap((group) => {
    const [first] = group;
    const cells: Cell[] = group.map(({ cell }) => cell);
    const n = total(cells, settled);
    if (first === undefined || n === 0) return [];
    const length = first.motif.steps.length;
    const of = scopeTotals.get(`${String(length)}/${first.model}`) ?? 0;
    return [
      body('method', cells, {
        slice: { motif: motifName(first.motif), model: first.model, length: String(length) },
        value: { share: rate(n, of), of, failureRate: rate(total(cells, (cell) => cell.failed), n) },
        n,
        interval: wilson(n, of),
      }),
    ];
  });
};
