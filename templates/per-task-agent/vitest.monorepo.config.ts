import { defineConfig } from 'vitest/config';

// The tests that need the Many Oars monorepo around the template (contract against Prism, catalog entry, README).
export default defineConfig({
  test: { include: ['test/monorepo/**/*.test.ts'], environment: 'node' },
});
