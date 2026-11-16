// The same-target lookup a client serves (failure hook, MCP tool). Kept apart from `read-recovery-target.ts` so the hook entry reaches no read family through its static imports.
import type { Read } from './read.js';

/** A same-target read as a client serves it: the step it carries and the counts it states. */
export interface SameTargetRead {
  readId: string;
  step: string;
  /** Times the step came back ok. */
  recovered: number;
  /** Times the step followed this failure on this target class. */
  followed: number;
  /** Every failure of this code, action, and target class that week. */
  of: number;
  clusters: number;
  day: string | null;
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * The same-target read a bundle holds for a failure's error code, failed action, and target class, or undefined. It reads only `recovery` reads whose slice has both `step` and `target`, and recomputes no
 * floor and no verdict: what the bundle holds is what is served. With several weeks it takes the newest, then the most recoveries, then the lower read ID, so the same reads give the same answer.
 */
export const sameTargetOf = (reads: readonly Read[], code: string, failed: string, target: string): SameTargetRead | undefined => {
  const found = reads.flatMap((read) => {
    const { slice, value } = read;
    const { recovered, followed, of } = value;
    if (read.family !== 'recovery' || slice.step === undefined || slice.target !== target || slice.errorCode !== code || slice.failed !== failed) return [];
    if (!isCount(recovered) || !isCount(followed) || !isCount(of)) return [];
    return [{ readId: read.readId, step: slice.step, recovered, followed, of, clusters: read.clusters, day: read.asOf.day }];
  });
  return found.sort((a, b) => (b.day ?? '').localeCompare(a.day ?? '') || b.recovered - a.recovered || a.readId.localeCompare(b.readId))[0];
};
