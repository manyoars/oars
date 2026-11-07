// The entry for `oars gate hook`: it imports the hook and the little it needs, never the CLI. Everything it does is in `hook-process.ts`, which a test can drive; this file
// only wires the real process into it, and every line of the wiring sits inside the guard that exits 0.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { defaultConfigDir } from '../credentials.js';
import { DEADLINE_MS, type GateHookDeps } from './hook.js';
import { isLocked, startFill, startHelper } from './hook-fill.js';
import { runHookProcess } from './hook-process.js';
import { managerReader } from './registry.js';
import { hookEmitter } from '../telemetry/hook-emit.js';

/** The process itself ends this long after `DEADLINE_MS`. */
const GRACE_MS = 100;

const readStdin = async (): Promise<string> => {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
};

const depsFor = (stage: NonNullable<GateHookDeps['stage']>): GateHookDeps => {
  const storeDir = join(defaultConfigDir(process.env, process.platform, homedir()), 'oars', 'sessions');
  return {
    storeDir,
    now: Date.now,
    // `performance.now()` counts from the start of the process, so node's own start is inside the budget.
    clock: () => performance.now(),
    deadlineMs: DEADLINE_MS,
    registry: managerReader(undefined, DEADLINE_MS),
    fill: (ask) => startFill(storeDir, ask, Date.now(), (dir, one) => { startHelper(spawn, dir, one); }),
    locked: (ask) => isLocked(storeDir, ask, Date.now()),
    stage,
  };
};

// One event per fire, recorded after the answer is written (`runHookProcess`), so it is never in front of the tool call. The version is read from `dist/gate/../../package.json`.
const emit = hookEmitter(process.env, process.platform, homedir(), new URL('../../package.json', import.meta.url), Date.now);

await runHookProcess({
  stdin: readStdin,
  deps: depsFor,
  exit: (code) => process.exit(code),
  write: (text) => new Promise<void>((done) => process.stdout.write(text, () => { done(); })),
  deadlineMs: DEADLINE_MS + GRACE_MS - performance.now(),
  clock: () => performance.now(),
  record: (fire) => { emit('hook', { name: 'gate', ...fire }); },
});
