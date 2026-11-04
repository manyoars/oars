import { defineConfig } from 'vitest/config';

// The opt-in live login, entered through `just live-login`. The direct `npm run test:live -w packages/cli` needs
// `npm run build -w packages/client` first, because the suite resolves the client's built `dist`. The root run never picks it up: it
// matches `*.test.ts` only, and this file's include is the `*.live.ts` suites, which need a running Keycloak.
export default defineConfig({
  test: {
    include: ['src/**/*.live.ts'],
    environment: 'node',
    // Keycloak's first login after a cold start renders its theme slowly, and the device poll waits its own interval (5 s).
    testTimeout: 120_000,
  },
});
