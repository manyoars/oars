// What followed a failed call (t868, Item 3), in closed vocabulary: the actions of up to the next 5 calls of the same prompt, and whether an edit was among them. Pure and Worker-safe (types only),
// so the client's skeleton, a local read, and the pool's ingest compute it from the same list of calls. These are what followed, never a fix, and `editFollowed` is not success.
import type { CanonicalAction } from './actions.js';
import type { ToolObservation } from './schema.js';

/** What the scan reads of a call, so a stored call and a skeleton's call both fit: its run, prompt, status, and the action of its first step. */
export type Followed = Pick<ToolObservation, 'side' | 'prompt' | 'status'> & { steps?: readonly { action: CanonicalAction }[] };

/** How many following calls a failed call lists. */
export const RECOVERY_CALLS = 5;

/** What followed one failed call: the actions of the next calls, and whether any of them wrote a file. */
export interface RecoveryCalls {
  next: CanonicalAction[];
  editFollowed: boolean;
}

/** The actions that write a file: the stored error row's `editFollowed` counts the same tools (`Edit`, `Write`, `MultiEdit`). */
const WRITES: ReadonlySet<CanonicalAction> = new Set<CanonicalAction>(['file.edit', 'file.write']);

/** A call's action is its first step's; a call with no step is `other`. */
const actionOf = ({ steps }: Followed): CanonicalAction => steps?.[0]?.action ?? 'other';

/**
 * What followed the call at `at` of a transcript's calls in the order they ran: null for a call that did not fail. The calls that followed are the later ones of the same prompt and the same run (a
 * subagent's call is not what the main run did next), up to 5. The scan ends at the first later call of that run that belongs to another prompt.
 */
export const recoveryCallsOf = (calls: readonly Followed[], at: number): RecoveryCalls | null => {
  const failed = calls[at];
  if (failed === undefined || failed.status !== 'error') return null;
  const next: CanonicalAction[] = [];
  for (let index = at + 1; index < calls.length && next.length < RECOVERY_CALLS; index += 1) {
    const call = calls[index];
    if (call === undefined || call.side !== failed.side) continue;
    if (call.prompt !== failed.prompt) break;
    next.push(actionOf(call));
  }
  return { next, editFollowed: next.some((action) => WRITES.has(action)) };
};
