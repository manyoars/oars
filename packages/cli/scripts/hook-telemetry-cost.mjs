// What telemetry adds to a hook fire: wall time of the whole process, built `dist/` run as the harness runs it, alternating telemetry off (`OARS_TELEMETRY=0`) and on so drift hits both
// alike. The fires carry a 200 KB transcript, and the frame read (the 64 KB tail) runs in both columns, so "added" is the emit's cost alone. The brief's line is 5 ms added at the median.
//
//   node scripts/hook-telemetry-cost.mjs [--runs 250]      # needs `npm run build -w packages/cli` first
//
// Wall times are of the machine they ran on: compare off with on in one run, never a run with another box's (t791's `pre-tool` p50 of 314 ms was Windows under load).
// Nothing here touches the real store or ~/.claude: every path the CLI uses points at a fresh folder under the OS temp folder.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} name
 * @param {number} fallback
 */
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const RUNS = arg('runs', 250);
/** @param {string} file */
const dist = (file) => fileURLToPath(new URL(`../dist/${file}`, import.meta.url));
const bin = dist('bin.js');
const hookBin = dist('hook-bin.js');
if (!existsSync(bin) || !existsSync(hookBin)) {
  console.error('dist/ is not built: run `npm run build -w packages/cli` first.');
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), 'oars-hook-cost-'));
mkdirSync(join(root, 'oars', 'sessions'), { recursive: true });
const transcript = join(root, 'transcript.jsonl');
const line = JSON.stringify({ version: '2.1.300', message: { model: 'claude-opus-4-5', content: 'x'.repeat(2000) } });
writeFileSync(transcript, `${Array.from({ length: 100 }, () => line).join('\n')}\n`);

/** @param {string} event */
const input = (event) => JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok', cwd: root, transcript_path: transcript, hook_event_name: event });
const cases = [
  { name: 'oars gate hook (miss)', args: [bin, 'gate', 'hook'], stdin: input('PreToolUse') },
  { name: 'hook-bin.js pre-tool (miss)', args: [hookBin, 'pre-tool'], stdin: input('PreToolUse') },
  { name: 'hook-bin.js post-tool (miss)', args: [hookBin, 'post-tool'], stdin: input('PostToolUse') },
];
/** @param {NodeJS.ProcessEnv} extra */
const envFor = (extra) => ({ PATH: process.env.PATH, APPDATA: root, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, ...extra });
/**
 * @param {{ args: string[], stdin: string }} spec
 * @param {NodeJS.ProcessEnv} extra
 */
const wall = (spec, extra) => {
  const started = performance.now();
  spawnSync(process.execPath, spec.args, { input: spec.stdin, encoding: 'utf8', timeout: 30_000, cwd: root, env: envFor(extra) });
  return performance.now() - started;
};
/**
 * @param {number[]} sorted
 * @param {number} p
 */
const at = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

try {
  for (const spec of cases) {
    wall(spec, { OARS_TELEMETRY: '0' });
    wall(spec, {});
    /** @type {number[]} */
    const off = [];
    /** @type {number[]} */
    const on = [];
    for (let run = 0; run < RUNS; run += 1) {
      off.push(wall(spec, { OARS_TELEMETRY: '0' }));
      on.push(wall(spec, {}));
    }
    off.sort((a, b) => a - b);
    on.sort((a, b) => a - b);
    /** @param {number} n */
    const f = (n) => n.toFixed(1);
    console.log(`${spec.name}: ${RUNS} runs each; off p50 ${f(at(off, 0.5))} p90 ${f(at(off, 0.9))}; on p50 ${f(at(on, 0.5))} p90 ${f(at(on, 0.9))}; added at the median ${f(at(on, 0.5) - at(off, 0.5))} ms`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
