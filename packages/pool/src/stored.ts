// Reading the pool for a bundle: the stored `index` cells of one harness version and the strata, three statements whose rows grow with the cells and never with deposits. The
// ledger plane (`deposits`) and the `contributor` records are not read here, so expiry on them cannot change what is served.
import { harnessBucket, type Cell, type Grain } from '../../cli/src/sessions/cells.js';
import type { Motif, MotifLevel, WindowStep } from '../../cli/src/sessions/motif.js';
import type { StrataCell } from '../../cli/src/sessions/pool-wire.js';
import { bucketPrefix, K_CELL } from './derive.js';
import { fieldOf, type Env } from './http.js';

/** What a bundle is derived from: one version's cells, the motifs they name, and the strata that clear the floor. */
export interface StoredPool {
  cells: Cell[];
  motifs: Motif[];
  strata: StrataCell[];
}

const LEVELS: ReadonlySet<unknown> = new Set<MotifLevel>(['shape', 'named', 'class']);
const DIMENSIONS: ReadonlySet<unknown> = new Set<StrataCell['dimension']>(['language', 'framework', 'repoFiles']);

// Narrowing by what ingest wrote: the tables hold nothing a derivation did not produce, so these check the outer shape and trust the rest.
const isLevel = (value: unknown): value is MotifLevel => LEVELS.has(value);
const isGrain = (value: unknown): value is Grain => value === 'day' || value === 'week';
const isDimension = (value: unknown): value is StrataCell['dimension'] => DIMENSIONS.has(value);
const isSteps = (value: unknown): value is WindowStep[] => Array.isArray(value);

const numberField = (row: unknown, key: string): number => {
  const found = fieldOf(row, key);
  if (typeof found !== 'number') throw new Error(`no number at ${key} in a stored row`);
  return found;
};

const textField = (row: unknown, key: string): string => {
  const found = fieldOf(row, key);
  if (typeof found !== 'string') throw new Error(`no text at ${key} in a stored row`);
  return found;
};

const grainField = (row: unknown): Grain => {
  const found = fieldOf(row, 'grain');
  if (!isGrain(found)) throw new Error('a stored cell names no grain');
  return found;
};

/** A motif as ingest wrote it. Only ingest writes the table, from a derivation, so a row that is not one is a fault to surface and not a row to skip. */
const motifOf = (row: unknown): Motif => {
  const motif: unknown = JSON.parse(textField(row, 'motif'));
  const steps = fieldOf(motif, 'steps');
  const cls = fieldOf(motif, 'cls');
  const level = fieldOf(motif, 'level');
  if (!isLevel(level) || !isSteps(steps) || (cls !== null && typeof cls !== 'string')) throw new Error('a stored motif is not a motif');
  return { motifId: textField(motif, 'motifId'), level, steps, cls };
};

export const storedOf = async (env: Env, harness: string, harnessVersion: string): Promise<StoredPool> => {
  const bucket = harnessBucket(harnessVersion);
  const prefix = bucketPrefix(harness, harnessVersion);
  const [cells, motifs, strata] = await Promise.all([
    env.DB.prepare('SELECT motif_id, frame_bucket, grain, day, exposed, sessions, clusters, ok, failed, tokens, duration_ms FROM cells WHERE harness_bucket = ? AND substr(frame_bucket, 1, ?) = ? AND sessions > 0').bind(bucket, prefix.length, prefix).all(),
    env.DB.prepare('SELECT motif FROM motifs WHERE motif_id IN (SELECT motif_id FROM cells WHERE harness_bucket = ? AND substr(frame_bucket, 1, ?) = ? AND sessions > 0)').bind(bucket, prefix.length, prefix).all(),
    env.DB.prepare('SELECT dimension, value, sessions, clusters FROM strata WHERE clusters >= ? AND sessions > 0').bind(K_CELL).all(),
  ]);
  return {
    cells: cells.results.map((row) => ({
      motifId: textField(row, 'motif_id'),
      frameBucket: textField(row, 'frame_bucket'),
      grain: grainField(row),
      day: textField(row, 'day'),
      sessions: numberField(row, 'sessions'),
      clusters: numberField(row, 'clusters'),
      ok: numberField(row, 'ok'),
      failed: numberField(row, 'failed'),
      tokens: numberField(row, 'tokens'),
      durationMs: numberField(row, 'duration_ms'),
      exposed: numberField(row, 'exposed') === 1,
    })),
    motifs: motifs.results.map(motifOf),
    strata: strata.results.map((row) => {
      const dimension = fieldOf(row, 'dimension');
      if (!isDimension(dimension)) throw new Error('a stored stratum names no dimension');
      return { dimension, value: textField(row, 'value'), sessions: numberField(row, 'sessions'), clusters: numberField(row, 'clusters') };
    }),
  };
};
