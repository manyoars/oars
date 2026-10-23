import { configDefaults, defineConfig } from 'vitest/config';

// A developer's copy of this template has no monorepo around it, so `npm test` skips test/monorepo/: those tests read the
// monorepo's openapi/public.json and start Prism. The monorepo runs them with `npm run test:monorepo` (and its root run
// includes them).
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, 'test/monorepo/**'], environment: 'node' },
});
