// A reversion the content shows: the digests of an edit and the path a `git restore` names, tied to an earlier edit of the same path. The commit-sha cases are in reversion.test.ts.
import { describe, expect, it } from 'vitest';
import { session, store, tool } from './pool-fixture.js';
import { reversionsOf } from './reversion.js';
import type { ShellSegment, ToolObservation } from './schema.js';

const stamp = (n: number): string => `2026-11-01T10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z`;
const digest = (letter: string): string => letter.repeat(32);

const shell = (id: string, n: number, promptIndex: number | null, runs: readonly string[], over: Partial<ToolObservation> = {}): ToolObservation =>
  tool(id, n, 'Bash', { ts: stamp(n), prompt: promptIndex, segments: runs.map((run): ShellSegment => ({ run, read: true })), ...over });
const commit = (id: string, n: number, promptIndex: number): ToolObservation => shell(id, n, promptIndex, ['git commit'], { commits: ['abc1234'] });
/** An Edit at position `n` of `id`'s line on the path `path`, one `[old, new]` letter pair per edit (a MultiEdit when more than one). */
const edit = (id: string, n: number, promptIndex: number | null, pairs: ReadonlyArray<readonly [string, string]>, over: Partial<ToolObservation> = {}, path = 'p1'): ToolObservation =>
  tool(id, n, pairs.length > 1 ? 'MultiEdit' : 'Edit', { ts: stamp(n), prompt: promptIndex, target: path, digests: pairs.map(([old, now]) => ({ old: digest(old), new: digest(now) })), ...over });
const write = (id: string, n: number, promptIndex: number | null, content: string, over: Partial<ToolObservation> = {}, path = 'p1'): ToolObservation =>
  tool(id, n, 'Write', { ts: stamp(n), prompt: promptIndex, target: path, digests: [{ new: digest(content) }], ...over });
const restore = (id: string, n: number, promptIndex: number | null, paths: readonly string[] = ['p1'], over: Partial<ToolObservation> = {}): ToolObservation =>
  shell(id, n, promptIndex, ['git restore'], { restores: [...paths], ...over });

/** The reversion each prompt reads, with `repos` the repository of sessions `s` and `t`. */
const read = (tools: ToolObservation[], repos: readonly [string | null, string | null] = ['r', 'r']) => {
  const found = reversionsOf(store({ sessions: [session('s', { repo: repos[0] }), session('t', { repo: repos[1] })], tools }));
  return { s0: found('s', 0), s1: found('s', 1), t0: found('t', 0) };
};

describe('a later reversion tied to an edit by its digests', () => {
  it('reads an edit whose old and new text are the swap of an earlier edit of the path, in the prompt, a later prompt, and a later session', () => {
    expect(read([edit('s', 1, 0, [['a', 'b']]), edit('s', 2, 0, [['b', 'a']])]).s0).toBe('same-prompt');
    expect(read([edit('s', 1, 0, [['a', 'b']]), edit('s', 2, 1, [['b', 'a']])]).s0).toBe('later-prompt');
    expect(read([edit('s', 1, 0, [['a', 'b']]), edit('t', 10, 0, [['b', 'a']])]).s0).toBe('later-session');
  });

  it('puts the reversion on the prompt of the edit it undid, and on no other', () => {
    expect(read([edit('s', 1, 0, [['a', 'b']]), edit('s', 2, 1, [['b', 'a']])])).toEqual({ s0: 'later-prompt', s1: null, t0: null });
  });

  it('reads the swap inside one MultiEdit and across a MultiEdit and an Edit', () => {
    expect(read([edit('s', 1, 0, [['a', 'b'], ['c', 'd'], ['b', 'a']])]).s0).toBe('same-prompt');
    expect(read([edit('s', 1, 0, [['a', 'b'], ['c', 'd']]), edit('s', 2, 1, [['d', 'c']])]).s0).toBe('later-prompt');
  });

  it('does not read an edit that repeats earlier text without undoing it', () => {
    // The same change again, a change that goes on from the new text, and an edit whose new text is the earlier old text but whose old text is something else.
    expect(read([edit('s', 1, 0, [['a', 'b']]), edit('s', 2, 1, [['a', 'b']])]).s0).toBeNull();
    expect(read([edit('s', 1, 0, [['a', 'b']]), edit('s', 2, 1, [['b', 'c']])]).s0).toBeNull();
    expect(read([edit('s', 1, 0, [['a', 'b']]), edit('s', 2, 1, [['c', 'a']])]).s0).toBeNull();
  });

  it('does not read an edit of another path, an edit before the one it would undo, a no-op edit, a failed edit, or a subagent edit', () => {
    expect(read([edit('s', 1, 0, [['a', 'b']]), edit('s', 2, 1, [['b', 'a']], {}, 'p2')]).s0).toBeNull();
    expect(read([edit('s', 2, 0, [['a', 'b']]), edit('s', 1, 1, [['b', 'a']])]).s0).toBeNull();
    expect(read([edit('s', 1, 0, [['a', 'a']]), edit('s', 2, 1, [['a', 'a']])]).s0).toBeNull();
    expect(read([edit('s', 1, 0, [['a', 'b']]), edit('s', 2, 1, [['b', 'a']], { status: 'error' })]).s0).toBeNull();
    expect(read([edit('s', 1, 0, [['a', 'b']], { status: 'error' }), edit('s', 2, 1, [['b', 'a']])]).s0).toBeNull();
    expect(read([edit('s', 1, 0, [['a', 'b']]), edit('s', 2, 1, [['b', 'a']], { side: true })]).s0).toBeNull();
    expect(read([edit('s', 1, 0, [['a', 'b']]), edit('t', 10, 0, [['b', 'a']])], ['r', 'other']).s0).toBeNull();
  });

  it('reads a Write whose new text equals an earlier Write of the path with a different Write between, on the prompt of the Write between', () => {
    expect(read([write('s', 1, 0, 'a'), write('s', 2, 1, 'b'), write('s', 3, 1, 'a')])).toEqual({ s0: null, s1: 'same-prompt', t0: null });
    expect(read([write('s', 1, 0, 'a'), write('s', 2, 1, 'b'), write('s', 3, 2, 'a')]).s1).toBe('later-prompt');
    expect(read([write('s', 1, 0, 'a'), write('s', 2, 0, 'b'), write('t', 10, 0, 'a')]).s0).toBe('later-session');
  });

  it('does not read a Write that repeats a Write with none between, with only an Edit between, or with another path between', () => {
    expect(read([write('s', 1, 0, 'a'), write('s', 2, 1, 'a')]).s1).toBeNull();
    expect(read([write('s', 1, 0, 'a'), write('s', 2, 1, 'a'), write('s', 3, 2, 'a')])).toEqual({ s0: null, s1: null, t0: null });
    expect(read([write('s', 1, 0, 'a'), edit('s', 2, 1, [['x', 'y']]), write('s', 3, 2, 'a')]).s1).toBeNull();
    expect(read([write('s', 1, 0, 'a'), write('s', 2, 1, 'b', {}, 'p2'), write('s', 3, 2, 'a')]).s1).toBeNull();
    expect(read([write('s', 1, 0, 'a'), write('s', 2, 1, 'b'), write('s', 3, 2, 'c')]).s1).toBeNull();
  });
});

describe('a later reversion tied to an edit by a git restore of its path', () => {
  it('reads a restore of a path an earlier edit or Write changed, in the prompt, a later prompt, and a later session', () => {
    expect(read([edit('s', 1, 0, [['a', 'b']]), restore('s', 2, 0)]).s0).toBe('same-prompt');
    expect(read([write('s', 1, 0, 'a'), restore('s', 2, 1)]).s0).toBe('later-prompt');
    expect(read([edit('s', 1, 0, [['a', 'b']]), restore('t', 10, 0)]).s0).toBe('later-session');
    expect(read([edit('s', 1, 0, [['a', 'b']]), restore('s', 2, 1, ['p2', 'p1'])])).toEqual({ s0: 'later-prompt', s1: null, t0: null });
  });

  it('reads an edit captured with no digest, since the path is the tie', () => {
    expect(read([edit('s', 1, 0, [['a', 'b']], { digests: undefined }), restore('s', 2, 1)]).s0).toBe('later-prompt');
  });

  it('does not read a restore of another path, before the edit, or from a call that failed or ran in a subagent', () => {
    expect(read([edit('s', 1, 0, [['a', 'b']]), restore('s', 2, 1, ['p2'])]).s0).toBeNull();
    expect(read([restore('s', 1, 0), edit('s', 2, 1, [['a', 'b']])]).s0).toBeNull();
    expect(read([edit('s', 1, 0, [['a', 'b']]), restore('s', 2, 1, ['p1'], { status: 'error' })]).s0).toBeNull();
    expect(read([edit('s', 1, 0, [['a', 'b']]), restore('s', 2, 1, ['p1'], { side: true })]).s0).toBeNull();
    expect(read([edit('s', 1, 0, [['a', 'b']], { status: 'error' }), restore('s', 2, 1)]).s0).toBeNull();
  });

  it('does not read an edit a commit has kept since: the restore returns to that commit, not to earlier content', () => {
    expect(read([edit('s', 1, 0, [['a', 'b']]), commit('s', 2, 0), restore('s', 3, 1)]).s0).toBeNull();
    expect(read([edit('s', 1, 0, [['a', 'b']]), commit('s', 2, 0), restore('t', 10, 0)]).s0).toBeNull();
    expect(read([edit('s', 1, 0, [['a', 'b']]), commit('t', 8, 0), restore('t', 10, 0)]).s0).toBeNull();
    // A commit before the edit does not keep it.
    expect(read([commit('s', 1, 0), edit('s', 2, 0, [['a', 'b']]), restore('s', 3, 1)]).s0).toBe('later-prompt');
  });
});
