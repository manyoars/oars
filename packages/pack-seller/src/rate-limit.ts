/** Offer requests one caller may make per window; the route is unauthenticated, so this is its only brake. */
export const OFFER_RATE_LIMIT = 5;
/** The fixed window the limit counts in, in milliseconds. */
export const OFFER_RATE_WINDOW_MS = 60_000;
/** The status a request over the limit gets. */
export const OFFER_RATE_REFUSAL_STATUS = 429;

export interface RateLimiter {
  /** Counts one request from `caller`; false when it is over the limit for the current window. */
  allow: (caller: string) => boolean;
}

interface Window {
  startedAt: number;
  count: number;
}

/** A fixed-window counter per caller. `now` is injected (milliseconds) so tests drive time instead of sleeping. */
export const createRateLimiter = (limit: number, windowMs: number, now: () => number): RateLimiter => {
  const windows = new Map<string, Window>();
  return {
    allow: (caller) => {
      const at = now();
      // Drop every expired window first so the map holds only callers seen in the last window.
      for (const [key, seen] of windows) {
        if (at - seen.startedAt >= windowMs) windows.delete(key);
      }
      const current = windows.get(caller);
      if (current === undefined) {
        windows.set(caller, { startedAt: at, count: 1 });
        return true;
      }
      current.count += 1;
      return current.count <= limit;
    },
  };
};
