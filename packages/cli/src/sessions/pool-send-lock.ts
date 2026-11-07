// One sender at a time per outbox (t884): the nightly task and `deposit --send` both take this lock, so a batch is never posted twice by two runs that overlap. The lock is a file created
// with `wx` beside `sent.log`, so it holds across processes as well as inside one. A run that finds it held waits; a lock older than `staleMs` belongs to a run that died, and is taken over.
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LockTimes {
  /** A lock file older than this was left by a run that died. */
  staleMs: number;
  /** How long a run waits for the lock before it gives up. */
  waitMs: number;
  pollMs: number;
}

const DEFAULT_TIMES: LockTimes = { staleMs: 10 * 60 * 1000, waitMs: 2 * 60 * 1000, pollMs: 50 };

export class SendLockBusy extends Error {
  constructor() {
    super('Another oars run is sending from this outbox.');
  }
}

export const withSendLock = async <T>(outbox: string, run: () => Promise<T>, times: Partial<LockTimes> = {}): Promise<T> => {
  const { staleMs, waitMs, pollMs } = { ...DEFAULT_TIMES, ...times };
  const file = join(outbox, 'send.lock');
  await mkdir(outbox, { recursive: true });
  const giveUp = Date.now() + waitMs;
  for (;;) {
    try {
      await (await open(file, 'wx')).close();
      break;
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'EEXIST') throw error;
    }
    const held = await stat(file).catch(() => undefined);
    if (held !== undefined && Date.now() - held.mtimeMs > staleMs) await rm(file, { force: true });
    else if (Date.now() >= giveUp) throw new SendLockBusy();
    else await sleep(pollMs);
  }
  try {
    return await run();
  } finally {
    await rm(file, { force: true });
  }
};
