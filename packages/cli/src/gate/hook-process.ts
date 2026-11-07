// The process behind `oars gate hook`, with every side effect handed in so a test can drive it: stdin in, at most one JSON document out, `exit(0)` whatever happens. A hard deadline ends
// the process before the harness's own, writing the record it has staged if the write had not finished. Nothing here may throw past `runHookProcess`: exit 1 from a
// PreToolUse hook is a visible error and exit 2 blocks the tool call, and the hook must never cost a session either.
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { gateHook, type GateHookDeps } from './hook.js';
import { parseRows } from './record.js';

/** What telemetry is told of one fire of `oars gate hook`: how long the handler took, how it ended, and the bytes it printed. */
export interface HookFire {
  latencyMs: number;
  outcome: 'hit' | 'miss' | 'held' | 'error';
  bytes: number;
}

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
  /** Told once how the fire went, with the transcript path the harness named (to read the frame from, never to record), after its output is written so recording is never in front of the answer. A throw here is swallowed: the exit code and stdout do not depend on it. */
  record?: (fire: HookFire, transcript: string | undefined) => void | Promise<void>;
  /** Milliseconds, only compared with itself: the latency in a fire is the difference across the handler. Absent: `Date.now`. */
  clock?: () => number;
}

/** The staged record is written before anything prints, so when the deadline ends the process with it still staged no note or deny was shown: its crossing rows read as no exposure, since a row cannot be backfilled. A block row has `arm: none` already but names its line, so every crossing row is reset, not only those with an arm. */
const unprinted = (text: string): string =>
  parseRows(text)
    .map((row) => `${JSON.stringify(row.kind === 'crossing' ? { ...row, arm: 'none', lineShown: 'none', lineHeld: 'none' } : row)}\n`)
    .join('');

/** The transcript path the harness put in the hook input, when there is one; anything else, including input that is not JSON, names none. */
const transcriptOf = (input: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(input);
    const path: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'transcript_path') : undefined;
    return typeof path === 'string' && path !== '' ? path : undefined;
  } catch {
    return undefined;
  }
};

const sizeOf = (file: string): number => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

/** Whether the record's own bytes are in the file past the length it had when the record was staged. Another hook's row may have grown the file too, so growth alone proves nothing. */
const landed = (file: string, text: string, size: number): boolean => {
  try {
    return readFileSync(file).subarray(size).includes(text);
  } catch {
    return false;
  }
};

/** Resolves once `exit(0)` has been called, or never when the deadline timer is what ended the process. */
export const runHookProcess = async ({ stdin, deps, exit, write, deadlineMs, record, clock = Date.now }: HookProcess): Promise<void> => {
  const started = clock();
  // `held` and `error` are what the output cannot say; the callback reaches the hook through `deps`.
  const how: { ended: HookFire['outcome'] | null } = { ended: null };
  let fired: Pick<HookFire, 'outcome' | 'bytes'>;
  let transcript: string | undefined;
  // Telemetry hears of a fire once: the deadline timer records the fire it cuts short (the slowest ones), and the main path skips a fire the timer has already told.
  let recorded = false;
  // Set once the main path's `record` has resolved. While it is false after `recorded`, the main path is still reading the transcript, and a stalled read would otherwise lose the fire at the deadline.
  let settled = false;
  let told: Pick<HookFire, 'outcome' | 'bytes'> | undefined;
  const send = async (result: Pick<HookFire, 'outcome' | 'bytes'>, transcript?: string): Promise<void> => {
    try {
      await record?.({ latencyMs: Math.max(0, Math.round(clock() - started)), ...result }, transcript);
    } catch {
      // Telemetry never changes what the hook did.
    }
  };
  const tell = async (result: Pick<HookFire, 'outcome' | 'bytes'>, transcript?: string): Promise<void> => {
    if (recorded) return;
    recorded = true;
    told = result;
    await send(result, transcript);
    settled = true;
  };
  // `size` is the file's length when the record was staged: an append that wrote and then stalled has put the record's own bytes past it, and the deadline must not write it again.
  let staged: { file: string; text: string; size: number; stop?: () => void } | null = null;
  // The last resort when the process is stuck past its grace: keep the staged record, then go. A write that fails here has nowhere to report, so it is dropped.
  setTimeout(
    () => {
      // The row first: it is the record this timer exists to keep, and the stop can be slow (on Windows it is a `taskkill` spawn at a moment already past the deadline).
      try {
        if (staged !== null && !landed(staged.file, staged.text, staged.size)) appendFileSync(staged.file, unprinted(staged.text), { mode: 0o600 });
      } catch {
        // Fail-open.
      }
      // The fire the deadline cut short is still a fire: recorded as an error with nothing printed, after the row and before the stop so a slow stop cannot lose it.
      // When the main path had told it first and its transcript read is still going, the fire it settled on goes now, with no transcript, so the read cannot cost the event.
      if (!recorded) void tell({ outcome: 'error', bytes: 0 });
      else if (!settled && told !== undefined) void send(told);
      // A registry ask still running is then stopped, so the manager the hook started does not outlive it; a stop that throws must not cost the exit.
      try {
        staged?.stop?.();
      } catch {
        // Fail-open.
      }
      exit(0);
    },
    Math.max(deadlineMs, 0),
  ).unref();
  try {
    const built = deps((pending) => {
      staged = pending === null ? null : { ...pending, size: sizeOf(pending.file) };
    });
    const input = await stdin();
    transcript = transcriptOf(input);
    const output = await gateHook(input, { ...built, ended: (result) => { how.ended = result; built.ended?.(result); } });
    if (output !== '') await write?.(output);
    fired = { outcome: how.ended ?? (output === '' ? 'miss' : 'hit'), bytes: Buffer.byteLength(output) };
  } catch {
    // Fail-open: a throw anywhere above is a record not written, never an exit code.
    fired = { outcome: 'error', bytes: 0 };
  }
  await tell(fired, transcript);
  // A manager the registry ask started can outlive the ask; leaving by `exit` rather than waiting for it is what keeps the call under a second.
  exit(0);
};
