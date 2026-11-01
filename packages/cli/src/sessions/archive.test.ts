import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { archiveRaw, type ArchiveOps } from './archive.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'oars-archive-test-'));
  dirs.push(dir);
  return dir;
};

const failing = (code: string): ArchiveOps => ({
  link: () => Promise.reject(Object.assign(new Error(code), { code })),
  copyFile: (source, target) => copyFile(source, target),
});

describe('archiveRaw', () => {
  it('hard-links the transcript, so the archive shares its bytes and sees later appends; a rerun leaves it alone', async () => {
    const dir = temp();
    const source = join(dir, 'a.jsonl');
    writeFileSync(source, 'one\n');
    const target = join(dir, 'raw', 'proj', 'a.jsonl');
    expect(await archiveRaw(source, target)).toBe('linked');
    expect(statSync(target).ino).toBe(statSync(source).ino);
    appendFileSync(source, 'two\n');
    expect(readFileSync(target, 'utf8')).toBe('one\ntwo\n');
    expect(await archiveRaw(source, target)).toBe('present');
  });

  it('copies when a hard link cannot reach (another volume), and replaces the copy only once the transcript changes', async () => {
    const dir = temp();
    const source = join(dir, 'a.jsonl');
    writeFileSync(source, 'one\n');
    const target = join(dir, 'raw', 'a.jsonl');
    const ops = failing('EXDEV');
    expect(await archiveRaw(source, target, ops)).toBe('copied');
    expect(statSync(target).ino).not.toBe(statSync(source).ino);
    expect(await archiveRaw(source, target, ops)).toBe('present');
    appendFileSync(source, 'two\n');
    utimesSync(source, new Date(), new Date(Date.now() + 5_000));
    expect(await archiveRaw(source, target, ops)).toBe('copied');
    expect(readFileSync(target, 'utf8')).toBe('one\ntwo\n');
  });

  it('rethrows a link failure that is not about reach, and a missing transcript', async () => {
    const dir = temp();
    const source = join(dir, 'a.jsonl');
    writeFileSync(source, 'one\n');
    await expect(archiveRaw(source, join(dir, 'raw', 'a.jsonl'), failing('EIO'))).rejects.toThrow('EIO');
    await expect(archiveRaw(join(dir, 'gone.jsonl'), join(dir, 'raw', 'gone.jsonl'))).rejects.toThrow();
  });
});
