// The one due check behind every trigger. oars installs no OS scheduler: the SessionEnd hook, after its deposit, and any `oars` command call `catchUp`, which decides whether a sweep and
// send is due (at most about hourly) and starts it detached, so the caller never waits and its exit code and output never change. The detached process is `hook-bin.js nightly` (the name
// is the persisted trigger word in the step log): it deposits every harness the person allowed, including those with no session-end hook, derives, sends telemetry when telemetry is on,
// and sends the pool outbox after the covenant is accepted; each of those gates itself, so a start by this check sends nothing a person has not agreed to.
// Fail-open: an error is written to `pool-send.log` in the session store (masked, one line) and the next trigger tries again.
import { spawn } from 'node:child_process';
import { appendFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorLine } from './steps.js';

/** The part of `child_process.spawn` the sender start uses, so a test can hand in a child that never starts or one that fails to. */
export type SenderSpawn = (
  command: string,
  args: string[],
  options: { detached: true; stdio: 'ignore'; windowsHide: true },
) => { on: (event: 'error', listener: (error: Error) => void) => unknown; unref: () => void };

/** The debounce: a sweep is started at most once in this long. */
export const SEND_EVERY_MS = 60 * 60 * 1000;

export type CatchUpResult = 'started' | 'not-due' | 'claimed' | 'not-ready' | 'failed';

export interface CatchUpDeps {
  storeDir: string;
  now: () => number;
  /** Whether this machine has a session store the person made (a deposit or a hook install ran): nothing is swept into a store nobody asked for. */
  ready: () => Promise<boolean>;
  /** Starts the sender detached and returns at once; nothing waits for it. */
  start: () => void;
}

const MARK = 'pool-due.json';
const LOG = 'pool-send.log';
const CLAIM = /^pool-due\.(\d+)\.claim$/;
/** Where `--schedule off` is remembered: a file of its own in the sessions store, because `state.json` is rewritten whole by every deposit. */
const OPT_OUT = 'schedule.json';

/** True once the person ran `oars sessions hook install --schedule off` and has not run `--schedule on` since. A record that cannot be read or parsed counts as no opt-out. */
export const scheduleOptedOut = async (storeDir: string): Promise<boolean> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(storeDir, OPT_OUT), 'utf8'));
    return typeof parsed === 'object' && parsed !== null && Reflect.get(parsed, 'schedule') === 'off';
  } catch {
    return false;
  }
};

/** Records the choice of `--schedule`: `off` writes the opt-out; `on` clears it. */
export const recordSchedule = async (storeDir: string, mode: 'on' | 'off'): Promise<void> => {
  if (mode === 'on') {
    await rm(join(storeDir, OPT_OUT), { force: true });
    return;
  }
  await mkdir(storeDir, { recursive: true });
  await writeFile(join(storeDir, OPT_OUT), `${JSON.stringify({ schedule: 'off' })}\n`, { encoding: 'utf8', mode: 0o600 });
};

/** One masked line in `pool-send.log`, the place a failure of the trigger or the sender goes. Never throws. */
const logFailure = async (storeDir: string, at: number, error: unknown): Promise<void> => {
  const line = await errorLine(storeDir, error).catch(() => 'unknown error');
  await mkdir(storeDir, { recursive: true }).then(() => appendFile(join(storeDir, LOG), `${new Date(at).toISOString()} ${line}\n`, 'utf8')).catch(() => undefined);
};

/** When the last sender was started; a missing, unreadable, or future mark is no mark. */
const lastStart = async (storeDir: string, now: number): Promise<number | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(storeDir, MARK), 'utf8'));
    const at: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'startedAt') : undefined;
    return typeof at === 'number' && at <= now ? at : undefined;
  } catch {
    return undefined;
  }
};

/**
 * One caller per window wins: the claim is a file named for the window and created with `wx`, so two callers in one window (two hooks that end together, a hook and a command) cannot both
 * create it. Claims of earlier windows are swept away by the winner.
 */
const claim = async (storeDir: string, window: number): Promise<boolean> => {
  try {
    await (await open(join(storeDir, `pool-due.${String(window)}.claim`), 'wx')).close();
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'EEXIST') return false;
    throw error;
  }
  for (const name of await readdir(storeDir)) {
    const found = CLAIM.exec(name);
    if (found !== null && Number(found[1]) < window) await rm(join(storeDir, name), { force: true });
  }
  return true;
};

/**
 * Never throws. Bound: the claim is per window and the mark is written after it, so two callers on either side of an hour boundary can both start a sender in the worst case; the send lock
 * (`pool-send-lock.ts`) makes the second sender wait for the first, so nothing is posted twice.
 */
export const catchUp = async (deps: CatchUpDeps): Promise<CatchUpResult> => {
  try {
    if (!(await deps.ready())) return 'not-ready';
    const now = deps.now();
    const last = await lastStart(deps.storeDir, now);
    if (last !== undefined && now - last < SEND_EVERY_MS) return 'not-due';
    if (!(await claim(deps.storeDir, Math.floor(now / SEND_EVERY_MS)))) return 'claimed';
    await writeFile(join(deps.storeDir, MARK), `${JSON.stringify({ startedAt: now })}\n`, 'utf8');
    deps.start();
    return 'started';
  } catch (error) {
    // The mark is already written when the start itself failed; the claim holds the rest of this window, and the next window tries again.
    const line = await errorLine(deps.storeDir, error).catch(() => 'unknown error');
    await mkdir(deps.storeDir, { recursive: true }).then(() => appendFile(join(deps.storeDir, LOG), `${new Date(deps.now()).toISOString()} ${line}\n`, 'utf8')).catch(() => undefined);
    return 'failed';
  }
};

/** What the hook and the command line call: the check on the real store, clock, and spawner, with the sender being `hook-bin.js nightly`. Never throws, and returns once the sender is started. */
export const catchUpOnStore = (storeDir: string, hookBin: string, now: () => number = Date.now, start: SenderSpawn = spawn): Promise<CatchUpResult> =>
  catchUp({ storeDir, now, ready: storeReady(storeDir), start: startSender(hookBin, storeDir, now, start) });

/** What the session-end hook calls after its deposit: the same check, returning once the sender is started and writing nothing to stdout (the hook's output is its deposit's, unchanged). */
export const afterStop = (storeDir: string, hookBin: string, now: () => number = Date.now, start: SenderSpawn = spawn): Promise<CatchUpResult> => catchUpOnStore(storeDir, hookBin, now, start);

/** The store counts once `state.json` is there and the person has not opted out with `--schedule off`. */
export const storeReady = (storeDir: string): (() => Promise<boolean>) => async () => (await stat(join(storeDir, 'state.json')).then(() => true, () => false)) && !(await scheduleOptedOut(storeDir));

/**
 * Starts `node <hook-bin> nightly` detached with no stdio and never waits for it, as telemetry's sender and the gate's helper are started. The sender inherits this process's environment. A child that cannot
 * start (its `error` event) is written to `pool-send.log` like any other failure, and the next trigger tries again.
 */
export const startSender = (hookBin: string, storeDir: string, now: () => number, start: SenderSpawn = spawn): (() => void) => () => {
  const child = start(process.execPath, [hookBin, 'nightly'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (error) => {
    void logFailure(storeDir, now(), error);
  });
  child.unref();
};
