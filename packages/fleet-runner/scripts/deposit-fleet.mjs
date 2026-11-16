// Bundles src/deposit-fleet.ts in memory with esbuild (as run-fake.mjs does) and runs it with the rest of the command line.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
// The CLI's store code finds its package.json and vocab folder from `import.meta.url`; see run-fake.mjs.
const sessions = pathToFileURL(join(here, '..', '..', 'cli', 'src', 'sessions', 'store.ts')).href;
const bundled = await build({ entryPoints: [join(here, '..', 'src', 'deposit-fleet.ts')], bundle: true, platform: 'node', format: 'esm', write: false, define: { 'import.meta.url': JSON.stringify(sessions) } });
const code = bundled.outputFiles?.[0]?.text ?? '';
const { main } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
process.exitCode = await main(process.argv.slice(2), (/** @type {string} */ line) => console.log(line), () => new Date(), join(here, '..', 'fleet-manifest.json'));
