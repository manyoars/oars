// Bundles src/run-fake.ts in memory with esbuild (as the pool's scripts do) and runs it.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
// The store code finds its package.json and vocab folder from `import.meta.url` (two files in `packages/cli/src/sessions/`), and a bundle run from a data: URL has none that
// resolves, so the one value both need is fixed here: a file in that folder.
const sessions = pathToFileURL(join(here, '..', '..', 'cli', 'src', 'sessions', 'store.ts')).href;
const bundled = await build({ entryPoints: [join(here, '..', 'src', 'run-fake.ts')], bundle: true, platform: 'node', format: 'esm', write: false, define: { 'import.meta.url': JSON.stringify(sessions) } });
const code = bundled.outputFiles?.[0]?.text ?? '';
const { main } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
process.exitCode = await main(process.argv.slice(2), (/** @type {string} */ line) => console.log(line));
