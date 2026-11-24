// The store lock is released on every exit path a holder can reach: a throw (the `finally`), and a signal (a listener that removes it first). An abort cannot be caught in-process;
// `nightly-detached.test.ts` covers the parent that releases that one.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { withLock } from './store.js';

const storeJs = fileURLToPath(new URL('../../dist/sessions/store.js', import.meta.url));

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const store = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-lock-exit-'));
  made.push(folder);
  return folder;
};

describe('the store lock on exit', () => {
  it('is gone after a run that throws', async () => {
    const folder = store();
    await expect(
      withLock(folder, async () => {
        await Promise.resolve();
        expect(existsSync(join(folder, 'store.lock'))).toBe(true);
        throw new Error('derive ran out of something');
      }),
    ).rejects.toThrow('derive ran out of something');
    expect(existsSync(join(folder, 'store.lock'))).toBe(false);
  });

  it.skipIf(!existsSync(storeJs) || process.platform === 'win32')('is gone after a holder is ended by SIGTERM, and the process still ends by that signal', async () => {
    const folder = store();
    // The holder says `held` once it has the lock, then works until it is killed.
    const script = `import { withLock } from ${JSON.stringify(pathToFileURL(storeJs).href)};
await withLock(${JSON.stringify(folder)}, () => new Promise(() => { process.stdout.write('held'); setInterval(() => undefined, 1000); }));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => child.stdout.once('data', () => {
      resolve();
    }));
    expect(existsSync(join(folder, 'store.lock'))).toBe(true);
    const ended = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once('exit', (code, signal) => {
      resolve({ code, signal });
    }));
    child.kill('SIGTERM');
    expect(await ended).toEqual({ code: null, signal: 'SIGTERM' });
    expect(existsSync(join(folder, 'store.lock'))).toBe(false);
  });
});
