// The erasure-notice register (docs/pool.md, "Erasure notices"). Bundled with esbuild into memory like deliver.mjs, since it imports that command's TypeScript:
//   npm run notices -w packages/pool -- sent <match id> --recipient <name> --operator <dir>
//   npm run notices -w packages/pool -- confirmed --ids <file> --recipient <name> --operator <dir>
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const bundled = await build({ entryPoints: [join(here, 'notices.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
const code = bundled.outputFiles?.[0]?.text ?? '';
const { main } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
process.exitCode = await main(process.argv.slice(2), { print: (/** @type {string} */ text) => console.log(text) });
