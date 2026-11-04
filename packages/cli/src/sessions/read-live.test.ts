import { describe, expect, it } from 'vitest';
import { frame, poolFrom, prompt, session, step, store, tool } from './pool-fixture.js';
import { deriveLive } from './read-live.js';
import type { Store } from './store.js';

const live = (from: Store) => deriveLive({ pool: poolFrom(from), store: from });
const on = (day: string, index: number) => prompt('s1', index, { frame: frame({ day }) });

describe('live', () => {
  const reads = live(
    store({
      sessions: [session('s1')],
      prompts: [on('2026-10-20', 0), on('2026-11-01', 1), on('2026-11-02', 2)],
      tools: [
        tool('s1', 0, 'Read', { prompt: 0 }),
        tool('s1', 1, 'Read', { prompt: 1 }),
        tool('s1', 2, 'Read', { prompt: 1 }),
        tool('s1', 3, 'Read', { prompt: 1 }),
        tool('s1', 4, 'Edit', { prompt: 1 }),
        tool('s1', 5, 'Read', { prompt: 2 }),
        tool('s1', 6, 'Write', { prompt: 2 }),
      ],
    }),
  );
  const of = (motif: string, day: string) => reads.find((read) => read.slice.motif === motif && read.slice.day === day);

  it('states a day share beside its share of the trailing week, and flags nothing', () => {
    expect(of('file.read', '2026-11-02')?.value).toEqual({ share: 0.5, baseline: 0.75, of: 2, ratio: 0.6667 });
    expect(of('file.read', '2026-11-02')?.n).toBe(1);
    // The day's cells only: the baseline is stated but never cited, so a pool's floor cannot lean on it.
    expect(of('file.read', '2026-11-02')?.inputs).toHaveLength(1);
  });

  it('keeps a day outside the seven before it out of the baseline', () => {
    expect(of('file.read', '2026-11-01')?.value).toEqual({ share: 0.75, baseline: null, of: 4, ratio: null });
  });

  it('states no ratio over a baseline of nothing', () => {
    expect(of('file.write', '2026-11-02')?.value).toEqual({ share: 0.5, baseline: 0, of: 2, ratio: null });
  });

  it('reads shapes only, and leaves out an unknown day and a step with no result', () => {
    const git = { program: 'git', sub: null, flags: [] };
    expect(live(store({ sessions: [session('s1')], prompts: [prompt('s1', 0)], tools: [tool('s1', 0, 'Bash', { steps: [step(0, 0, 'shell.exec', { identity: git })] })] })).map((read) => read.slice.motif)).toEqual(['shell.exec']);
    expect(live(store({ sessions: [session('s1')], prompts: [prompt('s1', 0, { frame: frame({ day: 'unknown' }) })], tools: [tool('s1', 0, 'Read')] }))).toEqual([]);
    expect(live(store({ sessions: [session('s1')], prompts: [prompt('s1', 0)], tools: [tool('s1', 0, 'Read', { status: 'none' })] }))).toEqual([]);
  });
});
