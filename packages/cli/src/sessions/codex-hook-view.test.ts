import { describe, expect, it } from 'vitest';
import { hookRowOf, type HookRow } from './codex-hook.js';
import { payloadOf } from './codex-hook-support.js';
import { separateHookRows } from './codex-hook-view.js';

const rowOf = (session: string, over: { [key: string]: unknown } = {}): HookRow => {
  const row = hookRowOf(payloadOf('PostToolUse', { session_id: session, ...over }), '2026-11-09T12:00:00.000Z', '/home/me', () => null);
  if (row === undefined) throw new Error('The fixture payload made no row.');
  return row;
};

describe('hook rows beside the store reader', () => {
  it('leaves the reader\'s record standing and shows the hook rows beside it, unchanged', () => {
    const rows = [rowOf('a'), rowOf('a', { tool_use_id: 'call_2' })];
    const [group] = separateHookRows(rows, new Set(['a']));
    expect(group).toMatchObject({ session: 'a', agentId: null, standing: 'beside', degraded: false });
    // The same objects, in order: nothing is copied into a reader record, and the view holds no reader record to count them in.
    expect(group?.rows).toEqual(rows);
    expect(group?.rows[0]).toBe(rows[0]);
    expect(Object.keys(group ?? {}).sort()).toEqual(['agentId', 'degraded', 'rows', 'session', 'standing']);
  });

  it('lets the hook rows stand alone, marked degraded, when the reader refuses the rollout', () => {
    const groups = separateHookRows([rowOf('a'), rowOf('b')], new Set(['a']));
    expect(groups.map((group) => [group.session, group.standing, group.degraded])).toEqual([
      ['a', 'beside', false],
      ['b', 'alone', true],
    ]);
    expect(separateHookRows([rowOf('a')], new Set())[0]).toMatchObject({ standing: 'alone', degraded: true });
  });

  it('never keys a subagent row to the parent thread\'s rollout, even when the reader holds that rollout', () => {
    const parent = rowOf('a');
    const child = rowOf('a', { agent_id: 'agent_9' });
    const groups = separateHookRows([parent, child], new Set(['a']));
    expect(groups.map((group) => [group.session, group.agentId, group.standing, group.degraded])).toEqual([
      ['a', null, 'beside', false],
      ['a', 'agent_9', 'alone', true],
    ]);
  });

  it('keeps a row with no session id alone', () => {
    const payload = payloadOf('PostToolUse');
    delete payload.session_id;
    const row = hookRowOf(payload, '2026-11-09T12:00:00.000Z', '/home/me', () => null);
    expect(separateHookRows(row === undefined ? [] : [row], new Set(['a']))[0]).toMatchObject({ session: null, standing: 'alone' });
  });
});
