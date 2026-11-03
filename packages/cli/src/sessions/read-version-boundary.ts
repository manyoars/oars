// Version boundary (spec Section 6, order 2): what moved between two neighboring harness version buckets, from order 1 change reads. Only moves past the screen exist, each
// with how many comparisons it was screened among. A step counts as independent in the inputs and steps cluster in sessions, so the intervals run narrow, which is one reason
// the screen runs wide. Confounders it does not remove: date (a later bucket is mostly later days, and `fromLastDay` and `toFirstDay` show any overlap), effort, role by brief,
// rule commits, and class drift. A model version boundary is not readable here: a cell holds a model's name and no version of it (`read-readable.ts`).
import { UNKNOWN } from './cells.js';
import { candidateOf, differenceOf, estimateOf, screen, trialsOf, TRIALS_FLOOR, type Candidate, type DeriveRelation, type Estimate } from './read-order.js';
import type { Read } from './read.js';
import { firstDayOf, groupBy, lastDayOf, wilson } from './read-support.js';

/** One version bucket of one harness, from its change reads. */
export interface Bucket {
  name: string;
  /** Settled steps in the bucket. */
  of: number;
  firstDay: string | null;
  lastDay: string | null;
  reads: ReadonlyMap<string, Read>;
  /** A read that states `of`, cited when the tool being compared has no read here. */
  witness: Read;
}

export interface Boundary {
  harness: string;
  from: Bucket;
  to: Bucket;
}

const dayOf = (read: Read, field: 'firstDay' | 'lastDay'): string[] => {
  const day = read.value[field];
  return typeof day === 'string' ? [day] : [];
};

export const toolKey = (read: Read): string => `${read.slice.level ?? ''}\n${read.slice.motif ?? ''}`;

const bucketOf = (name: string, reads: readonly [Read, ...Read[]]): Bucket => ({
  name,
  of: trialsOf(reads[0]),
  firstDay: firstDayOf(reads.flatMap((read) => dayOf(read, 'firstDay'))),
  lastDay: lastDayOf(reads.flatMap((read) => dayOf(read, 'lastDay'))),
  reads: new Map(reads.map((read) => [toolKey(read), read])),
  witness: reads[0],
});

const isNonEmpty = (reads: readonly Read[]): reads is readonly [Read, ...Read[]] => reads.length > 0;

/** Each harness's neighboring version buckets, in version order: `2.1.9x` comes before `2.1.10x`. An unknown version has no place in that order. */
export const boundariesOf = (reads: readonly Read[]): Boundary[] => {
  const change = reads.filter((read) => read.family === 'change' && read.slice.harnessBucket !== UNKNOWN);
  return [...groupBy(change, (read) => read.slice.harness ?? UNKNOWN)].flatMap(([harness, group]) => {
    const buckets = [...groupBy(group, (read) => read.slice.harnessBucket ?? UNKNOWN)]
      .flatMap(([name, inBucket]) => (isNonEmpty(inBucket) ? [bucketOf(name, inBucket)] : []))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    return buckets.slice(1).flatMap((to, index) => {
      const from = buckets[index];
      return from === undefined ? [] : [{ harness, from, to }];
    });
  });
};

/** A tool's share in a bucket, and what to cite for it. With no read of the tool there, its share is zero of the bucket's steps, and that is a measurement, not a gap. */
export const shareIn = (bucket: Bucket, key: string): { read: Read; share: Estimate } | undefined => {
  const read = bucket.reads.get(key);
  if (read !== undefined) {
    const share = estimateOf(read, 'share');
    return share === undefined ? undefined : { read, share };
  }
  const interval = wilson(0, bucket.of);
  return interval === null ? undefined : { read: bucket.witness, share: { value: 0, interval } };
};

/** Every tool on either side of a boundary. */
export const toolsAt = ({ from, to }: Boundary): string[] => [...new Set([...from.reads.keys(), ...to.reads.keys()])];

const slicesOf = (boundary: Boundary, key: string, metric: string) => {
  const [level = UNKNOWN, motif = UNKNOWN] = key.split('\n');
  return { motif, level, harness: boundary.harness, from: boundary.from.name, to: boundary.to.name, metric };
};

const movement = (boundary: Boundary, move: Estimate, before: number, after: number) => ({
  before,
  after,
  move: move.value,
  fromLastDay: boundary.from.lastDay,
  toFirstDay: boundary.to.firstDay,
});

const shareCandidate = (boundary: Boundary, key: string): Candidate | undefined => {
  const earlier = shareIn(boundary.from, key);
  const later = shareIn(boundary.to, key);
  if (earlier === undefined || later === undefined) return undefined;
  const move = differenceOf(later.share, earlier.share);
  return candidateOf('version-boundary', [earlier.read, later.read], [move], {
    slice: slicesOf(boundary, key, 'share'),
    value: movement(boundary, move, earlier.share.value, later.share.value),
    interval: move.interval,
  });
};

/** The change read's interval is on its share, so a failure rate's comes from the same read's count and rate. */
const failureOf = (read: Read | undefined): Estimate | undefined => {
  const value = read?.value.failureRate;
  if (read === undefined || typeof value !== 'number' || read.n < TRIALS_FLOOR) return undefined;
  const interval = wilson(value * read.n, read.n);
  return interval === null ? undefined : { value, interval };
};

const failureCandidate = (boundary: Boundary, key: string): Candidate | undefined => {
  const earlierRead = boundary.from.reads.get(key);
  const laterRead = boundary.to.reads.get(key);
  const earlier = failureOf(earlierRead);
  const later = failureOf(laterRead);
  if (earlierRead === undefined || laterRead === undefined || earlier === undefined || later === undefined) return undefined;
  const move = differenceOf(later, earlier);
  return candidateOf('version-boundary', [earlierRead, laterRead], [move], {
    slice: slicesOf(boundary, key, 'failureRate'),
    value: movement(boundary, move, earlier.value, later.value),
    interval: move.interval,
    n: Math.min(earlierRead.n, laterRead.n),
  });
};

/** The comparisons a store's change reads allow, above the floor, whether or not any of them moved. */
export const versionBoundaryCandidates = (reads: readonly Read[]): Candidate[] =>
  boundariesOf(reads).flatMap((boundary) =>
    toolsAt(boundary).flatMap((key) => [shareCandidate(boundary, key), failureCandidate(boundary, key)].filter((candidate) => candidate !== undefined)),
  );

export const deriveVersionBoundary: DeriveRelation = (reads) => screen(versionBoundaryCandidates(reads));
