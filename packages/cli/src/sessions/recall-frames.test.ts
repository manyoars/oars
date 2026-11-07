// t926 fix round 1, Item 9: the local half of a next-node read is filtered to the asker's harness and version. A pool built by hand with two harnesses, one of them split and one settled at the
// same position, and a recovery edge that only one of them has.
import { describe, expect, it } from 'vitest';
import type { Cell, Pool } from './cells.js';
import { recoveryClass } from './cells.js';
import { shapeMotif, type Motif } from './motif.js';
import { store } from './pool-fixture.js';
import { frameKeyOf } from './recall-next.js';
import { nextByFrame, PER_FRAME_POSITIONS } from './recall-frames.js';

const cell = (motifId: string, frameBucket: string, counts: { ok?: number; failed?: number }): Cell => ({ motifId, frameBucket, grain: 'week', day: '2026-11-02', sessions: 1, clusters: 1, ok: counts.ok ?? 0, failed: counts.failed ?? 0, tokens: null, durationMs: 0, exposed: false });

const after = (next: 'file.edit' | 'shell.exec'): Motif => shapeMotif([{ action: 'file.read', identity: null }, { action: next, identity: null }]);
const recovery = (next: string): Motif => ({ motifId: `recovery-${next}`, level: 'class', steps: [], cls: recoveryClass('1', 'shell.exec', next) });

const CODEX = 'codex/0.9.0x/m';
const CLAUDE = 'claude-code/2.1.31x/m';
const CLAUDE_NEXT = 'claude-code/2.1.41x/m';
const motifs = [after('file.edit'), after('shell.exec'), recovery('file.read'), recovery('shell.exec')];
const pool: Pool = {
  motifs: new Map(motifs.map((motif) => [motif.motifId, motif])),
  version: 'v1',
  lastDay: '2026-11-02',
  cells: [
    // Codex splits after a read: 12 edits, 8 commands.
    cell(after('file.edit').motifId, CODEX, { ok: 12 }),
    cell(after('shell.exec').motifId, CODEX, { ok: 8 }),
    // Claude Code settles at the same position: 19 edits, 1 command.
    cell(after('file.edit').motifId, CLAUDE, { ok: 19 }),
    cell(after('shell.exec').motifId, CLAUDE, { ok: 1 }),
    // A failed command was followed by a read in Codex 6 times and by a retry in Claude Code 2 times.
    cell(recovery('file.read').motifId, CODEX, { failed: 6 }),
    cell(recovery('shell.exec').motifId, CLAUDE, { failed: 2 }),
    // Another Claude Code version bucket, split like Codex.
    cell(after('file.edit').motifId, CLAUDE_NEXT, { ok: 12 }),
    cell(after('shell.exec').motifId, CLAUDE_NEXT, { ok: 8 }),
  ],
};

describe('nextByFrame', () => {
  const found = nextByFrame(pool, store({}));

  it('lists a position only under the harness and version that split on it', () => {
    expect(found.positions['codex/0.9.0x']?.map((position) => position.prefix)).toEqual(['file.read']);
    expect(found.positions['claude-code/2.1.41x']?.map((position) => position.prefix)).toEqual(['file.read']);
    expect(found.positions['claude-code/2.1.31x']).toBeUndefined();
  });

  it('keeps a harness-wide key that sums its versions, for a session that does not state one', () => {
    // Claude Code across both buckets: 31 edits and 9 commands, a leading share of 77 percent, inside the band.
    expect(found.positions['claude-code/*']?.[0]).toMatchObject({ prefix: 'file.read', n: 40 });
    expect(found.positions['codex/*']?.[0]).toMatchObject({ prefix: 'file.read', n: 20 });
  });

  it('keeps a recovery edge only under the harness that saw it, a below-floor one included', () => {
    expect(found.recovery['codex/0.9.0x']?.['shell.exec/1']?.map((edge) => [edge.next, edge.followed])).toEqual([['file.read', 6]]);
    expect(found.recovery['claude-code/2.1.31x']?.['shell.exec/1']?.map((edge) => [edge.next, edge.followed])).toEqual([['shell.exec', 2]]);
    expect(found.recovery['claude-code/2.1.41x']).toBeUndefined();
  });

  it('caps the positions a frame keeps', () => {
    expect(PER_FRAME_POSITIONS).toBeGreaterThanOrEqual(8);
    expect(Object.values(found.positions).every((positions) => positions.length <= PER_FRAME_POSITIONS)).toBe(true);
  });

  it('leaves the environment cells out', () => {
    const withEnvironment = nextByFrame({ ...pool, cells: [...pool.cells, cell(after('file.edit').motifId, 'env:linux:bash', { ok: 50 })] }, store({}));
    expect(Object.keys(withEnvironment.positions).some((key) => key.startsWith('env'))).toBe(false);
  });
});

describe('frameKeyOf', () => {
  it('buckets the version by tens of patches, and reads across versions when none is stated', () => {
    expect(frameKeyOf({ harness: 'claude-code', harnessVersion: '2.1.314' })).toBe('claude-code/2.1.31x');
    expect(frameKeyOf({ harness: 'codex', harnessVersion: null })).toBe('codex/*');
  });
});
