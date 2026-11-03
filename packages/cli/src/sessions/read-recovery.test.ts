import { describe, expect, it } from 'vitest';
import { error, poolFrom, prompt, session, store, tool } from './pool-fixture.js';
import { contentHash } from './read.js';
import { deriveRecovery } from './read-recovery.js';
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

  it('cites the failed call and the window to the step after it, on the days it occurred', () => {
    const pool = poolFrom(failed);
    const [one] = deriveRecovery({ pool, store: { ...failed, errors: [error('s1', SIG, { next: ['Edit'] })] } });
    const [bare] = deriveRecovery({ pool, store: { ...failed, errors: [error('s1', SIG)] } });
    expect(one?.inputs).toHaveLength(2);
    expect(bare?.inputs).toHaveLength(1);
    expect(deriveRecovery({ pool, store: { ...failed, errors: [error('s1', SIG, { ts: '2026-10-01T10:00:00.000Z' })] } })).toEqual([]);
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
