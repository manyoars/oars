// The scratch files the find reads an object from: real files, in a folder of the run's own.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nodeFiles, READ_CHUNK_BYTES } from './erase-files.js';

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
