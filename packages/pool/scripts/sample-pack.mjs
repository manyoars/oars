// The first sale's sample pack (docs/pool.md, "The sample pack"). The command is TypeScript that imports the CLI's own exclusion gate and redaction, so it is bundled with esbuild into memory and run from there:
//   npm run sample-pack -w packages/pool -- --terms <file> --owners <file> --index-key <file> --buyer-key-file <path> --out <dir> [--size <n>] [--seed <text>]
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const bundled = await build({ entryPoints: [join(here, 'sample-pack.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
// The bundle is imported from a data: URL, so it cannot find the CLI's vocabulary by its own location: this script, which has a real one, passes the folder in.
const vocabDir = pathToFileURL(join(here, '..', '..', 'cli', 'vocab', '/'));
const code = bundled.outputFiles?.[0]?.text ?? '';
const { main, runtimeOf, heapRelaunch } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const argv = process.argv.slice(2);
const limitMb = getHeapStatistics().heap_size_limit / 1048576;
// Run again under the heap `--max-heap-mb` asks for (default 8192) when this process has less: a full build ran out of memory at the default heap (t1259). The notice goes to stderr, so stdout is what it always was.
const relaunch = heapRelaunch(argv, limitMb, process.env.OARS_SAMPLE_PACK_RELAUNCHED === '1');
if (relaunch === undefined) {
  process.exitCode = await main(argv, { runtime: runtimeOf(process.env), print: (/** @type {string} */ text) => console.log(text), vocabDir });
} else {
  console.error(`sample-pack: this process allows ${String(Math.floor(limitMb))} MB of heap; running again with ${relaunch.join(' ')} (--max-heap-mb sets it).`);
  const again = spawnSync(process.execPath, [...process.execArgv, ...relaunch, process.argv[1] ?? '', ...argv], { stdio: 'inherit', env: { ...process.env, OARS_SAMPLE_PACK_RELAUNCHED: '1' } });
  if (again.error !== undefined) console.error(`sample-pack: could not run again: ${again.error.message}`);
  process.exitCode = again.status ?? 1;
}
