// The machine child: the settle wait before each extraction (on a clock the test drives), and the single flight on the send lock with the dirty mark. The outbox is a temp folder; no store and no pool is touched.
// Two races are closed on purpose, and each is driven here at the exact point: `stat` and `open` of node's file system are wrapped so a test can act between two of the child's own steps.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, type PathLike } from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { machineChild, parseChildInput, settle, type ChildInput, type MachineChildDeps, type SettleTimes } from './machine-child.js';

const hooks = vi.hoisted((): { beforeStat: ((path: string) => void) | undefined; beforeOpen: ((path: string) => void) | undefined } => ({ beforeStat: undefined, beforeOpen: undefined }));

vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof fsPromises>('node:fs/promises');
  return {
    ...real,
    stat: (path: PathLike) => {
      hooks.beforeStat?.(path.toString());
      return real.stat(path);
    },
    open: (path: PathLike, flags: string) => {
      hooks.beforeOpen?.(path.toString());
      return real.open(path, flags);
    },
  };
});

const made: string[] = [];
afterEach(() => {
  hooks.beforeStat = undefined;
  hooks.beforeOpen = undefined;
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const outboxFolder = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-machine-child-'));
  made.push(folder);
  if (!folder.startsWith(tmpdir())) throw new Error('the test outbox is not under the temp folder');
  return folder;
};

const input = (session: string): ChildInput => ({ session, transcript: `/t/${session}.jsonl`, cwd: '/work/repo' });

/** A mark line as a Stop writes it. */
const markOf = (session: string): string => `${JSON.stringify({ session_id: session, transcript_path: `/t/${session}.jsonl`, cwd: '/work/repo' })}\n`;

/** A clock the test drives: `sleep` moves it, so a settle wait takes no real time. */
const clockOf = (sizeAt: (at: number) => number | undefined): Pick<MachineChildDeps, 'now' | 'sleep' | 'size'> & { at: () => number } => {
  let clock = 0;
  return {
    at: () => clock,
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    size: () => Promise.resolve(sizeAt(clock)),
  };
};

const TIMES: SettleTimes = { quietMs: 2000, maxMs: 15_000, pollMs: 250 };

describe('settle', () => {
  it('returns once the transcript has been the same size for the quiet time', async () => {
    const clock = clockOf(() => 100);
    expect(await settle('/t', clock, TIMES)).toBe('quiet');
    expect(clock.at()).toBe(2000);
  });

  it('starts the quiet time again at each growth', async () => {
    const clock = clockOf((at) => (at < 3000 ? at : 3000));
    expect(await settle('/t', clock, TIMES)).toBe('quiet');
    expect(clock.at()).toBeGreaterThanOrEqual(5000);
    expect(clock.at()).toBeLessThan(5500);
  });

  it('gives up at the longest wait and captures the transcript as it is', async () => {
    const clock = clockOf((at) => at);
    expect(await settle('/t', clock, TIMES)).toBe('timeout');
    expect(clock.at()).toBe(15_000);
  });

  it('treats a transcript that cannot be read as unchanging', async () => {
    expect(await settle('/t', clockOf(() => undefined), TIMES)).toBe('quiet');
  });
});

describe('parseChildInput', () => {
  it('reads the forwarded session, transcript, and folder', () => {
    expect(parseChildInput(JSON.stringify({ session_id: 's', transcript_path: '/t', cwd: '/c' }))).toEqual({ session: 's', transcript: '/t', cwd: '/c' });
    expect(parseChildInput(JSON.stringify({ session_id: 's', transcript_path: '/t' }))).toEqual({ session: 's', transcript: '/t', cwd: undefined });
  });

  it.each([[''], ['{'], ['null'], ['{}'], [JSON.stringify({ session_id: '', transcript_path: '/t' })], [JSON.stringify({ session_id: 's', transcript_path: 3 })]])('refuses %s', (text) => {
    expect(parseChildInput(text)).toBeUndefined();
  });
});

describe('machineChild', () => {
  const deps = (outbox: string, log: string[], extra: Partial<MachineChildDeps> = {}): MachineChildDeps => ({
    outbox,
    ...clockOf(() => 1),
    allowed: () => Promise.resolve(true),
    capture: (given) => {
      log.push(`capture ${given.session}`);
      return Promise.resolve();
    },
    build: (given) => {
      log.push(`build ${given.session}`);
      return Promise.resolve();
    },
    hold: (given) => {
      log.push(`hold ${given.session}`);
      return Promise.resolve();
    },
    ...extra,
  });

  it('settles, captures, then builds, and lets go of the lock', async () => {
    const outbox = outboxFolder();
    const log: string[] = [];
    expect(await machineChild(deps(outbox, log, { settle: TIMES }), input('a'))).toBe('built');
    expect(log).toEqual(['capture a', 'build a', 'hold a']);
    expect(existsSync(join(outbox, 'send.lock'))).toBe(false);
    expect(existsSync(join(outbox, 'send.dirty'))).toBe(false);
  });

  it('builds nothing for a session whose repository is off the allow list: no wait, no capture, no build', async () => {
    const outbox = outboxFolder();
    const log: string[] = [];
    const asked: (string | undefined)[] = [];
    const guarded = deps(outbox, log, {
      settle: TIMES,
      allowed: (given) => {
        asked.push(given.cwd);
        return Promise.resolve(given.session === 'on');
      },
      size: () => {
        log.push('size');
        return Promise.resolve(1);
      },
    });
    expect(await machineChild(guarded, { ...input('off'), cwd: '/srv/off' })).toBe('built');
    expect(log).toEqual([]);
    expect(await machineChild(guarded, { ...input('on'), cwd: '/srv/on' })).toBe('built');
    expect(log).toContain('capture on');
    expect(log).toContain('build on');
    expect(log).not.toContain('capture off');
    expect(asked).toEqual(['/srv/off', '/srv/on']);
    expect(existsSync(join(outbox, 'send.lock'))).toBe(false);
  });

  it('waits for the transcript to settle before each extraction', async () => {
    const outbox = outboxFolder();
    const log: string[] = [];
    const clock = clockOf(() => 1);
    await machineChild(deps(outbox, log, { ...clock, settle: TIMES }), input('a'));
    expect(clock.at()).toBe(2000);
  });

  it('one child at a time: a Stop that finds the lock held marks it and leaves, and the holder builds the latest transcript before it lets go', async () => {
    const outbox = outboxFolder();
    const log: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const holding = deps(outbox, log, {
      build: async (given) => {
        log.push(`build ${given.session}`);
        if (first) {
          first = false;
          await gate;
        }
      },
    });
    const holder = machineChild(holding, input('a'));
    await vi.waitFor(() => {
      expect(log).toContain('build a');
    });
    // Two more Stops of the same burst, and one of another session: none runs, all are marked.
    expect(await machineChild(deps(outbox, log), input('a'))).toBe('marked');
    expect(await machineChild(deps(outbox, log), input('b'))).toBe('marked');
    expect(await machineChild(deps(outbox, log), input('a'))).toBe('marked');
    expect(readFileSync(join(outbox, 'send.dirty'), 'utf8').trim().split('\n')).toHaveLength(3);
    expect(log).toEqual(['capture a', 'build a']);
    release();
    expect(await holder).toBe('built');
    // The marks of one session count once: a is built again from its latest transcript, b once.
    expect(log).toEqual(['capture a', 'build a', 'hold a', 'capture a', 'build a', 'hold a', 'capture b', 'build b', 'hold b']);
    expect(existsSync(join(outbox, 'send.dirty'))).toBe(false);
    expect(existsSync(join(outbox, 'send.lock'))).toBe(false);
  });

  it('a mark left before the child starts is built with it', async () => {
    const outbox = outboxFolder();
    writeFileSync(join(outbox, 'send.dirty'), `${markOf('old')}not json\n\n`);
    const log: string[] = [];
    expect(await machineChild(deps(outbox, log), input('a'))).toBe('built');
    expect(log).toEqual(['capture a', 'build a', 'hold a', 'capture old', 'build old', 'hold old']);
  });

  it('a Stop that marks just after the holder let go finds the lock free on its second try and builds its own session', async () => {
    const outbox = outboxFolder();
    const log: string[] = [];
    const lock = join(outbox, 'send.lock');
    // The holder is a lock file another run made; the child's first try meets it, and its second try finds it gone.
    writeFileSync(lock, 'other-run');
    let opens = 0;
    hooks.beforeOpen = (path) => {
      if (!path.endsWith('send.lock')) return;
      opens += 1;
      if (opens === 2) rmSync(lock, { force: true });
    };
    expect(await machineChild(deps(outbox, log), input('b'))).toBe('built');
    expect(log).toEqual(['capture b', 'build b', 'hold b']);
    expect(existsSync(join(outbox, 'send.dirty'))).toBe(false);
  });

  it('a holder that let go while a mark was being written looks once more and builds it', async () => {
    const outbox = outboxFolder();
    const log: string[] = [];
    // The mark appears after the holder's last look inside the lock: the next `stat` of the mark file, which is the holder's look after it let go.
    let written = false;
    hooks.beforeStat = (path) => {
      if (written || !path.endsWith('send.dirty')) return;
      written = true;
      writeFileSync(path, markOf('late'));
    };
    expect(await machineChild(deps(outbox, log), input('a'))).toBe('built');
    expect(log).toEqual(['capture a', 'build a', 'hold a', 'capture late', 'build late', 'hold late']);
    expect(existsSync(join(outbox, 'send.dirty'))).toBe(false);
  });

  it('holds a session once it is built, and holds nothing of a session that failed to build or is off the list', async () => {
    const outbox = outboxFolder();
    const log: string[] = [];
    const failing = deps(outbox, log, { build: () => Promise.reject(new Error('build failed')) });
    await expect(machineChild(failing, input('a'))).rejects.toThrow('build failed');
    const off = deps(outbox, log, { allowed: () => Promise.resolve(false) });
    await machineChild(off, input('b'));
    expect(log).toEqual(['capture a']);
    await machineChild(deps(outbox, log), input('c'));
    expect(log).toEqual(['capture a', 'capture c', 'build c', 'hold c']);
  });

  it('every marked session gets its turn when one fails, and the first failure is reported', async () => {
    const outbox = outboxFolder();
    writeFileSync(join(outbox, 'send.dirty'), markOf('b'));
    const log: string[] = [];
    const failing = deps(outbox, log, {
      build: (given) => {
        log.push(`build ${given.session}`);
        return given.session === 'a' ? Promise.reject(new Error('build failed for a')) : Promise.resolve();
      },
    });
    await expect(machineChild(failing, input('a'))).rejects.toThrow('build failed for a');
    expect(log).toEqual(['capture a', 'build a', 'capture b', 'build b', 'hold b']);
    expect(existsSync(join(outbox, 'send.lock'))).toBe(false);
  });

  it('rethrows a lock that fails for a reason other than being held', async () => {
    // An outbox that is a file, not a folder: the lock cannot be made, which is not contention.
    const notAFolder = join(outboxFolder(), 'file');
    writeFileSync(notAFolder, 'x');
    await expect(machineChild(deps(notAFolder, []), input('a'))).rejects.toThrow();
  });
});
