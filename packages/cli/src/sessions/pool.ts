// The derive pass over cells (t756): motifs and cells from the store, each family's reads from those, and the files they are kept in. `cells.jsonl` and `motifs.jsonl` are
// rewritten from the log and can be dropped at any time. Each pool version's reads go in a file of their own that is written once and never rewritten, so a read cited by
// its ID stays what it was.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deriveCells, poolOf, serializeCells, type Pool } from './cells.js';
import { contentHash, FAMILIES, makeRead, orderResolver, type Family, type Read } from './read.js';
import { deriveAdoption } from './read-adoption.js';
import { deriveChange } from './read-change.js';
import { deriveCost } from './read-cost.js';
import { deriveFit } from './read-fit.js';
import { deriveLive } from './read-live.js';
import { deriveMethod } from './read-method.js';
import { deriveNextStep } from './read-next-step.js';
import { deriveRecovery } from './read-recovery.js';
import type { DeriveFamily } from './read-support.js';
import { writeAtomic, type Store } from './store.js';

const DERIVERS: { readonly [family in Family]: DeriveFamily } = {
  recovery: deriveRecovery,
  fit: deriveFit,
  cost: deriveCost,
  change: deriveChange,
  live: deriveLive,
  adoption: deriveAdoption,
  method: deriveMethod,
  'next-step': deriveNextStep,
};

export const poolFiles = (storeDir: string): { cells: string; motifs: string; reads: (version: string) => string } => ({
  cells: join(storeDir, 'cells.jsonl'),
  motifs: join(storeDir, 'motifs.jsonl'),
  reads: (version) => join(storeDir, 'reads', `${version}.jsonl`),
});

/** Every family's order-1 reads of one pool, in family order and then by slice, so a rerun writes the same bytes. */
export const deriveReads = (pool: Pool, store: Store): Read[] => {
  const asOf = { pool: pool.version, day: pool.lastDay };
  const orderOf = orderResolver([]);
  return FAMILIES.flatMap((family) =>
    DERIVERS[family]({ pool, store })
      .map((read) => makeRead({ ...read, asOf }, orderOf))
      .map((read) => ({ read, key: contentHash(read.slice) }))
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map(({ read }) => read),
  );
};

export const serializeReads = (reads: readonly Read[]): string => reads.map((read) => `${JSON.stringify(read)}\n`).join('');

const readStored = async (file: string): Promise<Read[] | undefined> => {
  try {
    const text = await readFile(file, 'utf8');
    return text.split('\n').flatMap((line) => (line === '' ? [] : [JSON.parse(line) as Read]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

/** The current pool's reads: already written when this pool has been read before, else derived and written once. */
export const refreshPool = async (storeDir: string, store: Store): Promise<{ pool: Pool; reads: Read[] }> => {
  const set = deriveCells(store);
  const pool = poolOf(set);
  const files = poolFiles(storeDir);
  await writeAtomic(files.cells, serializeCells(set.cells));
  await writeAtomic(files.motifs, set.motifs.map((motif) => `${JSON.stringify(motif)}\n`).join(''));
  const file = files.reads(pool.version);
  const stored = await readStored(file);
  if (stored !== undefined) return { pool, reads: stored };
  const reads = deriveReads(pool, store);
  await writeAtomic(file, serializeReads(reads));
  return { pool, reads };
};
