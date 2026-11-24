import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detachedNightly, exitReason, releaseDeadLock, spawnRun, type RunExit, type RunSpawn } from './nightly-detached.js';

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const store = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-nightly-detached-'));
  made.push(folder);
  return folder;
};

const rows = (folder: string, name: string): unknown[] =>
  existsSync(join(folder, name))
    ? readFileSync(join(folder, name), 'utf8')
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line))
    : [];

/** The named fields of each row, so a row is compared on what this test is about. */
const pick = (list: unknown[], ...keys: string[]): unknown[] => list.map((row) => Object.fromEntries(keys.map((key) => [key, typeof row === 'object' && row !== null ? Reflect.get(row, key) : undefined])));

/** The detached nightly over `run`, counting the sends. */
const night = async (folder: string, run: () => Promise<RunExit>): Promise<number> => {
  let sends = 0;
  await detachedNightly({
    storeDir: folder,
    now: () => Date.parse('2026-11-24T02:00:00Z'),
    run,
    send: () => {
      sends += 1;
      return Promise.resolve();
    },
  });
  return sends;
};

describe('detachedNightly', () => {
  it('sends after a run that aborted out of memory, records the run as failed, and removes the lock the dead run held', async () => {
    const folder = store();
    writeFileSync(join(folder, 'store.lock'), '4242 0b5c6a3e-claim');
    expect(await night(folder, () => Promise.resolve({ code: null, signal: 'SIGABRT', pid: 4242 }))).toBe(1);
    const reason = 'The nightly run aborted (out of memory, or another abort) before it recorded its steps.';
    expect(pick(rows(folder, 'hook-calls.jsonl'), 'event', 'session', 'hit', 'error')).toEqual([{ event: 'nightly', session: null, hit: false, error: reason }]);
    expect(pick(rows(folder, 'pipeline-runs.jsonl'), 'trigger', 'step', 'status', 'error')).toEqual([
      { trigger: 'nightly', step: 'deposit', status: 'error', error: reason },
      { trigger: 'nightly', step: 'derive', status: 'skipped', error: null },
      { trigger: 'nightly', step: 'index', status: 'skipped', error: null },
    ]);
    expect(existsSync(join(folder, 'store.lock'))).toBe(false);
  });

  it('sends after a run whose process cannot start, and records why', async () => {
    const folder = store();
    expect(await night(folder, () => Promise.reject(new Error('spawn node ENOENT')))).toBe(1);
    expect(pick(rows(folder, 'hook-calls.jsonl'), 'event', 'error')).toEqual([{ event: 'nightly', error: 'spawn node ENOENT' }]);
  });

  it('adds no rows after a clean run, which wrote its own, and leaves a lock it does not name alone', async () => {
    const folder = store();
    writeFileSync(join(folder, 'store.lock'), '777 another-claim');
    expect(await night(folder, () => Promise.resolve({ code: 0, signal: null, pid: 4242 }))).toBe(1);
    expect(rows(folder, 'hook-calls.jsonl')).toEqual([]);
    expect(rows(folder, 'pipeline-runs.jsonl')).toEqual([]);
    expect(existsSync(join(folder, 'store.lock'))).toBe(true);
  });

  it('keeps a lock another process took after the run died', async () => {
    const folder = store();
    writeFileSync(join(folder, 'store.lock'), '777 another-claim');
    await night(folder, () => Promise.resolve({ code: 134, signal: null, pid: 4242 }));
    expect(existsSync(join(folder, 'store.lock'))).toBe(true);
    expect(await releaseDeadLock(folder, 777)).toBe(true);
    expect(await releaseDeadLock(folder, 777)).toBe(false);
  });
});

describe('exitReason', () => {
  it('names an abort, a signal, and an exit code, and nothing for a clean exit', () => {
    expect(exitReason({ code: 0, signal: null, pid: 1 })).toBeUndefined();
    expect(exitReason({ code: 134, signal: null, pid: 1 })).toContain('aborted');
    expect(exitReason({ code: null, signal: 'SIGTERM', pid: 1 })).toContain('SIGTERM');
    expect(exitReason({ code: 3, signal: null, pid: 1 })).toContain('exit code 3');
  });
});

describe('spawnRun', () => {
  /** A child that ends as `end` says once it is listened to. */
  const fake = (end: (child: EventEmitter) => void): { start: RunSpawn; calls: unknown[][] } => {
    const calls: unknown[][] = [];
    const start: RunSpawn = (command, args, options) => {
      calls.push([command, args, options]);
      const child = Object.assign(new EventEmitter(), { pid: 99 });
      setImmediate(() => {
        end(child);
      });
      return child;
    };
    return { start, calls };
  };

  it('starts `node <hook-bin> nightly-run` with no stdio and resolves with how it ended', async () => {
    const { start, calls } = fake((child) => child.emit('exit', null, 'SIGABRT'));
    expect(await spawnRun('/dist/hook-bin.js', start, '/bin/node')()).toEqual({ code: null, signal: 'SIGABRT', pid: 99 });
    expect(calls).toEqual([['/bin/node', ['/dist/hook-bin.js', 'nightly-run'], { stdio: 'ignore', windowsHide: true }]]);
  });

  it('rejects when the child cannot start', async () => {
    const { start } = fake((child) => child.emit('error', new Error('spawn EACCES')));
    await expect(spawnRun('/dist/hook-bin.js', start)()).rejects.toThrow('spawn EACCES');
  });
});
