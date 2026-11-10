import { defineConfig } from 'vitest/config';
import root from '../../vitest.config.js';

// A run from this workspace (`npm run test -w packages/cli`) reads this file, not the root config, so without it the spawn-heavy suites
// (survival.test.ts: git per test) ran on vitest's 5 s defaults and timed out at 5000ms (t1113). The limits come from the root config; only
// `include` and the setup path (relative to this directory) differ, and vitest-config.test.ts pins that the setup path is the same file.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['../../vitest.setup.ts'],
    testTimeout: root.test?.testTimeout,
    hookTimeout: root.test?.hookTimeout,
  },
});
