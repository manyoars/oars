// Recovery on the same target (from cells): for a failed call, the next step that most often came back ok on the same target class. One read per (harness bucket, week, code, failed action, target class), from the week cells
// of `recovery-target.ts`. It states counts, never a fix, and it speaks only when its answer is not a retry: when the most common recovering step repeated the failed call, or a repeat did as often as any other step, the cell is left out and the reader stays silent.
// Its slice names the failed action `failed` and the next step `step`, not `action` and `next`: the pool's edge reader (`recoveryEdgesOf`) folds every recovery read that has `action`, `errorCode`, and `next`, so these keys keep it from counting this read twice.
// Confounders: the work the failure interrupted, that the next call is one of many a prompt may take, and that `ok` says the next call returned, not that the problem is gone.
import { parseRecoveryTargetClass, RETRY } from './recovery-target.js';
import { RECOVERY_TARGET_METHOD } from './read.js';
import { atGrain, body, groupBy, rate, total, wilson, type DeriveFamily } from './read-support.js';
import type { Cell, Pool } from './cells.js';

interface Edge {
  cell: Cell;
  code: string;
  failed: string;
  target: string;
  next: string;
}

/** The cells of one (harness bucket, week, code, failed action, target class), each next step beside the others. */
const keyedGroupsOf = (pool: Pool): Map<string, Edge[]> => {
  const edges = atGrain(pool, 'week').flatMap((cell) => {
    const cls = pool.motifs.get(cell.motifId)?.cls;
    const parts = cls === undefined || cls === null ? null : parseRecoveryTargetClass(cls);
    return parts === null ? [] : [{ cell, ...parts }];
  });
  return groupBy(edges, ({ cell, code, failed, target }) => `${cell.frameBucket}/${cell.day}/${code}/${failed}/${target}`);
};

const groupsOf = (pool: Pool): Edge[][] => [...keyedGroupsOf(pool).values()];

/** The step to serve, and the recoveries of a retry. The most recoveries among the steps that are not a retry first, the step's name breaking a tie so the same cells give the same read. */
const verdictOf = (group: readonly Edge[]): { top: Edge | undefined; retried: number } => {
  const [top] = group.filter(({ next }) => next !== RETRY).sort((a, b) => b.cell.ok - a.cell.ok || (a.next < b.next ? -1 : a.next > b.next ? 1 : 0));
  return { top, retried: group.find(({ next }) => next === RETRY)?.cell.ok ?? 0 };
};

export const deriveRecoveryTarget: DeriveFamily = ({ pool }) =>
  groupsOf(pool).flatMap((group) => {
    // A retry that ties the best other step keeps the cell silent: the read is served only when a step other than a repeat strictly beats the repeat.
    const { top, retried } = verdictOf(group);
    if (top === undefined || top.cell.ok <= retried) return [];
    const of = total(group.map(({ cell }) => cell), (cell: Cell) => cell.failed);
    const { cell, code, failed, target, next } = top;
    return [
      body(
        'recovery',
        [cell],
        { slice: { failed, errorCode: code, target, step: next, week: cell.day }, value: { recovered: cell.ok, followed: cell.failed, of, share: rate(cell.ok, of) }, n: cell.ok, interval: wilson(cell.ok, of) },
        RECOVERY_TARGET_METHOD,
      ),
    ];
  });

/**
 * The cells of every group whose read is withheld, so a bundle leaves them out and holds nothing for the group: a repeat of the failed call recovered as often as the best other step (a group where nothing recovered is not one), or
 * a repeat that recovered is held but not served (`held` is the pool before the floor; its count is used for this verdict and never printed). A withheld repeat may have led or tied, so the group fails closed.
 */
export const retryToppedOf = (pool: Pool, held: Pool = pool): Cell[] => {
  const heldGroups = keyedGroupsOf(held);
  return [...keyedGroupsOf(pool).entries()].flatMap(([key, group]) => {
    const { top, retried } = verdictOf(group);
    const withheld = !group.some(({ next }) => next === RETRY) && (heldGroups.get(key) ?? []).some(({ next, cell }) => next === RETRY && cell.ok > 0);
    return withheld || (retried > 0 && (top === undefined || top.cell.ok <= retried)) ? group.map(({ cell }) => cell) : [];
  });
};
