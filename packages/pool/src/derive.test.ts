// What bundleOf holds, pinned on stored cells without a pool: the bucket's own day is the bundle's day, whatever the version-free cells of other versions say, and a read sums served cells only.
import { describe, expect, it } from 'vitest';
import { recoveryClass, type Cell } from '../../cli/src/sessions/cells.js';
import { classMotif } from '../../cli/src/sessions/motif.js';
import { RECOVERY_TARGET_METHOD, type Read } from '../../cli/src/sessions/read.js';
import { recoveryTargetClass } from '../../cli/src/sessions/recovery-target.js';
import { recoveryEdgesOf } from '../../cli/src/sessions/recall-next.js';
import { bucketPrefix, bundleOf } from './derive.js';
import { DEFAULT_FLOORS } from './floors.js';
import type { StoredPool } from './stored.js';

const cellOf = (frameBucket: string, day: string, motifId: string): Cell => ({ motifId, frameBucket, grain: 'day', day, sessions: 5, clusters: 5, ok: 0, failed: 0, tokens: 0, durationMs: 0, exposed: false });

describe('bundleOf', () => {
  it('keeps asOf.day on the bucket when a version-free model error cell of another version is from a later day', () => {
    const prefix = bucketPrefix('claude-code', '2.1.314');
    const own = cellOf(`${prefix}opus`, '2026-10-12', 'own-motif');
    // The version-free error cell of a model is stored once for every version, so another version's failure on a later day sits here under this harness's `-` frame.
    const other = cellOf('claude-code/-/opus', '2026-11-02', 'error:429/shell.exec');
    const before: StoredPool = { cells: [own], environment: [], motifs: [], strata: [] };
    const after: StoredPool = { cells: [own, other], environment: [], motifs: [], strata: [] };

    expect(bundleOf('claude-code', '2.1.314', before, DEFAULT_FLOORS).asOf.day).toBe('2026-10-12');
    expect(bundleOf('claude-code', '2.1.314', after, DEFAULT_FLOORS).cells.map((cell) => cell.motifId)).toContain('error:429/shell.exec');
    expect(bundleOf('claude-code', '2.1.314', after, DEFAULT_FLOORS).asOf.day).toBe('2026-10-12');
  });

  it('does not count a sub-floor sibling edge in the denominator of a recovery read', () => {
    const prefix = bucketPrefix('claude-code', '2.1.314');
    const read = classMotif(recoveryClass('429', 'shell.exec', 'file.read'));
    const edit = classMotif(recoveryClass('429', 'shell.exec', 'file.edit'));
    const edge = (motifId: string, clusters: number, failed: number): Cell => ({ ...cellOf(`${prefix}opus`, '2026-10-12', motifId), grain: 'week', clusters, sessions: clusters, failed });
    const stored: StoredPool = { cells: [edge(read.motifId, 5, 5), edge(edit.motifId, 4, 3)], environment: [], motifs: [read, edit], strata: [] };

    const recovery = bundleOf('claude-code', '2.1.314', stored, DEFAULT_FLOORS).reads.filter((entry) => entry.family === 'recovery');
    // The edit edge has 4 accounts and is not served; if its 3 failures were in the denominator, `of` would be 8 and 8 minus 5 would give them away.
    expect(recovery.map(({ slice, value }) => [slice.next, value.followed, value.of])).toEqual([['file.read', 5, 5]]);
  });
});

describe('the same-target recovery read in a bundle', () => {
  const prefix = bucketPrefix('claude-code', '2.1.314');
  const motifOf = (next: string) => classMotif(recoveryTargetClass('429', 'file.edit', 'source', next));
  const week = (next: string, clusters: number, failed: number, ok: number): Cell => ({ ...cellOf(`${prefix}opus`, '2026-10-12', motifOf(next).motifId), grain: 'week', clusters, sessions: clusters, failed, ok });
  const bundledOf = (cells: Cell[], nexts: string[]) => bundleOf('claude-code', '2.1.314', { cells, environment: [], motifs: nexts.map(motifOf), strata: [] }, DEFAULT_FLOORS);
  const sameTarget = (bundle: ReturnType<typeof bundledOf>) => bundle.reads.filter((entry) => entry.method === RECOVERY_TARGET_METHOD.name);

  it('serves the most common recovering step when it is not a retry', () => {
    const reads = sameTarget(bundledOf([week('file.read', 5, 6, 5), week('retry', 5, 3, 2)], ['file.read', 'retry']));
    expect(reads.map(({ slice, value }) => [slice.target, slice.step, value.recovered, value.of])).toEqual([['source', 'file.read', 5, 9]]);
  });

  it('serves nothing for a cell whose most common recovering step is a retry', () => {
    const topped = bundledOf([week('retry', 5, 6, 5), week('file.read', 5, 3, 2)], ['retry', 'file.read']);
    expect(sameTarget(topped)).toEqual([]);
    // The bundle holds nothing for the cell: its same-target cells are left out too.
    expect(topped.cells.map((cell) => cell.motifId)).toEqual([]);
    const served = bundledOf([week('file.read', 5, 6, 5), week('retry', 5, 3, 2)], ['file.read', 'retry']);
    expect(served.cells.map((cell) => cell.motifId).sort()).toEqual([motifOf('file.read').motifId, motifOf('retry').motifId].sort());
  });

  it('serves nothing for a cell under the floor, and does not count it in the denominator of the one beside it', () => {
    const reads = sameTarget(bundledOf([week('file.read', 5, 6, 5), week('file.grep', 4, 3, 3)], ['file.read', 'file.grep']));
    expect(reads.map(({ slice, value }) => [slice.step, value.of])).toEqual([['file.read', 6]]);
    expect(sameTarget(bundledOf([week('file.read', 4, 6, 5)], ['file.read']))).toEqual([]);
  });

  it('is not folded into the recovery edges the failure hook reads', () => {
    const edge = classMotif(recoveryClass('429', 'file.edit', 'file.read'));
    const edgeCell: Cell = { ...cellOf(`${prefix}opus`, '2026-10-12', edge.motifId), grain: 'week', clusters: 5, sessions: 5, failed: 6 };
    const withEdge = (cells: Cell[]) => bundleOf('claude-code', '2.1.314', { cells, environment: [], motifs: [edge, motifOf('file.read')], strata: [] }, DEFAULT_FLOORS);
    const both = withEdge([edgeCell, week('file.read', 5, 6, 5)]);
    expect(sameTarget(both)).toHaveLength(1);
    // A read id hashes its pool, which differs with the extra cells, so the edges are compared by what they count.
    const counted = (reads: Read[]) => Object.values(recoveryEdgesOf(reads)).map((edges) => edges.map(({ next, followed, of, clusters }) => [next, followed, of, clusters]));
    expect(counted(both.reads)).toEqual(counted(withEdge([edgeCell]).reads));
    expect(Object.keys(recoveryEdgesOf(both.reads))).toEqual(['file.edit/429']);
  });

  it('leaves the bundle as it was for a store with no same-target cells', () => {
    const prefixed = bucketPrefix('claude-code', '2.1.314');
    const edge = classMotif(recoveryClass('429', 'shell.exec', 'file.read'));
    const cell: Cell = { ...cellOf(`${prefixed}opus`, '2026-10-12', edge.motifId), grain: 'week', clusters: 5, sessions: 5, failed: 5 };
    const bundle = bundleOf('claude-code', '2.1.314', { cells: [cell], environment: [], motifs: [edge], strata: [] }, DEFAULT_FLOORS);
    expect(sameTarget(bundle)).toEqual([]);
    expect(bundle.reads.map((entry) => entry.method)).not.toContain(RECOVERY_TARGET_METHOD.name);
    expect(bundle.reads.filter((entry) => entry.family === 'recovery')).toHaveLength(1);
    // Byte identity of what the edge derive says: the same read, key for key, as before the same-target read existed.
    const [only] = bundle.reads.filter((entry) => entry.family === 'recovery');
    expect(JSON.stringify([only?.method, only?.slice, only?.value, only?.n, only?.clusters])).toBe(JSON.stringify(['next-action-after-failure', { action: 'shell.exec', errorCode: '429', next: 'file.read', week: '2026-10-12' }, { followed: 5, of: 5, share: 1 }, 5, 5]));
    expect(bundle.cells.map((one) => one.motifId)).toEqual([edge.motifId]);
  });
});
