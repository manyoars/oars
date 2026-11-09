// The scan cache: a pass of the gate is reused for ten minutes under the same term list, and for no longer or under another list.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SCAN_TTL_MS, scanCache } from './machine-scan-cache.js';
import { cleanup, stage } from './test-support.js';

afterEach(cleanup);

const store = (): string => {
  const { storeDir } = stage();
  if (!storeDir.startsWith(tmpdir())) throw new Error('the test store is not under the temp folder');
  mkdirSync(storeDir, { recursive: true });
  return storeDir;
};

describe('scanCache', () => {
  it('remembers a pass for the window, then not', async () => {
    const dir = store();
    let at = 1000;
    const first = await scanCache(dir, 'terms-a', () => at);
    expect(first.fresh('p', 's')).toBe(false);
    first.note('p', 's');
    await first.save();
    const next = await scanCache(dir, 'terms-a', () => at + SCAN_TTL_MS - 1);
    expect(next.fresh('p', 's')).toBe(true);
    expect(next.fresh('p', 'other')).toBe(false);
    at += SCAN_TTL_MS;
    expect((await scanCache(dir, 'terms-a', () => at)).fresh('p', 's')).toBe(false);
  });

  it('starts empty under another term list, and under a clock that went backwards', async () => {
    const dir = store();
    const cache = await scanCache(dir, 'terms-a', () => 5000);
    cache.note('p', 's');
    await cache.save();
    expect((await scanCache(dir, 'terms-b', () => 5001)).fresh('p', 's')).toBe(false);
    expect((await scanCache(dir, 'terms-a', () => 4000)).fresh('p', 's')).toBe(false);
  });

  it('writes nothing when nothing passed, drops entries past the window, and writes owner-only', async () => {
    const dir = store();
    const idle = await scanCache(dir, 'terms-a', () => 1);
    await idle.save();
    expect(existsSync(join(dir, 'machine-scan-cache.json'))).toBe(false);
    const old = await scanCache(dir, 'terms-a', () => 1);
    old.note('p', 'old');
    await old.save();
    const later = await scanCache(dir, 'terms-a', () => 1 + SCAN_TTL_MS);
    later.note('p', 'new');
    await later.save();
    const written: unknown = JSON.parse(readFileSync(join(dir, 'machine-scan-cache.json'), 'utf8'));
    expect(written).toEqual({ terms: 'terms-a', passed: { '["p","new"]': 1 + SCAN_TTL_MS } });
    if (process.platform !== 'win32') expect(statSync(join(dir, 'machine-scan-cache.json')).mode & 0o777).toBe(0o600);
  });

  it('reads a damaged file, or one of another shape, as empty', async () => {
    const dir = store();
    const file = join(dir, 'machine-scan-cache.json');
    for (const text of ['not json', '[]', '{"terms":"terms-a","passed":3}', '{"terms":"terms-a","passed":{"[\\"p\\",\\"s\\"]":"yes"}}']) {
      writeFileSync(file, text);
      expect((await scanCache(dir, 'terms-a', () => 10)).fresh('p', 's')).toBe(false);
    }
  });
});
