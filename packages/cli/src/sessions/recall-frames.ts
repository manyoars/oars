// The local half of a next-node read, in the asker's frame (t926 Item 9). The pool's next-step and recovery reads sum every harness and version a store holds, so a table built from
// them would tell a Codex session what Claude Code sessions did. This derives the two families again over the cells of each harness and version bucket, once per deposit, and the
// hook index keeps the result by frame key; a hook then reads the one entry for the session it serves. It is its own module because the families it imports are the pool's,
// which a lookup hook must not load (the index step imports this one lazily, as it does `pool.js`).
import { bucketFields, type Pool } from './cells.js';
import { makeRead, orderResolver, type Read } from './read.js';
import { deriveNextStep } from './read-next-step.js';
import { deriveRecoveryEdges } from './read-recovery-edge.js';
import { positionsOf, recoveryEdgesOf, type Position, type RecoveryEdges } from './recall-next.js';
import type { Store } from './store.js';

/** The positions one frame keeps: a table prints at most eight, so twelve leaves room for the bundle's to rank ahead without carrying every position a store has. */
export const PER_FRAME_POSITIONS = 12;

export interface NextByFrame {
  recovery: { [frame: string]: RecoveryEdges };
  positions: { [frame: string]: Position[] };
}

const readsOf = (pool: Pool, store: Store): Read[] => {
  const asOf = { pool: pool.version, day: pool.lastDay };
  const orderOf = orderResolver([]);
  return [...deriveNextStep({ pool, store }), ...deriveRecoveryEdges({ pool, store })].map((body) => makeRead({ ...body, asOf }, orderOf));
};

/**
 * The recovery edges and split positions for each harness (key `<harness>/*`, for a session whose version is not stated) and each harness version bucket (`<harness>/<bucket>`).
 * Every recovery key is kept, a below-floor one included, so a hook can tell "a cell, too thin to serve" from "no cell".
 */
export const nextByFrame = (pool: Pool, store: Store): NextByFrame => {
  const frames = new Map<string, Set<string>>();
  for (const cell of pool.cells) {
    if (cell.frameBucket.startsWith('env:')) continue;
    const { harness, harnessBucket } = bucketFields(cell.frameBucket);
    for (const key of [`${harness}/*`, `${harness}/${harnessBucket}`]) {
      const buckets = frames.get(key) ?? new Set<string>();
      frames.set(key, buckets);
      buckets.add(cell.frameBucket);
    }
  }
  const out: NextByFrame = { recovery: {}, positions: {} };
  for (const [key, buckets] of frames) {
    const reads = readsOf({ ...pool, cells: pool.cells.filter((cell) => buckets.has(cell.frameBucket)) }, store);
    const recovery = recoveryEdgesOf(reads);
    const positions = positionsOf(reads).slice(0, PER_FRAME_POSITIONS);
    if (Object.keys(recovery).length > 0) out.recovery[key] = recovery;
    if (positions.length > 0) out.positions[key] = positions;
  }
  return out;
};
