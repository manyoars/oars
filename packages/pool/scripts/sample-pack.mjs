// The first sale's sample pack (docs/pool.md, "The sample pack"). The command is TypeScript that imports the CLI's own exclusion gate and redaction, so it is bundled with esbuild into memory and run from there:
//   npm run sample-pack -w packages/pool -- --terms <file> --owners <file> --index-key <file> --buyer-key-file <path> --out <dir> [--size <n>] [--seed <text>]
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const bundled = await build({ entryPoints: [join(here, 'sample-pack.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
// The bundle is imported from a data: URL, so it cannot find the CLI's vocabulary by its own location: this script, which has a real one, passes the folder in.
const vocabDir = pathToFileURL(join(here, '..', '..', 'cli', 'vocab', '/'));
const code = bundled.outputFiles?.[0]?.text ?? '';
const { main, runtimeOf } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
process.exitCode = await main(process.argv.slice(2), { runtime: runtimeOf(process.env), print: (/** @type {string} */ text) => console.log(text), vocabDir });
