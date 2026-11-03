// What `oars sessions read` serves: reads filtered by family and slice, largest sample first, one row each. A row states its clusters and no floor is applied, because
// these are the operator's own cells: a floor protects other people's data, and there is none here.

import { FAMILIES, type Family, type Read, type ReadSlice, type ReadValue } from './read.js';

export interface ReadFilter {
  family: Family | undefined;
  /** Every axis named must hold exactly this value. */
  slice: ReadSlice;
}

export const isFamily = (value: string): value is Family => FAMILIES.some((family) => family === value);

/** `axis=value`, repeated; undefined when one has no axis or no value, for the caller to refuse. A value may hold `=`, as a named motif does. */
export const parseSlice = (pairs: readonly string[]): ReadSlice | undefined => {
  const slice: ReadSlice = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0 || at === pair.length - 1) return undefined;
    slice[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return slice;
};

const compare = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);

/** In family order, then largest sample first; a read's ID settles a tie, so a rerun lists the same rows in the same order. */
export const selectReads = (reads: readonly Read[], filter: ReadFilter): Read[] =>
  reads
    .filter((read) => (filter.family === undefined || read.family === filter.family) && Object.entries(filter.slice).every(([axis, value]) => read.slice[axis] === value))
    .sort((a, b) => FAMILIES.indexOf(a.family) - FAMILIES.indexOf(b.family) || b.n - a.n || compare(a.readId, b.readId));

const pairsOf = (fields: ReadSlice | ReadValue): string =>
  Object.entries(fields)
    .map(([name, value]) => {
      if (typeof value !== 'object' || value === null) return `${name}=${String(value)}`;
      return `${name}=${Object.entries(value).sort(([a, one], [b, two]) => two - one || compare(a, b)).map(([key, number]) => `${key}:${String(number)}`).join(',')}`;
    })
    .join(' ');

const formatRead = (read: Read): string => {
  const interval = read.interval === null ? '' : ` ci=${String(read.interval.low)}-${String(read.interval.high)}`;
  return `  n=${String(read.n)} clusters: ${String(read.clusters)} order=${String(read.order)} ${pairsOf(read.slice)} | ${pairsOf(read.value)}${interval}`;
};

/** Rows under a heading per family, in the order `selectReads` put them. */
export const formatReads = (reads: readonly Read[]): string => {
  if (reads.length === 0) return 'No reads match.';
  const lines: string[] = [];
  let family: Family | undefined;
  for (const read of reads) {
    if (read.family !== family) {
      family = read.family;
      lines.push(`${family} (${String(reads.filter((one) => one.family === family).length)} reads)`);
    }
    lines.push(formatRead(read));
  }
  return lines.join('\n');
};
