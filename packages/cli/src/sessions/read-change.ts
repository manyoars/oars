// Change (rank 4), at order 1: each tool's share and failure rate inside one harness version bucket. What moved between two buckets is a relation between
// these reads, so it is order 2 (spec Section 6) and composes on them. Confounders: effort, role by brief, rule commits, class drift, and date.
import { bucketFields, UNKNOWN, type Cell } from './cells.js';
import { motifName } from './motif.js';
import { body, firstDayOf, groupBy, lastDayOf, rate, settled, shapeUnits, total, unitCells, wilson, type DeriveFamily } from './read-support.js';

const scopeOf = (cell: Cell): string => {
  const { harness, harnessBucket } = bucketFields(cell.frameBucket);
  return `${harness}/${harnessBucket}`;
};

export const deriveChange: DeriveFamily = ({ pool }) => {
  const steps = new Map([...groupBy(shapeUnits(pool), scopeOf)].map(([scope, cells]) => [scope, total(cells, settled)]));
  return [...groupBy(unitCells(pool), ({ cell }) => `${cell.motifId}/${scopeOf(cell)}`).values()].flatMap((group) => {
    const [first] = group;
    const cells = group.map(({ cell }) => cell);
    const n = total(cells, settled);
    if (first === undefined || n === 0) return [];
    const of = steps.get(scopeOf(first.cell)) ?? 0;
    const { harness, harnessBucket } = bucketFields(first.cell.frameBucket);
    const days = cells.map((cell) => cell.day).filter((day) => day !== UNKNOWN);
    return [
      body('change', cells, {
        slice: { motif: motifName(first.motif), level: first.motif.level, harness, harnessBucket },
        value: { share: rate(n, of), of, failureRate: rate(total(cells, (cell) => cell.failed), n), firstDay: firstDayOf(days), lastDay: lastDayOf(days) },
        n,
        interval: wilson(n, of),
      }),
    ];
  });
};
