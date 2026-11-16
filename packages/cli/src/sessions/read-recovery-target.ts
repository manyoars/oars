// Recovery on the same target (from cells): for a failed call, the next step that most often came back ok on the same target class. One read per (harness bucket, week, code, failed action, target class), from the week cells
// of `recovery-target.ts`. It states counts, never a fix, and it speaks only when its answer is not a retry: when the most common recovering step repeated the failed call, or a repeat did as often as any other step, the cell is left out and the reader stays silent.
// Its slice names the failed action `failed` and the next step `step`, not `action` and `next`: the pool's edge reader (`recoveryEdgesOf`) folds every recovery read that has `action`, `errorCode`, and `next`, so these keys keep it from counting this read twice.
// Confounders: the work the failure interrupted, that the next call is one of many a prompt may take, and that `ok` says the next call returned, not that the problem is gone.
import { parseRecoveryTargetClass, RETRY } from './recovery-target.js';
import { RECOVERY_TARGET_METHOD } from './read.js';
import { atGrain, body, groupBy, rate, total, wilson, type DeriveFamily } from './read-support.js';
import type { Cell } from './cells.js';

export const deriveRecoveryTarget: DeriveFamily = ({ pool }) => {
  const edges = atGrain(pool, 'week').flatMap((cell) => {
    const cls = pool.motifs.get(cell.motifId)?.cls;
    const parts = cls === undefined || cls === null ? null : parseRecoveryTargetClass(cls);
    return parts === null ? [] : [{ cell, ...parts }];
  });
  const groups = groupBy(edges, ({ cell, code, failed, target }) => `${cell.frameBucket}/${cell.day}/${code}/${failed}/${target}`);
  return [...groups.values()].flatMap((group) => {
    // The most recoveries among the steps that are not a retry first, the step's name breaking a tie so the same cells give the same read. A retry that ties it keeps the cell silent: the read is served only when a step
    // other than a repeat strictly beats the repeat.
    const [top] = group.filter(({ next }) => next !== RETRY).sort((a, b) => b.cell.ok - a.cell.ok || (a.next < b.next ? -1 : a.next > b.next ? 1 : 0));
    const retried = group.find(({ next }) => next === RETRY)?.cell.ok ?? 0;
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
};
