// One sender at a time per outbox (t884): the nightly task and `deposit --send` both take this lock, so a batch is never posted twice by two runs that overlap. The lock is a file created
// with `wx` beside `sent.log`, so it holds across processes as well as inside one. A run that finds it held waits; a lock older than `staleMs` belongs to a run that died, and is taken over by one waiter only. The holder touches the file while it runs, so a long send (a first night of raw parts) is never mistaken for a dead run, and it removes the file only if the file still names its own run.
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LockTimes {
  /** A lock file untouched for longer than this was left by a run that died; its holder touches it every quarter of this. */
  staleMs: number;
  /** How long a run waits for the lock before it gives up. */
  waitMs: number;
  pollMs: number;
}

/** The one file operation a test replaces, to read a lock as stale at the moment a waiter looks. */
export interface LockFs {
  stat: (path: string) => Promise<{ mtimeMs: number }>;
}

const DEFAULT_TIMES: LockTimes = { staleMs: 10 * 60 * 1000, waitMs: 2 * 60 * 1000, pollMs: 50 };

export class SendLockBusy extends Error {
  constructor() {
    super('Another oars run is sending from this outbox.');
  }
}

const exists = (error: unknown): boolean => error instanceof Error && Reflect.get(error, 'code') === 'EEXIST';

/**
 * A stale lock is moved to a name only this waiter knows, then removed: of several waiters that read it as stale, the rename succeeds for one. A waiter whose rename moved a lock that had meanwhile been
 * taken over and refreshed (it looked, then another run took over before it renamed) puts that lock back with `link`, which fails if the path is taken again, and counts as not having taken over.
 */
const takeOver = async (file: string, staleMs: number, fs: LockFs): Promise<void> => {
  const aside = `${file}.${randomUUID()}.stale`;
  try {
    await rename(file, aside);
  } catch {
    return;
  }
  const moved = await fs.stat(aside).catch(() => undefined);
  // Only this waiter has the moved file, so its age is read once more and decides: fresh means the holder is alive.
  if (moved !== undefined && Date.now() - moved.mtimeMs <= staleMs) await link(aside, file).catch(() => undefined);
  await rm(aside, { force: true });
};

export const withSendLock = async <T>(outbox: string, run: () => Promise<T>, times: Partial<LockTimes> = {}, fs: LockFs = { stat }): Promise<T> => {
  const { staleMs, waitMs, pollMs } = { ...DEFAULT_TIMES, ...times };
  const file = join(outbox, 'send.lock');
  const runId = randomUUID();
  await mkdir(outbox, { recursive: true });
  const giveUp = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(runId);
      await handle.close();
      break;
    } catch (error) {
      if (!exists(error)) throw error;
    }
    const held = await fs.stat(file).catch(() => undefined);
    if (held !== undefined && Date.now() - held.mtimeMs > staleMs) await takeOver(file, staleMs, fs);
    else if (Date.now() >= giveUp) throw new SendLockBusy();
    else await sleep(pollMs);
  }
  const beat = setInterval(() => {
    const now = new Date();
    utimes(file, now, now).catch(() => undefined);
  }, Math.max(1, Math.floor(staleMs / 4)));
  try {
    return await run();
  } finally {
    clearInterval(beat);
    // The file is ours only while it still names this run; a lock another run took over is theirs.
    if ((await readFile(file, 'utf8').catch(() => undefined)) === runId) await rm(file, { force: true });
  }
};
