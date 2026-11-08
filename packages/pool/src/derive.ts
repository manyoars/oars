// Cells and reads (recall spec Sections 2.5 and 2.6), with the same code a local store runs. A deposit's skeleton becomes cells in `cell-increments.ts`, which ingest adds to the stored
// ones; a bundle is derived from the stored cells, whose `clusters` is the held count of verified-distinct clusters of accounts (`clusters.ts`). Recovery is served from cells alone (what others did next after a failed call, `read-recovery-edge.ts`), and so is fit by call shape (`deriveFitShape`, from the shape cells); the signature record is left out: a skeleton holds no signature (`docs/pool.md`, "What a bundle serves").
import { cellIdOf, harnessBucket, NO_AXES, poolOf, type Cell, type Pool } from '../../cli/src/sessions/cells.js';
import { motifName } from '../../cli/src/sessions/motif.js';
import { BUNDLE_FORMAT, type Bundle, VOCAB_VERSION } from '../../cli/src/sessions/pool-wire.js';
import { makeRead, orderResolver, type FirstOrderFamily, type Read } from '../../cli/src/sessions/read.js';
import { deriveAdoption } from '../../cli/src/sessions/read-adoption.js';
import { deriveChange } from '../../cli/src/sessions/read-change.js';
import { deriveCost } from '../../cli/src/sessions/read-cost.js';
import { deriveFit, deriveFitEnvironment, deriveFitShape } from '../../cli/src/sessions/read-fit.js';
import { baselineDaysOf, deriveLive } from '../../cli/src/sessions/read-live.js';
import { deriveMethod } from '../../cli/src/sessions/read-method.js';
import { deriveNextStep } from '../../cli/src/sessions/read-next-step.js';
import { deriveRecoveryEdges } from '../../cli/src/sessions/read-recovery-edge.js';
import { deriveToolDay } from '../../cli/src/sessions/read-tool-day.js';
import { unitCells, type DeriveFamily, type ReadBody } from '../../cli/src/sessions/read-support.js';
import type { Harness } from '../../cli/src/sessions/schema.js';
import type { Store } from '../../cli/src/sessions/store.js';
import { cellClassOf } from './cell-class.js';
import { booksOf } from './books.js';
import { withheldOf } from './complement.js';
import { cellFloor, clears, clustersOf, countsEvery, floorFor, wireFloors, type Floors } from './floors.js';
import type { StoredPool } from './stored.js';

/** What a bundle derives, by name: the names are hashed into its ETag, so a change to this list moves the tag of a bundle whose cells did not change. */
export const SERVED: readonly { name: string; family: FirstOrderFamily; derive: DeriveFamily }[] = [
  { name: 'fit', family: 'fit', derive: deriveFit },
  { name: 'fit-environment', family: 'fit', derive: deriveFitEnvironment },
  { name: 'fit-shape', family: 'fit', derive: deriveFitShape },
  { name: 'cost', family: 'cost', derive: deriveCost },
  { name: 'change', family: 'change', derive: deriveChange },
  { name: 'live', family: 'live', derive: deriveLive },
  { name: 'adoption', family: 'adoption', derive: deriveAdoption },
  { name: 'method', family: 'method', derive: deriveMethod },
  { name: 'next-step', family: 'next-step', derive: deriveNextStep },
  { name: 'tool-day', family: 'tool-day', derive: deriveToolDay },
  { name: 'recovery', family: 'recovery', derive: deriveRecoveryEdges },
];

const NO_STORE: Store = { sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0 };

/**
 * A served read counts only cells at or above its family's floor (`floors.ts`) that the bundle serves, so every count, sum, and denominator it holds (its `n`, a share's denominator, a sum across models or weeks, a live baseline) is a sum of served cells,
 * and a sub-floor cell's id is in no `inputs`. Two numbers of one family's reads at one grain, set against each other, show nothing of a sub-floor cell. Across grains, a week and its days count the same steps, as do a shape and
 * its names, so a week with a sub-floor day also withholds its smallest served day, and a shape with a sub-floor name its smallest served name (`complement.ts`): the week less the served days is then a sum over at least two days,
 * one of them at or above the floor. A live baseline with no served cell of its motif is `null`, as a tool that is sub-floor is not absent.
 * A read's `clusters` is the largest held count among its input cells, the most one store can prove: the fetch path reads no per-account record, so five accounts in five different weeks are five cells of one cluster each and
 * serve nothing until a later change brings held counts for a key's `n` and `c`. Five accounts on five days of one week share each week cell and serve the week reads; a `live` cell is a day, so they serve no live read.
 * `asOf.pool`, `asOf.day`, and `weeksSinceLast` come from the served cells alone (`bundleOf`), so a sub-floor cell's size moves none of them. The first sub-floor part of a family withholds one more part, which a reader sees.
 */
const readsOf = (pool: Pool, derive: DeriveFamily, floor: number): Read[] => {
  const orderOf = orderResolver([]);
  const asOf = { pool: pool.version, day: pool.lastDay };
  // A live read's baseline is a second set of cells its inputs do not cite: when the motif has none of its own in the trailing days, the baseline and the ratio against it are null and not 0.
  const shapeUnits = unitCells(pool, 'day').filter(({ motif }) => motif.level === 'shape');
  const baselined = (read: ReadBody): ReadBody => {
    if (read.family !== 'live') return read;
    const { motif, day } = read.slice;
    const days = new Set(baselineDaysOf(String(day)));
    return shapeUnits.some(({ cell, motif: unit }) => motifName(unit) === motif && days.has(cell.day)) ? read : { ...read, value: { ...read.value, baseline: null, ratio: null } };
  };
  // Every served read states the floor it cleared, and the floor is in its ID, so a read served at 3 and the same numbers served at 5 are two reads.
  return derive({ pool, store: NO_STORE }).map(baselined).map((read) => makeRead({ ...read, asOf, floor }, orderOf));
};

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The frame buckets of one harness at one numbered bucket start with this: `frameBucket` is `harness/bucket/model`, and two harnesses can share a numbered bucket. */
export const bucketPrefix = (harness: string, harnessVersion: string): string => `${harness}/${harnessBucket(harnessVersion)}/`;

/**
 * What one harness's bundle at one version holds: the stored cells of its (harness, bucket), and beside them its version-free model cells and the environment cells, which key on neither. A share's denominator is the sum of the bundle's served cells (`readsOf`); only what clears the floor leaves.
 * The floors are the deploy's (`floors.ts`), applied here and nowhere else: the stored cells keep their held counts, so a floor that moves needs no redeposit. Each read family is derived from the cells served at its own floor (the public floor unless
 * `floors.families` names it), with complementary withholding computed at that floor, so a family on its own floor holds the same differencing guarantee as one on the public floor. A `clear` cell (`cell-class.ts`) is served at the floor of its class (`cellFloor`), and a part is sub-floor against its own class's floor when a whole is withheld beside it. The bundle's `cells` are those served at the public floor,
 * and beside them any cell that a read of a family on its own floor cites, since a read must be able to be walked back to the cells it names; a family on a lower floor therefore shows its own cells and no other family's.
 */
export const bundleOf = (harness: Harness, harnessVersion: string, stored: StoredPool, floors: Floors): Bundle => {
  const prefix = bucketPrefix(harness, harnessVersion);
  const cells = stored.cells.filter((cell) => cell.frameBucket.startsWith(prefix) || cell.frameBucket.startsWith(`${harness}/${NO_AXES}/`)).sort((a, b) => compare(a.motifId, b.motifId) || compare(a.frameBucket, b.frameBucket) || compare(a.grain, b.grain) || compare(a.day, b.day));
  const motifs = [...stored.motifs].sort((a, b) => compare(a.motifId, b.motifId));
  // No error rows: a skeleton holds none, and the signature record that reads them is left out here; recovery is served from the failed calls' cells.
  // The version-free (name, platform, shell) cells sit beside the bucket's: a harness without a version, as Gemini, Cursor, and Pi are, still has them, and they name no version.
  const environment = [...stored.environment].sort((a, b) => compare(a.motifId, b.motifId) || compare(a.frameBucket, b.frameBucket) || compare(a.grain, b.grain) || compare(a.day, b.day));
  // The environment cells are read with the bucket's, but the pool's last day is the bucket's own: a week held only by another version is not this bundle's, so it cannot age the reads that count weeks since. A bucket with no served cell takes the whole pool's.
  // Everything the bundle states, its version and its last day included, is that of the served cells: a sub-floor cell, or a served one held back (`withheldOf`), would otherwise move `asOf` and `weeksSinceLast`, which would show that it exists.
  const held = [...cells, ...environment];
  const motifOf = new Map(motifs.map((motif) => [motif.motifId, motif]));
  // A cell is held with both counts (`stored.every`) and counted where the floor is known: over every account when its own floor is 1 (`countsEvery`), over the accounts that have stood otherwise. One object per cell counted over every
  // account, so the cells a pool serves are the same objects wherever they are chosen; `standing` maps one back to the cell as stored.
  const standing = new Map<Cell, Cell>();
  const everyCounted = new Map<Cell, Cell>();
  const countedAt = (floor: number, cell: Cell): Cell => {
    const any = stored.every?.get(cell);
    if (any === undefined || !countsEvery(floors, floor, cell, motifOf.get(cell.motifId))) return cell;
    const known = everyCounted.get(cell);
    if (known !== undefined) return known;
    const made: Cell = { ...cell, clusters: any };
    everyCounted.set(cell, made);
    standing.set(made, cell);
    return made;
  };
  const poolsAt = new Map<number, { served: Cell[]; held: Cell[]; pool: Pool }>();
  const poolAt = (floor: number): { served: Cell[]; held: Cell[]; pool: Pool } => {
    const known = poolsAt.get(floor);
    if (known !== undefined) return known;
    const floorOf = (cell: Cell): number => cellFloor(floors, floor, cellClassOf(cell, motifOf.get(cell.motifId)));
    const countedHeld = held.map((cell) => countedAt(floor, cell));
    const withheld = withheldOf(countedHeld, motifs, { floorOf, standingOf: (cell) => clustersOf(standing.get(cell) ?? cell) });
    // A version-free counterpart would otherwise reveal the name withheld in this bucket.
    const counterpart = (cell: Cell): string => JSON.stringify([cell.motifId, cell.grain, cell.day, cell.exposed]);
    const withheldBuckets = new Set(cells.filter((cell) => withheld.has(countedAt(floor, cell))).map(counterpart));
    for (const cell of environment) {
      if (withheldBuckets.has(counterpart(cell))) withheld.add(countedAt(floor, cell));
    }
    const served = countedHeld.filter((cell) => clears(cell, floorOf(cell)) && !withheld.has(cell));
    const kept = new Set(served);
    // `cells` holds the version-free model cells of every version too, so the bucket's own are taken by its prefix: another version's failure on a later day must not move the day.
    const own = poolOf({ cells: cells.map((cell) => countedAt(floor, cell)).filter((cell) => kept.has(cell) && cell.frameBucket.startsWith(prefix)), motifs }, []);
    const whole = poolOf({ cells: served, motifs }, []);
    const made = { served, held: countedHeld, pool: { ...whole, lastDay: own.lastDay ?? whole.lastDay } };
    poolsAt.set(floor, made);
    return made;
  };
  const reads = SERVED.map(({ family, derive }) => ({ family, read: readsOf(poolAt(floorFor(floors, family)).pool, derive, floorFor(floors, family)) }));
  const { served, held: heldAtPublic, pool } = poolAt(floors.public);
  // The cells a family on its own floor cites, beside those the public floor serves.
  const cited = new Set(reads.filter(({ family }) => floorFor(floors, family) !== floors.public).flatMap(({ read }) => read.flatMap(({ inputs }) => inputs)));
  const shown = new Set([...served, ...[...new Set(Object.values(floors.families))].flatMap((floor) => poolAt(floor).served).filter((cell) => cited.has(cellIdOf(cell)))]);
  // A cell shown counted over every account, by the public floor or by a family's, is shown as that.
  const bundled = held.flatMap((cell) => {
    const every = everyCounted.get(cell);
    return every !== undefined && shown.has(every) ? [every] : shown.has(cell) ? [cell] : [];
  });
  const named = new Set(bundled.map((cell) => cell.motifId));
  return {
    format: BUNDLE_FORMAT,
    harness,
    harnessVersion,
    vocabVersion: VOCAB_VERSION,
    floor: floors.public,
    asOf: { pool: pool.version, day: pool.lastDay },
    cells: bundled,
    motifs: motifs.filter((motif) => named.has(motif.motifId)),
    reads: reads.flatMap(({ read }) => read),
    strata: [...stored.strata].sort((a, b) => compare(a.dimension, b.dimension) || compare(a.value, b.value)),
    floors: wireFloors(floors),
    books: booksOf({ held: heldAtPublic, served: new Set(served), panel: stored.panel, panelDay: stored.panelDay, lineage: { floor: floors.public, format: BUNDLE_FORMAT, vocabVersion: VOCAB_VERSION, asOf: { pool: pool.version, day: pool.lastDay } } }),
  };
};
