// What bundleOf holds, pinned on stored cells without a pool: the bucket's own day is the bundle's day, whatever the version-free cells of other versions say, and a read sums served cells only.
import { describe, expect, it } from 'vitest';
import { recoveryClass, type Cell } from '../../cli/src/sessions/cells.js';
import { classMotif } from '../../cli/src/sessions/motif.js';
import { bucketPrefix, bundleOf } from './derive.js';
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

    expect(bundleOf('claude-code', '2.1.314', before).asOf.day).toBe('2026-10-12');
    expect(bundleOf('claude-code', '2.1.314', after).cells.map((cell) => cell.motifId)).toContain('error:429/shell.exec');
    expect(bundleOf('claude-code', '2.1.314', after).asOf.day).toBe('2026-10-12');
  });

  it('does not count a sub-floor sibling edge in the denominator of a recovery read', () => {
    const prefix = bucketPrefix('claude-code', '2.1.314');
    const read = classMotif(recoveryClass('429', 'shell.exec', 'file.read'));
    const edit = classMotif(recoveryClass('429', 'shell.exec', 'file.edit'));
    const edge = (motifId: string, clusters: number, failed: number): Cell => ({ ...cellOf(`${prefix}opus`, '2026-10-12', motifId), grain: 'week', clusters, sessions: clusters, failed });
    const stored: StoredPool = { cells: [edge(read.motifId, 5, 5), edge(edit.motifId, 4, 3)], environment: [], motifs: [read, edit], strata: [] };

    const recovery = bundleOf('claude-code', '2.1.314', stored).reads.filter((entry) => entry.family === 'recovery');
    // The edit edge has 4 accounts and is not served; if its 3 failures were in the denominator, `of` would be 8 and 8 minus 5 would give them away.
    expect(recovery.map(({ slice, value }) => [slice.next, value.followed, value.of])).toEqual([['file.read', 5, 5]]);
  });
});
