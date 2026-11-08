import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendHookCall } from './hook-calls.js';
import { appendOwnerOnly, mkdirOwnerOnly, writeOwnerOnly } from './owner-only.js';
import { markDeltasSent } from './pool-delta.js';
import { markSent } from './pool-sent.js';
import { markShown, writeBatch } from './pool-outbox.js';
import { writeRaw } from './pool-raw.js';
import { appendStep } from './steps.js';
import { withLock } from './store.js';

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

  posix('appends 0600, and narrows a log that was wider before it appends: shown.log, sent.log, and the delta marks', async () => {
    const file = join(root, 'log.txt');
    await appendOwnerOnly(file, 'one\n');
    expect(modeOf(file)).toBe(0o600);
    chmodSync(file, 0o644);
    await appendOwnerOnly(file, 'two\n');
    expect(modeOf(file)).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n');
    const outbox = join(root, 'pool-outbox', 'server');
    await markShown(outbox, 'a1', 1);
    await markSent(outbox, 'a1', 1);
    await markDeltasSent(outbox, ['m1']);
    expect(modeOf(outbox)).toBe(0o700);
    const logs = readdirSync(outbox).filter((name) => name.endsWith('.log') || name.includes('mark'));
    expect(logs.length).toBeGreaterThanOrEqual(3);
    for (const log of logs) {
      chmodSync(join(outbox, log), 0o644);
    }
    await markShown(outbox, 'a2', 2);
    await markSent(outbox, 'a2', 2);
    await markDeltasSent(outbox, ['m2']);
    for (const log of logs) expect(modeOf(join(outbox, log))).toBe(0o600);
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

describe('the store folder is the operator's alone from first use (S9)', () => {
  posix('is made 0700 by the first hook call, step row, or store lock, not only by oars pool login', async () => {
    const byHook = join(root, 'by-hook', 'store');
    await appendHookCall(byHook, { at: '2026-11-07T00:00:00.000Z', event: 'prompt', session: null, hit: false, ms: 1, error: null });
    expect(modeOf(byHook)).toBe(0o700);
    const byStep = join(root, 'by-step', 'store');
    await appendStep(byStep, { at: '2026-11-07T00:00:00.000Z', run: 'r', trigger: 'manual', step: 'deposit', status: 'ok', ms: 1, in: {}, out: {}, cv: '1', ev: '1' });
    expect(modeOf(byStep)).toBe(0o700);
    const byLock = join(root, 'by-lock', 'store');
    await withLock(byLock, () => Promise.resolve(undefined));
    expect(modeOf(byLock)).toBe(0o700);
    // A store an older client made wider is narrowed on the next use.
    chmodSync(byHook, 0o755);
    await appendHookCall(byHook, { at: '2026-11-07T00:00:01.000Z', event: 'prompt', session: null, hit: false, ms: 1, error: null });
    expect(modeOf(byHook)).toBe(0o700);
  });
});
