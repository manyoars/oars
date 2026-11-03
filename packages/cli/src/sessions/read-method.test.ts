import { describe, expect, it } from 'vitest';
import { frame, poolFrom, prompt, session, store, tool } from './pool-fixture.js';
import { deriveMethod } from './read-method.js';
import type { Store } from './store.js';

const method = (from: Store) => deriveMethod({ pool: poolFrom(from), store: from });

describe('method', () => {
  const reads = method(
    store({
      sessions: [session('s1')],
      prompts: [prompt('s1', 0), prompt('s1', 1, { frame: frame({ model: 'claude-sonnet-5-5' }) })],
      tools: [tool('s1', 0, 'Read'), tool('s1', 1, 'Edit', { status: 'error' }), tool('s1', 2, 'Read'), tool('s1', 3, 'Read', { prompt: 1 }), tool('s1', 4, 'Edit', { prompt: 1 })],
    }),
  );
  const of = (motif: string, model: string) => reads.find((read) => read.slice.motif === motif && read.slice.model === model);

  it('states a shape share among windows of its length, per model', () => {
    expect(of('file.read>file.edit', 'claude-opus-5-5')?.value).toEqual({ share: 0.5, of: 2, failureRate: 1 });
    expect(of('file.edit>file.read', 'claude-opus-5-5')?.value).toEqual({ share: 0.5, of: 2, failureRate: 0 });
    expect(of('file.read>file.edit>file.read', 'claude-opus-5-5')?.value).toEqual({ share: 1, of: 1, failureRate: 0 });
    expect(of('file.read>file.edit', 'claude-sonnet-5-5')?.value).toEqual({ share: 1, of: 1, failureRate: 0 });
    expect(of('file.read>file.edit>file.read', 'claude-opus-5-5')?.slice.length).toBe('3');
  });

  it('reads no one-step window', () => {
    expect(reads.every((read) => read.slice.motif?.includes('>') === true)).toBe(true);
    expect(reads).toHaveLength(4);
  });

  it('says nothing of a window whose last step has no result', () => {
    expect(method(store({ sessions: [session('s1')], prompts: [prompt('s1', 0)], tools: [tool('s1', 0, 'Read'), tool('s1', 1, 'Edit', { status: 'none' })] }))).toEqual([]);
  });
});
