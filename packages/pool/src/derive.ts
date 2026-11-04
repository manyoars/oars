// Cells and reads (recall spec Sections 2.5 and 2.6), with the same code a local store runs. A deposit's skeleton becomes cells in `cell-increments.ts`, which ingest adds to the stored
// ones; a bundle is derived from the stored cells, whose `clusters` is the held count of accounts. Recovery is left out: its signature is class A text, which a skeleton does not hold.
import { cellIdOf, harnessBucket, poolOf, type Pool } from '../../cli/src/sessions/cells.js';
import { motifName } from '../../cli/src/sessions/motif.js';
import { BUNDLE_FORMAT, type Bundle, VOCAB_VERSION } from '../../cli/src/sessions/pool-wire.js';
import { makeRead, orderResolver, type Read } from '../../cli/src/sessions/read.js';
import { deriveAdoption } from '../../cli/src/sessions/read-adoption.js';
import { deriveChange } from '../../cli/src/sessions/read-change.js';
import { deriveCost } from '../../cli/src/sessions/read-cost.js';
import { deriveFit } from '../../cli/src/sessions/read-fit.js';
import { baselineDaysOf, deriveLive } from '../../cli/src/sessions/read-live.js';
import { deriveMethod } from '../../cli/src/sessions/read-method.js';
import { deriveNextStep } from '../../cli/src/sessions/read-next-step.js';
import { unitCells, type DeriveFamily, type ReadBody } from '../../cli/src/sessions/read-support.js';
import type { Store } from '../../cli/src/sessions/store.js';
import type { StoredPool } from './stored.js';

/** A served cell needs this many accounts, and a served read this many in at least one of its cells (spec Section 8; D4 may move this proposal, so it stays one constant). */
export const K_CELL = 5;

const DERIVERS: readonly DeriveFamily[] = [deriveFit, deriveCost, deriveChange, deriveLive, deriveAdoption, deriveMethod, deriveNextStep];

const NO_STORE: Store = { sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0 };

/**
 * Each family states the highest of a read's cells, the most one store can prove. A read's `clusters` here is the largest held count among its input cells: the fetch path
 * reads no per-account record, so five accounts on five days are five cells of one cluster each and serve nothing until a later change brings held counts for a key's `n` and `c`.
 */
const readsOf = (pool: Pool): Read[] => {
  const orderOf = orderResolver([]);
  const asOf = { pool: pool.version, day: pool.lastDay };
  const held = new Map(pool.cells.map((cell) => [cellIdOf(cell), cell.clusters]));
  const clustersOf = (inputs: readonly string[]): number => inputs.reduce((most, input) => Math.max(most, held.get(input) ?? 0), 0);
  // Once for every live read of a bundle: the shape-level units are the same for each.
  const shapeUnits = unitCells(pool, 'day').filter(({ motif }) => motif.level === 'shape');
  // A live read's baseline is a second set of cells its inputs do not cite, so it takes the same floor on its own: under it, the baseline and the ratio against it are null.
  const baselined = (read: ReadBody): ReadBody => {
    if (read.family !== 'live') return read;
    const { motif, day } = read.slice;
    const days = new Set(baselineDaysOf(String(day)));
    const inBaseline = shapeUnits.filter(({ cell, motif: unit }) => motifName(unit) === motif && days.has(cell.day));
    return clustersOf(inBaseline.map(({ cell }) => cellIdOf(cell))) >= K_CELL ? read : { ...read, value: { ...read.value, baseline: null, ratio: null } };
  };
  return DERIVERS.flatMap((derive) => derive({ pool, store: NO_STORE }).map(baselined).map((read) => makeRead({ ...read, asOf, clusters: clustersOf(read.inputs) }, orderOf)));
};

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The frame buckets of one harness at one numbered bucket start with this: `frameBucket` is `harness/bucket/model`, and two harnesses can share a numbered bucket. */
export const bucketPrefix = (harness: string, harnessVersion: string): string => `${harness}/${harnessBucket(harnessVersion)}/`;

/** What one harness's bundle at one version holds: the stored cells of its (harness, bucket), the only pair a landed cell keys on. A share's denominator is the bundle's; only what clears the floor leaves. */
export const bundleOf = (harness: string, harnessVersion: string, stored: StoredPool): Bundle => {
  const prefix = bucketPrefix(harness, harnessVersion);
  const cells = stored.cells.filter((cell) => cell.frameBucket.startsWith(prefix)).sort((a, b) => compare(a.motifId, b.motifId) || compare(a.frameBucket, b.frameBucket) || compare(a.grain, b.grain) || compare(a.day, b.day));
  const motifs = [...stored.motifs].sort((a, b) => compare(a.motifId, b.motifId));
  // No error rows: a skeleton holds none, and recovery, the one family that reads them, is left out here.
  const pool = poolOf({ cells, motifs }, []);
  const served = cells.filter((cell) => cell.clusters >= K_CELL);
  const named = new Set(served.map((cell) => cell.motifId));
  return {
    format: BUNDLE_FORMAT,
    harnessVersion,
    vocabVersion: VOCAB_VERSION,
    asOf: { pool: pool.version, day: pool.lastDay },
    cells: served,
    motifs: motifs.filter((motif) => named.has(motif.motifId)),
    reads: readsOf(pool).filter((read) => read.clusters >= K_CELL),
    strata: [...stored.strata].sort((a, b) => compare(a.dimension, b.dimension) || compare(a.value, b.value)),
  };
};
