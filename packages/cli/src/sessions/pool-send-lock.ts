// One sender at a time per outbox: the detached sender (hook-bin.js nightly) and `deposit --send` both take this lock, so a batch is never posted twice by two runs that overlap. The lock is a file created
// with `wx` beside `sent.log`, so it holds across processes as well as inside one. A run that finds it held waits; a holder on this host whose pid is not running is taken over at once, and a lock untouched for `staleMs` belongs to a run that died (the rule for a holder whose liveness cannot be read: an empty or older-format file, another host's pid). Either takeover is by one waiter only, under a guard file. The holder touches the file while it runs, so a long send (a first night of raw parts) is never mistaken for a dead run, and it removes the file only if the file still names its own run.
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat, utimes, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LockTimes {
  /** A lock file untouched for longer than this was left by a run that died; its holder touches it every quarter of this. */
  staleMs: number;
  /** How long a run waits for the lock before it gives up. */
  waitMs: number;
  pollMs: number;
  /** How long a run waits behind a live holder before it tells the person it is waiting. */
  noticeMs: number;
}

/** What a test replaces: `stat` to read a lock as stale at the moment a waiter looks, `open` to make the create fail the way Windows does, `platform` to pick the platform's rules. */
export interface LockFs {
  stat: (path: string) => Promise<{ mtimeMs: number }>;
  open?: (path: string, flags: 'wx') => Promise<FileHandle>;
  platform?: NodeJS.Platform;
  /** Whether a process with this id is running on this machine. A test answers for a pid it made up. */
  running?: (pid: number) => boolean;
  /** This run's pid and host, recorded in the lock; a test names the holder it plays. */
  self?: { pid: number; host: string };
  /** The clock and the pause between polls; a test drives both instead of sleeping. */
  clock?: { now: () => number; sleep: (ms: number) => Promise<void> };
}

export const DEFAULT_TIMES: LockTimes = { staleMs: 10 * 60 * 1000, waitMs: 2 * 60 * 1000, pollMs: 50, noticeMs: 500 };

/** Who holds the lock, as the holder wrote it into the file: its run, pid, host, and when it took the lock (epoch ms). */
export interface Holder {
  run: string;
  pid: number;
  host: string;
  since: number;
}

/** What a run that waits tells its caller once, when the wait has lasted `noticeMs`: the holder when the file names one (an empty or older-format file names none), how old the lock is, and how long this run will wait. */
export interface Waiting {
  holder: Holder | undefined;
  ageMs: number;
  waitMs: number;
}

/** What a run that gave up knows: the holder, the lock's age now, the time already waited, and the constants the takeover rules use. */
export interface BusyDetail {
  holder: Holder | undefined;
  /** Time since the holder took the lock, else since the lock file was last touched. */
  ageMs: number;
  /** Time since the lock file was last touched: a live holder touches it every `staleMs / 4`. */
  untouchedMs: number;
  waitedMs: number;
  staleMs: number;
  /** Whether the holder is a process on this host: its heartbeat then keeps the lock fresh while it lives, so only its end (not the clock) frees the lock. */
  local: boolean;
}

export interface LockWait {
  /** Called once if the lock is still held after `noticeMs`. */
  onWait?: (waiting: Waiting) => void;
  /** Ends the wait: the run throws the signal's reason. An interrupted `--send` leaves nothing waiting. */
  signal?: AbortSignal;
}

export class SendLockBusy extends Error {
  readonly detail: BusyDetail;
  constructor(detail: BusyDetail = { holder: undefined, ageMs: 0, untouchedMs: 0, waitedMs: 0, staleMs: DEFAULT_TIMES.staleMs, local: false }) {
    super('Another oars run is sending from this outbox.');
    this.detail = detail;
  }
}

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && Reflect.get(error, 'code') === 'EPERM';
  }
};

/** The holder a lock file names, or `undefined` for a file that is empty, half written, or not in this format: such a lock is judged by the clock alone. */
const holderOf = async (file: string): Promise<Holder | undefined> => {
  const text = await readFile(file, 'utf8').catch(() => '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const run: unknown = Reflect.get(parsed, 'run');
  const pid: unknown = Reflect.get(parsed, 'pid');
  const host: unknown = Reflect.get(parsed, 'host');
  const since: unknown = Reflect.get(parsed, 'since');
  return typeof run === 'string' && typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && typeof host === 'string' && typeof since === 'number' ? { run, pid, host, since } : undefined;
};

// EEXIST means another run holds the file. On Windows an open of a file whose delete is still pending (the holder just released it) answers EPERM or EACCES instead: the same contention, so retry within waitMs.
const contended = (error: unknown, platform: NodeJS.Platform): boolean => {
  if (!(error instanceof Error)) return false;
  const code: unknown = Reflect.get(error, 'code');
  return code === 'EEXIST' || (platform === 'win32' && (code === 'EPERM' || code === 'EACCES'));
};

/**
 * Whether a lock can be removed now: its holder is a process on this machine that is not running (taken over at once, whatever the clock says), or the file has not been touched for `staleMs` (the holder's heartbeat stopped).
 * A holder whose liveness cannot be read (an empty file, another host's pid) is judged by the clock alone, which is the only reason `staleMs` stays at ten minutes. A pid the system has handed to another process since reads as
 * running, so pid reuse can only make a waiter wait for the clock, never take a live holder's lock; the lock's age is not taken from the pid for that reason.
 */
const reclaimable = async (file: string, staleMs: number, fs: LockFs, now: () => number): Promise<boolean> => {
  const held = await fs.stat(file).catch(() => undefined);
  if (held === undefined) return false;
  if (now() - held.mtimeMs > staleMs) return true;
  const holder = await holderOf(file);
  return holder !== undefined && holder.host === (fs.self?.host ?? hostname()) && !(fs.running ?? running)(holder.pid);
};

/**
 * A reclaimable lock is removed under a takeover guard (`send.lock.takeover`, created with `wx`), so one waiter at a time reads the lock again and removes it only if it is still reclaimable. A live lock is never moved
 * or removed: a waiter that read a lock as reclaimable, but meets a lock another run took over and refreshed in the meantime, finds it live under the guard and leaves it. A guard left by a taker that died is
 * removed once it is older than `staleMs`.
 */
const takeOver = async (file: string, staleMs: number, fs: LockFs, now: () => number): Promise<boolean> => {
  const guard = `${file}.takeover`;
  try {
    await (await open(guard, 'wx')).close();
  } catch {
    const left = await stat(guard).catch(() => undefined);
    if (left !== undefined && now() - left.mtimeMs > staleMs) await rm(guard, { force: true });
    return false;
  }
  try {
    if (!(await reclaimable(file, staleMs, fs, now))) return false;
    await rm(file, { force: true });
    return true;
  } finally {
    await rm(guard, { force: true });
  }
};

export const withSendLock = async <T>(outbox: string, run: () => Promise<T>, times: Partial<LockTimes> = {}, fs: LockFs = { stat }, wait: LockWait = {}): Promise<T> => {
  const { staleMs, waitMs, pollMs, noticeMs } = { ...DEFAULT_TIMES, ...times };
  const file = join(outbox, 'send.lock');
  const runId = randomUUID();
  const create = fs.open ?? open;
  const platform = fs.platform ?? process.platform;
  const clock = fs.clock ?? { now: () => Date.now(), sleep: (ms: number) => sleep(ms) };
  const self = fs.self ?? { pid: process.pid, host: hostname() };
  await mkdir(outbox, { recursive: true });
  const began = clock.now();
  const giveUp = began + waitMs;
  let noticed = false;
  for (;;) {
    if (wait.signal?.aborted === true) throw wait.signal.reason;
    try {
      const handle = await create(file, 'wx');
      const holder: Holder = { run: runId, pid: self.pid, host: self.host, since: clock.now() };
      await handle.writeFile(JSON.stringify(holder));
      await handle.close();
      break;
    } catch (error) {
      if (!contended(error, platform)) throw error;
    }
    const held = await fs.stat(file).catch(() => undefined);
    // A takeover that cleared the lock goes straight back to taking it; any other outcome waits, and gives up once waitMs has passed.
    if (held !== undefined && (await reclaimable(file, staleMs, fs, clock.now)) && (await takeOver(file, staleMs, fs, clock.now))) continue;
    const at = clock.now();
    const holder = await holderOf(file);
    const untouchedMs = held === undefined ? 0 : Math.max(0, at - held.mtimeMs);
    const ageMs = holder === undefined ? untouchedMs : Math.max(0, at - holder.since);
    if (!noticed && at - began >= noticeMs) {
      noticed = true;
      wait.onWait?.({ holder, ageMs, waitMs });
    }
    if (at >= giveUp) throw new SendLockBusy({ holder, ageMs, untouchedMs, waitedMs: at - began, staleMs, local: holder?.host === self.host });
    await clock.sleep(pollMs);
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
    if ((await holderOf(file))?.run === runId) await rm(file, { force: true });
  }
};

/** Why an interactive send ended before it finished: a signal reached it, or the process that launched it is gone. */
export class SendInterrupted extends Error {
  constructor(readonly kind: 'signal' | 'launcher', message: string, readonly signal?: NodeJS.Signals) {
    super(message);
    this.name = 'SendInterrupted';
  }
}

/** What a test replaces: the process's signal hooks, its launcher, and how that launcher's liveness is read. */
export interface InterruptHost {
  on: (event: NodeJS.Signals, listener: () => void) => unknown;
  off: (event: NodeJS.Signals, listener: () => void) => unknown;
  /** The pid of the process that started this one; checked every `checkMs`. */
  parent: number;
  running: (pid: number) => boolean;
  checkMs: number;
}

const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * The signal an interactive `oars pool deposit --send` waits and sends under. Ctrl-C, a closed terminal, and a kill all end it. A launcher that is killed without a signal reaching its child (Windows `taskkill` of the
 * shell or the `oars.cmd` shim, a `timeout` wrapper) leaves the child running, so the launcher's pid is read every second and a run whose launcher is gone ends too. The detached nightly sender is not watched:
 * it is meant to outlive its starter.
 */
export const watchInterrupt = (host: InterruptHost = { on: (event, listener) => process.on(event, listener), off: (event, listener) => process.off(event, listener), parent: process.ppid, running, checkMs: 1000 }): { signal: AbortSignal; stop: () => void } => {
  const controller = new AbortController();
  const listeners = SIGNALS.map((name): [NodeJS.Signals, () => void] => [
    name,
    () => {
      controller.abort(new SendInterrupted('signal', `Interrupted by ${name}.`, name));
    },
  ]);
  for (const [name, listener] of listeners) host.on(name, listener);
  const timer = setInterval(() => {
    if (!host.running(host.parent)) controller.abort(new SendInterrupted('launcher', 'The program that started this send is gone.'));
  }, host.checkMs);
  timer.unref();
  return {
    signal: controller.signal,
    stop: () => {
      clearInterval(timer);
      for (const [name, listener] of listeners) host.off(name, listener);
    },
  };
};
