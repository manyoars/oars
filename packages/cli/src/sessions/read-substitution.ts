// Substitution (spec Section 6, order 2): at one version boundary, one tool's share rose as another's fell. Shares sum to one, so any rise pushes every other share down; a pair
// counts only when the falling tool also fell among the steps that are not the rising tool, which arithmetic alone cannot do. Confounders it does not remove: date, class
// drift (the work changed, not the choice of tool), and rule commits. It says two shares moved oppositely, not that one call replaced another.
import { UNKNOWN } from './cells.js';
import { candidateOf, differenceOf, screen, TRIALS_FLOOR, type Candidate, type DeriveRelation, type Estimate } from './read-order.js';
import type { Read } from './read.js';
import { rate, wilson } from './read-support.js';
import { boundariesOf, shareIn, toolsAt, type Boundary, type Bucket } from './read-version-boundary.js';

const countIn = (bucket: Bucket, key: string): number => bucket.reads.get(key)?.n ?? 0;

/** A tool's share of the steps that are not the other tool's, floored like any rate. */
const shareOfRest = (bucket: Bucket, key: string, without: string): Estimate | undefined => {
  const trials = bucket.of - countIn(bucket, without);
  const count = countIn(bucket, key);
  const value = rate(count, trials);
  const interval = wilson(count, trials);
  return trials < TRIALS_FLOOR || value === null || interval === null ? undefined : { value, interval };
};

const levelOf = (key: string): string => key.split('\n')[0] ?? UNKNOWN;
const motifOf = (key: string): string => key.split('\n')[1] ?? UNKNOWN;

const pairCandidate = (boundary: Boundary, rising: string, falling: string): Candidate | undefined => {
  const { from, to } = boundary;
  const risingBefore = shareIn(from, rising);
  const risingAfter = shareIn(to, rising);
  const fallingBefore = shareIn(from, falling);
  const fallingAfter = shareIn(to, falling);
  const restBefore = shareOfRest(from, falling, rising);
  const restAfter = shareOfRest(to, falling, rising);
  if (risingBefore === undefined || risingAfter === undefined || fallingBefore === undefined || fallingAfter === undefined || restBefore === undefined || restAfter === undefined) return undefined;
  const rise = differenceOf(risingAfter.share, risingBefore.share);
  const fall = differenceOf(fallingBefore.share, fallingAfter.share);
  const restFall = differenceOf(restBefore, restAfter);
  // How much of the move the two share: the smaller of them, whose interval is bounded by the smaller of each side.
  const offset = Math.min(rise.value, fall.value);
  const interval = { low: Math.min(rise.interval.low, fall.interval.low), high: Math.min(rise.interval.high, fall.interval.high), level: rise.interval.level };
  return candidateOf('substitution', 'rise-against-fall', '1', [risingBefore.read, risingAfter.read, fallingBefore.read, fallingAfter.read], [rise, fall, restFall], {
    slice: { rising: motifOf(rising), falling: motifOf(falling), level: levelOf(rising), harness: boundary.harness, from: from.name, to: to.name },
    value: { rise: rise.value, fall: fall.value, restFall: restFall.value, offset },
    interval,
  });
};

/** Both moves point the way the read claims: `moved` asks only that each is large, not its sign. */
const opposed = ({ gates }: Candidate): boolean => gates.every((gate) => gate.value > 0);

/** The pairs a store's change reads allow, above the floor, whether or not any of them moved. */
export const substitutionCandidates = (reads: readonly Read[]): Candidate[] =>
  boundariesOf(reads).flatMap((boundary) => {
    const keys = toolsAt(boundary);
    return keys.flatMap((rising) =>
      keys.filter((falling) => falling !== rising && levelOf(falling) === levelOf(rising)).flatMap((falling) => {
        const candidate = pairCandidate(boundary, rising, falling);
        return candidate === undefined ? [] : [candidate];
      }),
    );
  });

export const deriveSubstitution: DeriveRelation = (reads) => screen(substitutionCandidates(reads), opposed);
