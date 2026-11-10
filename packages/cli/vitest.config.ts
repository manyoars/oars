import { defineConfig } from 'vitest/config';

// A run from this workspace (`npm run test -w packages/cli`) does not read the root config, so without this file it ran on vitest's 5 s
// defaults and the spawn-heavy suites (survival.test.ts: git per test) timed out at 5000ms (t1113). Same limits and setup as the root
// `vitest.config.ts`, which stays the gate's path; keep the two in step.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['../../vitest.setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
