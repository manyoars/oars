import { afterEach, describe, expect, it, vi } from 'vitest';
import { deposit, type DepositTrace } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

const clock = vi.hoisted(() => ({ at: 0 }));

// A pool that takes 5 s to derive, on a clock only this test moves.
vi.mock('./pool.js', () => ({
  currentPool: (): Promise<undefined> => {
    clock.at += 5000;
    return Promise.resolve(undefined);
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('the index step', () => {
  it('times the index and not the pool derive that precedes it', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock.at);
    const staged = stage();
    const trace: DepositTrace = { kinds: { session: 0, subagent: 0, 'user-prompt': 0, tool: 0, 'error-line': 0 } };
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW }, trace);
    expect(clock.at).toBe(5000);
    expect(trace.index?.ms).toBe(0);
  });
});
