// Next step (rank 8): from a prefix of one to three actions, which action came next, by count. Confounders: no outcome label, so the most common next step is
// not the right one; a scoring found this barely above repeating the last tool. Remaining cost is not read here, because a window's cost stops at the window.
import { type Cell } from './cells.js';
import { motifName, shapeMotif, type WindowStep } from './motif.js';
import { body, atGrain, groupBy, rate, settled, total, wilson, type DeriveFamily } from './read-support.js';

interface Extension {
  cell: Cell;
  prefix: readonly WindowStep[];
  next: string;
}

const countsOf = (group: readonly Extension[]): { [action: string]: number } => {
  const counts: { [action: string]: number } = {};
  for (const { cell, next } of group) counts[next] = (counts[next] ?? 0) + settled(cell);
  return counts;
};

export const deriveNextStep: DeriveFamily = ({ pool }) => {
  const extensions = atGrain(pool, 'week').flatMap((cell): Extension[] => {
    const motif = pool.motifs.get(cell.motifId);
    const last = motif?.steps.at(-1);
    return motif?.level === 'shape' && motif.steps.length >= 2 && last !== undefined ? [{ cell, prefix: motif.steps.slice(0, -1), next: last.action }] : [];
  });
  return [...groupBy(extensions, ({ prefix }) => shapeMotif(prefix).motifId).values()].flatMap((group) => {
    const [first] = group;
    const cells = group.map(({ cell }) => cell);
    const n = total(cells, settled);
    if (first === undefined || n === 0) return [];
    const next = countsOf(group);
    const [top, topCount] = Object.entries(next).sort(([a, one], [b, two]) => two - one || (a < b ? -1 : 1))[0] ?? ['', 0];
    return [
      body('next-step', cells, {
        slice: { prefix: motifName(shapeMotif(first.prefix)), length: String(first.prefix.length) },
        value: { next, top, topShare: rate(topCount, n) },
        n,
        interval: wilson(topCount, n),
      }),
    ];
  });
};
