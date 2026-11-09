import { describe, expect, it } from 'vitest';
import { session, store, tool } from './pool-fixture.js';
import { reversionsOf } from './reversion.js';
import type { ShellSegment, ToolObservation } from './schema.js';

const stamp = (n: number): string => `2026-11-01T10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z`;

/** A shell call at position `n` of `id`'s line, under prompt `promptIndex`, with the segments and commits it holds. */
const shell = (id: string, n: number, promptIndex: number | null, runs: readonly string[], over: Partial<ToolObservation> = {}): ToolObservation =>
  tool(id, n, 'Bash', { ts: stamp(n), prompt: promptIndex, segments: runs.map((run): ShellSegment => ({ run, read: true })), ...over });
const commit = (id: string, n: number, promptIndex: number, sha: string | null = 'abc1234'): ToolObservation => shell(id, n, promptIndex, ['git commit'], { commits: [sha] });
const revert = (id: string, n: number, promptIndex: number | null, run = 'git revert abc1234', over: Partial<ToolObservation> = {}): ToolObservation => shell(id, n, promptIndex, [run], over);

/** The reversion each prompt of `s` reads, with `repo` the repository both sessions sit in. */
const read = (tools: ToolObservation[], repos: readonly [string | null, string | null] = ['r', 'r']) => {
  const found = reversionsOf(store({ sessions: [session('s', { repo: repos[0] }), session('t', { repo: repos[1] })], tools }));
  return { s0: found('s', 0), s1: found('s', 1), t0: found('t', 0) };
};

describe('a later reversion tied to a commit by its sha', () => {
  it('reads a clean revert in the same prompt, a later prompt, and a later session of the same repository', () => {
    expect(read([commit('s', 1, 0), revert('s', 2, 0)]).s0).toBe('same-prompt');
    expect(read([commit('s', 1, 0), revert('s', 2, 1)]).s0).toBe('later-prompt');
    expect(read([commit('s', 1, 0), revert('t', 10, 0)]).s0).toBe('later-session');
  });

  it('names the nearest reversion when more than one ties to the commit', () => {
    expect(read([commit('s', 1, 0), revert('t', 10, 0), revert('s', 4, 1)]).s0).toBe('later-prompt');
    expect(read([commit('s', 1, 0), revert('s', 2, 1), revert('s', 3, 0)]).s0).toBe('same-prompt');
  });

  it('puts the reversion on the prompt that made the commit, and on no other', () => {
    expect(read([commit('s', 1, 0), revert('s', 2, 1)])).toEqual({ s0: 'later-prompt', s1: null, t0: null });
  });

  it('matches the word to the sha as a prefix in either direction, and by lower case', () => {
    expect(read([commit('s', 1, 0, 'abc1234def5678'), revert('s', 2, 1, 'git revert abc1234')]).s0).toBe('later-prompt');
    expect(read([commit('s', 1, 0, 'abc1234'), revert('s', 2, 1, 'git revert abc1234def5678')]).s0).toBe('later-prompt');
    expect(read([commit('s', 1, 0, 'abc1234'), revert('s', 2, 1, 'git revert ABC1234')]).s0).toBe('later-prompt');
  });

  it('reads each word a revert names', () => {
    expect(read([commit('s', 1, 0, 'def5678'), revert('s', 2, 1, 'git revert abc1234 def5678')]).s0).toBe('later-prompt');
  });

  it('reads a revert behind another command of the call when its own result is the call result', () => {
    const behind = shell('s', 2, 1, ['cd', 'git revert abc1234']);
    expect(read([commit('s', 1, 0), behind]).s0).toBe('later-prompt');
  });

  it.each<[string, () => ToolObservation[]]>([
    ['a word that is not a sha: HEAD, a branch, a range', () => [commit('s', 1, 0), revert('s', 2, 1, 'git revert HEAD'), revert('s', 3, 1, 'git revert main'), revert('s', 4, 1, 'git revert abc1234..def5678')]],
    ['a word too short to name a commit', () => [commit('s', 1, 0), revert('s', 2, 1, 'git revert abc12')]],
    ['a sha that is not the commit', () => [commit('s', 1, 0), revert('s', 2, 1, 'git revert fff9999')]],
    ['a revert that failed', () => [commit('s', 1, 0), revert('s', 2, 1, 'git revert abc1234', { status: 'error' })]],
    ['a revert whose result the call does not report', () => [commit('s', 1, 0), shell('s', 2, 1, ['git revert abc1234'], { segments: [{ run: 'git revert abc1234', read: false }] })]],
    ['a revert ended by --abort or --continue', () => [commit('s', 1, 0), revert('s', 2, 1, 'git revert'), revert('s', 3, 1, 'git revert --abort')]],
    ['a git restore or reset, which names no commit', () => [commit('s', 1, 0), revert('s', 2, 1, 'git restore'), revert('s', 3, 1, 'git reset')]],
    ['a revert run before the commit', () => [revert('s', 1, 0), commit('s', 2, 0)]],
    ['a revert that is the same call as the commit', () => [shell('s', 1, 0, ['git commit', 'git revert abc1234'], { commits: ['abc1234'] })]],
    ['a revert from a subagent, which is not the main line', () => [commit('s', 1, 0), revert('s', 2, 1, 'git revert abc1234', { side: true })]],
    ['a call with no segments, captured before they were kept', () => [commit('s', 1, 0), tool('s', 2, 'Bash', { ts: stamp(2), prompt: 1, target: 'git revert abc1234' })]],
    ['a revert call under no prompt', () => [commit('s', 1, 0), revert('s', 2, null)]],
  ])('reads no reversion for %s', (_name, calls) => {
    expect(read(calls()).s0).toBeNull();
  });

  it('reads a commit with no sha, a commit that failed, and a commit from a subagent as nothing to tie', () => {
    expect(read([commit('s', 1, 0, null), revert('s', 2, 1)]).s0).toBeNull();
    expect(read([{ ...commit('s', 1, 0), status: 'error' }, revert('s', 2, 1)]).s0).toBeNull();
    expect(read([{ ...commit('s', 1, 0), side: true }, revert('s', 2, 1)]).s0).toBeNull();
  });

  it('reads no reversion across sessions unless both sit in one known repository, and the revert is later by its time', () => {
    expect(read([commit('s', 1, 0), revert('t', 10, 0)], ['r', 'other']).s0).toBeNull();
    expect(read([commit('s', 1, 0), revert('t', 10, 0)], [null, null]).s0).toBeNull();
    // `t` ran before the commit, and a call with no time cannot be ordered.
    expect(read([commit('s', 100, 0), revert('t', 10, 0)]).s0).toBeNull();
    expect(read([commit('s', 1, 0), revert('t', 10, 0, 'git revert abc1234', { ts: null })]).s0).toBeNull();
    expect(read([{ ...commit('s', 1, 0), ts: null }, revert('t', 10, 0)]).s0).toBeNull();
  });

  it('reads no reversion for a commit under no prompt, and none for a session the store does not hold', () => {
    const unprompted = reversionsOf(store({ sessions: [session('s')], tools: [{ ...commit('s', 1, 0), prompt: null }, revert('s', 2, 1)] }));
    expect(unprompted('s', 0)).toBeNull();
    expect(unprompted('s', null)).toBeNull();
    expect(reversionsOf(store({ tools: [commit('s', 1, 0), revert('s', 2, 1)] }))('s', 0)).toBe('later-prompt');
    expect(reversionsOf(store({ tools: [commit('s', 1, 0), revert('t', 10, 0)] }))('s', 0)).toBeNull();
  });
});
