import { defineConfig } from 'vitest/config';

// One run covers every workspace; a workspace's own `test` script (vitest run, defaults) still works from its directory.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts', 'packages/*/{src,scripts}/**/*.test.ts', 'templates/*/{src,test}/**/*.test.ts'],
    environment: 'node',
    // The spawn-heavy suites (git per test) took about 30 s in total for 33 tests (survival.test.ts, 4 files in parallel); under a busy box a single test
    // outgrew the 5 s default (t758's gate read RED on it twice). 30 s still catches a hang. No retry: a retry would hide a real flake.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
