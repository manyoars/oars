// The same-target recovery cells are parts of the recovery edge cell of the same code, failed action, and next step (a retry is the failed action again). Serving the edge beside all its served parts would show a sub-floor part
// by subtraction, so a sub-floor part withholds one more served part, as for any whole and its parts.
import { describe, expect, it } from 'vitest';
import { recoveryClass, type Cell } from '../../cli/src/sessions/cells.js';
import { classMotif, type Motif } from '../../cli/src/sessions/motif.js';
import { recoveryTargetClass } from '../../cli/src/sessions/recovery-target.js';
import { bucketPrefix, bundleOf } from './derive.js';
import { DEFAULT_FLOORS } from './floors.js';

const FRAME = `${bucketPrefix('claude-code', '2.1.314')}opus`;
const WEEK = '2026-10-12';
const weekCell = (motif: Motif, clusters: number): Cell => ({ motifId: motif.motifId, frameBucket: FRAME, grain: 'week', day: WEEK, sessions: clusters, clusters, ok: clusters, failed: clusters, tokens: 0, durationMs: 0, exposed: false });

const servedOf = (entries: readonly (readonly [string, Motif, number])[]): string[] => {
  const labels = new Map(entries.map(([label, motif]) => [motif.motifId, label]));
  const bundle = bundleOf('claude-code', '2.1.314', { cells: entries.map(([, motif, clusters]) => weekCell(motif, clusters)), environment: [], motifs: entries.map(([, motif]) => motif), strata: [] }, DEFAULT_FLOORS);
  return bundle.cells.map((cell) => labels.get(cell.motifId) ?? 'unknown').sort();
};

const edge = classMotif(recoveryClass('429', 'file.edit', 'file.read'));
const source = classMotif(recoveryTargetClass('429', 'file.edit', 'source', 'file.read'));
const doc = classMotif(recoveryTargetClass('429', 'file.edit', 'doc', 'file.read'));
const config = classMotif(recoveryTargetClass('429', 'file.edit', 'config', 'file.read'));

describe('the recovery edge cell beside its same-target cells', () => {
  it('serves all when every part clears the floor', () => {
    expect(servedOf([['edge', edge, 6], ['source', source, 5], ['doc', doc, 5]])).toEqual(['doc', 'edge', 'source']);
  });

  it('withholds one more served part when a part is under the floor', () => {
    expect(servedOf([['edge', edge, 8], ['source', source, 5], ['doc', doc, 6], ['config', config, 4]])).toEqual(['doc', 'edge']);
  });

  it('ties a retry part to the edge cell of the failed action', () => {
    const retryEdge = classMotif(recoveryClass('429', 'file.edit', 'file.edit'));
    const retry = classMotif(recoveryTargetClass('429', 'file.edit', 'source', 'retry'));
    const thin = classMotif(recoveryTargetClass('429', 'file.edit', 'doc', 'retry'));
    expect(servedOf([['edge', retryEdge, 8], ['retry', retry, 5], ['other', source, 5], ['thin', thin, 4]])).toEqual(['edge', 'other']);
  });
});
