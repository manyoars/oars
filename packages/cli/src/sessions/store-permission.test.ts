import { existsSync, mkdtempSync, promises, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const lockStat = vi.hoisted(() => ({ eperm: false, writable: false, unreadable: false }));

vi.mock('node:fs/promises', () => {
  const { appendFile, copyFile, link, mkdir, readdir, rename, rm } = promises;
  return {
    appendFile,
    copyFile,
    link,
    mkdir,
    readdir,
    // An antivirus share violation on Windows refuses a read of the holder's own lock for a moment.
    readFile: (file: string, ...rest: [] | [object | string]) => {
      if (lockStat.unreadable && file.endsWith('store.lock')) return Promise.reject(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }));
      return promises.readFile(file, ...rest);
    },
    rename,
    rm,
    stat: (file: string, ...rest: [] | [object]) => {
      if (lockStat.eperm && file.endsWith('store.lock')) return Promise.reject(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }));
      return promises.stat(file, ...rest);
    },
    writeFile: (file: string, data: string, options: object) => {
      if (!lockStat.writable && file.endsWith('store.lock')) return Promise.reject(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }));
      return promises.writeFile(file, data, options);
    },
  };
});

const { withLock } = await import('./store.js');

describe('a lock the holder cannot read back', () => {
  it('still removes its own lock when the read of it is refused, so hooks and deposits are not locked out for the stale window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oars-perm-'));
    lockStat.writable = true;
    lockStat.unreadable = true;
    try {
      await withLock(dir, () => Promise.resolve(), { waitMs: 100, staleMs: 600000 });
      expect(existsSync(join(dir, 'store.lock'))).toBe(false);
    } finally {
      lockStat.writable = false;
      lockStat.unreadable = false;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an unwritable store folder', () => {
  it('reports the permission error, not a held lock, when no lock file stands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oars-perm-'));
    try {
      await expect(withLock(dir, () => Promise.resolve(), { waitMs: 100, staleMs: 600000 })).rejects.toThrow('EPERM');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a held lock when the stat of the lock file is itself refused (a delete-pending file on Windows)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oars-perm-'));
    lockStat.eperm = true;
    try {
      await expect(withLock(dir, () => Promise.resolve(), { waitMs: 100, staleMs: 600000 })).rejects.toThrow('store is locked');
    } finally {
      lockStat.eperm = false;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
