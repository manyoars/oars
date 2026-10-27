import { defineConfig } from 'vitest/config';

// The token recovery e2e: `npm run test:e2e` against a running aor-platform e2e stack (see the top of the spec). Its own run, like the
// container smoke test; the spec is not a `*.test.ts`, so no other run picks it up.
export default defineConfig({
  test: { include: ['test/monorepo/recovery-e2e.spec.ts'], environment: 'node', testTimeout: 150_000, hookTimeout: 30_000 },
});
