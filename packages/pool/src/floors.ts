// The serve floors. A floor is configuration the deploy sets on the Worker, never a constant in the code and never a client release: `PUBLIC_FLOOR` is how many clusters a cell needs before a bundle serves it or a read counts it,
// `DISCLOSURE_FLOOR` is how many clusters must hold a signature's hash before its text may be requested, and `PUBLIC_FLOOR_FAMILIES` sets the public floor for single read families. Cells are stored with their held
// counts and the floor is applied when a bundle is served (`bundleOf`), so a deploy that moves a floor needs no redeposit and no re-derive by hand.
import { FIRST_ORDER_FAMILIES, type FirstOrderFamily } from '../../cli/src/sessions/read.js';
import type { BundleFloors } from '../../cli/src/sessions/pool-wire.js';
import type { Cell } from '../../cli/src/sessions/cells.js';
import { bound, type Env } from './http.js';

/** What a deploy that sets nothing serves at. `wrangler.jsonc` states the same two numbers, and a test holds the two together. */
export const DEFAULT_PUBLIC_FLOOR = 5;
export const DEFAULT_DISCLOSURE_FLOOR = 2;

export interface Floors {
  public: number;
  disclosure: number;
  /** The read families that have a floor of their own. A family not named here is served at `public`. */
  families: Partial<Record<FirstOrderFamily, number>>;
}

export const DEFAULT_FLOORS: Floors = { public: DEFAULT_PUBLIC_FLOOR, disclosure: DEFAULT_DISCLOSURE_FLOOR, families: {} };

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

/** The floors the Worker's bindings state, with the default wherever a binding is unset or bad. `warn` gets one line per binding that is bad. */
export const floorsOf = (env: Pick<Env, 'PUBLIC_FLOOR' | 'DISCLOSURE_FLOOR' | 'PUBLIC_FLOOR_FAMILIES'>, warn: (line: string) => void): Floors => ({
  public: floorBinding('PUBLIC_FLOOR', env.PUBLIC_FLOOR, DEFAULT_PUBLIC_FLOOR, warn),
  disclosure: floorBinding('DISCLOSURE_FLOOR', env.DISCLOSURE_FLOOR, DEFAULT_DISCLOSURE_FLOOR, warn),
  families: familiesOf(env.PUBLIC_FLOOR_FAMILIES, warn),
});

/** The floor a read family is served at. */
export const floorFor = (floors: Floors, family: FirstOrderFamily): number => floors.families[family] ?? floors.public;

/** The floors as the signed bundle states them, in the order of the families so the same bindings sign the same bytes. A family on the public floor is not listed. */
export const wireFloors = (floors: Floors): BundleFloors => {
  const families = FIRST_ORDER_FAMILIES.flatMap((family) => {
    const own = floors.families[family];
    return own === undefined || own === floors.public ? [] : [[family, own] as const];
  });
  return { public: floors.public, disclosure: floors.disclosure, ...(families.length === 0 ? {} : { families: Object.fromEntries(families) }) };
};

/**
 * The count a cell clears a floor with. This is the one place a cell's count is taken, so the Sybil brief replaces this function with verified-distinct clusters and no caller changes. Today it is the cell's held count of
 * accounts (`clusters`, one per account however many sessions it sent). The index queries in `stored.ts` compare the `clusters` column to a floor in SQL, only to fetch fewer rows; the bundle's own decision is this function.
 */
export const clustersOf = (cell: Cell): number => cell.clusters;

/** Whether a cell clears a floor. */
export const clears = (cell: Cell, floor: number): boolean => clustersOf(cell) >= floor;
