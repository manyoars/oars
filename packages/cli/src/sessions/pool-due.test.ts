// The due check with driven time: an injected clock and starter, a temp store, no sleeps. The store is a folder under the OS temp dir, asserted before any write.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterStop, catchUp, recordSchedule, scheduleOptedOut, SEND_EVERY_MS, startSender, storeReady, type CatchUpDeps } from './pool-due.js';

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
});

const store = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'oars-due-'));
  made.push(root);
  const dir = join(root, 'sessions');
  if (!dir.startsWith(tmpdir())) throw new Error('the test store is not under the temp folder');
  mkdirSync(dir, { recursive: true });
  return dir;
};

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
const MINUTE = 60_000;

/** A starter that counts, and a clock the test moves. */
const rig = (storeDir: string, ready = true): { deps: CatchUpDeps; clock: { at: number }; started: number[] } => {
  const clock = { at: T0 };
  const started: number[] = [];
  return { deps: { storeDir, now: () => clock.at, ready: () => Promise.resolve(ready), start: () => void started.push(clock.at) }, clock, started };
};

describe('the due check', () => {
  it('starts one sender when nothing was started before, and none while the window is open', async () => {
    const { deps, clock, started } = rig(store());
    expect(await catchUp(deps)).toBe('started');
    clock.at = T0 + 59 * MINUTE;
    expect(await catchUp(deps)).toBe('not-due');
    expect(started).toEqual([T0]);
  });

  it('starts another once the debounce has passed', async () => {
    const { deps, clock, started } = rig(store());
    await catchUp(deps);
    clock.at = T0 + SEND_EVERY_MS;
    expect(await catchUp(deps)).toBe('started');
    expect(started).toEqual([T0, T0 + SEND_EVERY_MS]);
  });

  it('starts nothing for a machine with no session store of its own', async () => {
    const { deps, started } = rig(store(), false);
    expect(await catchUp(deps)).toBe('not-ready');
    expect(started).toEqual([]);
  });

  it('lets two callers inside one window start one sender', async () => {
    const { deps, started } = rig(store());
    const results = await Promise.all([catchUp(deps), catchUp(deps), catchUp(deps)]);
    expect(results.filter((result) => result === 'started')).toHaveLength(1);
    expect(results.filter((result) => result === 'claimed' || result === 'not-due')).toHaveLength(2);
    expect(started).toEqual([T0]);
  });

  it('counts a mark from the future as no mark, and sweeps the claims of earlier windows', async () => {
    const dir = store();
    writeFileSync(join(dir, 'pool-due.json'), `${JSON.stringify({ startedAt: T0 + 5 * SEND_EVERY_MS })}\n`);
    writeFileSync(join(dir, 'pool-due.1.claim'), '');
    const { deps, started } = rig(dir);
    expect(await catchUp(deps)).toBe('started');
    expect(started).toEqual([T0]);
    expect(readdirSync(dir).filter((name) => name.endsWith('.claim'))).toEqual([`pool-due.${String(Math.floor(T0 / SEND_EVERY_MS))}.claim`]);
  });

  it('reads a damaged or non-numeric mark as no mark', async () => {
    const dir = store();
    const { deps } = rig(dir);
    writeFileSync(join(dir, 'pool-due.json'), 'not json');
    expect(await catchUp(deps)).toBe('started');
    writeFileSync(join(dir, 'pool-due.json'), '{"startedAt":"yesterday"}');
    deps.now = () => T0 + 2 * SEND_EVERY_MS;
    expect(await catchUp(deps)).toBe('started');
  });

  it('fails open: a starter that throws is written to the log and the caller sees a word, not an error', async () => {
    const dir = store();
    const { deps } = rig(dir);
    deps.start = () => {
      throw new Error('spawn denied');
    };
    expect(await catchUp(deps)).toBe('failed');
    expect(readFileSync(join(dir, 'pool-send.log'), 'utf8')).toBe(`${new Date(T0).toISOString()} spawn denied\n`);
  });

  it('fails open when the store cannot even take the log', async () => {
    const dir = store();
    const { deps } = rig(join(dir, 'file-not-folder', 'sessions'));
    writeFileSync(join(dir, 'file-not-folder'), '');
    expect(await catchUp(deps)).toBe('failed');
  });

  it('returns while the sender is still running: nothing awaits it', async () => {
    const { deps } = rig(store());
    let finish: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let finished = false;
    deps.start = () => {
      void running.then(() => {
        finished = true;
      });
    };
    expect(await catchUp(deps)).toBe('started');
    expect(finished).toBe(false);
    finish();
    await running;
  });
});

describe('the store and the sender', () => {
  it('counts a store once state.json is there', async () => {
    const dir = store();
    expect(await storeReady(dir)()).toBe(false);
    writeFileSync(join(dir, 'state.json'), '{}');
    expect(await storeReady(dir)()).toBe(true);
  });

  it('starts node on hook-bin nightly, detached, with no stdio, and lets go of it', () => {
    const calls: { command: string; args: string[]; options: object }[] = [];
    const events: string[] = [];
    startSender('C:\\x\\hook-bin.js', store(), () => T0, (command, args, options) => {
      calls.push({ command, args, options });
      return {
        on: (event) => void events.push(event),
        unref: () => void events.push('unref'),
      };
    })();
    expect(calls).toEqual([{ command: process.execPath, args: ['C:\\x\\hook-bin.js', 'nightly'], options: { detached: true, stdio: 'ignore', windowsHide: true } }]);
    expect(events).toEqual(['error', 'unref']);
  });

  it('writes a child that cannot start to the log, masked, and the caller sees nothing', async () => {
    const dir = store();
    const child = new EventEmitter();
    startSender('hook-bin.js', dir, () => T0, () => ({ on: (event, listener) => child.on(event, listener), unref: () => undefined }))();
    child.emit('error', new Error('spawn EACCES\nsecond line'));
    await vi.waitFor(() => {
      expect(readFileSync(join(dir, 'pool-send.log'), 'utf8')).toBe(`${new Date(T0).toISOString()} spawn EACCES\n`);
    });
  });
});

describe('the recorded opt-out', () => {
  it('holds the check back while schedule.json says off, and starts again once it is cleared', async () => {
    const dir = store();
    writeFileSync(join(dir, 'state.json'), '{}');
    const { deps, started } = rig(dir);
    deps.ready = storeReady(dir);
    await recordSchedule(dir, 'off');
    expect(readFileSync(join(dir, 'schedule.json'), 'utf8')).toBe('{"schedule":"off"}\n');
    expect(await scheduleOptedOut(dir)).toBe(true);
    expect(await catchUp(deps)).toBe('not-ready');
    expect(started).toEqual([]);
    await recordSchedule(dir, 'on');
    expect(existsSync(join(dir, 'schedule.json'))).toBe(false);
    expect(await scheduleOptedOut(dir)).toBe(false);
    expect(await catchUp(deps)).toBe('started');
    expect(started).toEqual([T0]);
  });

  it('counts a damaged or other record as no opt-out, and clearing it twice is harmless', async () => {
    const dir = store();
    writeFileSync(join(dir, 'schedule.json'), 'not json');
    expect(await scheduleOptedOut(dir)).toBe(false);
    writeFileSync(join(dir, 'schedule.json'), '{"schedule":"nightly"}');
    expect(await scheduleOptedOut(dir)).toBe(false);
    writeFileSync(join(dir, 'schedule.json'), '"off"');
    expect(await scheduleOptedOut(dir)).toBe(false);
    await recordSchedule(dir, 'on');
    await recordSchedule(dir, 'on');
  });

  it('creates the store folder to record an opt-out in a store not yet made', async () => {
    const dir = join(store(), 'later');
    await recordSchedule(dir, 'off');
    expect(await scheduleOptedOut(dir)).toBe(true);
  });
});

describe('the session-end hook tail', () => {
  it('returns started while the sender it started is still running (a child that never exits), and writes nothing to stdout', async () => {
    const dir = store();
    writeFileSync(join(dir, 'state.json'), '{}');
    const wrote = vi.spyOn(process.stdout, 'write');
    const calls: string[][] = [];
    try {
      const result = await afterStop(dir, 'hook-bin.js', () => T0, (_command, args) => {
        calls.push(args);
        return { on: () => undefined, unref: () => undefined };
      });
      expect(result).toBe('started');
      expect(calls).toEqual([['hook-bin.js', 'nightly']]);
      expect(wrote).not.toHaveBeenCalled();
    } finally {
      wrote.mockRestore();
    }
  });

  it('starts nothing and writes nothing when the person opted out', async () => {
    const dir = store();
    writeFileSync(join(dir, 'state.json'), '{}');
    await recordSchedule(dir, 'off');
    const calls: string[][] = [];
    expect(await afterStop(dir, 'hook-bin.js', () => T0, (_command, args) => {
      calls.push(args);
      return { on: () => undefined, unref: () => undefined };
    })).toBe('not-ready');
    expect(calls).toEqual([]);
  });
});
