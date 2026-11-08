// The serve floors. A floor is configuration the deploy sets on the Worker, never a constant in the code and never a client release: `PUBLIC_FLOOR` is how many clusters a cell needs before a bundle serves it or a read counts it
// (a `thresholded` cell, any part of which is outside the closed public vocabulary), `CLEAR_FLOOR` is the same for a `clear` cell (closed public vocabulary and client hashes only, `cell-class.ts`),
// `DISCLOSURE_FLOOR` is how many clusters must hold a signature's hash before its text may be requested, and `PUBLIC_FLOOR_FAMILIES` sets the public floor for single read families. Cells are stored with their held
// counts and the floor is applied when a bundle is served (`bundleOf`), so a deploy that moves a floor needs no redeposit and no re-derive by hand.
import { FIRST_ORDER_FAMILIES, type FirstOrderFamily } from '../../cli/src/sessions/read.js';
import type { BundleFloors } from '../../cli/src/sessions/pool-wire.js';
import type { Cell } from '../../cli/src/sessions/cells.js';
import type { Motif } from '../../cli/src/sessions/motif.js';
import { cellClassOf, type CellClass } from './cell-class.js';
import { bound, type Env } from './http.js';

/** What a deploy that sets nothing serves at. `wrangler.jsonc` states the same three numbers, and a test holds the two together. */
export const DEFAULT_PUBLIC_FLOOR = 5;
export const DEFAULT_CLEAR_FLOOR = 1;
export const DEFAULT_DISCLOSURE_FLOOR = 2;

export interface Floors {
  public: number;
  disclosure: number;
  /**
   * The floor a `clear` cell (`cell-class.ts`) is served at when a read is at the public floor: `CLEAR_FLOOR`, 1 by default, never above `public`. A cell below the floor shows how few accounts did a thing, and a clear cell names only
   * public vocabulary, so the most it shows is that one operator used a public tool. The gap below `public` carries to every read family's floor (`cellFloor`), and the bundle states both floors. A clear cell at floor 1 counts every
   * account, standing or not (`bundleOf`), since a floor of 1 has no k to protect; at a floor above 1 (a family's, `cellFloor`) it counts the accounts that have stood, as a thresholded cell does.
   */
  clear: number;
  /** The read families that have a floor of their own. A family not named here is served at `public`. */
  families: Partial<Record<FirstOrderFamily, number>>;
}

export const DEFAULT_FLOORS: Floors = { public: DEFAULT_PUBLIC_FLOOR, disclosure: DEFAULT_DISCLOSURE_FLOOR, clear: DEFAULT_CLEAR_FLOOR, families: {} };

const WHOLE = /^[1-9]\d*$/;

const isFamily = (name: string): name is FirstOrderFamily => FIRST_ORDER_FAMILIES.some((family) => family === name);

/** A whole number of at least 1, or undefined. Hex, exponent, sign, and fraction are all refused, so what is read is what was written. */
const countOf = (text: string): number | undefined => {
  const whole = WHOLE.test(text) ? Number(text) : Number.NaN;
  return Number.isSafeInteger(whole) ? whole : undefined;
};

/** An unset binding is the default and says nothing; a set one that is not a whole number of at least 1 is the default too, with one line, so a bad value cannot serve below the floor the deploy meant. */
const floorBinding = (name: string, value: string | undefined, fallback: number, warn: (line: string) => void): number => {
  const text = bound(value);
  if (text === undefined) return fallback;
  const found = countOf(text.trim());
  if (found !== undefined) return found;
  warn(`${name} is ${JSON.stringify(text)}, not a whole number of at least 1: using ${String(fallback)}.`);
  return fallback;
};

/** One `<family>=<floor>` entry as a pair, or the reason it is refused. */
const entryOf = (entry: string): readonly [FirstOrderFamily, number] | string => {
  const parts = entry.split('=').map((part) => part.trim());
  const [name = '', floor = ''] = parts;
  const count = countOf(floor);
  if (parts.length !== 2 || count === undefined) return `${JSON.stringify(entry.trim())} is not <family>=<whole number of at least 1>`;
  return isFamily(name) ? [name, count] : `${JSON.stringify(name)} is not a read family`;
};

/** `live=3,tool-day=8`: a family name, `=`, and a floor, comma separated. The map is typed by the read families, so a name outside them is refused here and not carried to a lookup that would never find it. */
const familiesOf = (value: string | undefined, warn: (line: string) => void): Floors['families'] => {
  const text = bound(value);
  if (text === undefined) return {};
  // All or none: a typo in one entry must not leave the rest of the list half applied.
  const refused = (reason: string): Floors['families'] => {
    warn(`PUBLIC_FLOOR_FAMILIES is refused (${reason}): every family is served at the public floor.`);
    return {};
  };
  const found: Floors['families'] = {};
  for (const entry of text.split(',')) {
    const parsed = entryOf(entry);
    if (typeof parsed === 'string') return refused(parsed);
    if (Object.hasOwn(found, parsed[0])) return refused(`${parsed[0]} is named twice`);
    found[parsed[0]] = parsed[1];
  }
  return found;
};

/**
 * The clear floor: a whole number from 1 to the public floor, 1 when unset. A binding that is set and bad (not a whole number, 0, or above the public floor, which would put a clear cell behind a thresholded one and be no class split) fails
 * closed to the public floor, the strictest valid value, with one line: an operator who typed `6` or `5x` to be strict must not get the loosest floor. `PUBLIC_FLOOR` is already 1 or more, so the public floor never fails the same test.
 */
const clearFloorOf = (value: string | undefined, publicFloor: number, warn: (line: string) => void): number => {
  if (bound(value) === undefined) return Math.min(DEFAULT_CLEAR_FLOOR, publicFloor);
  const found = floorBinding('CLEAR_FLOOR', value, publicFloor, warn);
  if (found <= publicFloor) return found;
  warn(`CLEAR_FLOOR is ${String(found)}, above the public floor of ${String(publicFloor)}: using ${String(publicFloor)}.`);
  return publicFloor;
};

/** The floors the Worker's bindings state, with the default wherever a binding is unset or bad. `warn` gets one line per binding that is bad. */
export const floorsOf = (env: Pick<Env, 'PUBLIC_FLOOR' | 'DISCLOSURE_FLOOR' | 'CLEAR_FLOOR' | 'PUBLIC_FLOOR_FAMILIES'>, warn: (line: string) => void): Floors => {
  const floor = floorBinding('PUBLIC_FLOOR', env.PUBLIC_FLOOR, DEFAULT_PUBLIC_FLOOR, warn);
  return { public: floor, disclosure: floorBinding('DISCLOSURE_FLOOR', env.DISCLOSURE_FLOOR, DEFAULT_DISCLOSURE_FLOOR, warn), clear: clearFloorOf(env.CLEAR_FLOOR, floor, warn), families: familiesOf(env.PUBLIC_FLOOR_FAMILIES, warn) };
};

/** The floor a read family is served at. */
export const floorFor = (floors: Floors, family: FirstOrderFamily): number => floors.families[family] ?? floors.public;

/** The floor a cell of this class is served at in a pool whose floor is `floor` (a family's, or the public floor): a thresholded cell at `floor`, a clear one at `floor` less the gap `floors.clear` sits below `floors.public`, and never under 1. No gap today. */
export const cellFloor = (floors: Floors, floor: number, cellClass: CellClass): number => (cellClass === 'clear' ? Math.max(1, floor - (floors.public - floors.clear)) : floor);

/**
 * Whether a cell is counted over every account that holds it, standing or not, in a pool whose floor is `floor`: a `clear` cell whose own floor (`cellFloor`) is 1, since a floor of 1 has no k to protect and the standing filter (S13) would hold
 * the first read back until an account has stood. At any floor above 1, and for a `thresholded` cell, it is the accounts that have stood. The class is read when the cell is served, so a vocabulary that moves reclassifies a cell without a recount.
 */
export const countsEvery = (floors: Floors, floor: number, cell: Cell, motif: Motif | undefined): boolean => cellFloor(floors, floor, 'clear') <= 1 && cellClassOf(cell, motif) === 'clear';

/** The floors as the signed bundle states them, in the order of the families so the same bindings sign the same bytes. A family on the public floor is not listed. */
export const wireFloors = (floors: Floors): BundleFloors => {
  const families = FIRST_ORDER_FAMILIES.flatMap((family) => {
    const own = floors.families[family];
    return own === undefined || own === floors.public ? [] : [[family, own] as const];
  });
  return { public: floors.public, disclosure: floors.disclosure, clear: floors.clear, ...(families.length === 0 ? {} : { families: Object.fromEntries(families) }) };
};

/**
 * The count a cell clears a floor with: its verified-distinct clusters of accounts, not its accounts (`clusters.ts`, "Clusters" in docs/pool.md), a weighting and never a cap. The stored `clusters` column
 * is that count of the accounts that have stood (a free account that has not counts toward no floor, S13), written by `recount` (`cluster-store.ts`) after every deposit, so the SQL in `stored.ts` that compares the column to a floor to fetch fewer rows and this function, which the bundle's own
 * decision uses, read one number. A served read carries it in its `clusters` field.
 */
export const clustersOf = (cell: Cell): number => cell.clusters;

/** Whether a cell clears a floor. */
export const clears = (cell: Cell, floor: number): boolean => clustersOf(cell) >= floor;
