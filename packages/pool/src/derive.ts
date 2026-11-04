// Cells and reads (recall spec Sections 2.5 and 2.6), with the same code a local store runs. A deposit's skeleton becomes cells in `cell-increments.ts`, which ingest adds to the stored
// ones; a bundle is derived from the stored cells, whose `clusters` is the held count of accounts. Recovery and the call-shape method are left out: a skeleton holds no error row, signature, or tool input keys (`docs/pool.md`, "What a bundle serves").
import { harnessBucket, poolOf, type Pool } from '../../cli/src/sessions/cells.js';
import { BUNDLE_FORMAT, type Bundle, VOCAB_VERSION } from '../../cli/src/sessions/pool-wire.js';
import { makeRead, orderResolver, type Read } from '../../cli/src/sessions/read.js';
import { deriveAdoption } from '../../cli/src/sessions/read-adoption.js';
import { deriveChange } from '../../cli/src/sessions/read-change.js';
import { deriveCost } from '../../cli/src/sessions/read-cost.js';
import { deriveFit, deriveFitEnvironment } from '../../cli/src/sessions/read-fit.js';
import { deriveLive } from '../../cli/src/sessions/read-live.js';
import { deriveMethod } from '../../cli/src/sessions/read-method.js';
import { deriveNextStep } from '../../cli/src/sessions/read-next-step.js';
import { deriveToolDay } from '../../cli/src/sessions/read-tool-day.js';
import type { DeriveFamily } from '../../cli/src/sessions/read-support.js';
import type { Harness } from '../../cli/src/sessions/schema.js';
import type { Store } from '../../cli/src/sessions/store.js';
import type { StoredPool } from './stored.js';

/** A served cell needs this many accounts, and a served read this many in at least one of its cells (spec Section 8; D4 may move this proposal, so it stays one constant). */
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
];

const NO_STORE: Store = { sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0 };

/**
 * A served read counts only cells at or above `K_CELL`, so every number it holds (its `n`, a share's denominator, a sum across models or weeks, a live baseline) is a sum of served cells: no
 * served number can be set against another to show the size of a sub-floor cell. The families run over the pool less its sub-floor cells, which also leaves such a cell's id out of `inputs`.
 * A read's `clusters` is the largest held count among its input cells, the most one store can prove: the fetch path reads no per-account record, so five accounts in five different weeks are five cells of one cluster each and
 * serve nothing until a later change brings held counts for a key's `n` and `c`. Five accounts on five days of one week share each week cell and serve the week reads; a `live` cell is a day, so they serve no live read.
 */
const readsOf = (pool: Pool): Read[] => {
  const orderOf = orderResolver([]);
  const asOf = { pool: pool.version, day: pool.lastDay };
  const floored: Pool = { ...pool, cells: pool.cells.filter((cell) => cell.clusters >= K_CELL) };
  return SERVED.flatMap(({ derive }) => derive({ pool: floored, store: NO_STORE }).map((read) => makeRead({ ...read, asOf }, orderOf)));
};

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The frame buckets of one harness at one numbered bucket start with this: `frameBucket` is `harness/bucket/model`, and two harnesses can share a numbered bucket. */
export const bucketPrefix = (harness: string, harnessVersion: string): string => `${harness}/${harnessBucket(harnessVersion)}/`;

/** What one harness's bundle at one version holds: the stored cells of its (harness, bucket), and beside them the version-free environment cells, which key on neither. A share's denominator is the bundle's; only what clears the floor leaves. */
export const bundleOf = (harness: Harness, harnessVersion: string, stored: StoredPool): Bundle => {
  const prefix = bucketPrefix(harness, harnessVersion);
  const cells = stored.cells.filter((cell) => cell.frameBucket.startsWith(prefix)).sort((a, b) => compare(a.motifId, b.motifId) || compare(a.frameBucket, b.frameBucket) || compare(a.grain, b.grain) || compare(a.day, b.day));
  const motifs = [...stored.motifs].sort((a, b) => compare(a.motifId, b.motifId));
  // No error rows: a skeleton holds none, and recovery, the one family that reads them, is left out here.
  // The version-free (name, platform, shell) cells sit beside the bucket's: a harness without a version, as Gemini, Cursor, and Pi are, still has them, and they name no version.
  const environment = [...stored.environment].sort((a, b) => compare(a.motifId, b.motifId) || compare(a.frameBucket, b.frameBucket) || compare(a.grain, b.grain) || compare(a.day, b.day));
  // The environment cells are read with the bucket's, but the pool's last day is the bucket's own: a week held only by another version is not this bundle's, so it cannot age the reads that count weeks since. A bucket with no cell takes the whole pool's.
  const own = poolOf({ cells, motifs }, []);
  const whole = poolOf({ cells: [...cells, ...environment], motifs }, []);
  const pool = { ...whole, lastDay: own.lastDay ?? whole.lastDay };
  const served = [...cells, ...environment].filter((cell) => cell.clusters >= K_CELL);
  const named = new Set(served.map((cell) => cell.motifId));
  return {
    format: BUNDLE_FORMAT,
    harness,
    harnessVersion,
    vocabVersion: VOCAB_VERSION,
    asOf: { pool: pool.version, day: pool.lastDay },
    cells: served,
    motifs: motifs.filter((motif) => named.has(motif.motifId)),
    reads: readsOf(pool),
    strata: [...stored.strata].sort((a, b) => compare(a.dimension, b.dimension) || compare(a.value, b.value)),
  };
};
