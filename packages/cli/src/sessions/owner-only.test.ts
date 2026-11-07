import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirOwnerOnly, writeOwnerOnly } from './owner-only.js';
import { writeBatch } from './pool-outbox.js';
import { writeRaw } from './pool-raw.js';

// The mode calls do nothing on Windows (it has no POSIX mode bits), so these checks run where the bits exist.
const posix = it.skipIf(process.platform === 'win32');
const modeOf = (path: string): number => statSync(path).mode & 0o777;

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oars-owner-only-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('owner-only writes (S9, S10)', () => {
  posix('writes a new file 0600, and narrows a file that was once wider before it writes', async () => {
    const file = join(root, 'accounts.json');
    await writeOwnerOnly(file, 'one');
    expect(modeOf(file)).toBe(0o600);
    chmodSync(file, 0o644);
    await writeOwnerOnly(file, 'two');
    expect(modeOf(file)).toBe(0o600);
  });

  posix('makes a folder 0700 with the folders it creates, and narrows one that exists', async () => {
    const leaf = join(root, 'a', 'b');
    await mkdirOwnerOnly(leaf);
    expect(modeOf(leaf)).toBe(0o700);
    expect(modeOf(join(root, 'a'))).toBe(0o700);
    const wide = join(root, 'wide');
    mkdirSync(wide, { mode: 0o755 });
    chmodSync(wide, 0o755);
    await mkdirOwnerOnly(wide);
    expect(modeOf(wide)).toBe(0o700);
  });

  posix('holds every outbox batch and raw transcript to 0600, including a rewrite of a file that was wider', async () => {
    const outbox = join(root, 'pool-outbox', 'server');
    const batch = await writeBatch(outbox, '0123456789abcdef', { id: 'x' }, '2026-11-07');
    const batchFile = join(batch.folder, readdirSync(batch.folder)[0] ?? '');
    expect(modeOf(batchFile)).toBe(0o600);
    expect(modeOf(batch.folder)).toBe(0o700);
    chmodSync(batchFile, 0o644);
    await writeBatch(outbox, '0123456789abcdef', { id: 'x' }, '2026-11-07');
    expect(modeOf(batchFile)).toBe(0o600);

    await writeRaw(outbox, '0123456789abcdef', 1, 'redacted text');
    const stamps = readdirSync(outbox).filter((name) => name !== '2026-11-07');
    const rawFolder = join(outbox, stamps[0] ?? '');
    const rawFile = join(rawFolder, readdirSync(rawFolder)[0] ?? '');
    expect(modeOf(rawFile)).toBe(0o600);
    expect(modeOf(rawFolder)).toBe(0o700);
    chmodSync(rawFile, 0o644);
    await writeRaw(outbox, '0123456789abcdef', 1, 'redacted text');
    expect(modeOf(rawFile)).toBe(0o600);
  });
});
