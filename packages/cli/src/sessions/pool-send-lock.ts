// One sender at a time per outbox (t884): the nightly task and `deposit --send` both take this lock, so a batch is never posted twice by two runs that overlap. The lock is a file created
// with `wx` beside `sent.log`, so it holds across processes as well as inside one. A run that finds it held waits; a lock older than `staleMs` belongs to a run that died, and is taken over by one waiter only, under a guard file. The holder touches the file while it runs, so a long send (a first night of raw parts) is never mistaken for a dead run, and it removes the file only if the file still names its own run.
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat, utimes, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LockTimes {
  /** A lock file untouched for longer than this was left by a run that died; its holder touches it every quarter of this. */
  staleMs: number;
  /** How long a run waits for the lock before it gives up. */
  waitMs: number;
  pollMs: number;
}

/** What a test replaces: `stat` to read a lock as stale at the moment a waiter looks, `open` to make the create fail the way Windows does, `platform` to pick the platform's rules. */
export interface LockFs {
  stat: (path: string) => Promise<{ mtimeMs: number }>;
  open?: (path: string, flags: 'wx') => Promise<FileHandle>;
  platform?: NodeJS.Platform;
}

const DEFAULT_TIMES: LockTimes = { staleMs: 10 * 60 * 1000, waitMs: 2 * 60 * 1000, pollMs: 50 };

export class SendLockBusy extends Error {
  constructor() {
    super('Another oars run is sending from this outbox.');
  }
}

// EEXIST means another run holds the file. On Windows an open of a file whose delete is still pending (the holder just released it) answers EPERM or EACCES instead: the same contention, so retry within waitMs.
const contended = (error: unknown, platform: NodeJS.Platform): boolean => {
  if (!(error instanceof Error)) return false;
  const code = Reflect.get(error, 'code');
  return code === 'EEXIST' || (platform === 'win32' && (code === 'EPERM' || code === 'EACCES'));
};

/**
 * A stale lock is removed under a takeover guard (`send.lock.takeover`, created with `wx`), so one waiter at a time reads the lock again and removes it only if it is still stale. A live lock is never moved
 * or removed: a waiter that read a lock as stale, but meets a lock another run took over and refreshed in the meantime, finds it fresh under the guard and leaves it. A guard left by a taker that died is
 * removed once it is older than `staleMs`.
 */
const takeOver = async (file: string, staleMs: number, fs: LockFs): Promise<boolean> => {
  const guard = `${file}.takeover`;
  try {
    await (await open(guard, 'wx')).close();
  } catch {
    const left = await stat(guard).catch(() => undefined);
    if (left !== undefined && Date.now() - left.mtimeMs > staleMs) await rm(guard, { force: true });
    return false;
  }
  try {
    const held = await fs.stat(file).catch(() => undefined);
    if (held === undefined || Date.now() - held.mtimeMs <= staleMs) return false;
    await rm(file, { force: true });
    return true;
  } finally {
    await rm(guard, { force: true });
  }
};

export const withSendLock = async <T>(outbox: string, run: () => Promise<T>, times: Partial<LockTimes> = {}, fs: LockFs = { stat }): Promise<T> => {
  const { staleMs, waitMs, pollMs } = { ...DEFAULT_TIMES, ...times };
  const file = join(outbox, 'send.lock');
  const runId = randomUUID();
  const create = fs.open ?? open;
  const platform = fs.platform ?? process.platform;
  await mkdir(outbox, { recursive: true });
  const giveUp = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await create(file, 'wx');
      await handle.writeFile(runId);
      await handle.close();
      break;
    } catch (error) {
      if (!contended(error, platform)) throw error;
    }
    const held = await fs.stat(file).catch(() => undefined);
    // A takeover that cleared the lock goes straight back to taking it; any other outcome waits, and gives up once waitMs has passed.
    if (held !== undefined && Date.now() - held.mtimeMs > staleMs && (await takeOver(file, staleMs, fs))) continue;
    if (Date.now() >= giveUp) throw new SendLockBusy();
    await sleep(pollMs);
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
