// The real-work release note (docs/pool.md, "The real-work release note"). The command is TypeScript that imports the CLI's own store reader and exclusion gate, so it is bundled with esbuild into memory and run from there:
//   npm run real-work-note -w packages/pool -- <store folder> --terms <file> --owners <file> --out <dir> --harness <name> --from <bucket> --to <bucket>
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const bundled = await build({ entryPoints: [join(here, 'real-work-note.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
const code = bundled.outputFiles?.[0]?.text ?? '';
const { main, runtimeOf } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
process.exitCode = await main(process.argv.slice(2), { runtime: runtimeOf(process.env), print: (/** @type {string} */ text) => console.log(text) });
