import { defineConfig } from 'vitest/config';

// One run covers every workspace; a workspace's own `test` script (vitest run, defaults) still works from its directory.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts', 'packages/*/{src,scripts}/**/*.test.ts', 'templates/*/{src,test}/**/*.test.ts'],
    environment: 'node',
  },
});
