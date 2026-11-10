// The scratch files the find reads an object from: real files, in a folder of the run's own.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFiles, nodeFolder, READ_CHUNK_BYTES } from './erase-files.js';
import { asyncPieces } from './erase-test-store.js';

describe('the scratch files', () => {
  it('hands out a path under a folder of its own, streams a file in pieces no larger than the read size, and removes it', async () => {
    const files = nodeFiles();
    const path = await files.temp();
    const bytes = Buffer.alloc(READ_CHUNK_BYTES * 2 + 10, 0x61);
    writeFileSync(path, bytes);
    const sizes: number[] = [];
    for await (const piece of files.read(path)) sizes.push(piece.length);
    expect(sizes).toEqual([READ_CHUNK_BYTES, READ_CHUNK_BYTES, 10]);
    await files.remove(path);
    expect(existsSync(path)).toBe(false);
    // A second removal, of a file that was never written, is not an error.
    await files.remove(await files.temp());
    await files.dispose();
  });

  it('gives each file its own path, and dispose removes the folder with whatever is left in it', async () => {
    const files = nodeFiles();
    const [first, second] = [await files.temp(), await files.temp()];
    expect(first).not.toBe(second);
    writeFileSync(first, 'left behind');
    const folder = first.slice(0, first.lastIndexOf(first.includes('/') ? '/' : '\\'));
    expect(readdirSync(folder)).toHaveLength(1);
    await files.dispose();
    expect(existsSync(folder)).toBe(false);
    // With no file ever asked for, there is no folder and dispose does nothing.
    await nodeFiles().dispose();
  });
});

describe('the export folder', () => {
  it('makes the folder and its raw/ folder on first write, writes text and streamed bytes, replaces a file on a rerun, and removes one', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'oars-export-test-'));
    try {
      const folder = nodeFolder(join(parent, 'request-1'));
      const pieces = (...parts: string[]): AsyncIterable<Uint8Array> => asyncPieces(parts.map((part) => Buffer.from(part)));
      await folder.write('account-export-0001.json', '{"a":1}' + String.fromCharCode(10));
      await folder.write('raw/abc', pieces('first ', 'second'));
      expect(readFileSync(join(parent, 'request-1', 'account-export-0001.json'), 'utf8')).toBe('{"a":1}' + String.fromCharCode(10));
      expect(readFileSync(join(parent, 'request-1', 'raw', 'abc'), 'utf8')).toBe('first second');
      await folder.write('raw/abc', pieces('again'));
      expect(readFileSync(join(parent, 'request-1', 'raw', 'abc'), 'utf8')).toBe('again');
      await folder.remove('raw/abc');
      expect(existsSync(join(parent, 'request-1', 'raw', 'abc'))).toBe(false);
      // A file that is not there is not an error.
      await folder.remove('raw/abc');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses a folder that already holds files, so no copy from an earlier run can be sent, and writes into an empty or missing one', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'oars-export-test-'));
    try {
      const used = join(parent, 'used');
      mkdirSync(used);
      writeFileSync(join(used, 'account-export-0001.json'), 'stale');
      await expect(nodeFolder(used).write('account-export-0001.json', 'new')).rejects.toThrow('use a new, empty folder for each run');
      expect(readFileSync(join(used, 'account-export-0001.json'), 'utf8')).toBe('stale');
      const empty = join(parent, 'empty');
      mkdirSync(empty);
      await nodeFolder(empty).write('account-export-0001.json', 'new');
      expect(readFileSync(join(empty, 'account-export-0001.json'), 'utf8')).toBe('new');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('reads a missing folder as empty but rethrows any other readdir failure', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'oars-export-test-'));
    try {
      const file = join(parent, 'a-file');
      writeFileSync(file, 'x');
      // A regular file as the folder fails readdir with ENOTDIR, not ENOENT: the folder cannot be shown empty, so the error reaches the operator as it is.
      await expect(nodeFolder(file).write('account-export-0001.json', 'new')).rejects.toThrow(/ENOTDIR/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('creates the folder readable by the operator alone, 0700 for folders and 0600 for files', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'oars-export-test-'));
    try {
      const folder = nodeFolder(join(parent, 'request-2'));
      await folder.write('raw/abc', asyncPieces([Buffer.from('bytes')]));
      await folder.write('account-export-0001.json', '{}');
      expect(statSync(join(parent, 'request-2')).mode & 0o777).toBe(0o700);
      expect(statSync(join(parent, 'request-2', 'raw')).mode & 0o777).toBe(0o700);
      expect(statSync(join(parent, 'request-2', 'raw', 'abc')).mode & 0o777).toBe(0o600);
      expect(statSync(join(parent, 'request-2', 'account-export-0001.json')).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
