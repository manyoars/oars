import { describe, expect, it } from 'vitest';
import { error, frame, poolFrom, prompt, session, store, tool } from './pool-fixture.js';
import { contentHash } from './read.js';
import { deriveRecovery, recoveryOf } from './read-recovery.js';
import type { Store } from './store.js';

const SIG = 'Read | no such file /home/someone/secret.txt';
const recovery = (from: Store) => deriveRecovery({ pool: poolFrom(from), store: from });
const failed = store({
  sessions: [session('s1')],
  prompts: [prompt('s1', 0)],
  tools: [tool('s1', 0, 'Read', { status: 'error' }), tool('s1', 1, 'Edit'), tool('s1', 2, 'Read', { status: 'error' }), tool('s1', 3, 'Edit')],
});

describe('recovery', () => {
  it('turns a signature record into a read, holding its hash and public names only', () => {
    const reads = recovery({
      ...failed,
      errors: [error('s1', SIG, { next: ['Edit', 'Read'], editFollowed: true }), error('s1', SIG, { next: ['Edit'], ts: '2026-11-02T10:00:00.000Z' })],
    });
    expect(reads).toHaveLength(1);
    const [read] = reads;
    expect(read?.family).toBe('recovery');
    expect(read?.slice).toEqual({ sig: contentHash(SIG), action: 'file.read' });
    expect(read?.value).toEqual({ sessions: 1, errors: 2, firstSeen: '2026-11-01', lastSeen: '2026-11-02', following: { 'file.edit': 2, 'file.read': 1 }, editFollowed: 1 });
    expect(read?.n).toBe(2);
    expect(JSON.stringify(read)).not.toContain('secret');
    expect(JSON.stringify(read)).not.toContain('no such file');
  });

  it('keeps the same copy of a call whatever the record order when its copies tie on time', () => {
    for (const ts of ['2026-11-01T10:00:00.000Z', null]) {
      const one = error('s1', 'Read | one', { toolUseId: 'call-1', ts });
      const other = error('s1', 'Read | other', { toolUseId: 'call-1', ts });
      expect(recovery({ ...failed, errors: [other, one] })[0]?.slice).toEqual(recovery({ ...failed, errors: [one, other] })[0]?.slice);
    }
  });

  it('counts one row per session and tool-use id, and a row with no id as its own call', () => {
    const first = error('s1', SIG, { toolUseId: 'call-1', next: ['Edit'] });
    const replay = error('s1', SIG, { toolUseId: 'call-1', next: ['Edit'], ts: '2026-11-02T10:00:00.000Z' });
    const [read] = recovery({ ...failed, errors: [first, replay] });
    expect(read?.value).toMatchObject({ errors: 1, sessions: 1, firstSeen: '2026-11-01', lastSeen: '2026-11-01', following: { 'file.edit': 1 } });
    expect(read?.n).toBe(1);
    expect(recovery({ ...failed, errors: [replay, first] })).toEqual(recovery({ ...failed, errors: [first, replay] }));
    expect(recovery({ ...failed, errors: [error('s1', SIG, { toolUseId: null }), error('s1', SIG, { toolUseId: null })] })[0]?.n).toBe(2);
    expect(recovery({ ...failed, errors: [first, { ...first, session: 's2' }] })[0]?.n).toBe(2);
    expect(recovery({ ...failed, errors: [first, { ...first, agent: 's1~agent-a' }] })[0]?.n).toBe(2);
    expect(recovery({ ...failed, errors: [{ ...first, ts: null }, first] })[0]?.value.firstSeen).toBe('2026-11-01');
  });

  it('cites the failed call and the window to the step after it, on the days it occurred', () => {
    const pool = poolFrom(failed);
    const [one] = deriveRecovery({ pool, store: { ...failed, errors: [error('s1', SIG, { next: ['Edit'] })] } });
    const [bare] = deriveRecovery({ pool, store: { ...failed, errors: [error('s1', SIG)] } });
    expect(one?.inputs).toHaveLength(2);
    expect(bare?.inputs).toHaveLength(1);
    expect(deriveRecovery({ pool, store: { ...failed, errors: [error('s1', SIG, { ts: '2026-10-01T10:00:00.000Z', prompt: null })] } })).toEqual([]);
  });

  it('keeps a signature whose error has no timestamp on its prompt frame day, and finds no cell for a frame of no day: a day cell exists only for a known day', () => {
    expect(recovery({ ...failed, errors: [error('s1', SIG, { ts: null })] })).toHaveLength(1);
    const undated = store({ sessions: [session('s1')], prompts: [prompt('s1', 0, { frame: frame({ day: null }) })], tools: [tool('s1', 0, 'Read', { status: 'error' })] });
    expect(recovery({ ...undated, errors: [error('s1', SIG, { ts: null })] })).toEqual([]);
    // A failed week cell of the action exists, so the drop is named for the frame's missing day and not for a missing cell.
    const outcome = recoveryOf({ pool: poolFrom(undated), store: { ...undated, errors: [error('s1', SIG, { ts: null })] } });
    expect(outcome.dropped).toEqual({ 'no-cell-of-action': 0, 'no-failed-cell-of-action': 0, 'no-failed-cell-on-day': 0, 'frame-has-no-day': 1 });
    // A step after the failure changes nothing: a week cell exists at the unknown week, but a frame of no day names no week to look in.
    const stepped = { ...undated, tools: [...undated.tools, tool('s1', 1, 'Edit')] };
    const withNext = recoveryOf({ pool: poolFrom(stepped), store: { ...stepped, errors: [error('s1', SIG, { ts: null, next: ['Edit'] })] } });
    expect(withNext.reads).toEqual([]);
    expect(withNext.dropped).toEqual({ 'no-cell-of-action': 0, 'no-failed-cell-of-action': 0, 'no-failed-cell-on-day': 0, 'frame-has-no-day': 1 });
  });

  it('finds the call of an error past midnight on its prompt frame day, and keeps the error its own day', () => {
    const [read] = recovery({ ...failed, errors: [error('s1', SIG, { ts: '2026-11-02T00:10:00.000Z', next: ['Edit'] })] });
    expect(read?.inputs).toHaveLength(2);
    expect(read?.value.firstSeen).toBe('2026-11-02');
  });

  it('reads the day of a prompt with no frame from its own timestamp', () => {
    const old = store({ sessions: [session('s1')], prompts: [prompt('s1', 0, { frame: undefined, ts: '2026-11-01T23:50:00.000Z' })], tools: [tool('s1', 0, 'Read', { status: 'error', ts: '2026-11-01T23:51:00.000Z' })] });
    expect(recovery({ ...old, errors: [error('s1', SIG, { ts: '2026-11-02T00:10:00.000Z' })] })).toHaveLength(1);
  });

  it('finds the call of a subagent or of no prompt on its session frame day', () => {
    const line = [tool('s1~a', 0, 'Read', { status: 'error', parent: 's1', prompt: null })];
    const framed = store({ sessions: [session('s1')], subagents: [session('s1~a', { parent: 's1', frame: frame({ day: '2026-11-03' }) })], prompts: [prompt('s1', 0)], tools: line });
    expect(recovery({ ...framed, errors: [error('s1', SIG, { agent: 's1~a', ts: '2026-11-04T00:05:00.000Z' })] })).toHaveLength(1);
    const old = store({ sessions: [session('s1')], subagents: [session('s1~a', { parent: 's1', tsFirst: '2026-11-03T23:00:00.000Z' })], tools: line });
    expect(recovery({ ...old, errors: [error('s1', SIG, { agent: 's1~a', ts: '2026-11-04T00:05:00.000Z' })] })).toHaveLength(1);
    const early = store({ sessions: [session('s1', { frame: frame({ day: '2026-11-03' }) })], tools: [tool('s1', 0, 'Read', { status: 'error', prompt: null })] });
    expect(recovery({ ...early, errors: [error('s1', SIG, { prompt: null, ts: '2026-11-04T00:05:00.000Z' })] })).toHaveLength(1);
  });

  it('states why a signature record has no read, and accounts for every record', () => {
    const elsewhere = { ...failed, errors: [error('s1', SIG, { ts: '2026-10-01T10:00:00.000Z', prompt: null })] };
    expect(recoveryOf({ pool: poolFrom(elsewhere), store: elsewhere }).dropped).toEqual({ 'no-cell-of-action': 0, 'no-failed-cell-of-action': 0, 'no-failed-cell-on-day': 1, 'frame-has-no-day': 0 });
    const clean = store({ sessions: [session('s1')], prompts: [prompt('s1', 0)], tools: [tool('s1', 0, 'Read')], errors: [error('s1', SIG)] });
    expect(recoveryOf({ pool: poolFrom(clean), store: clean }).dropped).toEqual({ 'no-cell-of-action': 0, 'no-failed-cell-of-action': 1, 'no-failed-cell-on-day': 0, 'frame-has-no-day': 0 });
    const none = store({ sessions: [session('s1')], errors: [error('s1', SIG), error('s1', 'Read | another'), { ...error('s1', 'Bash | third'), tool: 'Bash' }] });
    const outcome = recoveryOf({ pool: poolFrom(none), store: none });
    expect(outcome.reads).toEqual([]);
    expect(outcome.dropped).toEqual({ 'no-cell-of-action': 3, 'no-failed-cell-of-action': 0, 'no-failed-cell-on-day': 0, 'frame-has-no-day': 0 });
    const kept = { ...failed, errors: [error('s1', SIG)] };
    expect(recoveryOf({ pool: poolFrom(kept), store: kept }).reads).toEqual(deriveRecovery({ pool: poolFrom(kept), store: kept }));
  });

  it('is not a read when the failed call is in no cell', () => {
    expect(recovery({ ...store({ sessions: [session('s1')] }), errors: [error('s1', SIG)] })).toEqual([]);
    expect(recovery(store({ ...failed, tools: [tool('s1', 0, 'Read')], errors: [error('s1', SIG)] }))).toEqual([]);
  });

  it('reads a subagent error under the subagent, and an unknown session under the default table', () => {
    const subagent = session('s1~agent-a', { parent: 's1' });
    const under = store({ sessions: [session('s1')], subagents: [subagent], prompts: [prompt('s1', 0)], tools: [tool('s1', 0, 'Read', { status: 'error' })], errors: [error('s1', SIG, { agent: 's1~agent-a' })] });
    expect(recovery(under)[0]?.slice.action).toBe('file.read');
    expect(recovery({ ...failed, errors: [error('gone', SIG)] })[0]?.slice.action).toBe('file.read');
  });
});
