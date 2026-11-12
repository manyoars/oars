// The operator's pull of third-party deposits (docs/pool-deposit-title.md). TypeScript that imports the Worker's own helpers, so it is bundled with esbuild into memory and run from there:
//   npm run pull-deposits -w packages/pool -- --out <folder outside every repository> [--local]   (reads the pool, changes nothing)
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const poolDir = join(here, '..');
const wranglerBin = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');

const bundled = await build({ entryPoints: [join(here, 'pull-deposits.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
const code = bundled.outputFiles?.[0]?.text ?? '';
const { main, nodeFiles, nodeFolder, insideRepository } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

/** Wrangler's own entry point under node, so the same call works on Windows, where `npx` is a .cmd file. It runs in the pool's folder, where `wrangler.jsonc` is. */
const wrangler = (/** @type {readonly string[]} */ args) =>
  new Promise((resolve, reject) => {
    execFile(process.execPath, [wranglerBin, ...args], { cwd: poolDir, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => (error === null ? resolve(stdout) : reject(new Error(`wrangler ${args.slice(0, 3).join(' ')} failed: ${stderr.trim() || error.message}`))));
  });

const files = nodeFiles();
try {
  process.exitCode = await main(process.argv.slice(2), { print: (/** @type {string} */ text) => console.log(text), wrangler, files, folder: nodeFolder, inRepository: insideRepository });
} finally {
  await files.dispose();
}
