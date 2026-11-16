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
const weekCell = (motif: Motif, clusters: number, ok = clusters): Cell => ({ motifId: motif.motifId, frameBucket: FRAME, grain: 'week', day: WEEK, sessions: clusters, clusters, ok, failed: clusters, tokens: 0, durationMs: 0, exposed: false });

const bundleFor = (entries: readonly (readonly [string, Motif, number])[]) =>
  bundleOf('claude-code', '2.1.314', { cells: entries.map(([, motif, clusters]) => weekCell(motif, clusters)), environment: [], motifs: entries.map(([, motif]) => motif), strata: [] }, DEFAULT_FLOORS);

const servedOf = (entries: readonly (readonly [string, Motif, number, number?])[]): string[] => {
  const labels = new Map(entries.map(([label, motif]) => [motif.motifId, label]));
  const bundle = bundleOf('claude-code', '2.1.314', { cells: entries.map(([, motif, clusters, ok]) => weekCell(motif, clusters, ok)), environment: [], motifs: entries.map(([, motif]) => motif), strata: [] }, DEFAULT_FLOORS);
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
    // The thin retry part makes the complement rule withhold the served `retry` part. Then a held retry that recovered keeps the group silent, so no part ships. Without the mapping the retry part is
    // outside the edge's family, is served, and the group ships `retry` and `other`.
    const retryEdge = classMotif(recoveryClass('429', 'file.edit', 'file.edit'));
    const retry = classMotif(recoveryTargetClass('429', 'file.edit', 'source', 'retry'));
    const thin = classMotif(recoveryTargetClass('429', 'file.edit', 'doc', 'retry'));
    expect(servedOf([['edge', retryEdge, 8], ['retry', retry, 5, 1], ['other', source, 6, 6], ['thin', thin, 4]])).toEqual(['edge']);
  });

  it('stays silent on a same-target group whose retry part is withheld, and ships none of its cells', () => {
    const retryEdge = classMotif(recoveryClass('429', 'file.edit', 'file.edit'));
    const retry = classMotif(recoveryTargetClass('429', 'file.edit', 'source', 'retry'));
    const thin = classMotif(recoveryTargetClass('429', 'file.edit', 'doc', 'retry'));
    const bundle = bundleFor([['edge', retryEdge, 8], ['retry', retry, 5], ['other', source, 5], ['thin', thin, 4]]);
    expect(bundle.reads.filter((read) => read.slice.step !== undefined)).toEqual([]);
    expect(bundle.cells.map((cell) => cell.motifId)).not.toContain(source.motifId);
  });
});

// The calls with no target class are in no part, so the parts never sum to the edge: a lone unserved part is not the edge's count, and the edge stays served whatever its parts are.
describe('the recovery edge cell, which its same-target cells never complete', () => {
  const retryEdge = classMotif(recoveryClass('429', 'file.edit', 'file.edit'));
  const retry = classMotif(recoveryTargetClass('429', 'file.edit', 'source', 'retry'));
  const thinRetry = classMotif(recoveryTargetClass('429', 'file.edit', 'doc', 'retry'));

  it.each([
    ['an edge with no part', [['edge', edge, 6]], ['edge']],
    ['an edge beside one served part', [['edge', edge, 6], ['source', source, 5]], ['edge', 'source']],
    ['an edge beside its one part under the floor', [['edge', edge, 8], ['source', source, 4]], ['edge']],
    ['an edge beside two parts under the floor', [['edge', edge, 8], ['source', source, 4], ['doc', doc, 4]], ['edge']],
    ['an edge beside its one retry part, held under the floor', [['edge', retryEdge, 8], ['retry', thinRetry, 4]], ['edge']],
    ['an edge under the floor', [['edge', edge, 4]], []],
    ['an edge under the floor beside one served part', [['edge', edge, 4], ['source', source, 5]], ['source']],
    ['an edge under the floor beside one part under it', [['edge', edge, 4], ['source', source, 4]], []],
    ['an edge under the floor beside a served part and one under it', [['edge', edge, 4], ['source', source, 5], ['doc', doc, 4]], ['source']],
    ['an edge under the floor beside a served retry part that is the only step', [['edge', retryEdge, 4], ['retry', retry, 5]], []],
  ] as const)('serves %s as the floor alone would', (_, entries, served) => {
    expect(servedOf(entries)).toEqual(served);
  });

  it('serves a retry part beside its edge when another step strictly beats it, and leaves the group out on a tie', () => {
    expect(servedOf([['edge', retryEdge, 8], ['retry', retry, 5, 1], ['other', source, 6, 6]])).toEqual(['edge', 'other', 'retry']);
    expect(servedOf([['edge', retryEdge, 8], ['retry', retry, 5, 5], ['other', source, 5, 5]])).toEqual(['edge']);
  });
});
