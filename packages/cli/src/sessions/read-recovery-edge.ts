// Recovery from cells (rank 1, t868): what others did next after a failed call, by (failed action, `errorCode`, next action). One read for each edge, citing its own week cell only, so a count under the floor in
// another edge is not lifted by this one. It states counts, never a fix: there is no fix field, `none` means nothing followed in that prompt, and an edit that followed is not that the failure was resolved.
// Confounders: the work the failure interrupted, the user's refusals and policy denials (their own codes), and that a call's next action is one of many a prompt may take.
import { parseRecoveryClass, type Cell } from './cells.js';
import { RECOVERY_EDGE_METHOD } from './read.js';
import { atGrain, body, groupBy, rate, total, wilson, type DeriveFamily } from './read-support.js';

export const deriveRecoveryEdges: DeriveFamily = ({ pool }) => {
  const edges = atGrain(pool, 'week').flatMap((cell) => {
    const cls = pool.motifs.get(cell.motifId)?.cls;
    const parts = cls === undefined || cls === null ? null : parseRecoveryClass(cls);
    return parts === null ? [] : [{ cell, ...parts }];
  });
  // The denominator is the failures of the same action and code in the same frame bucket and week.
  const keyOf = ({ cell, code, failed }: { cell: Cell; code: string; failed: string }): string => `${cell.frameBucket}/${cell.day}/${code}/${failed}`;
  const failures = new Map([...groupBy(edges, keyOf)].map(([key, group]) => [key, total(group.map(({ cell }) => cell), (cell) => cell.failed)]));
  return edges.flatMap((edge) => {
    const { cell, code, failed, next } = edge;
    const followed = cell.failed;
    const of = failures.get(keyOf(edge)) ?? 0;
    return followed === 0
      ? []
      : [
          body(
            'recovery',
            [cell],
            { slice: { action: failed, errorCode: code, next, week: cell.day }, value: { followed, of, share: rate(followed, of) }, n: followed, interval: wilson(followed, of) },
            RECOVERY_EDGE_METHOD,
          ),
        ];
  });
};
