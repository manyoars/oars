// The license status of a sample pack row (docs/pool.md, "License status by match id"). Bundled with esbuild into memory like deliver.mjs, since it imports that command's TypeScript:
//   npm run license-status -w packages/pool -- <match id> --key-id <id> --operator <dir> [--json]
//   npm run license-status -w packages/pool -- --ids <file> --key-id <id> --operator <dir> [--json]
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const bundled = await build({ entryPoints: [join(here, 'license-status.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
const code = bundled.outputFiles?.[0]?.text ?? '';
const { main } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
process.exitCode = await main(process.argv.slice(2), { print: (/** @type {string} */ text) => console.log(text) });
