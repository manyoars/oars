import { describe, expect, it } from 'vitest';
import { cellKey, measuresOf } from './measures.js';

const hook = (data: object): unknown => ({ type: 'hook', data: { name: 'pre-tool', latencyMs: 10, outcome: 'hit', ...data } });

describe('hook cells', () => {
  it('keys a hook cell by harness and harness version: one version under two harnesses is two cells', () => {
    const claude = measuresOf(hook({ harness: 'claude-code', harnessVersion: '2.1.5' }));
    const codex = measuresOf(hook({ harness: 'codex', harnessVersion: '2.1.5' }));
    expect(claude.map(cellKey)).not.toEqual(codex.map(cellKey));
    expect(claude[0]).toMatchObject({ metric: 'hook.pre-tool.latency', dimension: 'harnessVersion', value: 'claude-code/2.1.5' });
    expect(codex[0]).toMatchObject({ value: 'codex/2.1.5' });
  });

  it('reads an event written before the field as an unrecorded harness, and an unknown name as other', () => {
    expect(measuresOf(hook({ harnessVersion: '2.1.5' }))[0]).toMatchObject({ value: 'unrecorded/2.1.5' });
    expect(measuresOf(hook({ harness: 'acme private', harnessVersion: '2.1.5' }))[0]).toMatchObject({ value: 'other/2.1.5' });
    expect(measuresOf(hook({ harness: 'codex' }))[0]).toMatchObject({ value: 'codex/unrecorded' });
  });
});
