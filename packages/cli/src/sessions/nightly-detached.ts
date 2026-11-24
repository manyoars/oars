// The detached sender's two halves (`hook-bin.js nightly`). The deposit, derive, and index run in a process of their own (`hook-bin.js nightly-run`), and this one waits for it and then sends:
// a derive that runs out of heap aborts its process (V8's `heap out of memory` is exit 134, which no `catch` can see), and while both halves shared one process that abort also took the
// send of every batch already in the outbox. Here the send runs whatever the run did, and a run that died before it could record itself gets its rows from this process instead.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { appendHookCall } from './hook-calls.js';
import { errorLine, logSkipped, logStep, newContext, tryLog } from './steps.js';

/** How the run's process ended: its exit code, or the signal that ended it, and its pid when it started. */
export interface RunExit {
  code: number | null;
  signal: string | null;
  pid: number | undefined;
}

export interface DetachedNightlyDeps {
  storeDir: string;
  now: () => number;
  /** Starts `hook-bin.js nightly-run` and resolves when it exits; rejects when it cannot be started. */
  run: () => Promise<RunExit>;
  /** Telemetry, then the pool outbox. It never throws. */
  send: () => Promise<void>;
}

/** Why a run's process ended without a clean exit, as the one line its rows carry, or undefined for a clean exit. */
export const exitReason = (exit: RunExit): string | undefined => {
  if (exit.code === 0) return undefined;
  // V8's out-of-memory abort is exit code 134 on Windows and SIGABRT elsewhere.
  if (exit.code === 134 || exit.signal === 'SIGABRT') return 'The nightly run aborted (out of memory, or another abort) before it recorded its steps.';
  return exit.signal === null
    ? `The nightly run ended with exit code ${String(exit.code)} before it recorded its steps.`
    : `The nightly run was ended by ${exit.signal} before it recorded its steps.`;
};

/**
 * The store lock a run left when its process died (an abort or a signal skips every `finally`): removed when the lock file names that pid, so the next deposit does not wait out the
 * stale window for a holder that is gone. A lock another process took since is left alone. Never throws.
 */
export const releaseDeadLock = async (storeDir: string, pid: number): Promise<boolean> => {
  const lock = join(storeDir, 'store.lock');
  const holder = (await readFile(lock, 'utf8').catch(() => '')).trim().split(' ')[0];
  if (holder !== String(pid)) return false;
  return rm(lock, { force: true }).then(
    () => true,
    () => false,
  );
};

/**
 * Runs the nightly run in its own process, then the send. A run that exits clean wrote its own rows (`runHook` records a throw as a `nightly` hook call with its error, and `runDeposit`
 * records the failed step), so this adds nothing. A run that died (exit code other than 0, or a signal) wrote neither: this records the `nightly` hook call with the reason and the failed
 * run's step rows as `runDeposit` records a failed run (the deposit's error, then the derive and the index skipped), and releases the lock the dead process held. Never throws.
 */
export const detachedNightly = async (deps: DetachedNightlyDeps): Promise<RunExit | Error> => {
  const started = deps.now();
  const ended = await deps.run().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  const reason = ended instanceof Error ? await errorLine(deps.storeDir, ended).catch(() => 'unknown error') : exitReason(ended);
  if (reason !== undefined) {
    const ms = deps.now() - started;
    await tryLog(() => appendHookCall(deps.storeDir, { at: new Date(deps.now()).toISOString(), event: 'nightly', session: null, hit: false, ms, error: reason }));
    const context = newContext(deps.storeDir, deps.now, 'nightly');
    await tryLog(() => logStep(context, 'deposit', 'error', ms, { in: {}, out: {}, key: null }, reason));
    await tryLog(() => logSkipped(context, 'derive'));
    await tryLog(() => logSkipped(context, 'index'));
    if (!(ended instanceof Error) && ended.pid !== undefined) await releaseDeadLock(deps.storeDir, ended.pid);
  }
  await deps.send();
  return ended;
};

/** The part of `child_process.spawn` the run's start uses, so a test can hand in a child that exits as it says. */
export type RunSpawn = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: true },
) => {
  pid?: number | undefined;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
};

/** Starts `node <hook-bin> nightly-run` with no stdio (the parent is already detached) and resolves with how it ended. */
export const spawnRun =
  (hookBin: string, start: RunSpawn, execPath: string = process.execPath): (() => Promise<RunExit>) =>
  () =>
    new Promise((resolve, reject) => {
      const child = start(execPath, [hookBin, 'nightly-run'], { stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        resolve({ code, signal, pid: child.pid });
      });
    });
