import { defineConfig } from 'vitest/config';

// The container smoke test: `OARS_SMOKE_IMAGE=<image> npm run test:smoke`. Slow (Docker and Prism), so it is its own run.
export default defineConfig({
  test: { include: ['test/monorepo/smoke.spec.ts'], environment: 'node', testTimeout: 30_000 },
});
