// The process behind `oars gate hook`: stdin in, nothing out, exit 0 whatever happens. It imports the hook and the little it needs, never the CLI. A hard deadline in this
// process ends it before the harness's own, writing the record it has staged if the write had not finished.
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { defaultConfigDir } from '../credentials.js';
import { DEADLINE_MS, gateHook, type GateHookDeps } from './hook.js';
import { managerReader } from './registry.js';

/** The process itself ends this long after `DEADLINE_MS`. */
const GRACE_MS = 100;

const readStdin = async (stream: AsyncIterable<unknown>): Promise<string> => {
  let text = '';
  for await (const chunk of stream) text += String(chunk);
  return text;
};

let staged: { file: string; text: string } | null = null;

const deps: GateHookDeps = {
  storeDir: join(defaultConfigDir(process.env, process.platform, homedir()), 'oars', 'sessions'),
  now: Date.now,
  // `performance.now()` counts from the start of the process, so node's own start is inside the budget.
  clock: () => performance.now(),
  deadlineMs: DEADLINE_MS,
  registry: managerReader(undefined, DEADLINE_MS),
  stage: (pending) => {
    staged = pending;
  },
};

// The last resort when the process is stuck past its grace: keep the staged record, then go. A write that fails here has nowhere to report, so it is dropped.
setTimeout(
  () => {
    try {
      if (staged !== null) appendFileSync(staged.file, staged.text);
    } catch {
      // Fail-open.
    }
    process.exit(0);
  },
  Math.max(DEADLINE_MS + GRACE_MS - performance.now(), 0),
).unref();

process.stdin.setEncoding('utf8');
const stdin = await readStdin(process.stdin).catch(() => '');
await gateHook(stdin, deps);
// A manager the registry ask started can outlive the ask; leaving by `exit` rather than waiting for it is what keeps the call under a second.
process.exit(0);
