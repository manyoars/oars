// Local deltas (spec Section 2, "Deltas"): the client compares its own before and after windows and builds each change once. Nothing here reads a store or sends a byte; `pool deposit` hands it the
// sessions that passed the session gates and carries what comes back in the batch of the session that filled the after window.

/** `delta_days` and `delta_min_sessions` (spec Section 7): a week on each side spans a work cycle, and five sessions keep one session from being the delta. */
export const DELTA_DAYS = 7;
export const DELTA_MIN_SESSIONS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A session as a window sees it: when it began (epoch milliseconds) and an id that orders two sessions of one instant. */
export interface Placed {
  id: string;
  at: number;
}

/** A before and an after window, each of `DELTA_DAYS`, and the session that brought the after window to its minimum. */
export interface Windows<T> {
  before: T[];
  after: T[];
  filler: T;
}

/**
 * The pairs of windows a set of sessions holds. Windows are consecutive spans of `days`, counted from the earliest session, so a session belongs to exactly one and a change is compared once. A pair is
 * two windows next to each other that each hold at least `min` sessions; a gap of an empty window, or of one with too few, compares nothing across it. The `filler` is the `min`th session of the after
 * window in time order, so it is the same session whenever the deposit runs.
 */
export const windowsOf = <T extends Placed>(sessions: readonly T[], days: number = DELTA_DAYS, min: number = DELTA_MIN_SESSIONS): Windows<T>[] => {
  const ordered = [...sessions].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const first = ordered[0]?.at ?? 0;
  const span = days * DAY_MS;
  const windows = new Map<number, T[]>();
  for (const session of ordered) {
    const index = Math.floor((session.at - first) / span);
    const held = windows.get(index);
    if (held === undefined) windows.set(index, [session]);
    else held.push(session);
  }
  const pairs: Windows<T>[] = [];
  for (const [index, after] of windows) {
    const before = windows.get(index - 1);
    const filler = after[min - 1];
    if (before !== undefined && before.length >= min && filler !== undefined) pairs.push({ before, after, filler });
  }
  return pairs;
};
