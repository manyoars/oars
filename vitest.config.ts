import { defineConfig } from 'vitest/config';

// One run covers every workspace; a workspace's own `test` script (vitest run, defaults) still works from its directory.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts', 'packages/*/{src,scripts}/**/*.test.ts'],
    environment: 'node',
    // Spawn-heavy suites (git per test): with survival.test.ts run in 4 parallel processes the slowest test took 5.0 s (the 5 s default timed out 7-8 tests per copy), so
    // 30 s leaves about 6x that margin and still catches a hang. No retry: a retry would hide a real flake. Binds root runs (`just check`), not a run from packages/cli.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
