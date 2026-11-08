// The two triggers of the due check, with driven time: a command run through `run()` and the SessionEnd hook's call. The store is a temp folder under the OS temp dir, asserted before any write; the
// spawner is injected, so no sender process starts and nothing here touches the real store or the real scheduled task.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { harness } from '../test-support.js';
import { catchUpOnStore, SEND_EVERY_MS } from './pool-due.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
});

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);

/** A store that exists (its state.json is there), under the temp folder. */
const store = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'oars-due-trigger-'));
  roots.push(root);
  const dir = join(root, 'sessions');
  if (!dir.startsWith(tmpdir())) throw new Error('the test store is not under the temp folder');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), '{}');
  return dir;
};

interface Started {
  command: string;
  args: string[];
}

/** The spawner a sender would start through: it records, and the child it returns does nothing. */
const spawner = (started: Started[]) => (command: string, args: string[]): { on: () => undefined; unref: () => undefined } => {
  started.push({ command, args });
  return { on: () => undefined, unref: () => undefined };
};

describe('a command runs the catch-up', () => {
  it('starts one sender per window across commands, and another once the window has passed', async () => {
    const dir = store();
    const started: Started[] = [];
    const clock = { at: T0 };
    const { deps, out } = harness();
    deps.catchUp = () => catchUpOnStore(dir, 'hook-bin.js', () => clock.at, spawner(started));
    expect(await run(['--version'], deps)).toBe(0);
    expect(await run(['--version'], deps)).toBe(0);
    expect(started).toEqual([{ command: process.execPath, args: ['hook-bin.js', 'nightly'] }]);
    clock.at = T0 + SEND_EVERY_MS;
    await run(['--version'], deps);
    expect(started).toHaveLength(2);
    expect(out).toEqual(['9.9.9\n', '9.9.9\n', '9.9.9\n']);
  });

  it('leaves the exit code and the output as they were when the catch-up throws or rejects', async () => {
    const plain = harness();
    const plainExit = await run(['--version'], plain.deps);
    for (const failing of [(): Promise<never> => Promise.reject(new Error('boom')), (): Promise<never> => {
      throw new Error('boom');
    }]) {
      const { deps, out, err } = harness();
      deps.catchUp = failing;
      expect(await run(['--version'], deps)).toBe(plainExit);
      expect(out).toEqual(plain.out);
      expect(err).toEqual(plain.err);
    }
  });

  it('is not run from a gate hook, which fires before every tool call', async () => {
    const { deps } = harness();
    let calls = 0;
    deps.catchUp = () => {
      calls += 1;
      return Promise.resolve();
    };
    await run(['gate', 'hook', '--bogus'], deps);
    expect(calls).toBe(0);
    await run(['--version'], deps);
    expect(calls).toBe(1);
  });
  it('is not run from hook uninstall, whose removal steps delete the store the sweep would recreate', async () => {
    const { deps } = harness();
    const dir = store();
    // The runtime points at the temp folder on a non-Windows platform, so no real settings file and no real task is read.
    deps.install = { platform: 'linux', nodePath: process.execPath, hookBin: 'hook-bin.js', userSettings: join(dir, 'settings.json'), cwd: dir, schtasks: () => Promise.resolve({ code: 1, output: '' }) };
    let calls = 0;
    deps.catchUp = () => {
      calls += 1;
      return Promise.resolve();
    };
    expect(await run(['sessions', 'hook', 'uninstall', '--file', join(dir, 'settings.json')], deps)).toBe(0);
    expect(calls).toBe(0);
    await run(['--version'], deps);
    expect(calls).toBe(1);
  });
});

describe('the SessionEnd hook runs the catch-up', () => {
  it('returns while the sender it started is still running, and a second hook in the window starts none', async () => {
    const dir = store();
    const started: Started[] = [];
    let release: () => void = () => undefined;
    const sender = new Promise<void>((resolve) => {
      release = resolve;
    });
    let senderDone = false;
    void sender.then(() => {
      senderDone = true;
    });
    const spawn = spawner(started);
    expect(await catchUpOnStore(dir, 'hook-bin.js', () => T0, spawn)).toBe('started');
    expect(senderDone).toBe(false);
    expect(await catchUpOnStore(dir, 'hook-bin.js', () => T0 + 1, spawn)).toBe('not-due');
    expect(started).toHaveLength(1);
    release();
    await sender;
  });

  it('starts nothing where there is no store', async () => {
    const dir = store();
    rmSync(join(dir, 'state.json'));
    const started: Started[] = [];
    expect(await catchUpOnStore(dir, 'hook-bin.js', () => T0, spawner(started))).toBe('not-ready');
    expect(started).toEqual([]);
  });
});
