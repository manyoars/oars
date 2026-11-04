// The entry for `oars gate hook`: it imports the hook and the little it needs, never the CLI. Everything it does is in `hook-process.ts`, which a test can drive; this file
// only wires the real process into it, and every line of the wiring sits inside the guard that exits 0.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { defaultConfigDir } from '../credentials.js';
import { DEADLINE_MS, type GateHookDeps } from './hook.js';
import { startFill, type FillAsk } from './hook-fill.js';
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

/** The helper outlives this process: detached, no stdio, never waited on, so the harness's call does not wait for it either. */
const startHelper = (storeDir: string, ask: FillAsk): void => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./hook-fill-main.js', import.meta.url)), storeDir, ask.class, ask.name, ask.cwd], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
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
    fill: (ask) => startFill(storeDir, ask, Date.now(), startHelper),
    stage,
  };
};

await runHookProcess({ stdin: readStdin, deps: depsFor, exit: (code) => process.exit(code), deadlineMs: DEADLINE_MS + GRACE_MS - performance.now() });
