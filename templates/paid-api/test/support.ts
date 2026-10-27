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

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A response's JSON object; anything else fails the test at the call. */
export const bodyOf = async (response: Response): Promise<{ [key: string]: unknown }> => {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error('expected a JSON object');
  return body;
};
