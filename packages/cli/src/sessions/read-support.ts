// What the family modules share: their input, a read's common fields, and the arithmetic of a rate over cells.
import { cellIdOf, type Cell, type Grain, type Pool } from './cells.js';
import type { Motif } from './motif.js';
import { METHODS, type Family, type ReadDraft, type ReadInterval, type ReadSlice, type ReadValue } from './read.js';
import type { Store } from './store.js';

export interface FamilyInput {
  pool: Pool;
  /** Only recovery reads this: an error's signature is not in a cell. */
  store: Store;
}

/** A read as a family states it; the pool's snapshot is added to all of them in one place. */
export type ReadBody = Omit<ReadDraft, 'asOf'>;

export type DeriveFamily = (input: FamilyInput) => ReadBody[];

export const round = (value: number): number => Math.round(value * 10_000) / 10_000;

/** A rate to four places, so a value reads alike wherever it is computed; null with nothing to divide by. */
export const rate = (part: number, whole: number): number | null => (whole === 0 ? null : round(part / whole));

/** The normal quantile for a 95 percent interval, which every read's interval and the screen's scaling share. */
export const Z_95 = 1.96;

/** The Wilson interval: it stays inside 0 and 1, and it is honest about the small cells one operator's store is mostly made of. */
export const wilson = (part: number, whole: number): ReadInterval | null => {
  if (whole === 0) return null;
  const share = part / whole;
  const z2 = Z_95 * Z_95;
  const denominator = 1 + z2 / whole;
  const centre = share + z2 / (2 * whole);
  const margin = Z_95 * Math.sqrt((share * (1 - share)) / whole + z2 / (4 * whole * whole));
  return { low: round(Math.max(0, (centre - margin) / denominator)), high: round(Math.min(1, (centre + margin) / denominator)), level: 0.95 };
};

/** Windows with a known result: a step with no result is in neither count, so it is in no rate. */
export const settled = (cell: Cell): number => cell.ok + cell.failed;

export const total = (cells: readonly Cell[], count: (cell: Cell) => number): number => {
  let sum = 0;
  for (const cell of cells) sum += count(cell);
  return sum;
};

export const groupBy = <K, T>(items: Iterable<T>, keyOf: (item: T) => K): Map<K, T[]> => {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
};

/**
 * The pool's cells at one grain (rule 6). Weekly and day cells share a table and count the same steps, so a read that sums over both counts a step twice and a read that
 * names a day from a week answers from the wrong grain: every read takes the grain it answers from here, and no read iterates `pool.cells` itself.
 */
export const atGrain = (pool: Pool, grain: Grain): Cell[] => pool.cells.filter((cell) => cell.grain === grain);

/** The cells of one-step motifs at one grain: every action, and every identity capture has named. */
export const unitCells = (pool: Pool, grain: Grain): { cell: Cell; motif: Motif }[] => {
  const units: { cell: Cell; motif: Motif }[] = [];
  for (const cell of atGrain(pool, grain)) {
    const motif = pool.motifs.get(cell.motifId);
    if (motif === undefined || motif.steps.length !== 1) continue;
    if (motif.level === 'named' && motif.steps[0]?.identity === null) continue;
    units.push({ cell, motif });
  }
  return units;
};

/** Counts over every one-step `shape` cell, for shares: a named motif's share is of all steps, like its action's. */
export const shapeUnits = (pool: Pool, grain: Grain): Cell[] => unitCells(pool, grain).filter(({ motif }) => motif.level === 'shape').map(({ cell }) => cell);

export const body = (
  family: Family,
  cells: readonly Cell[],
  fields: { slice: ReadSlice; value: ReadValue; n: number; interval: ReadInterval | null },
  method: { readonly name: string; readonly version: string } = METHODS[family],
): ReadBody => ({
  family,
  method: method.name,
  methodVersion: method.version,
  inputs: cells.map(cellIdOf),
  // Cell counts cannot give distinct accounts across cells, so this is the floor they do prove, which never overstates what a served floor may rely on.
  clusters: cells.reduce((highest, cell) => Math.max(highest, cell.clusters), 0),
  basis: 'all',
  ...fields,
});

export const firstDayOf = (days: readonly string[]): string | null => days.reduce<string | null>((first, day) => (first === null || day < first ? day : first), null);
export const lastDayOf = (days: readonly string[]): string | null => days.reduce<string | null>((last, day) => (last === null || day > last ? day : last), null);
