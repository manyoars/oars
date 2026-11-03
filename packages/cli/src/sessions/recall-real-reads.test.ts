import { afterEach, describe, expect, it } from 'vitest';
import { buildIndex } from './hook-index.js';
import { walkLineage } from './lineage.js';
import { frame, poolFrom, prompt as promptRow, session as sessionRow, store as storeOf, tool as toolRow } from './pool-fixture.js';
import { deriveReads } from './pool.js';
import { shapeMotif } from './motif.js';
import { fitReads, pull, toolShapeId } from './recall-reads.js';
import { error as errorRow } from './pool-fixture.js';
import type { Store } from './store.js';
import { cleanup, NOW } from './test-support.js';

afterEach(cleanup);

/** Three sessions over the fit floors for one call shape, with one signature in two of them. */
const stocked = (): Store => {
  const sessions = ['a', 'b', 'c'];
  return storeOf({
    sessions: sessions.map((id) => sessionRow(id, { at: '2026-06-02T00:00:00.000Z' })),
    prompts: sessions.map((id) => promptRow(id, 0, { frame: frame({ day: '2026-06-01' }) })),
    errors: ['a', 'b'].map((id) => errorRow(id, 'Monitor | wrong input', { tool: 'Monitor', ts: '2026-06-01T00:00:00.000Z' })),
    tools: sessions.flatMap((id) => Array.from({ length: 10 }, (_, n) => toolRow(id, n, 'Monitor', { keys: ['query'], status: n === 0 ? 'error' : 'ok', ts: '2026-06-01T00:00:00.000Z' }))),
  });
};

const currentOf = (store: Store) => {
  const pool = poolFrom(store);
  return { pool, reads: deriveReads(pool, store) };
};

describe('a recall cites the stored read of the current pool', () => {
  it('stores one fit read per call shape over the floors, naming the shape', () => {
    const store = stocked();
    const { reads } = currentOf(store);
    const stored = reads.filter((read) => read.slice.shape === toolShapeId('Monitor', ['query']));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ family: 'fit', method: 'call-shape', order: 1, value: { failed: 3, calls: 30 } });
    expect(fitReads(store)).toHaveLength(1);
  });

  it('answers recovery and fit with stored read IDs, and walks a pull through read to cell', () => {
    const store = stocked();
    const current = currentOf(store);
    const asked = { sid: null, now: NOW, frame: null, harness: 'claude-code', current } as const;
    const fit = pull(store, { form: 'question', family: 'fit' }, asked).recall;
    const recovery = pull(store, { form: 'question', family: 'recovery' }, asked).recall;
    for (const recall of [fit, recovery]) {
      expect(recall.answer.reads[0]).toMatch(/^read:[0-9a-f]{16}$/);
      expect(recall.answer.rendered).toContain(`read ${String(recall.answer.reads[0])}`);
      const hops = walkLineage({ recalls: [recall], reads: current.reads, cells: [...current.pool.cells] }, recall.id);
      expect(hops.map(({ kind }) => kind).slice(0, 3)).toEqual(['recall', 'read', 'cell']);
    }
  });

  it('lets a prefix name a motif ID, a stored read ID, or a shape', () => {
    const store = stocked();
    const current = currentOf(store);
    const asked = { sid: null, now: NOW, frame: null, harness: 'claude-code', current } as const;
    const motifId = shapeMotif([{ action: 'other', identity: null }]).motifId;
    const byMotif = pull(store, { form: 'pattern', prefix: [motifId] }, asked).recall;
    expect(byMotif.answer.kind).toBe('hit');
    expect(byMotif.answer.reads[0]).toMatch(/^read:/);
    const shape = toolShapeId('Monitor', ['query']);
    const byShape = pull(store, { form: 'pattern', prefix: [shape] }, asked).recall;
    expect(byShape.answer.reads).toHaveLength(1);
    expect(pull(store, { form: 'pattern', prefix: byShape.answer.reads }, asked).recall.answer.reads).toEqual(byShape.answer.reads);
  });

  it('carries the stored read ID in the index, keyed by the shape a hook can compute', () => {
    const store = stocked();
    const { reads } = currentOf(store);
    const index = buildIndex(store, [], '2026-06-02T00:00:00.000Z', reads);
    expect(index.fit?.[toolShapeId('Monitor', ['query'])]?.readId).toMatch(/^read:/);
  });

  it('keeps the stand-in when the pool holds no read for it', () => {
    const store = stocked();
    const recall = pull(store, { form: 'question', family: 'fit' }, { sid: null, now: NOW, frame: null, harness: 'claude-code' }).recall;
    expect(recall.answer.reads).toEqual([toolShapeId('Monitor', ['query'])]);
  });
});
