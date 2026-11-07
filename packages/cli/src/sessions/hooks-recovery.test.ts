// Item 2 of t926: the recovery edge at PostToolUseFailure. A retry cell and a below-floor cell stay silent, a served cell is shown with one row, a held cell is held with one row.
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { slugOf } from './allow.js';
import { indexPath, readIndex } from './hook-index.js';
import { runHook } from './hooks.js';
import { armOf, readRecalls } from './recall-object.js';
import { recoveryDecision, recoveryEdgesOf, RECOVERY_FLOOR, type RecoveryEdge } from './recall-next.js';
import type { Read } from './read.js';
import { signatureOf } from './extract.js';
import { readIdOf } from './recall-reads.js';
import { makeRedactor } from './redact.js';
import { deposit } from './store.js';
import { contextOf, indexAtOf, readOf } from './next-fixtures.js';
import { cleanup, NOW, stage, type Staged } from './test-support.js';

afterEach(cleanup);

const REPO = 'work/app';
const edge = (next: string, followed: number): RecoveryEdge => ({ next, followed, of: 20, clusters: 1, readId: 'read:0123456789abcdef', day: '2026-11-01' });

/** A deposited store whose index carries the given local recovery edges. */
const staged = async (recovery: { [key: string]: RecoveryEdge[] }): Promise<Staged> => {
  const made = stage(slugOf(REPO));
  await deposit(made.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
  const index = await readIndex(made.storeDir);
  writeFileSync(indexPath(made.storeDir), JSON.stringify({ ...index, recoveryByFrame: { 'claude-code/*': recovery } }));
  return made;
};

/** A session id whose arm is the one asked for, for the index's pool version. */
const sessionOn = (made: Staged, arm: 'shown' | 'held', key: string): string => {
  const at = indexAtOf(made.storeDir);
  for (let i = 0; i < 1000; i++) if (armOf(`s${String(i)}`, [key], at) === arm) return `s${String(i)}`;
  throw new Error('no session found');
};

const fail = (session: string, error = 'Exit code 1\nnothing seen before'): string => JSON.stringify({ hook_event_name: 'PostToolUseFailure', session_id: session, tool_name: 'Bash', error });
const text = contextOf;

describe('the recovery edge at PostToolUseFailure', () => {
  const KEY = 'shell.exec/1';

  it('shows a served cell once, with one recalls row', async () => {
    const made = await staged({ [KEY]: [edge('file.read', 12), edge('file.edit', 6)] });
    const session = sessionOn(made, 'shown', KEY);
    const output = await runHook('post-tool', fail(session), made.runtime, () => NOW);
    expect(text(output)).toContain('after a failed shell.exec (1)');
    expect(text(output)).toContain('file.read x12');
    const rows = await readRecalls(made.storeDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sid: session, mode: 'push', arm: 'shown', query: { form: 'question', family: 'recovery', prefix: [KEY] } });
  });

  it('holds a served cell back for the held arm: nothing printed, one row that keeps what it would have shown', async () => {
    const made = await staged({ [KEY]: [edge('file.read', 12)] });
    const session = sessionOn(made, 'held', KEY);
    expect(await runHook('post-tool', fail(session), made.runtime, () => NOW)).toBeUndefined();
    const rows = await readRecalls(made.storeDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ arm: 'held' });
    expect(rows[0]?.answer.rendered).toContain('file.read x12');
  });

  it('stays silent, with no row, when the top next step is a same-step retry', async () => {
    const made = await staged({ [KEY]: [edge('shell.exec', 14), edge('file.read', 3)] });
    expect(await runHook('post-tool', fail(sessionOn(made, 'shown', KEY)), made.runtime, () => NOW)).toBeUndefined();
    expect(await readRecalls(made.storeDir)).toEqual([]);
  });

  it('stays silent, with no row, when a local cell is under the floor', async () => {
    const made = await staged({ [KEY]: [edge('file.read', RECOVERY_FLOOR - 1)] });
    expect(await runHook('post-tool', fail(sessionOn(made, 'shown', KEY)), made.runtime, () => NOW)).toBeUndefined();
    expect(await readRecalls(made.storeDir)).toEqual([]);
  });

  it('stays silent on a below-floor cell even when a recurring signature matches the error', async () => {
    const made = await staged({ [KEY]: [edge('file.read', RECOVERY_FLOOR - 1)] });
    const index = await readIndex(made.storeDir);
    const sig = signatureOf('Bash', 'Exit code 1\nnothing seen before', makeRedactor([]));
    writeFileSync(indexPath(made.storeDir), JSON.stringify({ ...index, signatures: { [sig]: { sessions: 4, followed: [['file.read', 3]] } } }));
    expect(await runHook('post-tool', fail(sessionOn(made, 'shown', KEY)), made.runtime, () => NOW)).toBeUndefined();
    expect(await readRecalls(made.storeDir)).toEqual([]);
  });

  it('stays silent, with no row, when the cell covers the failure and nothing followed it, even when a recurring signature matches', async () => {
    const made = await staged({ [KEY]: [edge('none', RECOVERY_FLOOR + 3)] });
    const index = await readIndex(made.storeDir);
    const sig = signatureOf('Bash', 'Exit code 1\nnothing seen before', makeRedactor([]));
    writeFileSync(indexPath(made.storeDir), JSON.stringify({ ...index, signatures: { [sig]: { sessions: 4, followed: [['file.read', 3]] } } }));
    expect(await runHook('post-tool', fail(sessionOn(made, 'shown', KEY)), made.runtime, () => NOW)).toBeUndefined();
    expect(await readRecalls(made.storeDir)).toEqual([]);
  });

  it('lets the signature line answer a failure no cell covers', async () => {
    const made = await staged({});
    const index = await readIndex(made.storeDir);
    const sig = signatureOf('Bash', 'Exit code 1\nnothing seen before', makeRedactor([]));
    writeFileSync(indexPath(made.storeDir), JSON.stringify({ ...index, signatures: { [sig]: { sessions: 4, followed: [['file.read', 3]] } } }));
    const session = sessionOn(made, 'shown', readIdOf(sig));
    expect(text(await runHook('post-tool', fail(session), made.runtime, () => NOW))).toContain('seen in 4 sessions');
  });

  it('says nothing for a failure with no session, since the arm is the session', async () => {
    const made = await staged({ [KEY]: [edge('file.read', 12)] });
    expect(await runHook('post-tool', JSON.stringify({ tool_name: 'Bash', error: 'Exit code 1\nx' }), made.runtime, () => NOW)).toBeUndefined();
    expect(await readRecalls(made.storeDir)).toEqual([]);
  });
});

describe('recoveryDecision', () => {
  const local = (edges: RecoveryEdge[]) => ({ recovery: { 'shell.exec/1': edges }, poolVersion: 'local' });
  const bundle = (edges: RecoveryEdge[]) => ({ poolVersion: 'bundle', recovery: { 'shell.exec/1': edges }, positions: [] });

  it('prefers the bundle, and counts a bundle edge as past the floor', () => {
    const decision = recoveryDecision(bundle([edge('file.read', 1)]), local([edge('file.edit', 9)]), 'shell.exec', '1');
    expect(decision).toMatchObject({ kind: 'serve', source: 'bundle', poolVersion: 'bundle' });
  });

  it('falls back to the local cells when the bundle has none for this action and code', () => {
    expect(recoveryDecision(bundle([edge('file.read', 9)]), { recovery: { 'shell.exec/2': [edge('file.edit', 9)] }, poolVersion: 'local' }, 'shell.exec', '2')).toMatchObject({ kind: 'serve', source: 'local' });
    expect(recoveryDecision(bundle([]), local([edge('file.edit', 9)]), 'shell.exec', '2')).toEqual({ kind: 'none' });
  });

  it('serves a tie with the retry, is silent on a strict retry lead and on nothing followed, and holds a local cell to the floor', () => {
    expect(recoveryDecision(undefined, local([edge('file.edit', 7), edge('shell.exec', 7)]), 'shell.exec', '1').kind).toBe('serve');
    expect(recoveryDecision(undefined, local([edge('shell.exec', 8), edge('file.edit', 7)]), 'shell.exec', '1').kind).toBe('retry');
    expect(recoveryDecision(undefined, local([edge('none', 9)]), 'shell.exec', '1').kind).toBe('ended');
    expect(recoveryDecision(undefined, local([edge('file.edit', 4)]), 'shell.exec', '1').kind).toBe('floor');
    expect(recoveryDecision(undefined, undefined, 'shell.exec', '1').kind).toBe('none');
  });
});

describe('recoveryEdgesOf', () => {
  const read = (next: string, followed: number, week: string, readId: string): Read =>
    readOf({ readId, family: 'recovery', slice: { action: 'shell.exec', errorCode: '1', next, week }, value: { followed, of: 10, share: followed / 10 }, n: followed, clusters: 1, asOf: { pool: 'p', day: week } });

  it('sums weeks per next step, cites the heaviest week, ignores other families and names that are not actions, and applies the keep rule to the top', () => {
    const reads: Read[] = [read('file.read', 3, '2026-10-26', 'read:a'), read('file.read', 5, '2026-11-02', 'read:b'), read('not an action', 9, '2026-11-02', 'read:c'), { ...read('file.edit', 1, '2026-11-02', 'read:d'), family: 'fit' }];
    // The failures are what followed them over every week (3 + 5 + 9), the same for the one edge that survives the name filter.
    expect(recoveryEdgesOf(reads)['shell.exec/1']).toEqual([{ next: 'file.read', followed: 8, of: 17, clusters: 1, readId: 'read:b', day: '2026-11-02' }]);
    expect(recoveryEdgesOf(reads, (followed) => followed >= 9)).toEqual({});
  });

  it('gives every edge of an action and code one denominator, however many weeks each next step appeared in', () => {
    // file.read followed 4 failures in the first week and 2 in the second; file.edit followed 8 in the second only. 14 failures in all.
    const edges = recoveryEdgesOf([read('file.read', 4, '2026-10-26', 'read:a'), read('file.read', 2, '2026-11-02', 'read:b'), read('file.edit', 8, '2026-11-02', 'read:c')])['shell.exec/1'];
    expect(edges?.map((edge) => [edge.next, edge.followed, edge.of])).toEqual([
      ['file.edit', 8, 14],
      ['file.read', 6, 14],
    ]);
  });
});
