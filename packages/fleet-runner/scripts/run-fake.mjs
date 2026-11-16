// Bundles src/run-fake.ts in memory with esbuild (as the pool's scripts do) and runs it.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const bundled = await build({ entryPoints: [join(here, '..', 'src', 'run-fake.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
const code = bundled.outputFiles?.[0]?.text ?? '';
const { main } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
process.exitCode = await main(process.argv.slice(2), (/** @type {string} */ line) => console.log(line));
