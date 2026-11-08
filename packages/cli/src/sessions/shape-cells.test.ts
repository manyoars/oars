// The shape cells of a call (layer 0): one week cell per facet of what the call held, by action and harness version bucket, never a value. The facets are the target class, each argument class, the
// count bucket of key names not sent, and the sorted key names; `fit` reads them as its call-shape slices. The pool derives the same cells from a skeleton as a local read derives from the store.
import { describe, expect, it } from 'vitest';
import { cellsOf, incrementsOf, projectedStore } from './cell-increments.js';
import { NO_AXES, parseShapeClass, poolOf, SHAPE_CLASS, shapeClass, type Cell, type CellSet } from './cells.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';
import { skeletonOf } from './pool-wire.js';
import { deriveFitShape } from './read-fit.js';

const framed = frame({ shell: 'bash' });
const version = `claude-code/2.1.31x/${NO_AXES}`;

const read = (n: number, status: 'ok' | 'error', keys: string[]) =>
  tool('s1', n, 'Read', { status, keys, targetClass: 'source', argClass: ['number', 'path'], steps: [step(n, 0, 'file.read', { native: 'Read', status })] });

const fixture = () =>
  store({
    sessions: [session('s1', { frame: framed })],
    prompts: [prompt('s1', 0, { frame: framed })],
    tools: [
      read(0, 'ok', ['file_path', 'limit']),
      read(1, 'error', ['file_path', 'limit']),
      // `acme_scope` is off Read's pinned list, so the wire drops it and counts it.
      read(2, 'ok', ['acme_scope', 'file_path']),
      // A record captured before the shape fields carries none of them.
      tool('s1', 3, 'Grep', { keys: [], steps: [step(3, 0, 'file.search', { native: 'Grep' })] }),
    ],
  });

const shapeCells = (set: CellSet): { cls: string; bucket: string; grain: string; ok: number; failed: number }[] =>
  set.cells
    .map((cell: Cell) => ({ cls: set.motifs.find(({ motifId }) => motifId === cell.motifId)?.cls ?? '', bucket: cell.frameBucket, grain: cell.grain, ok: cell.ok, failed: cell.failed }))
    .filter(({ cls }) => cls.startsWith(SHAPE_CLASS));

describe('shape cells', () => {
  const set = cellsOf(projectedStore(fixture(), storedNames));

  it('are week cells per (action, facet, version bucket), counting each call by its own status', () => {
    const cells = shapeCells(set);
    expect(cells.every(({ grain, bucket }) => grain === 'week' && bucket === version)).toBe(true);
    expect(cells.map(({ cls, ok, failed }) => [cls, ok, failed]).sort()).toEqual(
      [
        [shapeClass('file.read', 'arg', 'number'), 2, 1],
        [shapeClass('file.read', 'arg', 'path'), 2, 1],
        [shapeClass('file.read', 'dropped', '1'), 1, 0],
        [shapeClass('file.read', 'keys', 'file_path'), 1, 0],
        [shapeClass('file.read', 'keys', 'file_path,limit'), 1, 1],
        [shapeClass('file.read', 'target', 'source'), 2, 1],
      ].sort(),
    );
  });

  it('hold no facet a record did not capture', () => {
    expect(shapeCells(set).some(({ cls }) => cls.includes('file.search'))).toBe(false);
  });

  it('name the action, facet, and value, and nothing else', () => {
    expect(parseShapeClass(shapeClass('file.read', 'keys', 'file_path,limit'))).toEqual({ action: 'file.read', facet: 'keys', value: 'file_path,limit' });
    expect(parseShapeClass('shape:file.read/unknown-facet/x')).toBeNull();
    expect(parseShapeClass('recovery:429/shell.exec>none')).toBeNull();
  });

  it('are the same cells at the pool as on the machine', () => {
    const [only] = sessionsFrom(fixture());
    const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
    if (skeleton === null) throw new Error('no skeleton');
    const increments = incrementsOf(skeleton);
    const pooled = shapeCells({ cells: [...increments.cells.values()].map((row) => ({ ...row, clusters: 1, exposed: row.exposed === 1 })), motifs: increments.motifs });
    expect(pooled.map(({ cls, ok, failed }) => [cls, ok, failed]).sort()).toEqual(shapeCells(set).map(({ cls, ok, failed }) => [cls, ok, failed]).sort());
    expect(pooled.length).toBeGreaterThan(0);
  });
});

describe('fit by call shape', () => {
  const reads = deriveFitShape({ pool: poolOf(cellsOf(projectedStore(fixture(), storedNames)), []), store: store({}) });

  it('states a failure rate per (action, facet, value, version bucket) from the shape cells', () => {
    const keyed = reads.find(({ slice }) => slice.facet === 'keys' && slice.value === 'file_path,limit');
    expect(keyed?.family).toBe('fit');
    expect(keyed?.slice).toEqual({ action: 'file.read', facet: 'keys', value: 'file_path,limit', harness: 'claude-code', harnessBucket: '2.1.31x' });
    expect(keyed?.value).toEqual({ failureRate: 0.5, failed: 1, ok: 1 });
    expect(reads.find(({ slice }) => slice.facet === 'target')?.value).toEqual({ failureRate: 0.3333, failed: 1, ok: 2 });
    expect(reads.map(({ slice }) => `${slice.facet ?? ''}/${slice.value ?? ''}`).sort()).toEqual(['arg/number', 'arg/path', 'dropped/1', 'keys/file_path', 'keys/file_path,limit', 'target/source']);
  });
});
