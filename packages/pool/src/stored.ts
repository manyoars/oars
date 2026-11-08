// Reading the pool for a bundle: the stored `index` cells of one harness version, the version-free environment cells, the motifs, and the strata, four statements whose rows grow with the cells and never with deposits. The
// ledger plane (`deposits`) and the `contributor` records are not read here, so a write to them cannot change what is served.
import { ENVIRONMENT_BUCKET, harnessBucket, NO_AXES, type Cell, type Grain } from '../../cli/src/sessions/cells.js';
import type { Motif, MotifLevel, WindowStep } from '../../cli/src/sessions/motif.js';
import type { StrataCell } from '../../cli/src/sessions/pool-wire.js';
import { bucketPrefix } from './derive.js';
import { cellClassOf } from './cell-class.js';
import { cellFloor, floorFor, type Floors } from './floors.js';
import { fieldOf, type Env } from './http.js';
import { chunksOf } from './ingest.js';

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
 * The version-free (name, platform, shell) cells that may clear a floor: those held by `clusters_any` at the lowest floor either class could serve them at (the caller's bound), a superset that `environmentOf` narrows by the cell's class.
 * They count the same calls as the version cells, so a total beside only some of its parts shows the rest by subtraction: five accounts on one version and three on another make an environment total of eight, and the total less the
 * served five is the three. Every part is served or the total is not (`environmentOf`), so the difference is nothing.
 */
export const ENVIRONMENT_CELLS =
  'SELECT motif_id, frame_bucket, grain, day, exposed, sessions, clusters, clusters_any, ok, failed, tokens, token_sessions, token_prompts, duration_ms FROM cells WHERE harness_bucket = ? AND sessions > 0 AND clusters_any >= ?';

/** The parts of those cells: every cell of the given motifs (a JSON array of motif ids), in any bucket or environment. A cell's key starts with its motif, so the join reads each motif's rows through the key's index. */
export const ENVIRONMENT_PARTS =
  "SELECT cells.motif_id, cells.frame_bucket, cells.grain, cells.day, cells.exposed, cells.sessions, cells.clusters, cells.clusters_any, cells.ok, cells.failed, cells.tokens, cells.token_sessions, cells.token_prompts, cells.duration_ms FROM json_each(?) AS motif JOIN cells ON cells.key >= motif.value || '/' AND cells.key < motif.value || '0' WHERE cells.sessions > 0";

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

/** A count that is NULL on a row written before migration 0013: its coverage was never held, so it reads as unknown and not as full coverage. */
const coverageField = (row: unknown, key: string): number | null => {
  const found = fieldOf(row, key);
  return found === null || found === undefined ? null : numberField(row, key);
};

const cellBase = (row: unknown): Omit<Cell, 'tokens'> => ({
  motifId: textField(row, 'motif_id'),
  frameBucket: textField(row, 'frame_bucket'),
  grain: grainField(row),
  day: textField(row, 'day'),
  sessions: numberField(row, 'sessions'),
  clusters: numberField(row, 'clusters'),
  ok: numberField(row, 'ok'),
  failed: numberField(row, 'failed'),
  durationMs: numberField(row, 'duration_ms'),
  exposed: numberField(row, 'exposed') === 1,
});

/** A cell as held, and the count of every account that holds it, standing or not (`clusters_any`). */
export interface Held {
  cell: Cell;
  any: number;
}

const heldOf = (row: unknown): Held => ({ cell: cellOf(row), any: numberField(row, 'clusters_any') });

const cellOf = (row: unknown): Cell => {
  const tokenSessions = coverageField(row, 'token_sessions');
  const tokenPrompts = coverageField(row, 'token_prompts');
  const tokens = numberField(row, 'tokens');
  // The column is a running sum that holds 0 for a cell no session recorded; with a known coverage of none that is no figure, as the derivation states it.
  return {
    ...cellBase(row),
    tokens: tokenSessions === 0 ? null : tokens,
    ...(tokenSessions === null ? {} : { tokenSessions }),
    ...(tokenPrompts === null ? {} : { tokenPrompts }),
  };
};

/**
 * The count a cell is served on. A `clear` cell at a clear floor of 1 counts every account that holds it, standing or not, since a floor of 1 has no k to protect and the standing filter (S13) would hold the first read back until an account has
 * stood; at any other clear floor, and for a `thresholded` cell, it is the count of the accounts that have stood. The class is read here, when the cell is served, so a vocabulary that moves reclassifies a cell without a recount.
 */
const countedAs = (held: Held, motifs: ReadonlyMap<string, Motif>, floors: Floors): Cell => (floors.clear <= 1 && cellClassOf(held.cell, motifs.get(held.cell.motifId)) === 'clear' ? { ...held.cell, clusters: held.any } : held.cell);

/**
 * The environment cells to serve: those that clear the floor of their own class, and only when no cell of the same motif, grain, day, and exposure, in any bucket or environment, is under the floor of its class. One sub-floor part
 * withholds the total, because the total less its served parts would be that part. A part is sub-floor against its own class: a long-tail version, model, or shell is held to the public floor even beside a clear total, which is how the
 * rule withholds a total that would reveal it, while a clear part at the clear floor withholds nothing.
 */
export const environmentOf = (candidates: readonly Held[], parts: readonly Held[], motifs: ReadonlyMap<string, Motif>, floors: Floors, floor: number): Cell[] => {
  const counted = (held: Held): Cell => countedAs(held, motifs, floors);
  const clearsOwn = (held: Held): boolean => {
    const cell = counted(held);
    return cell.clusters >= cellFloor(floors, floor, cellClassOf(cell, motifs.get(cell.motifId)));
  };
  const under = new Set(parts.filter((part) => !clearsOwn(part)).map(({ cell }) => JSON.stringify([cell.motifId, cell.grain, cell.day, cell.exposed, cell.frameBucket])));
  const partsOf = new Map<string, string[]>();
  for (const { cell } of parts) {
    const key = JSON.stringify([cell.motifId, cell.grain, cell.day, cell.exposed]);
    partsOf.set(key, [...(partsOf.get(key) ?? []), cell.frameBucket]);
  }
  return candidates
    .filter((held) => clearsOwn(held))
    .filter(({ cell }) => (partsOf.get(JSON.stringify([cell.motifId, cell.grain, cell.day, cell.exposed])) ?? []).every((frame) => !under.has(JSON.stringify([cell.motifId, cell.grain, cell.day, cell.exposed, frame]))))
    .map(counted);
};

/**
 * The rows a bundle is derived from. The cells come with their held counts, whatever they are, so a floor is applied when the bundle is served (`bundleOf`) and never decided here. The queries that do compare a count to a floor
 * (the environment cells, the motifs they name, and the strata) take the floor of the family that reads them, to fetch fewer rows: the environment cells are the `fit` family's, and a stratum is a bundle-level count at the public floor.
 */
export const storedOf = async (env: Env, harness: string, harnessVersion: string, floors: Floors, now: number): Promise<StoredPool> => {
  const environmentFloor = floorFor(floors, 'fit');
  // The lowest count an environment cell can be served on: its class's floor, the clear one when that is lower.
  const lowest = Math.min(environmentFloor, cellFloor(floors, environmentFloor, 'clear'));
  const bucket = harnessBucket(harnessVersion);
  const prefix = bucketPrefix(harness, harnessVersion);
  const modelPrefix = `${harness}/${NO_AXES}/`;
  const [cells, candidates, motifs, strata, panel] = await Promise.all([
    env.DB.prepare('SELECT motif_id, frame_bucket, grain, day, exposed, sessions, clusters, clusters_any, ok, failed, tokens, token_sessions, token_prompts, duration_ms FROM cells WHERE ((harness_bucket = ? AND substr(frame_bucket, 1, ?) = ?) OR (harness_bucket = ? AND substr(frame_bucket, 1, ?) = ?)) AND sessions > 0').bind(bucket, prefix.length, prefix, NO_AXES, modelPrefix.length, modelPrefix).all(),
    env.DB.prepare(ENVIRONMENT_CELLS).bind(ENVIRONMENT_BUCKET, lowest).all(),
    env.DB.prepare('SELECT motif FROM motifs WHERE motif_id IN (SELECT motif_id FROM cells WHERE ((harness_bucket = ? AND substr(frame_bucket, 1, ?) = ?) OR (harness_bucket = ? AND substr(frame_bucket, 1, ?) = ?)) AND sessions > 0) OR motif_id IN (SELECT motif_id FROM cells WHERE harness_bucket = ? AND sessions > 0 AND clusters_any >= ?)').bind(bucket, prefix.length, prefix, NO_AXES, modelPrefix.length, modelPrefix, ENVIRONMENT_BUCKET, lowest).all(),
    env.DB.prepare('SELECT dimension, value, sessions, clusters FROM strata WHERE clusters >= ? AND sessions > 0').bind(floors.public).all(),
    panelOf(env, now),
  ]);
  const held = candidates.results.map(heldOf);
  // The parts of the candidates' motifs, read after them: a candidate with no cell under its floor is the only one that is served.
  const parts = (await Promise.all(chunksOf([...new Set(held.map(({ cell }) => cell.motifId))]).map((chunk) => env.DB.prepare(ENVIRONMENT_PARTS).bind(chunk).all()))).flatMap((page) => page.results.map(heldOf));
  const known = motifs.results.map(motifOf);
  const byId = new Map(known.map((motif) => [motif.motifId, motif]));
  return {
    cells: cells.results.map(heldOf).map((one) => countedAs(one, byId, floors)),
    environment: environmentOf(held, parts, byId, floors, environmentFloor),
    motifs: known,
    panel: panel.accounts,
    panelDay: panel.day,
    strata: strata.results.map((row) => {
      const dimension = fieldOf(row, 'dimension');
      if (!isDimension(dimension)) throw new Error('a stored stratum names no dimension');
      return { dimension, value: textField(row, 'value'), sessions: numberField(row, 'sessions'), clusters: numberField(row, 'clusters') };
    }),
  };
};
