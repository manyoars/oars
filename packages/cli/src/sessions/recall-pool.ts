// What ties a recall's answer to the stored read of the current pool (t757, fix round). A store-wide count answers the asker, and the read it rests on is what `lineage` can
// walk, so each answer carries that read's ID. Without a stored read for it, an answer keeps its stand-in hash, which `lineage` reports as evidence with no further hop.
import { bucketFields, cellIdOf, UNKNOWN, type Cell, type Pool } from './cells.js';
import { motifName, type Motif } from './motif.js';
import type { Read } from './read.js';
import type { RecallRead } from './recall-reads.js';

export interface CurrentPool {
  pool: Pool;
  reads: readonly Read[];
}

/** The stand-in hash a stored read answers for: a recovery read's signature hash and a call-shape read's shape are the values `recall-reads.ts` computes from the store. */
const standInOf = (read: Read): string | undefined => {
  if (read.family === 'recovery') return read.slice.sig;
  return read.family === 'fit' ? read.slice.shape : undefined;
};

const keyOf = (family: string, standIn: string): string => `${family}/${standIn}`;

/** Each answer under its stored read's ID, where the pool holds one. */
export const resolveReads = (reads: readonly RecallRead[], stored: readonly Read[]): RecallRead[] => {
  const ids = new Map(
    stored.flatMap((read): Array<[string, string]> => {
      const standIn = standInOf(read);
      return standIn === undefined ? [] : [[keyOf(read.family, standIn), read.readId]];
    }),
  );
  return reads.map((read) => ({ ...read, readId: ids.get(keyOf(read.family, read.readId)) ?? read.readId }));
};

const countIn = (value: unknown): number => (typeof value === 'number' ? value : 0);

const nextOf = (read: Read): Array<[string, number]> => {
  const { next } = read.value;
  if (typeof next !== 'object' || next === null) return [];
  return Object.entries(next).sort(([a, one], [b, two]) => two - one || a.localeCompare(b));
};

const FOLLOWED = 3;

const presentOf = (values: readonly string[]): string[] => [...new Set(values.filter((value) => value !== UNKNOWN && value !== ''))].sort();

/** A stored read as an answer. Its evidence's frames and days come from the cells it cites; a daily session count cannot be summed, so `n` is the floor those cells prove. */
const answerOfStored = (read: Read, cells: ReadonlyMap<string, Cell>): RecallRead => {
  const cited = read.inputs.flatMap((input) => cells.get(input) ?? []);
  const frames = cited.map((cell) => bucketFields(cell.frameBucket));
  const days = presentOf(cited.map((cell) => cell.day));
  const isRate = read.family === 'fit';
  const failed = countIn(read.value.failed);
  return {
    readId: read.readId,
    family: read.family,
    tool: read.slice.motif ?? read.slice.prefix ?? read.slice.class ?? read.slice.action ?? read.family,
    keys: [],
    n: cited.reduce((highest, cell) => Math.max(highest, cell.sessions), 0),
    count: isRate ? failed : read.n,
    calls: isRate ? failed + countIn(read.value.ok) : null,
    clusters: read.clusters,
    firstDay: days[0] ?? null,
    lastDay: days[days.length - 1] ?? null,
    harnesses: presentOf(frames.map((frame) => frame.harness)),
    harnessVersions: [],
    models: presentOf(frames.map((frame) => frame.model)),
    followed: nextOf(read).slice(0, FOLLOWED),
  };
};

/** A pull can answer an agent, and an experimental read goes to no agent (`docs/sessions-store.md`), so a recall never serves one; `oars sessions read` still prints it. */
const isServed = (read: Read): boolean => read.value.label !== 'experimental';

const cellsOf = (pool: Pool): Map<string, Cell> => new Map(pool.cells.map((cell) => [cellIdOf(cell), cell]));

const ranked = (reads: readonly RecallRead[]): RecallRead[] => [...reads].sort((a, b) => b.n - a.n || b.count - a.count || a.readId.localeCompare(b.readId));

/** The answers to a question about a family only the pool holds, best first. */
export const readsOfFamily = (family: string, current: CurrentPool): RecallRead[] => {
  const cells = cellsOf(current.pool);
  return ranked(current.reads.filter((read) => read.family === family && isServed(read)).map((read) => answerOfStored(read, cells)));
};

const ofMotif = (motif: Motif, reads: readonly Read[]): Read[] => {
  const name = motifName(motif);
  return reads.filter((read) => (read.family === 'fit' && read.slice.motif === name && read.slice.level === motif.level) || (read.family === 'next-step' && motif.level === 'shape' && read.slice.prefix === name));
};

/**
 * What a prefix names in the pool: a stored read by its ID, or a motif by its ID. A stored read with a stand-in goes back through it, because the store's own counts answer those;
 * `standIns` holds those hashes for the caller to match, and `reads` every other answer.
 */
export const namedByPrefix = (prefix: readonly string[], current: CurrentPool): { standIns: string[]; reads: RecallRead[] } => {
  const named = new Set<Read>();
  for (const id of prefix) {
    for (const read of current.reads) if (read.readId === id && isServed(read)) named.add(read);
    const motif = current.pool.motifs.get(id);
    if (motif !== undefined) for (const read of ofMotif(motif, current.reads)) named.add(read);
  }
  const cells = cellsOf(current.pool);
  const standIns: string[] = [];
  const reads: RecallRead[] = [];
  for (const read of named) {
    const standIn = standInOf(read);
    if (standIn === undefined) reads.push(answerOfStored(read, cells));
    else standIns.push(standIn);
  }
  return { standIns, reads: ranked(reads) };
};
