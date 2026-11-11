// The send lock's liveness rules (t1143): a holder that is not running is replaced at once, a live holder is waited for with a notice and a true busy detail, and an interrupted send leaves nothing waiting. Time is driven: a clock the test moves, never a real sleep.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendInterrupted, SendLockBusy, watchInterrupt, withSendLock, type Holder, type InterruptHost, type LockFs, type Waiting } from './pool-send-lock.js';
import { cleanup, stage } from './test-support.js';

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const HOST = 'laptop';
const FIRST = 1_000_000;

type Clock = NonNullable<LockFs['clock']>;

/** A clock that only `sleep` moves, and the pauses it was asked for. */
const driven = (): { clock: Clock; sleeps: number[]; at: () => number } => {
  const state = { at: FIRST };
  const sleeps: number[] = [];
  return {
    clock: {
      now: () => state.at,
      sleep: (ms) => {
        sleeps.push(ms);
        state.at += ms;
        return Promise.resolve();
      },
    },
    sleeps,
    at: () => state.at,
  };
};

const folder = (): string => {
  const outbox = join(stage().root, 'outbox');
  mkdirSync(outbox, { recursive: true });
  return outbox;
};

const leave = (outbox: string, holder: Partial<Holder> = {}): string => {
  const file = join(outbox, 'send.lock');
  writeFileSync(file, JSON.stringify({ run: 'earlier', pid: 4242, host: HOST, since: FIRST - 90_000, ...holder }));
  return file;
};

/** A lock file that reads as touched `touched` ms after FIRST, on a host named HOST where only the listed pids run. */
const here = (alive: number[], time = driven(), touched = 0): LockFs & { time: ReturnType<typeof driven> } => ({
  stat: () => Promise.resolve({ mtimeMs: FIRST + touched }),
  running: (pid) => alive.includes(pid),
  self: { pid: 7, host: HOST },
  clock: time.clock,
  time,
});

describe('a lock left by a holder that is not running', () => {
  it('is taken over at once: the next send runs with no wait and no pause', async () => {
    const outbox = folder();
    const file = leave(outbox, { pid: 4242 });
    const fs = here([]);
    const notices: Waiting[] = [];
    const seen = await withSendLock(outbox, () => Promise.resolve(readFileSync(file, 'utf8')), { staleMs: 10 * 60_000 }, fs, { onWait: (waiting) => notices.push(waiting) });
    expect(JSON.parse(seen)).toMatchObject({ pid: 7, host: HOST, since: FIRST });
    expect(fs.time.sleeps).toEqual([]);
    expect(fs.time.at()).toBe(FIRST);
    expect(notices).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it('is not taken over while its pid runs, even if the pid was reused: a running pid waits for the clock alone', async () => {
    const outbox = folder();
    leave(outbox, { pid: 4242 });
    const fs = here([4242]);
    await expect(withSendLock(outbox, () => Promise.resolve('ran'), { staleMs: 5000, waitMs: 3000, pollMs: 1000 }, fs)).rejects.toBeInstanceOf(SendLockBusy);
    expect(fs.time.sleeps).toEqual([1000, 1000, 1000]);
    // The same pid, but the heartbeat stopped long ago: the clock takes the lock over.
    const stale = here([4242], driven(), -5001);
    await expect(withSendLock(outbox, () => Promise.resolve('ran'), { staleMs: 5000, waitMs: 3000, pollMs: 1000 }, stale)).resolves.toBe('ran');
    expect(stale.time.sleeps).toEqual([]);
  });

  it('is judged by the clock alone when the pid belongs to another host or the file names nobody', async () => {
    for (const written of [{ host: 'elsewhere' }, undefined]) {
      const outbox = folder();
      if (written === undefined) writeFileSync(join(outbox, 'send.lock'), '');
      else leave(outbox, written);
      const fs = here([]);
      await expect(withSendLock(outbox, () => Promise.resolve('ran'), { staleMs: 600_000, waitMs: 3000, pollMs: 1000 }, fs)).rejects.toBeInstanceOf(SendLockBusy);
      expect(fs.time.sleeps).toEqual([1000, 1000, 1000]);
    }
  });

  it('names no holder for a file that is half written, not an object, or missing a field', async () => {
    const outbox = folder();
    for (const text of ['{"run":"half"', '[]', JSON.stringify({ run: 'x', pid: 'one', host: HOST, since: 1 })]) {
      writeFileSync(join(outbox, 'send.lock'), text);
      const fs = here([]);
      const busy = await withSendLock(outbox, () => Promise.resolve('ran'), { waitMs: 2000, pollMs: 1000 }, fs).catch((error: unknown) => error);
      expect(busy).toBeInstanceOf(SendLockBusy);
      expect(busy).toMatchObject({ detail: { holder: undefined } });
    }
  });
});

describe('waiting behind a live holder', () => {
  it('tells the caller once, within noticeMs, who holds the lock and how long this run will wait', async () => {
    const outbox = folder();
    leave(outbox, { pid: 4242, since: FIRST - 90_000 });
    const fs = here([4242]);
    const notices: Array<Waiting & { at: number }> = [];
    const busy = await withSendLock(outbox, () => Promise.resolve('ran'), { waitMs: 120_000, pollMs: 100, noticeMs: 500 }, fs, {
      onWait: (waiting) => notices.push({ ...waiting, at: fs.time.at() }),
    }).catch((error: unknown) => error);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ holder: { pid: 4242, host: HOST }, ageMs: 90_500, waitMs: 120_000, at: FIRST + 500 });
    expect(busy).toBeInstanceOf(SendLockBusy);
  });

  it('gives up with the true state: the holder, the lock age, the time waited, and staleMs', async () => {
    const outbox = folder();
    leave(outbox, { pid: 4242, since: FIRST - 90_000 });
    const fs = here([4242]);
    const busy = await withSendLock(outbox, () => Promise.resolve('ran'), { waitMs: 2000, pollMs: 500, staleMs: 600_000 }, fs).catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(SendLockBusy);
    expect(busy).toMatchObject({ detail: { holder: { pid: 4242 }, ageMs: 92_000, untouchedMs: 2000, waitedMs: 2000, staleMs: 600_000 } });
  });

  it('takes the lock once the holder releases it', async () => {
    const outbox = folder();
    const file = leave(outbox, { pid: 4242 });
    const fs = here([4242]);
    const pause = fs.time.clock.sleep;
    let polls = 0;
    fs.clock = {
      now: fs.time.clock.now,
      sleep: (ms) => {
        polls += 1;
        // The holder finishes during the second pause.
        if (polls === 2) rmSync(file, { force: true });
        return pause(ms);
      },
    };
    await expect(withSendLock(outbox, () => Promise.resolve('ran'), { waitMs: 60_000, pollMs: 100 }, fs)).resolves.toBe('ran');
    expect(polls).toBe(2);
  });

  it('ends the wait with the reason of an aborted signal, and takes nothing', async () => {
    const outbox = folder();
    const file = leave(outbox, { pid: 4242 });
    const fs = here([4242]);
    const stop = new AbortController();
    const pause = fs.time.clock.sleep;
    fs.clock = {
      now: fs.time.clock.now,
      sleep: (ms) => {
        stop.abort(new SendInterrupted('signal', 'Interrupted by SIGINT.'));
        return pause(ms);
      },
    };
    const ran = vi.fn(() => Promise.resolve('ran'));
    await expect(withSendLock(outbox, ran, { waitMs: 120_000, pollMs: 100 }, fs, { signal: stop.signal })).rejects.toMatchObject({ kind: 'signal', message: 'Interrupted by SIGINT.' });
    expect(ran).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ run: 'earlier' });
  });
});

describe('watchInterrupt', () => {
  const hostOf = (alive: { value: boolean }): InterruptHost & { signals: EventEmitter } => {
    const signals = new EventEmitter();
    return { signals, on: (event, listener) => signals.on(event, listener), off: (event, listener) => signals.off(event, listener), parent: 99, running: () => alive.value, checkMs: 1000 };
  };

  it('aborts on Ctrl-C, a kill, or a closed terminal, and stop removes every hook', () => {
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      const host = hostOf({ value: true });
      const watch = watchInterrupt(host);
      expect(watch.signal.aborted).toBe(false);
      host.signals.emit(name);
      expect(watch.signal.aborted).toBe(true);
      expect(watch.signal.reason).toMatchObject({ kind: 'signal', message: `Interrupted by ${name}.` });
      watch.stop();
      expect(host.signals.eventNames()).toEqual([]);
    }
  });

  it('aborts when the program that launched the send is gone, which no signal reaches the child to say', async () => {
    vi.useFakeTimers();
    const alive = { value: true };
    const watch = watchInterrupt(hostOf(alive));
    await vi.advanceTimersByTimeAsync(5000);
    expect(watch.signal.aborted).toBe(false);
    alive.value = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(watch.signal.reason).toMatchObject({ kind: 'launcher' });
    watch.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a waiting send whose launcher died stops waiting, so it can never take the lock later', async () => {
    // Only the watcher's interval is faked; the lock waits on the driven clock, whose every pause moves the faked interval too.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const outbox = folder();
    const file = leave(outbox, { pid: 4242 });
    const alive = { value: true };
    const watch = watchInterrupt(hostOf(alive));
    const fs = here([4242]);
    const pause = fs.time.clock.sleep;
    let pauses = 0;
    fs.clock = {
      now: fs.time.clock.now,
      sleep: (ms) => {
        pauses += 1;
        // The launcher is killed during the third pause; the watcher notices on its next check.
        if (pauses === 3) alive.value = false;
        vi.advanceTimersByTime(ms);
        return pause(ms);
      },
    };
    const ran = vi.fn(() => Promise.resolve('ran'));
    const failed = await withSendLock(outbox, ran, { waitMs: 120_000, pollMs: 500 }, fs, { signal: watch.signal }).catch((error: unknown) => error);
    expect(failed).toMatchObject({ kind: 'launcher' });
    // Well inside waitMs: it stopped because the launcher died, not because the wait ran out.
    expect(fs.time.at() - FIRST).toBeLessThan(5000);
    // The holder lets go afterwards; nothing of the dead send is left to take the lock.
    rmSync(file, { force: true });
    expect(ran).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
    watch.stop();
  });
});
