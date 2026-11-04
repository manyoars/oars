// The process behind `oars gate hook`, with every side effect handed in so a test can drive it: stdin in, at most one JSON document out, `exit(0)` whatever happens. A hard deadline ends
// the process before the harness's own, writing the record it has staged if the write had not finished. Nothing here may throw past `runHookProcess`: exit 1 from a
// PreToolUse hook is a visible error and exit 2 blocks the tool call, and the hook must never cost a session either.
import { appendFileSync } from 'node:fs';
import { gateHook, type GateHookDeps } from './hook.js';

export interface HookProcess {
  /** Reads the whole of stdin. Called inside the guard, so a stream that cannot be set up is a failed read, not a crash. */
  stdin: () => Promise<string>;
  /** Builds the hook's dependencies, handed the function that records what is about to be written. Called inside the guard. */
  deps: (stage: NonNullable<GateHookDeps['stage']>) => GateHookDeps;
  exit: (code: number) => void;
  /** Writes the hook's answer to stdout and resolves once it is flushed. Absent: nothing is written. */
  write?: (text: string) => Promise<void>;
  /** Milliseconds from now until the process ends itself. */
  deadlineMs: number;
}

/** Resolves once `exit(0)` has been called, or never when the deadline timer is what ended the process. */
export const runHookProcess = async ({ stdin, deps, exit, write, deadlineMs }: HookProcess): Promise<void> => {
  let staged: { file: string; text: string } | null = null;
  // The last resort when the process is stuck past its grace: keep the staged record, then go. A write that fails here has nowhere to report, so it is dropped.
  setTimeout(
    () => {
      try {
        if (staged !== null) appendFileSync(staged.file, staged.text, { mode: 0o600 });
      } catch {
        // Fail-open.
      }
      exit(0);
    },
    Math.max(deadlineMs, 0),
  ).unref();
  try {
    const built = deps((pending) => {
      staged = pending;
    });
    const output = await gateHook(await stdin(), built);
    if (output !== '') await write?.(output);
  } catch {
    // Fail-open: a throw anywhere above is a record not written, never an exit code.
  }
  // A manager the registry ask started can outlive the ask; leaving by `exit` rather than waiting for it is what keeps the call under a second.
  exit(0);
};
