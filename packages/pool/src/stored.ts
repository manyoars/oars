// Reading the pool for a bundle: the stored `index` cells of one harness version, the version-free environment cells, the motifs, and the strata, four statements whose rows grow with the cells and never with deposits. The
// ledger plane (`deposits`) and the `contributor` records are not read here, so a write to them cannot change what is served.
import { ENVIRONMENT_BUCKET, harnessBucket, NO_AXES, type Cell, type Grain } from '../../cli/src/sessions/cells.js';
import type { Motif, MotifLevel, WindowStep } from '../../cli/src/sessions/motif.js';
import type { StrataCell } from '../../cli/src/sessions/pool-wire.js';
import { bucketPrefix, K_CELL } from './derive.js';
import { fieldOf, type Env } from './http.js';

/** What a bundle is derived from: one version's cells, the version-free cells that are safe beside them, the motifs they name, and the strata that clear the floor. */
export interface StoredPool {
  cells: Cell[];
  environment: Cell[];
  motifs: Motif[];
  strata: StrataCell[];
  /** Accounts with a deposit in the panel window; left out by a caller that did not read the deposit records. */
  panel?: number;
  panelDay?: string;
}

const LEVELS: ReadonlySet<unknown> = new Set<MotifLevel>(['shape', 'named', 'class']);
const DIMENSIONS: ReadonlySet<unknown> = new Set<StrataCell['dimension']>(['language', 'framework', 'repoFiles', 'languageShare', 'repoFilesExplore']);

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

/**
 * The version-free (name, platform, shell) cells that clear the floor, for a motif only when no cell of that motif, grain, day, and exposure is under it, in any bucket or environment.
 * They count the same calls as the version cells, so a total beside only some of its parts shows the rest by subtraction: five accounts on one version and three on another make an
 * environment total of eight, and the total less the served five is the three. Every part is served or the total is not, so the difference is nothing. A cell's key starts with its
 * motif, so the subquery reads the motif's rows through the key's index.
 */
export const ENVIRONMENT_CELLS =
  "SELECT motif_id, frame_bucket, grain, day, exposed, sessions, clusters, ok, failed, tokens, duration_ms FROM cells WHERE harness_bucket = ? AND sessions > 0 AND clusters >= ? AND NOT EXISTS (SELECT 1 FROM cells AS other WHERE other.key >= cells.motif_id || '/' AND other.key < cells.motif_id || '0' AND other.grain = cells.grain AND other.day = cells.day AND other.exposed = cells.exposed AND other.sessions > 0 AND other.clusters < ?)";

/** The panel window: four weeks, in days. */
export const PANEL_DAYS = 28;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Distinct accounts with a counting deposit in the window, input sources left out (`accounts.source`). The `deposits_recent` index reads only the window's rows. */
export const PANEL_COUNT = "SELECT COUNT(DISTINCT deposits.account) AS accounts FROM deposits JOIN accounts ON accounts.id = deposits.account WHERE deposits.counted_at IS NOT NULL AND deposits.tier <> 'none' AND deposits.counted_at >= ? AND accounts.source = 'user'";

/**
 * The panel as of a UTC day. The ledger is read on the first fetch of a day and the count kept in the one `panel` row, so a fetch reads that row whatever the pool holds, and a deposit made after
 * the day's first read is counted from the next day. It is an account count that names no account and is not held to the floor.
 */
export const panelOf = async (env: Env, now: number): Promise<{ day: string; accounts: number }> => {
  const day = new Date(now).toISOString().slice(0, 10);
  const kept = await env.DB.prepare('SELECT day, accounts FROM panel WHERE id = 1').bind().first();
  if (fieldOf(kept, 'day') === day) return { day, accounts: numberField(kept, 'accounts') };
  const accounts = numberField(await env.DB.prepare(PANEL_COUNT).bind(now - PANEL_DAYS * DAY_MS).first(), 'accounts');
  await env.DB.prepare('INSERT INTO panel (id, day, accounts) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET day = excluded.day, accounts = excluded.accounts').bind(day, accounts).run();
  return { day, accounts };
};

const cellOf = (row: unknown): Cell => ({
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
});

export const storedOf = async (env: Env, harness: string, harnessVersion: string, now: number): Promise<StoredPool> => {
  const bucket = harnessBucket(harnessVersion);
  const prefix = bucketPrefix(harness, harnessVersion);
  const modelPrefix = `${harness}/${NO_AXES}/`;
  const [cells, environment, motifs, strata, panel] = await Promise.all([
    env.DB.prepare('SELECT motif_id, frame_bucket, grain, day, exposed, sessions, clusters, ok, failed, tokens, duration_ms FROM cells WHERE ((harness_bucket = ? AND substr(frame_bucket, 1, ?) = ?) OR (harness_bucket = ? AND substr(frame_bucket, 1, ?) = ?)) AND sessions > 0').bind(bucket, prefix.length, prefix, NO_AXES, modelPrefix.length, modelPrefix).all(),
    env.DB.prepare(ENVIRONMENT_CELLS).bind(ENVIRONMENT_BUCKET, K_CELL, K_CELL).all(),
    env.DB.prepare('SELECT motif FROM motifs WHERE motif_id IN (SELECT motif_id FROM cells WHERE ((harness_bucket = ? AND substr(frame_bucket, 1, ?) = ?) OR (harness_bucket = ? AND substr(frame_bucket, 1, ?) = ?)) AND sessions > 0) OR motif_id IN (SELECT motif_id FROM cells WHERE harness_bucket = ? AND sessions > 0 AND clusters >= ?)').bind(bucket, prefix.length, prefix, NO_AXES, modelPrefix.length, modelPrefix, ENVIRONMENT_BUCKET, K_CELL).all(),
    env.DB.prepare('SELECT dimension, value, sessions, clusters FROM strata WHERE clusters >= ? AND sessions > 0').bind(K_CELL).all(),
    panelOf(env, now),
  ]);
  return {
    cells: cells.results.map(cellOf),
    environment: environment.results.map(cellOf),
    motifs: motifs.results.map(motifOf),
    panel: panel.accounts,
    panelDay: panel.day,
    strata: strata.results.map((row) => {
      const dimension = fieldOf(row, 'dimension');
      if (!isDimension(dimension)) throw new Error('a stored stratum names no dimension');
      return { dimension, value: textField(row, 'value'), sessions: numberField(row, 'sessions'), clusters: numberField(row, 'clusters') };
    }),
  };
};
