// The public spec's validator (docs/session-record.md). The command is TypeScript that imports the pool's own record reader, so it is bundled with esbuild into memory and run from there:
//   npm run validate-pack -w packages/pool -- <pack folder | manifest.jsonl | record.json>
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const bundled = await build({ entryPoints: [join(here, 'validate-pack.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
const code = bundled.outputFiles?.[0]?.text ?? '';
const { main } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
process.exitCode = await main(process.argv.slice(2), { print: (/** @type {string} */ text) => console.log(text) });
