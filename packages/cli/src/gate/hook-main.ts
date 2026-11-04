// The entry for `oars gate hook`: it imports the hook and the little it needs, never the CLI. Everything it does is in `hook-process.ts`, which a test can drive; this file
// only wires the real process into it, and every line of the wiring sits inside the guard that exits 0.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { defaultConfigDir } from '../credentials.js';
import { DEADLINE_MS, type GateHookDeps } from './hook.js';
import { runHookProcess } from './hook-process.js';
import { managerReader } from './registry.js';

/** The process itself ends this long after `DEADLINE_MS`. */
const GRACE_MS = 100;

const readStdin = async (): Promise<string> => {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
};

const depsFor = (stage: NonNullable<GateHookDeps['stage']>): GateHookDeps => ({
  storeDir: join(defaultConfigDir(process.env, process.platform, homedir()), 'oars', 'sessions'),
  now: Date.now,
  // `performance.now()` counts from the start of the process, so node's own start is inside the budget.
  clock: () => performance.now(),
  deadlineMs: DEADLINE_MS,
  registry: managerReader(undefined, DEADLINE_MS),
  stage,
});

await runHookProcess({ stdin: readStdin, deps: depsFor, exit: (code) => process.exit(code), deadlineMs: DEADLINE_MS + GRACE_MS - performance.now() });
