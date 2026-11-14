// The failure and continuation index (docs/pool.md, "The failure and continuation index"). The command is TypeScript that imports the pool's own skeleton reader, so it is bundled with esbuild into memory and run from there:
//   npm run failure-index -w packages/pool -- <pack folder> --out <dir> [--text-sample <n> --seed <text>]
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const bundled = await build({ entryPoints: [join(here, 'failure-index.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
const code = bundled.outputFiles?.[0]?.text ?? '';
const { main } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
process.exitCode = await main(process.argv.slice(2), { print: (/** @type {string} */ text) => console.log(text) });
