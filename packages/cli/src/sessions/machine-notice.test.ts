// The notice file: the child records a condition, the next Stop reads it once. The store is a temp folder and the test confirms it before it writes.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { messageOf, NOTICE_INTERVAL_MS, noticeFile, recordNotice, takeNotice } from './machine-notice.js';
import { cleanup, stage } from './test-support.js';

afterEach(cleanup);

const store = (): string => {
  const { storeDir } = stage();
  if (!storeDir.startsWith(tmpdir())) throw new Error('the test store is not under the temp folder');
  mkdirSync(storeDir, { recursive: true });
  return storeDir;
};

describe('recordNotice', () => {
  it('writes one entry, owner-only, in the shape the reader takes', async () => {
    const storeDir = store();
    await recordNotice(storeDir, 'vocabulary_expired', 1000);
    expect(JSON.parse(readFileSync(noticeFile(storeDir), 'utf8'))).toEqual({ entries: [{ code: 'vocabulary_expired', at: 1000 }] });
    if (process.platform !== 'win32') expect(statSync(noticeFile(storeDir)).mode & 0o777).toBe(0o600);
  });

  it('keeps one entry per code: a repeat replaces its time', async () => {
    const storeDir = store();
    await recordNotice(storeDir, 'vocabulary_expired', 1000);
    await recordNotice(storeDir, 'vocabulary_expired', 1000 + NOTICE_INTERVAL_MS);
    expect(JSON.parse(readFileSync(noticeFile(storeDir), 'utf8'))).toEqual({ entries: [{ code: 'vocabulary_expired', at: 1000 + NOTICE_INTERVAL_MS }] });
  });

  it('writes a code at most once a day, so a VM does not print the same message at every Stop', async () => {
    const storeDir = store();
    await recordNotice(storeDir, 'vocabulary_expired', 1000);
    expect(takeNotice(storeDir)).toMatch(/out of date/);
    await recordNotice(storeDir, 'vocabulary_expired', 1000 + NOTICE_INTERVAL_MS - 1);
    expect(takeNotice(storeDir)).toBeUndefined();
    await recordNotice(storeDir, 'vocabulary_expired', 1000 + NOTICE_INTERVAL_MS);
    expect(takeNotice(storeDir)).toMatch(/out of date/);
  });

  it('makes the store folder when the machine has captured nothing yet', async () => {
    const { storeDir } = stage();
    expect(existsSync(storeDir)).toBe(false);
    await recordNotice(storeDir, 'vocabulary_expired', 1);
    expect(existsSync(noticeFile(storeDir))).toBe(true);
  });

  it('rewrites a file it cannot read', async () => {
    const storeDir = store();
    writeFileSync(noticeFile(storeDir), 'not json');
    await recordNotice(storeDir, 'vocabulary_expired', 5);
    expect(takeNotice(storeDir)).toMatch(/out of date/);
  });
});

describe('takeNotice', () => {
  it('answers the message once and clears the file', async () => {
    const storeDir = store();
    await recordNotice(storeDir, 'vocabulary_expired', 1);
    expect(takeNotice(storeDir)).toBe(messageOf([{ code: 'vocabulary_expired', at: 1 }]));
    expect(existsSync(noticeFile(storeDir))).toBe(false);
    expect(readdirSync(storeDir).filter((name) => name.startsWith('machine-notice'))).toEqual([]);
    expect(takeNotice(storeDir)).toBeUndefined();
  });

  it('answers nothing with no file, and for a folder that does not exist', () => {
    expect(takeNotice(store())).toBeUndefined();
    expect(takeNotice('/no/such/folder/for/oars')).toBeUndefined();
  });

  it.each([
    ['not json'],
    ['[]'],
    ['null'],
    ['{}'],
    [JSON.stringify({ entries: 'x' })],
    [JSON.stringify({ entries: [null, 3, {}, { code: 'other_code', at: 1 }, { code: 'vocabulary_expired' }, { code: 'vocabulary_expired', at: 'late' }] })],
  ])('answers nothing for the file %s, and still clears it', (text) => {
    const storeDir = store();
    writeFileSync(noticeFile(storeDir), text);
    expect(takeNotice(storeDir)).toBeUndefined();
    expect(existsSync(noticeFile(storeDir))).toBe(false);
  });

  it('keeps the entries it knows when a newer client wrote one it does not', () => {
    const storeDir = store();
    writeFileSync(noticeFile(storeDir), JSON.stringify({ entries: [{ code: 'from_a_newer_client', at: 1 }, { code: 'vocabulary_expired', at: 2 }] }));
    expect(takeNotice(storeDir)).toBe(messageOf([{ code: 'vocabulary_expired', at: 2 }]));
  });
});

describe('messageOf', () => {
  it('has no message for no entries, and tells the person what stopped, what is kept, and the step', () => {
    expect(messageOf([])).toBeUndefined();
    const text = messageOf([{ code: 'vocabulary_expired', at: 1 }]) ?? '';
    expect(text).toMatch(/builds no deposit batches/);
    expect(text).toMatch(/sessions stay on this machine/);
    expect(text).toMatch(/Upgrade with/);
  });
});
