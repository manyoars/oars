// Cells and reads (recall spec Sections 2.5 and 2.6), with the same code a local store runs. A deposit's skeleton becomes cells in `cell-increments.ts`, which ingest adds to the stored
// ones; a bundle is derived from the stored cells, whose `clusters` is the held count of accounts. Recovery is served from cells alone (what others did next after a failed call, `read-recovery-edge.ts`); the signature record and the call-shape method are left out: a skeleton holds no signature or tool input keys (`docs/pool.md`, "What a bundle serves").
import { harnessBucket, NO_AXES, poolOf, type Pool } from '../../cli/src/sessions/cells.js';
import { motifName } from '../../cli/src/sessions/motif.js';
import { BUNDLE_FORMAT, type Bundle, VOCAB_VERSION } from '../../cli/src/sessions/pool-wire.js';
import { makeRead, orderResolver, type Read } from '../../cli/src/sessions/read.js';
import { deriveAdoption } from '../../cli/src/sessions/read-adoption.js';
import { deriveChange } from '../../cli/src/sessions/read-change.js';
import { deriveCost } from '../../cli/src/sessions/read-cost.js';
import { deriveFit, deriveFitEnvironment } from '../../cli/src/sessions/read-fit.js';
import { baselineDaysOf, deriveLive } from '../../cli/src/sessions/read-live.js';
import { deriveMethod } from '../../cli/src/sessions/read-method.js';
import { deriveNextStep } from '../../cli/src/sessions/read-next-step.js';
import { deriveRecoveryEdges } from '../../cli/src/sessions/read-recovery-edge.js';
import { deriveToolDay } from '../../cli/src/sessions/read-tool-day.js';
import { unitCells, type DeriveFamily, type ReadBody } from '../../cli/src/sessions/read-support.js';
import type { Harness } from '../../cli/src/sessions/schema.js';
import type { Store } from '../../cli/src/sessions/store.js';
import { booksOf } from './books.js';
import { withheldOf } from './complement.js';
import type { StoredPool } from './stored.js';

/** A served cell needs this many accounts, and a served read counts only such cells (spec Section 8; D4 may move this proposal, so it stays one constant). */
export const K_CELL = 5;

/** What a bundle derives, by name: the names are hashed into its ETag, so a change to this list moves the tag of a bundle whose cells did not change. */
export const SERVED: readonly { name: string; derive: DeriveFamily }[] = [
  { name: 'fit', derive: deriveFit },
  { name: 'fit-environment', derive: deriveFitEnvironment },
  { name: 'cost', derive: deriveCost },
  { name: 'change', derive: deriveChange },
  { name: 'live', derive: deriveLive },
  { name: 'adoption', derive: deriveAdoption },
  { name: 'method', derive: deriveMethod },
  { name: 'next-step', derive: deriveNextStep },
  { name: 'tool-day', derive: deriveToolDay },
  { name: 'recovery', derive: deriveRecoveryEdges },
];

const NO_STORE: Store = { sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0 };

/**
 * A served read counts only cells at or above `K_CELL` that the bundle serves, so every count, sum, and denominator it holds (its `n`, a share's denominator, a sum across models or weeks, a live baseline) is a sum of served cells,
 * and a sub-floor cell's id is in no `inputs`. Two numbers of one family's reads at one grain, set against each other, show nothing of a sub-floor cell. Across grains, a week and its days count the same steps, as do a shape and
 * its names, so a week with a sub-floor day also withholds its smallest served day, and a shape with a sub-floor name its smallest served name (`complement.ts`): the week less the served days is then a sum over at least two days,
 * one of them at or above the floor. A live baseline with no served cell of its motif is `null`, as a tool that is sub-floor is not absent.
 * A read's `clusters` is the largest held count among its input cells, the most one store can prove: the fetch path reads no per-account record, so five accounts in five different weeks are five cells of one cluster each and
 * serve nothing until a later change brings held counts for a key's `n` and `c`. Five accounts on five days of one week share each week cell and serve the week reads; a `live` cell is a day, so they serve no live read.
 * `asOf.pool`, `asOf.day`, and `weeksSinceLast` come from the served cells alone (`bundleOf`), so a sub-floor cell's size moves none of them. The first sub-floor part of a family withholds one more part, which a reader sees.
 */
const readsOf = (pool: Pool): Read[] => {
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
  return SERVED.flatMap(({ derive }) => derive({ pool, store: NO_STORE }).map(baselined).map((read) => makeRead({ ...read, asOf }, orderOf)));
};

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The frame buckets of one harness at one numbered bucket start with this: `frameBucket` is `harness/bucket/model`, and two harnesses can share a numbered bucket. */
export const bucketPrefix = (harness: string, harnessVersion: string): string => `${harness}/${harnessBucket(harnessVersion)}/`;

/** What one harness's bundle at one version holds: the stored cells of its (harness, bucket), and beside them its version-free model cells and the environment cells, which key on neither. A share's denominator is the sum of the bundle's served cells (`readsOf`); only what clears the floor leaves. */
export const bundleOf = (harness: Harness, harnessVersion: string, stored: StoredPool): Bundle => {
  const prefix = bucketPrefix(harness, harnessVersion);
  const cells = stored.cells.filter((cell) => cell.frameBucket.startsWith(prefix) || cell.frameBucket.startsWith(`${harness}/${NO_AXES}/`)).sort((a, b) => compare(a.motifId, b.motifId) || compare(a.frameBucket, b.frameBucket) || compare(a.grain, b.grain) || compare(a.day, b.day));
  const motifs = [...stored.motifs].sort((a, b) => compare(a.motifId, b.motifId));
  // No error rows: a skeleton holds none, and the signature record that reads them is left out here; recovery is served from the failed calls' cells.
  // The version-free (name, platform, shell) cells sit beside the bucket's: a harness without a version, as Gemini, Cursor, and Pi are, still has them, and they name no version.
  const environment = [...stored.environment].sort((a, b) => compare(a.motifId, b.motifId) || compare(a.frameBucket, b.frameBucket) || compare(a.grain, b.grain) || compare(a.day, b.day));
  // The environment cells are read with the bucket's, but the pool's last day is the bucket's own: a week held only by another version is not this bundle's, so it cannot age the reads that count weeks since. A bucket with no served cell takes the whole pool's.
  // Everything the bundle states, its version and its last day included, is that of the served cells: a sub-floor cell, or a served one held back (`withheldOf`), would otherwise move `asOf` and `weeksSinceLast`, which would show that it exists.
  const held = [...cells, ...environment];
  const withheld = withheldOf(held, motifs, K_CELL);
  // A version-free counterpart would otherwise reveal the name withheld in this bucket.
  const counterpart = (cell: (typeof held)[number]): string => JSON.stringify([cell.motifId, cell.grain, cell.day, cell.exposed]);
  const withheldBuckets = new Set(cells.filter((cell) => withheld.has(cell)).map(counterpart));
  for (const cell of environment) {
    if (withheldBuckets.has(counterpart(cell))) withheld.add(cell);
  }
  const served = held.filter((cell) => cell.clusters >= K_CELL && !withheld.has(cell));
  const kept = new Set(served);
  // `cells` holds the version-free model cells of every version too, so the bucket's own are taken by its prefix: another version's failure on a later day must not move the day.
  const own = poolOf({ cells: cells.filter((cell) => kept.has(cell) && cell.frameBucket.startsWith(prefix)), motifs }, []);
  const whole = poolOf({ cells: served, motifs }, []);
  const pool = { ...whole, lastDay: own.lastDay ?? whole.lastDay };
  const named = new Set(served.map((cell) => cell.motifId));
  return {
    format: BUNDLE_FORMAT,
    harness,
    harnessVersion,
    vocabVersion: VOCAB_VERSION,
    floor: K_CELL,
    asOf: { pool: pool.version, day: pool.lastDay },
    cells: served,
    motifs: motifs.filter((motif) => named.has(motif.motifId)),
    reads: readsOf(pool),
    strata: [...stored.strata].sort((a, b) => compare(a.dimension, b.dimension) || compare(a.value, b.value)),
    books: booksOf({ held, served: kept, panel: stored.panel, panelDay: stored.panelDay, lineage: { floor: K_CELL, format: BUNDLE_FORMAT, vocabVersion: VOCAB_VERSION, asOf: { pool: pool.version, day: pool.lastDay } } }),
  };
};
