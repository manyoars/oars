// Shared by the unit tests: a clock the tests advance and a way to let queued promise callbacks run.
export const createClock = (start = Date.parse('2026-10-23T12:00:00Z')) => {
  let current = start;
  return {
    now: (): number => current,
    advance: (milliseconds: number): void => {
      current += milliseconds;
    },
  };
};

export type Clock = ReturnType<typeof createClock>;

export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
