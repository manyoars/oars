// The first sale's sample pack (docs/pool.md, "The sample pack"). The command is TypeScript that imports the CLI's own exclusion gate and redaction, so it is bundled with esbuild into memory and run from there:
//   npm run sample-pack -w packages/pool -- --terms <file> --owners <file> --index-key <file> --buyer-key <key> --out <dir> [--size <n>] [--seed <text>]
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const bundled = await build({ entryPoints: [join(here, 'sample-pack.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
const code = bundled.outputFiles?.[0]?.text ?? '';
const { main, runtimeOf } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
process.exitCode = await main(process.argv.slice(2), { runtime: runtimeOf(process.env), print: (/** @type {string} */ text) => console.log(text) });
