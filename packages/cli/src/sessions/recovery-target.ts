// The same-target recovery cell: for a failed call, the call that came right after it in the same prompt and the same run, keyed by the failed call's target class (the kind of thing it acted on, `call-shape.ts`). Pure and
// Worker-safe, so the client's local store and the pool's ingest build the cell from the same code. The cell counts what followed and whether that call succeeded; it names no path, text, or fix.
import type { TargetClass } from './call-shape.js';
import type { Followed } from './recovery-calls.js';

/** `recoverytarget:<code>/<failed action>/<target class>><next action>`, or `...><retry>` when the next call repeated the failed one. A week cell with no prompt class in it, like the other side cells. */
export const RECOVERY_TARGET_CLASS = 'recoverytarget:';
/** The next step of a cell whose next call repeated the failed call. The read leaves such a cell out when it is the most common one. */
export const RETRY = 'retry';

export const recoveryTargetClass = (code: string, failed: string, target: string, next: string): string => `${RECOVERY_TARGET_CLASS}${code}/${failed}/${target}>${next}`;

/** The four parts of a same-target class name, or null for a name that is not one. An action name and a target class hold no `>` or `/`, and a code holds no `/`. */
export const parseRecoveryTargetClass = (cls: string): { code: string; failed: string; target: string; next: string } | null => {
  const found = /^recoverytarget:([^/]+)\/([^>/]+)\/([^>/]+)>([^>/]+)$/.exec(cls);
  return found === null ? null : { code: found[1] ?? '', failed: found[2] ?? '', target: found[3] ?? '', next: found[4] ?? '' };
};

/** What the rule reads of a call: its action and the class of its target. */
export interface TargetedCall {
  action: string;
  targetClass: TargetClass | undefined;
}

/** A retry repeats the failed call: the same action on the same target class. A call with no target (`none`) or no recorded class is not on a target, so it is never a retry. */
export const isRetry = (failed: TargetedCall, next: TargetedCall): boolean =>
  failed.targetClass !== undefined && failed.targetClass !== 'none' && failed.action === next.action && failed.targetClass === next.targetClass;

/** The index of the call right after the one at `at` in the same prompt and the same run, or null when none follows. It is the first of `recoveryCallsOf`'s scan. */
export const nextIndexOf = (calls: readonly Followed[], at: number): number | null => {
  const failed = calls[at];
  if (failed === undefined) return null;
  for (let index = at + 1; index < calls.length; index += 1) {
    const call = calls[index];
    if (call === undefined || call.side !== failed.side) continue;
    return call.prompt === failed.prompt ? index : null;
  }
  return null;
};

/** The next step a cell names: `retry` for a repeat of the failed call, else the next call's action. */
export const nextStepOf = (failed: TargetedCall, next: TargetedCall): string => (isRetry(failed, next) ? RETRY : next.action);
