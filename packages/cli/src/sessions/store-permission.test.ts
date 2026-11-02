import { mkdtempSync, promises, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const lockStat = vi.hoisted(() => ({ eperm: false }));

vi.mock('node:fs/promises', () => {
  const { appendFile, copyFile, link, mkdir, readdir, readFile, rename, rm } = promises;
  return {
    appendFile,
    copyFile,
    link,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat: (file: string, ...rest: [] | [object]) => {
      if (lockStat.eperm && file.endsWith('store.lock')) return Promise.reject(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }));
      return promises.stat(file, ...rest);
    },
    writeFile: (file: string, data: string, options: object) => {
      if (file.endsWith('store.lock')) return Promise.reject(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }));
      return promises.writeFile(file, data, options);
    },
  };
});

const { withLock } = await import('./store.js');

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
