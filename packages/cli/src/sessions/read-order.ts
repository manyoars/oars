// Reads over reads (spec Section 6): noise compounds, so an interval comes from the inputs and a read below its floor does not exist. Every family above order 1 builds its
// read here, which is how the floor stays a property of the read and not a filter on a listing. Order 1 has no floor, because a cell is the operator's own; a relation
// between rates has one, because two thin rates differ by chance and read as news.
import type { Family, Read, ReadInterval, ReadSlice, ReadValue } from './read.js';
import { round, type ReadBody } from './read-support.js';

/** A family over reads: it reads every read of the stages before it. */
export type DeriveRelation = (reads: readonly Read[]) => ReadBody[];

/** The fewest trials a rate may rest on and still be compared: t752's k. */
export const TRIALS_FLOOR = 30;

/** The smallest move worth stating. Large samples clear zero on moves no one would act on, so a move has to be large as well as unlikely. */
export const MIN_MOVE = 0.01;

const Z_95 = 1.96;
const FAMILYWISE_ERROR = 0.05;

/** A number and its interval, as an input states them. */
export interface Estimate {
  value: number;
  interval: ReadInterval;
}

/**
 * `later - earlier`, by MOVER (Newcombe 1998, Zou and Donner 2008): each side of the result takes the sides of the inputs that could push it there, so a skewed Wilson
 * interval stays skewed. It holds at any order, because it asks only for a value and an interval. It treats the two inputs as independent, which two periods nearly are.
 */
export const differenceOf = (later: Estimate, earlier: Estimate): Estimate => {
  const value = later.value - earlier.value;
  const down = Math.hypot(later.value - later.interval.low, earlier.interval.high - earlier.value);
  const up = Math.hypot(later.interval.high - later.value, earlier.value - earlier.interval.low);
  return { value: round(value), interval: { low: round(value - down), high: round(value + up), level: later.interval.level } };
};

/** One named number of a read with the read's interval, or nothing to propagate. */
export const estimateOf = (read: Read, metric: string): Estimate | undefined => {
  const value = read.value[metric];
  return typeof value === 'number' && read.interval !== null ? { value, interval: read.interval } : undefined;
};

/** What a read's interval rests on: a share's denominator, or else its own count. A rare tool's share of many steps is well measured, so its count would be the wrong floor. */
export const trialsOf = (read: Read): number => {
  const { of } = read.value;
  return typeof of === 'number' ? of : read.n;
};

/**
 * Whether an estimate's interval clears zero once `tested` comparisons were made, the Bonferroni way: the half-width toward zero scales from 95 percent to the family's z.
 * `sqrt(2 ln(2m / alpha))` is the Chernoff bound on that z. It runs a little wide and needs no quantile table, and a wide screen suits inputs that count a step as independent.
 */
export const clearsZero = (estimate: Estimate, tested: number): boolean => {
  const { value, interval } = estimate;
  const toZero = value > 0 ? value - interval.low : interval.high - value;
  return value !== 0 && Math.abs(value) > toZero * (Math.sqrt(2 * Math.log((2 * tested) / FAMILYWISE_ERROR)) / Z_95);
};

/** A move a reader should hear about: past the screen for `tested` comparisons, and large enough to matter. */
export const moved = (estimate: Estimate, tested: number): boolean => Math.abs(estimate.value) >= MIN_MOVE && clearsZero(estimate, tested);

export interface Relation {
  slice: ReadSlice;
  value: ReadValue;
  interval: ReadInterval;
  /** The observations behind the value, when they are not the inputs' trials: a slope over pairs counts pairs. */
  n?: number;
  /** Reads this one cites but does not measure on: a witness for a total. They are not held to the floor. */
  cites?: readonly Read[];
}

/**
 * A read over reads, or nothing when any measured input sits below the floor or has no interval. `n` and `clusters` state the weakest side: a relation knows no more than its
 * thinnest input, and summing trials up a chain would count one step many times.
 */
export const relate = (family: Family, method: string, methodVersion: string, inputs: readonly Read[], relation: Relation): ReadBody | undefined => {
  if (inputs.some((read) => read.interval === null || trialsOf(read) < TRIALS_FLOOR)) return undefined;
  const { cites = [], n = Math.min(...inputs.map(trialsOf)), ...fields } = relation;
  const all = [...inputs, ...cites];
  return { family, method, methodVersion, inputs: all.map((read) => read.readId), clusters: Math.min(...all.map((read) => read.clusters)), basis: 'all', n, ...fields };
};

/** A comparison made, before the screen: the read it would be, and every estimate that has to move for it to exist. */
export interface Candidate {
  gates: readonly Estimate[];
  body: ReadBody;
}

/** A comparison above the floor, which therefore counts toward what the screen allows for. */
export const candidateOf = (family: Family, method: string, methodVersion: string, inputs: readonly Read[], gates: readonly Estimate[], relation: Relation): Candidate | undefined => {
  const body = relate(family, method, methodVersion, inputs, relation);
  return body === undefined ? undefined : { gates, body };
};

/** The reads that survive the screen over everything compared, each stating how many comparisons that was: `tested * 0.05` is what chance alone would offer an unscreened reader. */
export const screen = (candidates: readonly Candidate[], claims: (candidate: Candidate) => boolean = () => true): ReadBody[] => {
  const tested = candidates.length;
  return candidates.filter((candidate) => claims(candidate) && candidate.gates.every((gate) => moved(gate, tested))).map(({ body }) => ({ ...body, value: { ...body.value, tested } }));
};
