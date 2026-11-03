import { describe, expect, it } from 'vitest';
import { frame, poolFrom, prompt, session, step, store, tool } from './pool-fixture.js';
import { deriveFit } from './read-fit.js';
import type { Store } from './store.js';

const fit = (from: Store) => deriveFit({ pool: poolFrom(from), store: from });

describe('fit', () => {
  it('states a tool failure rate in its frame, leaving out a step with no result', () => {
    const [read, ...rest] = fit(
      store({
        sessions: [session('s1')],
        prompts: [prompt('s1', 0)],
        tools: [tool('s1', 0, 'Read'), tool('s1', 1, 'Read', { status: 'error' }), tool('s1', 2, 'Read'), tool('s1', 3, 'Read', { status: 'none' })],
      }),
    );
    expect(rest).toEqual([]);
    expect(read?.slice).toEqual({ motif: 'file.read', level: 'shape', harness: 'claude-code', harnessBucket: '2.1.31x', model: 'claude-opus-5-5', effort: 'high' });
    expect(read?.value).toEqual({ failureRate: 0.3333, failed: 1, ok: 2 });
    expect(read?.n).toBe(3);
    expect(read?.interval?.low).toBeLessThan(0.3333);
    expect(read?.interval?.high).toBeGreaterThan(0.3333);
  });

  it('keeps two models apart, and pools the days of one frame bucket', () => {
    const reads = fit(
      store({
        sessions: [session('s1')],
        prompts: [prompt('s1', 0), prompt('s1', 1, { frame: frame({ model: 'claude-sonnet-5-5' }) }), prompt('s1', 2, { frame: frame({ day: '2026-11-02' }) })],
        tools: [tool('s1', 0, 'Read'), tool('s1', 1, 'Read', { prompt: 1, status: 'error' }), tool('s1', 2, 'Read', { prompt: 2 })],
      }),
    );
    expect(reads.map((read) => [read.slice.model, read.n, read.inputs.length]).sort()).toEqual([
      ['claude-opus-5-5', 2, 2],
      ['claude-sonnet-5-5', 1, 1],
    ]);
  });

  it('adds a named read beside its shape when capture knows the identity', () => {
    const git = { program: 'git', sub: null, flags: [] };
    const reads = fit(store({ sessions: [session('s1')], prompts: [prompt('s1', 0)], tools: [tool('s1', 0, 'Bash', { steps: [step(0, 0, 'shell.exec', { identity: git })] })] }));
    expect(reads.map((read) => [read.slice.level, read.slice.motif]).sort()).toEqual([
      ['named', 'shell.exec[program=git]'],
      ['shape', 'shell.exec'],
    ]);
  });

  it('says nothing of a tool with no settled step', () => {
    expect(fit(store({ sessions: [session('s1')], prompts: [prompt('s1', 0)], tools: [tool('s1', 0, 'Read', { status: 'none' })] }))).toEqual([]);
  });
});
