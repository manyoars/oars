// The first sale's hand-over register (docs/pool.md, "The sample pack"). Bundled with esbuild into memory like sample-pack.mjs, since it imports that command's TypeScript:
//   npm run deliver -w packages/pool -- --pack <dir> --recipient <name> --license <id> --buyer-key <key> --owners <file>
//   npm run deliver -w packages/pool -- recipients <session id or name> --owners <file>
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const bundled = await build({ entryPoints: [join(here, 'deliver.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
const code = bundled.outputFiles?.[0]?.text ?? '';
const { main } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
process.exitCode = await main(process.argv.slice(2), { print: (/** @type {string} */ text) => console.log(text) });
