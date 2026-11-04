// How the settings file is written: its mode against the umask, a symlink that points at nothing yet, and a rename that fails.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVENT, installGateHook } from './install.js';

const failing = vi.hoisted(() => ({ rename: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: (...args: Parameters<typeof actual.rename>) => (failing.rename ? Promise.reject(new Error('EXDEV: cross-device link not permitted')) : actual.rename(...args)) };
});

const made: string[] = [];
afterEach(() => {
  failing.rename = false;
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const scratch = (): string => {
  const one = mkdtempSync(join(tmpdir(), 'oars-gate-write-'));
  made.push(one);
  return one;
};

const windows = process.platform === 'win32';

describe('gate install: writing the settings file', () => {
  it.skipIf(windows)('keeps a mode the umask would mask, such as 0666', async () => {
    const file = join(scratch(), 'settings.json');
    writeFileSync(file, '{}');
    chmodSync(file, 0o666);
    await installGateHook(file);
    expect(statSync(file).mode & 0o777).toBe(0o666);
  });

  it.skipIf(windows)('writes through a symlink that points at nothing yet, and keeps it a symlink', async () => {
    const dir = scratch();
    const real = join(dir, 'dotfiles', 'settings.json');
    const link = join(dir, 'claude-settings.json');
    mkdirSync(join(dir, 'dotfiles'));
    symlinkSync(real, link);
    await installGateHook(link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const settings: unknown = JSON.parse(readFileSync(real, 'utf8'));
    expect(settings).toMatchObject({ hooks: { [EVENT]: [expect.anything()] } });
    expect(statSync(real).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp file beside the settings when the rename fails, and rethrows', async () => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{"model":"x"}');
    failing.rename = true;
    await expect(installGateHook(file)).rejects.toThrow('EXDEV');
    expect(readdirSync(dir)).toEqual(['settings.json']);
    expect(readFileSync(file, 'utf8')).toBe('{"model":"x"}');
    expect(existsSync(file)).toBe(true);
  });
});
