// The derive pass over cells: motifs and cells from the store, each family's reads from those, and the files they are kept in. `cells.jsonl` and `motifs.jsonl` are
// rewritten from the log and can be dropped at any time. Each pool version's reads go in a file of their own that is written once and never rewritten, so a read cited by
// its ID stays what it was.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { CliError, ExitCode } from '../errors.js';
import { poolOf, UNKNOWN, type Cell, type Pool } from './cells.js';
import type { Motif } from './motif.js';
import { LOAD_STATUS_FILE, loadStatusLines } from './load-status.js';
import { contentHash, FIRST_ORDER_FAMILIES, frozenRead, makeRead, orderResolver, type FirstOrderFamily, type OrderResolver, type Read, type ReadAsOf } from './read.js';
import { readRecalls } from './recall-object.js';
import { deriveAdoption } from './read-adoption.js';
import { deriveCallShape } from './read-call-shape.js';
import { deriveChange } from './read-change.js';
import { deriveCost } from './read-cost.js';
import { deriveFit, deriveFitShape } from './read-fit.js';
import { deriveLive } from './read-live.js';
import { deriveMethod } from './read-method.js';
import { deriveNextStep } from './read-next-step.js';
import { deriveRecovery } from './read-recovery.js';
import { deriveToolDay } from './read-tool-day.js';
import type { DeriveRelation } from './read-order.js';
import type { DeriveFamily, ReadBody } from './read-support.js';
import { poolFoldsOf, type PoolFolds } from './pool-fold.js';
import type { ReadFolds } from './read-folds.js';
import { deriveDayMove } from './read-day-move.js';
import { deriveInteraction } from './read-interaction.js';
import { deriveLeadLag } from './read-lead-lag.js';
import { deriveSubstitution } from './read-substitution.js';
import { deriveVersionBoundary } from './read-version-boundary.js';
import { writeAtomic, type Store } from './store.js';

// Built on call.
const derivers = (): { readonly [family in FirstOrderFamily]: DeriveFamily } => ({
  recovery: deriveRecovery,
  fit: (input) => [...deriveFit(input), ...deriveFitShape(input), ...deriveCallShape(input)],
  cost: deriveCost,
  change: deriveChange,
  live: deriveLive,
  adoption: deriveAdoption,
  method: deriveMethod,
  'next-step': deriveNextStep,
  'tool-day': deriveToolDay,
});

/** Families over reads, one stage per order: a stage reads what the stages before it wrote. Built on call. */
const relations = (): readonly (readonly DeriveRelation[])[] => [[deriveVersionBoundary, deriveSubstitution, deriveInteraction, deriveDayMove], [deriveLeadLag]];

export const poolFiles = (storeDir: string): { cells: string; motifs: string; consequences: string; reads: (version: string) => string } => ({
  cells: join(storeDir, 'cells.jsonl'),
  consequences: join(storeDir, 'consequences.jsonl'),
  motifs: join(storeDir, 'motifs.jsonl'),
  reads: (version) => join(storeDir, 'reads', `${version}.jsonl`),
});

const made = (bodies: readonly ReadBody[], asOf: ReadAsOf, orderOf: OrderResolver): Read[] =>
  bodies
    .map((body) => makeRead({ ...body, asOf }, orderOf))
    .map((read) => ({ read, key: contentHash(read.slice) }))
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map(({ read }) => read);

/** Every family's order 1 reads of one pool, in family order and then by slice, so a rerun writes the same bytes. */
export const deriveFirstOrder = (pool: Pool, store: Store, folds?: ReadFolds): Read[] => {
  const asOf = { pool: pool.version, day: pool.lastDay };
  const orderOf = orderResolver([]);
  const byFamily = derivers();
  return FIRST_ORDER_FAMILIES.flatMap((family) => made(byFamily[family]({ pool, store, ...(folds === undefined ? {} : { folds }) }), asOf, orderOf));
};

/** Order 1, then each stage of `relations` over everything before it. One list grows stage by stage: a stage's reads join it after the whole stage has read it, so no stage sees its own. */
export const deriveReads = (pool: Pool, store: Store, folds?: ReadFolds): Read[] => {
  const asOf = { pool: pool.version, day: pool.lastDay };
  const known = deriveFirstOrder(pool, store, folds);
  for (const stage of relations()) {
    const orderOf = orderResolver(known);
    const found = stage.flatMap((derive) => made(derive(known), asOf, orderOf));
    for (const read of found) known.push(read);
  }
  return known;
};

const isRead = (value: unknown): value is Read => typeof value === 'object' && value !== null && 'readId' in value && 'family' in value;
const isCell = (value: unknown): value is Cell => typeof value === 'object' && value !== null && 'motifId' in value && 'frameBucket' in value && 'grain' in value;
const isMotif = (value: unknown): value is Motif => typeof value === 'object' && value !== null && 'motifId' in value && 'level' in value;

const parsedLine = (file: string, line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    throw new CliError(`${file} holds a line that is not JSON. Delete that file and run this again: its reads are derived from the store.`, ExitCode.UNEXPECTED, 'read');
  }
};

/** The lines of a file, one at a time as its chunks arrive: a line that spans two chunks is joined, and a character cut by a chunk boundary is decoded whole. The last line is yielded even when nothing ends it. */
const linesOf = async function* (file: string): AsyncGenerator<string> {
  let rest = '';
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    const lines = (rest + String(chunk)).split('\n');
    rest = lines.pop() ?? '';
    yield* lines;
  }
  yield rest;
};

/**
 * A file that is missing, or whose lines are JSON but not all of the kind asked for, is no record of this pool: it is derived and written again. A line that is not JSON is damage, so it stops here and asks the operator to delete that
 * file. The file is read a line at a time and its rows kept as they are parsed, never as one string of the whole file with its split lines beside them (t1403's synthetic `cells.jsonl` is 284 MB). After a row of the wrong kind
 * the rest is still parsed, only so that a line that is not JSON is found wherever it is, and the rows kept so far are let go.
 */
const storedRows = async <Row>(file: string, isRow: (value: unknown) => value is Row): Promise<Row[] | undefined> => {
  try {
    let rows: Row[] | undefined = [];
    for await (const line of linesOf(file)) {
      if (line === '') continue;
      const parsed = parsedLine(file, line);
      if (rows === undefined) continue;
      if (isRow(parsed)) rows.push(parsed);
      else rows = undefined;
    }
    return rows;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
};

const readStored = async (file: string): Promise<Read[] | undefined> => (await storedRows(file, isRead))?.map(frozenRead);

/** Text is handed to the disk in pieces of at least this many characters, cut at line ends. */
const PIECE = 64 * 1024;

/** The lines joined into pieces of at least `PIECE` characters (the last may be shorter), so a file is never one string. */
const piecesOf = function* (lines: Iterable<string>): Generator<string> {
  let piece = '';
  for (const line of lines) {
    piece += line;
    if (piece.length >= PIECE) {
      yield piece;
      piece = '';
    }
  }
  if (piece !== '') yield piece;
};

/** What `writeAtomic` does (a private temp file, then a rename, so a reader sees the old file or the new one), for lines written piece by piece with the stream's backpressure honored. */
const writeLines = async (file: string, lines: Iterable<string>): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${String(process.pid)}.tmp`;
  await pipeline(piecesOf(lines), createWriteStream(temp, { mode: 0o600 }));
  await rename(temp, file);
};

const jsonLines = function* (rows: Iterable<unknown>): Generator<string> {
  for (const row of rows) yield `${JSON.stringify(row)}\n`;
};

/** `cells.jsonl`: one JSON line a cell, the bytes `serializeCells` makes, written in pieces (t1403's synthetic 284 MB file: one string of it held about 1,000 MB more than the cells). */
export const writeCells = (file: string, cells: readonly Cell[]): Promise<void> => writeLines(file, jsonLines(cells));

/** A pool version's reads file: one JSON line a read, in derived order, written in pieces as `cells.jsonl` is, never as one string of the whole file. */
export const writeReads = (file: string, reads: readonly Read[]): Promise<void> => writeLines(file, jsonLines(reads));

/**
 * The current pool's reads: already written when this pool has been read before, else derived and written once. `store` holds the sessions, subagents, and errors; the rows of every turn are read through
 * `folds`, which a refresh folds run by run. Without them `store` is taken whole, with its prompts and tools, and folded as one run.
 */
export const refreshPool = async (storeDir: string, store: Store, folds?: PoolFolds): Promise<{ pool: Pool; reads: Read[] }> => {
  const { recalls, cells: set, reads: readFolds } = folds ?? poolFoldsOf(await readRecalls(storeDir), store);
  const pool = poolOf(set, store.errors);
  const files = poolFiles(storeDir);
  await writeAtomic(files.consequences, recalls.flatMap(({ id, n, consequence }) => (consequence === undefined ? [] : [`${JSON.stringify({ id, n, consequence })}\n`])).join(''));
  await writeAtomic(join(storeDir, LOAD_STATUS_FILE), await loadStatusLines(storeDir, store.sessions));
  await writeCells(files.cells, set.cells);
  await writeLines(files.motifs, jsonLines(set.motifs));
  const file = files.reads(pool.version);
  const stored = await readStored(file);
  if (stored !== undefined) return { pool, reads: stored };
  const reads = deriveReads(pool, store, readFolds);
  await writeReads(file, reads);
  return { pool, reads };
};

const POOL_FAILED = 'oars: the read pool was not built, and answers keep their stand-ins: ';

const unbuilt = (error: unknown): void => {
  process.stderr.write(`${POOL_FAILED}${error instanceof Error ? error.message : String(error)}\n`);
};

/**
 * The pool a deposit's index step reads. It answers without one (spec 2.7): a pool that cannot be read or written costs only the stored read IDs, whose answers keep their stand-ins, and one line on stderr says so.
 * `failed` hears the failure too, so the step log can record it (the nightly's stderr goes nowhere).
 */
export const currentPool = async (storeDir: string, store: Store, folds?: PoolFolds | Error, failed: (error: unknown) => void = () => undefined): Promise<{ pool: Pool; reads: Read[] } | undefined> => {
  try {
    if (folds instanceof Error) throw folds;
    return await refreshPool(storeDir, store, folds);
  } catch (error) {
    unbuilt(error);
    failed(error);
    return undefined;
  }
};

/** The reads file written last: a deposit writes one per new pool version and nothing prunes them, so the newest by time is the pool the last deposit left. */
const newestReadsFile = async (dir: string): Promise<string | undefined> => {
  try {
    const names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
    const stamped = await Promise.all(names.map(async (name) => ({ file: join(dir, name), at: (await stat(join(dir, name))).mtimeMs })));
    return stamped.sort((a, b) => b.at - a.at || (a.file < b.file ? -1 : 1))[0]?.file;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
};

/** The newest stored pool as the files hold it, or undefined when a file of it is missing. A damaged file throws. */
const storedPool = async (storeDir: string): Promise<{ pool: Pool; reads: Read[] } | undefined> => {
  const files = poolFiles(storeDir);
  const file = await newestReadsFile(dirname(files.reads('any')));
  const reads = file === undefined ? undefined : await readStored(file);
  const cells = await storedRows(files.cells, isCell);
  const motifs = await storedRows(files.motifs, isMotif);
  if (file === undefined || reads === undefined || cells === undefined || motifs === undefined) return undefined;
  const lastDay = cells.reduce<string | null>((last, cell) => (cell.day !== UNKNOWN && (last === null || cell.day > last) ? cell.day : last), null);
  return { pool: { cells, motifs: new Map(motifs.map((motif) => [motif.motifId, motif])), version: basename(file, '.jsonl'), lastDay }, reads };
};

/**
 * The pool a pull answers from: the newest one already stored, with nothing derived or written. A pull used to refresh the pool, and a deposit that moved it left the next pull to
 * derive every read again (12 to 17 s on a real store) and write a file nothing prunes. Only a store with no stored pool derives one, once, and a stored one is read after that.
 */
export const servedPool = async (storeDir: string, store: Store): Promise<{ pool: Pool; reads: Read[] } | undefined> => {
  try {
    return (await storedPool(storeDir)) ?? (await refreshPool(storeDir, store));
  } catch (error) {
    unbuilt(error);
    return undefined;
  }
};
