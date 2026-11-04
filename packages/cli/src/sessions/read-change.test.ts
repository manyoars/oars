import { describe, expect, it } from 'vitest';
import { frame, poolFrom, prompt, session, store, tool } from './pool-fixture.js';
import { deriveChange } from './read-change.js';
import type { Store } from './store.js';

const change = (from: Store) => deriveChange({ pool: poolFrom(from), store: from });
const later = frame({ harnessVersion: '2.1.320', day: '2026-11-02' });

describe('change', () => {
  it('states each tool inside one version bucket, as a share of that bucket alone', () => {
    const reads = change(
      store({
        sessions: [session('s1')],
        prompts: [prompt('s1', 0), prompt('s1', 1, { frame: later })],
        tools: [tool('s1', 0, 'Read'), tool('s1', 1, 'Edit', { status: 'error' }), tool('s1', 2, 'Read'), tool('s1', 3, 'Read', { prompt: 1 })],
      }),
    );
    const of = (motif: string, bucket: string) => reads.find((read) => read.slice.motif === motif && read.slice.harnessBucket === bucket);
    expect(reads).toHaveLength(3);
    expect(of('file.read', '2.1.31x')?.value).toEqual({ share: 0.6667, of: 3, failureRate: 0, firstWeek: '2026-10-26', lastWeek: '2026-10-26' });
    expect(of('file.edit', '2.1.31x')?.value).toEqual({ share: 0.3333, of: 3, failureRate: 1, firstWeek: '2026-10-26', lastWeek: '2026-10-26' });
    expect(of('file.read', '2.1.32x')?.value).toEqual({ share: 1, of: 1, failureRate: 0, firstWeek: '2026-11-02', lastWeek: '2026-11-02' });
    expect(of('file.read', '2.1.31x')?.n).toBe(2);
  });

  it('leaves out an unknown day and a step with no result', () => {
    const reads = change(store({ sessions: [session('s1')], prompts: [prompt('s1', 0, { frame: frame({ day: 'unknown' }) })], tools: [tool('s1', 0, 'Read'), tool('s1', 1, 'Edit', { status: 'none' })] }));
    expect(reads.map((read) => [read.slice.motif, read.value.firstWeek, read.value.lastWeek])).toEqual([['file.read', null, null]]);
  });
});
