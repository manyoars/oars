// The same-target recovery cells and read: per (code, failed action, target class, next step) a week cell of the failed calls the next call followed and of those where it came back ok; the read names the most common
// recovering step per target class, and stays silent when that step is a retry.
import { describe, expect, it } from 'vitest';
import { cellsOf, incrementsOf, projectedStore } from './cell-increments.js';
import { isPromptClass, poolOf, RECOVERY_CLASS } from './cells.js';
import { motifName } from './motif.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';
import { skeletonOf } from './pool-wire.js';
import { isRetry, nextCallOf, nextStepOf, parseRecoveryTargetClass, RECOVERY_TARGET_CLASS, recoveryTargetClass, RETRY } from './recovery-target.js';
import { RECOVERY_TARGET_METHOD } from './read.js';
import { deriveRecoveryEdges } from './read-recovery-edge.js';
import { deriveRecoveryTarget } from './read-recovery-target.js';
import type { ToolObservation } from './schema.js';

const framed = frame({ shell: 'bash' });
const call = (n: number, native: string, action: 'file.edit' | 'file.read', over: Partial<ToolObservation> = {}) =>
  tool('s1', n, native, { targetClass: 'source', steps: [step(n, 0, action, { native, ...(over.status === 'error' ? { status: 'error' } : {}) })], ...over });
const failedEdit = (n: number) => call(n, 'Edit', 'file.edit', { status: 'error', errorCode: '429' });
const okEdit = (n: number) => call(n, 'Edit', 'file.edit');
const okRead = (n: number) => call(n, 'Read', 'file.read');
const badRead = (n: number) => call(n, 'Read', 'file.read', { status: 'error' });
const okOtherTarget = (n: number) => call(n, 'Edit', 'file.edit', { targetClass: 'doc' });

const fixtureOf = (tools: ToolObservation[]) => store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed }), prompt('s1', 1, { frame: framed })], tools });

const cellsFor = (tools: ToolObservation[]) => {
  const set = cellsOf(projectedStore(fixtureOf(tools), storedNames));
  const named = (motifId: string): string => {
    const motif = set.motifs.find((one) => one.motifId === motifId);
    return motif === undefined ? '' : motifName(motif);
  };
  return { set, cells: set.cells.map((cell) => [named(cell.motifId), cell] as const).filter(([name]) => name.startsWith(RECOVERY_TARGET_CLASS)) };
};

describe('the retry comparison', () => {
  it('is the same action on the same target class, and nothing else', () => {
    expect(isRetry({ action: 'file.edit', targetClass: 'source' }, { action: 'file.edit', targetClass: 'source' })).toBe(true);
    expect(isRetry({ action: 'file.edit', targetClass: 'source' }, { action: 'file.edit', targetClass: 'doc' })).toBe(false);
    expect(isRetry({ action: 'file.edit', targetClass: 'source' }, { action: 'file.read', targetClass: 'source' })).toBe(false);
  });

  it('is never true for a call with no target', () => {
    expect(isRetry({ action: 'shell.exec', targetClass: 'none' }, { action: 'shell.exec', targetClass: 'none' })).toBe(false);
    expect(isRetry({ action: 'shell.exec', targetClass: undefined }, { action: 'shell.exec', targetClass: undefined })).toBe(false);
  });

  it('names a repeat retry and any other step by its action', () => {
    expect(nextStepOf({ action: 'file.edit', targetClass: 'source' }, { action: 'file.edit', targetClass: 'source' })).toBe(RETRY);
    expect(nextStepOf({ action: 'file.edit', targetClass: 'source' }, { action: 'file.read', targetClass: 'source' })).toBe('file.read');
  });
});

describe('the class name', () => {
  it('round-trips and rejects other names', () => {
    expect(parseRecoveryTargetClass(recoveryTargetClass('429', 'file.edit', 'source', 'file.read'))).toEqual({ code: '429', failed: 'file.edit', target: 'source', next: 'file.read' });
    expect(parseRecoveryTargetClass(`${RECOVERY_CLASS}429/file.edit>file.read`)).toBeNull();
  });

  it('is not a prompt class', () => {
    expect(isPromptClass(recoveryTargetClass('429', 'file.edit', 'source', 'file.read'))).toBe(false);
  });
});

describe('the next call', () => {
  const calls = [
    { side: false, prompt: 0, status: 'error' },
    { side: true, prompt: 0, status: 'ok' },
    { side: false, prompt: 1, status: 'ok' },
  ] as const;
  it('is the next of the same run, and none when the prompt ended or nothing follows', () => {
    expect(nextCallOf([calls[0], calls[1], { side: false, prompt: 0, status: 'ok' }, calls[2]], 0)).toEqual({ side: false, prompt: 0, status: 'ok' });
    expect(nextCallOf(calls, 0)).toBeNull();
    expect(nextCallOf(calls, 2)).toBeNull();
    expect(nextCallOf(calls, 9)).toBeNull();
  });
});

describe('the cells', () => {
  it('count a recovering step of another tool on the same target, by whether it came back ok', () => {
    const { cells } = cellsFor([failedEdit(0), okRead(1), failedEdit(2), badRead(3)]);
    expect(cells.map(([name, cell]) => [name, cell.grain, cell.failed, cell.ok]).sort()).toEqual([[`${RECOVERY_TARGET_CLASS}429/file.edit/source>file.read`, 'week', 2, 1]]);
  });

  it('name a repeat of the failed call retry', () => {
    const { cells } = cellsFor([failedEdit(0), okEdit(1), failedEdit(2), okOtherTarget(3)]);
    expect(cells.map(([name, cell]) => [name, cell.failed, cell.ok]).sort()).toEqual([
      [`${RECOVERY_TARGET_CLASS}429/file.edit/source>file.edit`, 1, 1],
      [`${RECOVERY_TARGET_CLASS}429/file.edit/source>retry`, 1, 1],
    ]);
  });

  it('are made for a failed call with a code, a target, and a next call in its prompt, and no other', () => {
    const noCode = call(0, 'Edit', 'file.edit', { status: 'error' });
    const noTarget = call(2, 'Edit', 'file.edit', { status: 'error', errorCode: '429', targetClass: 'none' });
    const last = failedEdit(4);
    const otherPrompt = { ...okRead(5), prompt: 1 };
    const { cells } = cellsFor([noCode, okRead(1), noTarget, okRead(3), last, otherPrompt]);
    expect(cells).toEqual([]);
  });

  it('are the same at the pool as on the machine', () => {
    const tools = [failedEdit(0), okRead(1), failedEdit(2), okEdit(3)];
    const { set } = cellsFor(tools);
    const [only] = sessionsFrom(fixtureOf(tools));
    const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
    if (skeleton === null) throw new Error('no skeleton');
    const increments = incrementsOf(skeleton);
    const targeted = (motifs: readonly { motifId: string; cls: string | null }[], motifId: string): boolean => motifs.some((motif) => motif.motifId === motifId && (motif.cls?.startsWith(RECOVERY_TARGET_CLASS) ?? false));
    const pooled = [...increments.cells.values()].filter(({ motifId }) => targeted(increments.motifs, motifId));
    const local = set.cells.filter(({ motifId }) => targeted(set.motifs, motifId));
    expect(pooled.map(({ motifId, failed, ok }) => [motifId, failed, ok]).sort()).toEqual(local.map(({ motifId, failed, ok }) => [motifId, failed, ok]).sort());
    expect(pooled).toHaveLength(2);
  });
});

describe('the read', () => {
  const readOf = (tools: ToolObservation[]) => deriveRecoveryTarget({ pool: poolOf(cellsFor(tools).set, []), store: store({}) });

  it('names the step that most often came back ok, even when it is another tool on the same target', () => {
    const reads = readOf([failedEdit(0), okRead(1), failedEdit(2), okRead(3), failedEdit(4), badRead(5)]);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ family: 'recovery', method: RECOVERY_TARGET_METHOD.name, slice: { failed: 'file.edit', errorCode: '429', target: 'source', step: 'file.read' }, n: 2, value: { recovered: 2, followed: 3, of: 3 } });
    expect(reads[0]?.inputs).toHaveLength(1);
  });

  it('is absent when the most common recovering step is a retry', () => {
    expect(readOf([failedEdit(0), okEdit(1), failedEdit(2), okEdit(3), failedEdit(4), okRead(5)])).toEqual([]);
  });

  it('is present when a retry is not the most common step', () => {
    const reads = readOf([failedEdit(0), okEdit(1), failedEdit(2), okRead(3), failedEdit(4), okRead(5)]);
    expect(reads.map((one) => [one.slice.step, one.n])).toEqual([['file.read', 2]]);
  });

  it('is absent when nothing came back ok', () => {
    expect(readOf([failedEdit(0), badRead(1)])).toEqual([]);
  });

  it('leaves the recovery edge reads as they were', () => {
    const pool = poolOf(cellsFor([failedEdit(0), okRead(1)]).set, []);
    expect(deriveRecoveryEdges({ pool, store: store({}) }).every((one) => one.method === 'next-action-after-failure')).toBe(true);
  });
});
