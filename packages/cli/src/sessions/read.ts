// The read (t756, recall spec Section 2.6): any derived value, citing its inputs. A read's ID is the hash of its content and a read never changes, so
// a recall can cite one and lineage can walk back from it. Its order is computed from its inputs and has no ceiling: a cell is 0 and a read is one more
// than the highest order it cites, so a read over reads needs nothing here that a read over cells does not.

import { createHash } from 'node:crypto';

/** A value, read by content: object keys are sorted, so two writers of one value hash alike. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
};

/** SHA-256 of canonical JSON, 16 hex characters, unsalted: one content reads alike on any account (D1's `hP`). */
export const contentHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex').slice(0, 16);

/** The eight families (t752), in the order that report ranks them, recovery first: the only one that changes a next call today. Then `tool-day`, which the reads above order 1 stand on. */
export const FIRST_ORDER_FAMILIES = ['recovery', 'fit', 'cost', 'change', 'live', 'adoption', 'method', 'next-step', 'tool-day'] as const;
export type FirstOrderFamily = (typeof FIRST_ORDER_FAMILIES)[number];

/** Families that read other reads, lowest order first. `lead-lag` is the labeled experiment (spec Section 6). */
export const FAMILIES = [...FIRST_ORDER_FAMILIES, 'version-boundary', 'substitution', 'interaction', 'day-move', 'lead-lag'] as const;
export type Family = (typeof FAMILIES)[number];

/**
 * Each family's method and its version. A rule change bumps its version here, and the pool's version hashes this table, so a stored file of the old rule is not served.
 * It lives here and not beside each family because the pool hash needs it, and a family module imports the cells the hash is in.
 */
export const METHODS: { readonly [family in Family]: { readonly name: string; readonly version: string } } = {
  recovery: { name: 'signature-record', version: '1' },
  fit: { name: 'failure-rate', version: '1' },
  cost: { name: 'per-prompt-by-class', version: '1' },
  change: { name: 'share-in-version-bucket', version: '1' },
  live: { name: 'day-against-trailing-week', version: '2' },
  adoption: { name: 'share-and-span', version: '1' },
  method: { name: 'shape-share-by-model', version: '1' },
  'next-step': { name: 'next-action-counts', version: '1' },
  'tool-day': { name: 'rates-on-day', version: '1' },
  'version-boundary': { name: 'move-between-buckets', version: '1' },
  substitution: { name: 'rise-against-fall', version: '1' },
  interaction: { name: 'failure-gap-across-tier-assigned', version: '2' },
  'day-move': { name: 'move-to-next-day', version: '2' },
  'lead-lag': { name: 'failure-move-leads-share-move', version: '1' },
};

/** The fit family's other method (`read-call-shape.ts`). The pool's version hashes it beside the table, for the same reason. */
export const CALL_SHAPE_METHOD = { name: 'call-shape', version: '1' } as const;

/** `all`, or `unexposed`: only steps outside any recall's consequence window, so a read cannot mistake the pool's influence for the world. */
export type ReadBasis = 'all' | 'unexposed';

/** The coordinates a read covers, as public names. */
export interface ReadSlice {
  [axis: string]: string;
}

/** What a read says. Closed vocabulary and numbers only: a read never holds a path, a prompt, or an error's text. */
export interface ReadValue {
  [metric: string]: number | string | null | { [name: string]: number };
}

/** A 95 percent interval on a read's headline number: a rate at order 1, propagated from the inputs above it (`read-order.ts`), so it can run below zero. Null when the value is not a rate. */
export interface ReadInterval {
  low: number;
  high: number;
  level: number;
}

/** The pool a read was computed from: a later version is a new read, even when the value comes out the same. */
export interface ReadAsOf {
  pool: string;
  /** The newest day in that pool; null when no cell has a known day. */
  day: string | null;
}

export interface Read {
  /** `read:<contentHash>` of every other field. */
  readId: string;
  family: Family;
  method: string;
  methodVersion: string;
  /** The IDs this read cites, sorted, each `cell:<hash>` or `read:<hash>`. Never empty. A rate's denominator is a total of the pool `asOf` pins, so it is not listed. */
  inputs: string[];
  /** 1 + the highest order among `inputs`. */
  order: number;
  slice: ReadSlice;
  value: ReadValue;
  /** The observations behind the value. At order 1 its own count; above order 1 the trials of its weakest input, or the observations a relation names, such as pairs. */
  n: number;
  /** The accounts behind the value, as its inputs state it. One operator's store says 1. */
  clusters: number;
  interval: ReadInterval | null;
  asOf: ReadAsOf;
  basis: ReadBasis;
}

/** A read before its inputs are checked and its ID and order are computed. */
export type ReadDraft = Omit<Read, 'readId' | 'order'>;

const ORDER_OF_CELL = 0;
const CELL_PREFIX = 'cell:';
const READ_PREFIX = 'read:';

export const cellRef = (hash: string): string => `${CELL_PREFIX}${hash}`;

/** Looks up an input's order; undefined when this input is not a cell ID and no read known here has it. */
export type OrderResolver = (input: string) => number | undefined;

/** Orders from the IDs themselves for cells, and from these reads for a read. */
export const orderResolver = (reads: readonly Read[]): OrderResolver => {
  const orders = new Map(reads.map((read) => [read.readId, read.order]));
  return (input) => (input.startsWith(CELL_PREFIX) ? ORDER_OF_CELL : orders.get(input));
};

export const readIdOf = (read: Omit<Read, 'readId'>): string => {
  const { family, method, methodVersion, inputs, order, slice, value, n, clusters, interval, asOf, basis } = read;
  return `${READ_PREFIX}${contentHash({ family, method, methodVersion, inputs, order, slice, value, n, clusters, interval, asOf, basis })}`;
};

const deepFreeze = (value: unknown): void => {
  if (typeof value !== 'object' || value === null) return;
  Object.values(value).forEach((entry: unknown) => {
    deepFreeze(entry);
  });
  Object.freeze(value);
};

/** A read's ID pins every field down to the last count, so none of them may change below the top either. */
export const frozenRead = (read: Read): Read => {
  deepFreeze(read);
  return read;
};

/** The one way a read comes to exist. It refuses a read that cites nothing or cites what it cannot place, since either would have no lineage. */
export const makeRead = (draft: ReadDraft, orderOf: OrderResolver): Read => {
  const inputs = [...new Set(draft.inputs)].sort();
  if (inputs.length === 0) throw new Error(`A ${draft.family} read cites no input.`);
  let highest = -1;
  for (const input of inputs) {
    const order = orderOf(input);
    if (order === undefined) throw new Error(`A ${draft.family} read cites ${input}, whose order is not known.`);
    highest = Math.max(highest, order);
  }
  const body = { ...draft, inputs, order: 1 + highest };
  return frozenRead({ readId: readIdOf(body), ...body });
};
