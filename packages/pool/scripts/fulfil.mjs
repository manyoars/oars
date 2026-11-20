// The operator's builder for paid pack fetches (docs/pool.md, "Paid pack fetches"). The command is TypeScript that imports the sample pack's build, so it is bundled with esbuild into memory and run from there, like sample-pack.mjs:
//   npm run fulfil -w packages/pool -- --lots <file> --terms <file> --owners <file> --index-key <file> [--server <url>] [--token-file <path>] [--work <dir>] [--local]
import { execFile, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const poolDir = join(here, '..');
const wranglerBin = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');

const bundled = await build({ entryPoints: [join(here, 'fulfil.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
// The bundle is imported from a data: URL, so it cannot find the CLI's vocabulary by its own location: this script, which has a real one, passes the folder in.
const vocabDir = pathToFileURL(join(here, '..', '..', 'cli', 'vocab', '/'));
const code = bundled.outputFiles?.[0]?.text ?? '';
const { main, runtimeOf, heapRelaunch } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

/** Wrangler's own entry point under node, so the same call works on Windows. It runs in the pool's folder, where `wrangler.jsonc` is. */
const wrangler = (/** @type {readonly string[]} */ args) =>
  new Promise((resolve, reject) => {
    execFile(process.execPath, [wranglerBin, ...args], { cwd: poolDir, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => (error === null ? resolve(stdout) : reject(new Error(`wrangler ${args.slice(0, 3).join(' ')} failed: ${stderr.trim() || error.message}`))));
  });

const argv = process.argv.slice(2);
const limitMb = getHeapStatistics().heap_size_limit / 1048576;
// A lot's build needs the heap sample-pack needs (t1259), so this runs itself again under it the same way; the notice goes to stderr.
const relaunch = heapRelaunch(argv, limitMb, process.env.OARS_FULFIL_RELAUNCHED === '1');
if (relaunch === undefined) {
  process.exitCode = await main(argv, { runtime: runtimeOf(process.env), print: (/** @type {string} */ text) => console.log(text), wrangler, env: process.env, vocabDir });
} else {
  console.error(`fulfil: this process allows ${String(Math.floor(limitMb))} MB of heap; running again with ${relaunch.join(' ')} (--max-heap-mb sets it).`);
  const again = spawnSync(process.execPath, [...process.execArgv, ...relaunch, process.argv[1] ?? '', ...argv], { stdio: 'inherit', env: { ...process.env, OARS_FULFIL_RELAUNCHED: '1' } });
  if (again.error !== undefined) console.error(`fulfil: could not run again: ${again.error.message}`);
  process.exitCode = again.status ?? 1;
}
