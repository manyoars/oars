// `waitUntilFree` ends on the condition the temp-home cleanups need: no process holds the folder. A child whose working directory is the folder holds it on Windows (a rename fails with `EBUSY` or `EPERM`),
// and the wait must outlast that child; driven by the child's own exit, never by a delay.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { waitUntilFree } from './test-support.js';

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const temp = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-free-'));
  made.push(folder, `${folder}.free`);
  if (!folder.startsWith(tmpdir())) throw new Error('the test folder is not under the temp folder');
  return folder;
};

describe('waitUntilFree', () => {
  it('moves a folder nothing holds aside and returns where it went', async () => {
    const folder = temp();
    const moved = await waitUntilFree(folder);
    expect(moved).toBe(`${folder}.free`);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(moved)).toBe(true);
  });

  it('returns a folder that is already gone as it is', async () => {
    const folder = temp();
    rmSync(folder, { recursive: true });
    expect(await waitUntilFree(folder)).toBe(folder);
  });

  it('waits for a process that has the folder as its working directory to exit', async () => {
    const folder = temp();
    const child = spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdout.write('up')"], { cwd: folder, stdio: ['pipe', 'pipe', 'ignore'] });
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.stdout.once('data', () => {
        resolve();
      });
    });
    // Windows refuses to move a folder a live process has as its working directory; elsewhere the move works and the wait is a single try, so the proof is the Windows one.
    if (process.platform === 'win32') expect(() => renameSync(folder, `${folder}.held`)).toThrow();
    const waiting = waitUntilFree(folder);
    const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
    child.stdin.end();
    await closed;
    expect(await waiting).toBe(`${folder}.free`);
    expect(existsSync(`${folder}.free`)).toBe(true);
  });
});
