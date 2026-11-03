// The derive pass over cells (t756): motifs and cells from the store, each family's reads from those, and the files they are kept in. `cells.jsonl` and `motifs.jsonl` are
// rewritten from the log and can be dropped at any time. Each pool version's reads go in a file of their own that is written once and never rewritten, so a read cited by
// its ID stays what it was.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError, ExitCode } from '../errors.js';
import { deriveCells, poolOf, serializeCells, type Pool } from './cells.js';
import { contentHash, FIRST_ORDER_FAMILIES, frozenRead, makeRead, orderResolver, type FirstOrderFamily, type OrderResolver, type Read, type ReadAsOf } from './read.js';
import { deriveConsequences, recallGraphOf } from './recall-consequence.js';
import { readRecalls } from './recall-object.js';
import { deriveAdoption } from './read-adoption.js';
import { deriveCallShape } from './read-call-shape.js';
import { deriveChange } from './read-change.js';
import { deriveCost } from './read-cost.js';
import { deriveFit } from './read-fit.js';
import { deriveLive } from './read-live.js';
import { deriveMethod } from './read-method.js';
import { deriveNextStep } from './read-next-step.js';
import { deriveRecovery } from './read-recovery.js';
import { deriveToolDay } from './read-tool-day.js';
import type { DeriveRelation } from './read-order.js';
import type { DeriveFamily, ReadBody } from './read-support.js';
import { deriveDayMove } from './read-day-move.js';
import { deriveInteraction } from './read-interaction.js';
import { deriveLeadLag } from './read-lead-lag.js';
import { deriveSubstitution } from './read-substitution.js';
import { deriveVersionBoundary } from './read-version-boundary.js';
import { writeAtomic, type Store } from './store.js';

// Built on call: `store.ts` imports this file for its refresh and `read-recovery.ts` imports `store.ts`, so these names may not be initialized yet when this module's top level runs.
const derivers = (): { readonly [family in FirstOrderFamily]: DeriveFamily } => ({
  recovery: deriveRecovery,
  fit: (input) => [...deriveFit(input), ...deriveCallShape(input)],
  cost: deriveCost,
  change: deriveChange,
  live: deriveLive,
  adoption: deriveAdoption,
  method: deriveMethod,
  'next-step': deriveNextStep,
  'tool-day': deriveToolDay,
});

/** Families over reads, one stage per order: a stage reads what the stages before it wrote. Built on call, for the same reason as `derivers`. */
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
export const deriveFirstOrder = (pool: Pool, store: Store): Read[] => {
  const asOf = { pool: pool.version, day: pool.lastDay };
  const orderOf = orderResolver([]);
  const byFamily = derivers();
  return FIRST_ORDER_FAMILIES.flatMap((family) => made(byFamily[family]({ pool, store }), asOf, orderOf));
};

/** Order 1, then each stage of `relations` over everything before it. */
export const deriveReads = (pool: Pool, store: Store): Read[] => {
  const asOf = { pool: pool.version, day: pool.lastDay };
  return relations().reduce<Read[]>((known, stage) => {
    const orderOf = orderResolver(known);
    return [...known, ...stage.flatMap((derive) => made(derive(known), asOf, orderOf))];
  }, deriveFirstOrder(pool, store));
};

export const serializeReads = (reads: readonly Read[]): string => reads.map((read) => `${JSON.stringify(read)}\n`).join('');

const isRead = (value: unknown): value is Read => typeof value === 'object' && value !== null && 'readId' in value && 'family' in value;

const parsedLine = (file: string, line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    throw new CliError(`${file} holds a line that is not JSON. Delete that file and run this again: its reads are derived from the store.`, ExitCode.UNEXPECTED, 'read');
  }
};

/** A file that is missing, or whose lines are JSON but not reads, is no record of this pool: it is derived and written again. A line that is not JSON is damage, so it stops here and asks the operator to delete the file. */
const readStored = async (file: string): Promise<Read[] | undefined> => {
  try {
    const text = await readFile(file, 'utf8');
    const parsed = text.split('\n').flatMap((line): unknown[] => (line === '' ? [] : [parsedLine(file, line)]));
    return parsed.every(isRead) ? parsed.map(frozenRead) : undefined;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
};

/** The current pool's reads: already written when this pool has been read before, else derived and written once. */
export const refreshPool = async (storeDir: string, store: Store): Promise<{ pool: Pool; reads: Read[] }> => {
  const recalls = deriveConsequences(store, await readRecalls(storeDir));
  const set = deriveCells(store, recallGraphOf(store, recalls));
  const pool = poolOf(set, store.errors);
  const files = poolFiles(storeDir);
  await writeAtomic(files.consequences, recalls.flatMap(({ id, n, consequence }) => (consequence === undefined ? [] : [`${JSON.stringify({ id, n, consequence })}\n`])).join(''));
  await writeAtomic(files.cells, serializeCells(set.cells));
  await writeAtomic(files.motifs, set.motifs.map((motif) => `${JSON.stringify(motif)}\n`).join(''));
  const file = files.reads(pool.version);
  const stored = await readStored(file);
  if (stored !== undefined) return { pool, reads: stored };
  const reads = deriveReads(pool, store);
  await writeAtomic(file, serializeReads(reads));
  return { pool, reads };
};

/** The pool a pull answers from. A pull always answers (spec 2.7), so a pool that cannot be read or written costs it only the stored read IDs: its answers keep their stand-ins. */
export const currentPool = async (storeDir: string, store: Store): Promise<{ pool: Pool; reads: Read[] } | undefined> => {
  try {
    return await refreshPool(storeDir, store);
  } catch {
    return undefined;
  }
};
