import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { indexPath } from './hook-index.js';
import { deposit, type DepositTrace } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

// A pool module that fails to load, as a damaged install would.
vi.mock('./pool.js', () => {
  throw new Error('pool module missing');
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('the index step when the pool module cannot be loaded', () => {
  it('writes one stderr line and still writes the index, with no fit reads, rather than rejecting the refresh', async () => {
    const written = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const staged = stage();
    const trace: DepositTrace = { kinds: { session: 0, subagent: 0, 'user-prompt': 0, tool: 0, 'error-line': 0 } };
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW }, trace);
    expect(existsSync(indexPath(staged.runtime.storeDir))).toBe(true);
    expect(trace.indexFailure).toBeUndefined();
    const lines = written.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('oars: the read pool module could not be loaded'));
    expect(lines).toHaveLength(1);
  });
});
