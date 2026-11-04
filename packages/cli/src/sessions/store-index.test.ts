import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** Every module a static import or re-export reaches from `entry` (a dynamic `import()` is not followed: it runs only when its step does). */
const staticClosure = (entry: string): string[] => {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^\s*(?:import|export)\s(?!type\s)[^;'"]*?from\s+'(\.[^']+)'|^\s*import\s+'(\.[^']+)'/gm)) {
      visit(resolve(dirname(file), (match[1] ?? match[2] ?? '').replace(/\.js$/, '.ts')));
    }
  };
  visit(entry);
  return [...seen];
};

describe('the hook entry', () => {
  it('reaches neither the pool nor a read family through its static imports (it loads them only in the nightly index step)', () => {
    const modules = staticClosure(fileURLToPath(new URL('../hook-bin.ts', import.meta.url))).map((file) => basename(file));
    expect(modules).toContain('store.ts');
    expect(modules).not.toContain('pool.ts');
    expect(modules.filter((name) => name.startsWith('read-'))).toEqual([]);
  });
});
