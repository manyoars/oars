import { defineConfig } from 'vitest/config';

// One run covers every workspace; packages/cli has its own config that takes these limits from here, so its `test` script matches this run.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts', 'packages/*/{src,scripts}/**/*.test.ts'],
    environment: 'node',
    // Telemetry is on by default, so a test that runs the CLI as a process must not write the real spool; telemetry's own tests pass their env explicitly.
    setupFiles: ['./vitest.setup.ts'],
    // Spawn-heavy suites (git per test): with survival.test.ts run in 4 parallel processes the slowest test took 5.0 s (the 5 s default timed out 7-8 tests per copy), so
    // 30 s leaves about 6x that margin and still catches a hang. No retry: a retry would hide a real flake. packages/cli/vitest.config.ts imports these limits, so a run from there gets them too.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
