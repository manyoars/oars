// The recovery cells (t868, Item 4): per (failed action, `errorCode`, the next action) a week cell of the failed calls the next action followed, and the `recovery` read over them. They count what followed, not what fixed
// anything, and they carry no signature or text.
import { describe, expect, it } from 'vitest';
import { cellsOf, incrementsOf, projectedStore } from './cell-increments.js';
import { isPromptClass, NO_AXES, poolOf, RECOVERY_CLASS, type Cell } from './cells.js';
import { motifName } from './motif.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';
import { skeletonOf } from './pool-wire.js';
import { deriveRecoveryEdges } from './read-recovery-edge.js';
import { RECOVERY_EDGE_METHOD } from './read.js';

const framed = frame({ shell: 'bash' });
const failed = (n: number, errorCode?: string) =>
  tool('s1', n, 'Bash', { status: 'error', ...(errorCode === undefined ? {} : { errorCode }), steps: [step(n, 0, 'shell.exec', { native: 'Bash', status: 'error', identity: { program: 'git', sub: 'push', flags: [] } })] });
const read = (n: number) => tool('s1', n, 'Read', { steps: [step(n, 0, 'file.read', { native: 'Read' })] });
const edit = (n: number) => tool('s1', n, 'Edit', { steps: [step(n, 0, 'file.edit', { native: 'Edit' })] });

const fixture = () =>
  store({
    sessions: [session('s1', { frame: framed })],
    prompts: [prompt('s1', 0, { frame: framed }), prompt('s1', 1, { frame: framed })],
    // Prompt 0: a 429 then a read, a 429 then an edit, a refusal that nothing followed. Prompt 1: a failure with no captured code (no cell), then an edit of another prompt that is not what followed prompt 0's last call.
    tools: [failed(0, '429'), read(1), failed(2, '429'), edit(3), failed(4, 'user-rejected'), { ...failed(5), prompt: 1 }, { ...edit(6), prompt: 1 }],
  });

const nameOf = (set: ReturnType<typeof cellsOf>, cell: Cell): string => {
  const motif = set.motifs.find(({ motifId }) => motifId === cell.motifId);
  return motif === undefined ? '' : motifName(motif);
};

const recoveryCells = (set: ReturnType<typeof cellsOf>) => set.cells.map((cell) => ({ name: nameOf(set, cell), cell })).filter(({ name }) => name.startsWith(RECOVERY_CLASS));

describe('recovery cells', () => {
  const set = cellsOf(projectedStore(fixture(), storedNames));

  it('are week cells per (failed action, code, next action), none when nothing followed named as an action', () => {
    const cells = recoveryCells(set);
    expect(cells.every(({ cell }) => cell.grain === 'week')).toBe(true);
    expect(cells.every(({ cell }) => cell.frameBucket === `claude-code/2.1.31x/${NO_AXES}`)).toBe(true);
    expect(cells.map(({ name, cell }) => [name, cell.failed, cell.ok]).sort()).toEqual([
      [`${RECOVERY_CLASS}429/shell.exec>file.edit`, 1, 0],
      [`${RECOVERY_CLASS}429/shell.exec>file.read`, 1, 0],
      [`${RECOVERY_CLASS}user-rejected/shell.exec>none`, 1, 0],
    ]);
  });

  it('are not prompt classes, so cost and the class reads skip them', () => {
    expect(isPromptClass(`${RECOVERY_CLASS}429/shell.exec>file.read`)).toBe(false);
  });

  it('are the same cells at the pool as on the machine', () => {
    const [only] = sessionsFrom(fixture());
    const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
    if (skeleton === null) throw new Error('no skeleton');
    const increments = incrementsOf(skeleton);
    const isRecovery = (motifs: readonly { motifId: string; cls: string | null }[], motifId: string): boolean => motifs.some((motif) => motif.motifId === motifId && (motif.cls?.startsWith(RECOVERY_CLASS) ?? false));
    const pooled = [...increments.cells.values()].filter(({ motifId }) => isRecovery(increments.motifs, motifId));
    const local = set.cells.filter(({ motifId }) => isRecovery(set.motifs, motifId));
    expect(pooled.map(({ motifId, frameBucket, failed: count }) => [motifId, frameBucket, count]).sort()).toEqual(local.map(({ motifId, frameBucket, failed: count }) => [motifId, frameBucket, count]).sort());
    expect(pooled).toHaveLength(3);
  });
});

describe('the recovery read', () => {
  const pool = poolOf(cellsOf(projectedStore(fixture(), storedNames)), []);
  const reads = deriveRecoveryEdges({ pool, store: store({}) });

  it('states what others did next after a failed action and code, with the count and the share of those failures', () => {
    const edge = reads.find((one) => one.slice.next === 'file.read');
    expect(edge).toMatchObject({ family: 'recovery', method: RECOVERY_EDGE_METHOD.name, methodVersion: RECOVERY_EDGE_METHOD.version, slice: { action: 'shell.exec', errorCode: '429', next: 'file.read' }, n: 1, value: { followed: 1, of: 2, share: 0.5 } });
    expect(reads.map((one) => one.slice.next).sort()).toEqual(['file.edit', 'file.read', 'none']);
  });

  it('holds no fix, no outcome, and no signature', () => {
    const text = JSON.stringify(reads);
    expect(text).not.toMatch(/fix|outcome|sig|resolved|succe/i);
  });

  it('cites the edge cell only, so a count under the floor in another edge is not lifted by it', () => {
    const edge = reads.find((one) => one.slice.next === 'file.read');
    expect(edge?.inputs).toHaveLength(1);
  });
});
