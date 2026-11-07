// What recall answers from beside the local store: the kept bundle for the session's own harness and version (t926). The bundle's served cells and reads come first, and the
// local pool's follow, so a family the pool serves for this setup answers from the commons and one it does not answers from this machine. Only cells and reads reach the agent.
import type { Cell, Pool } from './cells.js';
import type { Motif } from './motif.js';
import { sessionBundle, type Setup } from './pool-replica.js';
import type { Bundle } from './pool-wire.js';
import type { Read } from './read.js';
import type { CurrentPool } from './recall-pool.js';
import { harnessOf } from './schema.js';
import type { Store } from './store.js';

/** The setup of the store's newest call that states a version: what a pull made outside a hook (the CLI, the MCP tool) is asked from. Undefined for a store with none. */
export const storeSetup = (store: Pick<Store, 'sessions' | 'tools'>): Setup | undefined => {
  const harnesses = new Map(store.sessions.map((session) => [session.session, harnessOf(session)]));
  let newest: { ts: string; setup: Setup } | undefined;
  for (const call of store.tools) {
    if (call.harnessVersion === null || call.ts === null || (newest !== undefined && call.ts <= newest.ts)) continue;
    newest = { ts: call.ts, setup: { harness: harnesses.get(call.session) ?? 'claude-code', harnessVersion: call.harnessVersion } };
  }
  return newest?.setup;
};

/** A verified bundle as a pool: its served cells, motifs, and reads, as of the pool snapshot it was signed from. */
export const bundlePool = (bundle: Bundle): CurrentPool => ({
  pool: { cells: bundle.cells, motifs: new Map(bundle.motifs.map((motif) => [motif.motifId, motif])), version: bundle.asOf.pool, lastDay: bundle.asOf.day },
  reads: bundle.reads,
});

/** The bundle's pool first, then the local one; either alone when the other is absent. */
export const withBundle = (local: CurrentPool | undefined, bundle: Bundle | undefined): CurrentPool | undefined => {
  if (bundle === undefined) return local;
  const kept = bundlePool(bundle);
  if (local === undefined) return kept;
  const motifs = new Map<string, Motif>([...local.pool.motifs, ...kept.pool.motifs]);
  const cells: Cell[] = [...kept.pool.cells, ...local.pool.cells];
  const pool: Pool = { cells, motifs, version: local.pool.version, lastDay: local.pool.lastDay };
  const reads: Read[] = [...kept.reads, ...local.reads];
  return { pool, reads };
};

/** The pool a pull answers from: the local one `served` gives, with the kept bundle for the store's own setup ahead of it. */
export const recallPool = async (storeDir: string, store: Store, served: (storeDir: string, store: Store) => Promise<CurrentPool | undefined>): Promise<CurrentPool | undefined> =>
  withBundle(await served(storeDir, store), await sessionBundle(storeDir, storeSetup(store)));
