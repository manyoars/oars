// The `live` day cells of a failed call by its `errorCode` (t868, Item 2): per (name, `model`, `errorCode`) and per (name, `harnessVersion`, `errorCode`). They are day cells of a class motif, so no read of a call's
// own cell sees them, and they carry the one dimension each: a model-and-code cell holds the model, a version-and-code cell holds the version bucket and no model.
import { describe, expect, it } from 'vitest';
import { cellsOf, incrementsOf, projectedStore } from './cell-increments.js';
import { ERROR_CLASS, ERROR_VERSION_CLASS, NO_AXES, type Cell } from './cells.js';
import { motifName } from './motif.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';
import { skeletonOf } from './pool-wire.js';

const framed = frame({ shell: 'bash' });
const failedPush = (n: number, errorCode?: string) =>
  tool('s1', n, 'Bash', { status: 'error', ...(errorCode === undefined ? {} : { errorCode }), steps: [step(n, 0, 'shell.exec', { native: 'Bash', status: 'error', identity: { program: 'git', sub: 'push', flags: [] } })] });

const fixture = () =>
  store({
    sessions: [session('s1', { frame: framed })],
    prompts: [prompt('s1', 0, { frame: framed })],
    tools: [failedPush(0, '429'), failedPush(1, '429'), failedPush(2, 'user-rejected'), failedPush(3), tool('s1', 4, 'Read', { steps: [step(4, 0, 'file.read', { native: 'Read' })] })],
  });

const nameOf = (cells: ReturnType<typeof cellsOf>, cell: Cell): string => {
  const motif = cells.motifs.find(({ motifId }) => motifId === cell.motifId);
  return motif === undefined ? '' : motifName(motif);
};

const errorCells = (set: ReturnType<typeof cellsOf>): { name: string; bucket: string; grain: string; day: string; failed: number; ok: number }[] =>
  set.cells
    .map((cell) => ({ name: nameOf(set, cell), bucket: cell.frameBucket, grain: cell.grain, day: cell.day, failed: cell.failed, ok: cell.ok }))
    .filter(({ name }) => name.startsWith(ERROR_CLASS) || name.startsWith(ERROR_VERSION_CLASS));

describe('error-code cells', () => {
  const set = cellsOf(projectedStore(fixture(), storedNames));

  it('are day cells per (name, model, code) and per (name, version, code), counting the failed calls of that code', () => {
    const model = 'claude-code/2.1.31x/claude-opus-5-5';
    const version = `claude-code/2.1.31x/${NO_AXES}`;
    const cells = errorCells(set);
    expect(cells.every(({ grain, day }) => grain === 'day' && day === '2026-11-01')).toBe(true);
    const counts = (prefix: string, bucket: string) => cells.filter((cell) => cell.name.startsWith(prefix) && cell.bucket === bucket).map(({ name, failed, ok }) => [name, failed, ok]).sort();
    expect(counts(ERROR_CLASS, model)).toEqual([
      [`${ERROR_CLASS}429/shell.exec`, 2, 0],
      [`${ERROR_CLASS}429/shell.exec[program=git sub=push]`, 2, 0],
      [`${ERROR_CLASS}user-rejected/shell.exec`, 1, 0],
      [`${ERROR_CLASS}user-rejected/shell.exec[program=git sub=push]`, 1, 0],
    ]);
    expect(counts(ERROR_VERSION_CLASS, version)).toEqual([
      [`${ERROR_VERSION_CLASS}429/shell.exec`, 2, 0],
      [`${ERROR_VERSION_CLASS}429/shell.exec[program=git sub=push]`, 2, 0],
      [`${ERROR_VERSION_CLASS}user-rejected/shell.exec`, 1, 0],
      [`${ERROR_VERSION_CLASS}user-rejected/shell.exec[program=git sub=push]`, 1, 0],
    ]);
  });

  it('count a failed call with no captured code in none, and a call that succeeded in none', () => {
    expect(errorCells(set).some(({ name }) => name.includes('file.read') || name.includes('/null') || name.includes('undefined'))).toBe(false);
  });

  it('are the same cells at the pool as on the machine', () => {
    const [only] = sessionsFrom(fixture());
    const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
    if (skeleton === null) throw new Error('no skeleton');
    const increments = incrementsOf(skeleton);
    const isError = (motifs: readonly { motifId: string; cls: string | null }[], motifId: string): boolean => motifs.some((motif) => motif.motifId === motifId && (motif.cls?.startsWith('error') ?? false));
    const pooled = [...increments.cells.values()].filter(({ motifId }) => isError(increments.motifs, motifId));
    const local = set.cells.filter(({ motifId }) => isError(set.motifs, motifId));
    expect(pooled.map(({ motifId, frameBucket, failed }) => [motifId, frameBucket, failed]).sort()).toEqual(local.map(({ motifId, frameBucket, failed }) => [motifId, frameBucket, failed]).sort());
    expect(pooled.length).toBeGreaterThan(0);
  });
});
