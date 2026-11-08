// The pool serves two floors by cell class: a `clear` cell (closed public vocabulary and client hashes only) at `CLEAR_FLOOR`, a `thresholded` one (any long-tail part) at `PUBLIC_FLOOR`. The class of a version cell is read by `bundle.test.ts`
// and `cell-class.test.ts`; here are the cells that count accounts (a fresh account against a clear and a thresholded name) and the rule that decides whether a version-free environment total is served beside its parts.
import { describe, expect, it } from 'vitest';
import { ENVIRONMENT_BUCKET, type Cell } from '../../cli/src/sessions/cells.js';
import type { Motif } from '../../cli/src/sessions/motif.js';
import { verifyBundle, VOCAB_VERSION } from '../../cli/src/sessions/pool-wire.js';
import { floorsOf } from './floors.js';
import { sampleSkeleton } from './sample.js';
import { environmentOf, type Held } from './stored.js';
import { fieldOf, startPool, stubUser, type TestPool } from './test-pool.js';

const VERSION = '2.1.314';

const inPool = async (bindings: { [name: string]: string }, run: (pool: TestPool) => Promise<void>): Promise<void> => {
  const pool = await startPool(bindings);
  try {
    await run(pool);
  } finally {
    await pool.dispose();
  }
};

/** The programs of the cells a verified bundle serves. */
const servedPrograms = async (pool: TestPool, token: string): Promise<string[]> => {
  const response = await pool.raw(`/bundle/claude-code/${VERSION}/${VOCAB_VERSION}`, token);
  expect(response.status).toBe(200);
  const verified = await verifyBundle(response.json, pool.signingKey(), 'claude-code', VERSION);
  if (!verified.ok) throw new Error(verified.reason);
  const served = new Set(verified.bundle.cells.map((cell) => cell.motifId));
  return verified.bundle.motifs
    .filter((motif) => served.has(motif.motifId))
    .flatMap((motif) => motif.steps.map(({ identity }) => (identity !== null && 'program' in identity ? identity.program : '')))
    .sort();
};

describe('one fresh account', () => {
  const deposit = async (pool: TestPool): Promise<string> => {
    // An account that has not stood: its first counting batch is today (`access.ts`). The long-tail name is on another week, so no shape total of the two shows it beside the clear name (`complement.ts`).
    const { token } = await pool.signIn('github', stubUser('9801'), { fresh: true });
    await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000009801', undefined, '2026-11-02', 'claude-code', { program: 'git', sub: 'push' }), token)).status).toBe(201);
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000009802', undefined, '2026-10-26', 'claude-code', { program: 'acme-deploy', sub: 'ship' }), token)).status).toBe(201);
    return token;
  };

  it('has its clear-cell name served at the clear floor of 1, and its long-tail name not', async () => {
    await inPool({ CLEAR_FLOOR: '1' }, async (pool) => {
      const token = await deposit(pool);
      const held = await (await pool.db()).prepare('SELECT clusters, clusters_any FROM cells WHERE sessions > 0').all();
      // The standing count is 0 for every cell it holds; the count of every account is 1.
      expect(new Set(held.results.map((row) => `${String(fieldOf(row, 'clusters'))}/${String(fieldOf(row, 'clusters_any'))}`))).toEqual(new Set(['0/1']));
      const programs = await servedPrograms(pool, token);
      expect(programs).toContain('git');
      expect(programs).not.toContain('acme-deploy');
    });
  }, 120_000);

  it('serves neither name when the clear floor is raised to 5', async () => {
    await inPool({ CLEAR_FLOOR: '5' }, async (pool) => {
      expect(await servedPrograms(pool, await deposit(pool))).toEqual([]);
    });
  }, 120_000);
});

describe('which environment totals are served', () => {
  const clearMotif: Motif = { motifId: 'm-clear', level: 'named', steps: [{ action: 'shell.exec', identity: { program: 'git', sub: 'push', flags: [] } }], cls: null };
  const tailMotif: Motif = { motifId: 'm-tail', level: 'named', steps: [{ action: 'shell.exec', identity: { program: 'acme-deploy', sub: null, flags: [] } }], cls: null };
  const motifs = new Map([clearMotif, tailMotif].map((motif) => [motif.motifId, motif]));
  const cell = (motifId: string, frameBucket: string, clusters: number): Held => ({
    cell: { motifId, frameBucket, grain: 'week', day: '2026-11-02', sessions: clusters, clusters: 0, ok: clusters, failed: 0, tokens: 0, durationMs: 0, exposed: false },
    any: clusters,
  });
  const standing = (held: Held, clusters: number): Held => ({ cell: { ...held.cell, clusters } as Cell, any: held.any });
  const total = (motifId: string, clusters: number): Held => cell(motifId, `${ENVIRONMENT_BUCKET}linux:bash`, clusters);
  const defaults = floorsOf({}, () => undefined);
  const served = (candidates: Held[], parts: Held[], floors = defaults): string[] => environmentOf(candidates, parts, motifs, floors, 5).map((one) => one.motifId);

  it('serves the total of a clear name at the clear floor, beside parts that are clear at it', () => {
    const one = total('m-clear', 1);
    expect(served([one], [one, cell('m-clear', 'claude-code/2.1.31x/claude-sonnet-4-5', 1)])).toEqual(['m-clear']);
  });

  it('withholds a total beside a long-tail part under the public floor, because it would reveal that part, and serves it from the public floor', () => {
    const one = total('m-clear', 3);
    const tail = (clusters: number): Held => standing(cell('m-clear', 'claude-code/2.1.31x/acme-private-finetune-v7', clusters), clusters);
    expect(served([one], [one, tail(3)])).toEqual([]);
    expect(served([one], [one, tail(4)])).toEqual([]);
    expect(served([one], [one, tail(5)])).toEqual(['m-clear']);
  });

  it('holds a long-tail name to the public floor, standing accounts only', () => {
    expect(served([standing(total('m-tail', 4), 4)], [])).toEqual([]);
    expect(served([standing(total('m-tail', 9), 4)], [])).toEqual([]);
    expect(served([standing(total('m-tail', 5), 5)], [])).toEqual(['m-tail']);
  });

  it('withholds the total beside a clear part under a clear floor raised above it', () => {
    const raised = floorsOf({ CLEAR_FLOOR: '3' }, () => undefined);
    const one = standing(total('m-clear', 3), 3);
    expect(served([one], [one, standing(cell('m-clear', 'claude-code/2.1.31x/claude-sonnet-4-5', 2), 2)], raised)).toEqual([]);
    expect(served([one], [one, standing(cell('m-clear', 'claude-code/2.1.31x/claude-sonnet-4-5', 3), 3)], raised)).toEqual(['m-clear']);
  });

  it('counts the standing accounts of a clear cell, not all of them, when the clear floor is above 1', () => {
    const raised = floorsOf({ CLEAR_FLOOR: '2' }, () => undefined);
    expect(served([cell('m-clear', `${ENVIRONMENT_BUCKET}linux:bash`, 4)], [], raised)).toEqual([]);
  });
});
