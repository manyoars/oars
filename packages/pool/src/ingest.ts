// Ingest (spec Section 2, "the deposit form"): a batch's skeleton becomes cell increments on the stored `index` cells, and a `contributor` record per (cell, account, UTC day) lets a
// cell tell a new cluster from a returning one. Everything one deposit writes goes in one transaction, guarded by the deposit row that this write set, so a refused deposit writes none.
import { incrementsOf, type CellRow, type Increments, type StratumRow } from '../../cli/src/sessions/cell-increments.js';
import { parseSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { fieldOf, type Bound, type Env } from './http.js';

export { incrementsOf, type CellRow, type Increments, type StratumRow };

/** What replacing `previous` with `next` adds to each cell: next's counts less the replaced batch's, and only where something changes. */
const netOf = <Row extends { key: string }>(next: ReadonlyMap<string, Row>, previous: ReadonlyMap<string, Row>, fields: readonly (keyof Row)[]): Row[] => {
  const rows: Row[] = [];
  for (const [key, row] of next) {
    const old = previous.get(key);
    rows.push(old === undefined ? row : { ...row, ...Object.fromEntries(fields.map((field) => [field, Number(row[field]) - Number(old[field])])) });
  }
  for (const [key, old] of previous) if (!next.has(key)) rows.push({ ...old, ...Object.fromEntries(fields.map((field) => [field, -Number(old[field])])) });
  return rows.filter((row) => fields.some((field) => Number(row[field]) !== 0));
};

const CELL_FIELDS: readonly (keyof CellRow)[] = ['sessions', 'ok', 'failed', 'tokens', 'durationMs'];
const STRATUM_FIELDS: readonly (keyof StratumRow)[] = ['sessions'];

/** The row an account holds under this id: the mark of the write that set it, and the increments that write made, or none when the stored skeleton no longer parses (see `previousOf`). */
export interface Previous {
  ingest: string;
  increments: Increments | undefined;
}

/**
 * The batch an account sent under this id before, or none. A stored row that no longer parses gives no increments to take back, but its increments are still in the cells (they are
 * not derived again on a read), so a resend over it adds the whole batch a second time: a limit the stored form has until the ledger is rebuilt by a later change.
 */
export const previousOf = async (env: Env, account: string, id: string): Promise<Previous | undefined> => {
  const held = await env.DB.prepare('SELECT skeleton, ingest FROM deposits WHERE account = ? AND id = ?').bind(account, id).first();
  const text = fieldOf(held, 'skeleton');
  const ingest = fieldOf(held, 'ingest');
  if (typeof text !== 'string' || typeof ingest !== 'string') return undefined;
  try {
    const parsed = parseSkeleton(JSON.parse(text));
    return { ingest, increments: parsed.ok ? incrementsOf(parsed.skeleton) : undefined };
  } catch {
    return { ingest, increments: undefined };
  }
};

/** The mark of the write that set the row an account holds under this id, or none. It reads the mark alone: `previousOf` parses the held skeleton and derives its whole batch, which a refusal never uses. */
export const markOf = async (env: Env, account: string, id: string): Promise<string | undefined> => {
  const held = await env.DB.prepare('SELECT ingest FROM deposits WHERE account = ? AND id = ?').bind(account, id).first();
  const ingest = fieldOf(held, 'ingest');
  return typeof ingest === 'string' ? ingest : undefined;
};

/** The cells a write of `next` over `previous` changes: how many increments ingest writes, which is none for a batch sent again unchanged. */
export const netCellCount = (next: Increments, previous: Increments | undefined): number => netOf(next.cells, previous?.cells ?? new Map<string, CellRow>(), CELL_FIELDS).length;

/** What D1 takes as one bound value is 2 MB (`worker.ts`), so a payload goes in chunks of at most half that. */
const CHUNK_BYTES = 1024 * 1024;

/** `items` as JSON arrays of at most `limit` bytes each, in order; one item over the limit gets an array of its own. */
export const chunksOf = (items: readonly unknown[], limit = CHUNK_BYTES): string[] => {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let held: string[] = [];
  let size = 2;
  for (const item of items) {
    const text = JSON.stringify(item);
    // One comma per item; the last is spare, so a chunk only ever comes in under the limit.
    const bytes = encoder.encode(text).length + 1;
    if (size + bytes > limit && held.length > 0) {
      chunks.push(`[${held.join(',')}]`);
      held = [];
      size = 2;
    }
    held.push(text);
    size += bytes;
  }
  if (held.length > 0) chunks.push(`[${held.join(',')}]`);
  return chunks;
};

const GUARD = 'EXISTS (SELECT 1 FROM deposits WHERE account = ? AND id = ? AND ingest = ?)';

/**
 * The statements that write one batch's increments, to run after the deposit's own row in the same transaction. Each carries the guard, so none takes effect unless that row did.
 * A session sent again replaces its earlier batch: only the difference is added. A cell's cluster count rises only for an account with no record for it, on any day.
 */
export const incrementStatements = (env: Env, account: string, id: string, ingest: string, today: string, next: Increments, previous: Increments | undefined): Bound[] => {
  const cells = netOf(next.cells, previous?.cells ?? new Map<string, CellRow>(), CELL_FIELDS);
  const strata = netOf(next.strata, previous?.strata ?? new Map<string, StratumRow>(), STRATUM_FIELDS);
  const guard = [account, id, ingest] as const;
  const statements: Bound[] = [];
  // One statement per chunk, all in the one batch under the one guard: a large batch of varied steps runs its cell JSON to about four times its skeleton, and D1 refuses a bound value over 2 MB.
  for (const chunk of chunksOf(cells)) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO cells (key, harness_bucket, motif_id, frame_bucket, day, exposed, sessions, ok, failed, tokens, duration_ms) SELECT json_extract(value, '$.key'), json_extract(value, '$.harnessBucket'), json_extract(value, '$.motifId'), json_extract(value, '$.frameBucket'), json_extract(value, '$.day'), json_extract(value, '$.exposed'), json_extract(value, '$.sessions'), json_extract(value, '$.ok'), json_extract(value, '$.failed'), json_extract(value, '$.tokens'), json_extract(value, '$.durationMs') FROM json_each(?) WHERE ${GUARD} ON CONFLICT (key) DO UPDATE SET sessions = cells.sessions + excluded.sessions, ok = cells.ok + excluded.ok, failed = cells.failed + excluded.failed, tokens = cells.tokens + excluded.tokens, duration_ms = cells.duration_ms + excluded.duration_ms`,
      ).bind(chunk, ...guard),
    );
  }
  for (const chunk of chunksOf(next.motifs)) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO motifs (motif_id, motif) SELECT json_extract(value, '$.motifId'), value FROM json_each(?) WHERE ${GUARD}`).bind(chunk, ...guard));
  }
  // A chunk's keys are its own: the cluster count of a key reads the record before this chunk writes it, and no other chunk writes that key's record.
  for (const keys of chunksOf([...next.cells.keys()])) {
    statements.push(
      env.DB.prepare(`UPDATE cells SET clusters = clusters + 1 WHERE key IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM contributors WHERE contributors.kind = 'cell' AND contributors.key = cells.key AND contributors.account = ?) AND ${GUARD}`).bind(keys, account, ...guard),
      env.DB.prepare(`INSERT OR IGNORE INTO contributors (kind, key, account, day) SELECT 'cell', value, ?, ? FROM json_each(?) WHERE ${GUARD}`).bind(account, today, keys, ...guard),
    );
  }
  for (const chunk of chunksOf(strata)) {
    statements.push(
      env.DB.prepare(`INSERT INTO strata (key, dimension, value, sessions) SELECT json_extract(value, '$.key'), json_extract(value, '$.dimension'), json_extract(value, '$.value'), json_extract(value, '$.sessions') FROM json_each(?) WHERE ${GUARD} ON CONFLICT (key) DO UPDATE SET sessions = strata.sessions + excluded.sessions`).bind(chunk, ...guard),
    );
  }
  for (const keys of chunksOf([...next.strata.keys()])) {
    statements.push(
      env.DB.prepare(`UPDATE strata SET clusters = clusters + 1 WHERE key IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM contributors WHERE contributors.kind = 'stratum' AND contributors.key = strata.key AND contributors.account = ?) AND ${GUARD}`).bind(keys, account, ...guard),
      env.DB.prepare(`INSERT OR IGNORE INTO contributors (kind, key, account, day) SELECT 'stratum', value, ?, ? FROM json_each(?) WHERE ${GUARD}`).bind(account, today, keys, ...guard),
    );
  }
  return statements;
};
