import { describe, expect, it } from 'vitest';
import { poolFrom, prompt, session, store, tool } from './pool-fixture.js';
import { deriveNextStep } from './read-next-step.js';
import type { Store } from './store.js';

const nextStep = (from: Store) => deriveNextStep({ pool: poolFrom(from), store: from });
const line = (...names: string[]) => store({ sessions: [session('s1')], prompts: [prompt('s1', 0)], tools: names.map((name, n) => tool('s1', n, name)) });

describe('next step', () => {
  it('counts what came next after each prefix of one to three actions', () => {
    const reads = nextStep(line('Read', 'Edit', 'Read', 'Edit', 'Bash'));
    const of = (prefix: string) => reads.find((read) => read.slice.prefix === prefix);
    expect(of('file.read')?.value).toEqual({ next: { 'file.edit': 2 }, top: 'file.edit', topShare: 1 });
    expect(of('file.edit')?.value).toEqual({ next: { 'file.read': 1, 'shell.exec': 1 }, top: 'file.read', topShare: 0.5 });
    expect(of('file.edit')?.n).toBe(2);
    expect(of('file.read>file.edit')?.slice.length).toBe('2');
    expect(of('file.read>file.edit>file.read')?.value).toEqual({ next: { 'file.edit': 1 }, top: 'file.edit', topShare: 1 });
    expect(of('file.edit>file.read>file.edit>shell.exec')).toBeUndefined();
  });

  it('breaks a tie by name whichever way the counts arrive, so a rerun states one top', () => {
    const forward = nextStep(line('Read', 'Edit', 'Read', 'Write')).find((read) => read.slice.prefix === 'file.read');
    const backward = nextStep(line('Read', 'Write', 'Read', 'Edit')).find((read) => read.slice.prefix === 'file.read');
    expect(forward?.value.top).toBe('file.edit');
    expect(backward?.value.top).toBe('file.edit');
  });

  it('says nothing of a prefix whose next step has no result, or of a lone call', () => {
    expect(nextStep(store({ sessions: [session('s1')], prompts: [prompt('s1', 0)], tools: [tool('s1', 0, 'Read'), tool('s1', 1, 'Edit', { status: 'none' })] }))).toEqual([]);
    expect(nextStep(line('Read'))).toEqual([]);
  });
});
