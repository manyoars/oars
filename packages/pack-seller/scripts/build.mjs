// Bundles src/bin.ts into dist/bin.js with esbuild. The seller imports the pool's sample-pack and deliver and the CLI's session store by path, which tsc with rootDir src cannot emit,
// so those sources are bundled in and the npm packages stay external (resolved from node_modules at run time). dist/ is emptied first so a deleted source file cannot linger.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** @param {string} path relative to packages/pack-seller */
const here = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));

rmSync(here('dist'), { recursive: true, force: true });
await build({ entryPoints: [here('src/bin.ts')], outfile: here('dist/bin.js'), bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24' });
