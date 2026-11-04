import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILL_LOCK_MS, isLocked, runFill, startFill, type FillAsk } from './hook-fill.js';
import { folderKey, parseRows } from './record.js';
import type { RegistryAnswer, RegistryReader } from './registry.js';

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const store = (): string => {
  const one = mkdtempSync(join(tmpdir(), 'oars-gate-fill-'));
  made.push(one);
  return one;
};

const NOW = Date.parse('2026-11-04T10:00:00.000Z');
const ASK: FillAsk = { class: 'npm-package', name: 'slow-lib', cwd: tmpdir() };
const lockOf = (dir: string): string | undefined => readdirSync(dir).find((name) => name.endsWith('.lock'));
const cacheOf = (dir: string) => parseRows(readFileSync(join(dir, 'gate-registry.jsonl'), 'utf8'));

describe('the fill: is the name locked', () => {
  it('is true while a lock younger than the window is held, false with none, an old one, or an unreadable store', async () => {
    const dir = store();
    expect(await isLocked(dir, ASK, NOW)).toBe(false);
    await startFill(dir, ASK, NOW, vi.fn());
    expect(await isLocked(dir, ASK, NOW + 1000)).toBe(true);
    expect(await isLocked(dir, { ...ASK, name: 'other-lib' }, NOW + 1000)).toBe(false);
    expect(await isLocked(dir, ASK, Date.now() + FILL_LOCK_MS + 1000)).toBe(false);
  });
});

describe('the fill: starting the helper', () => {
  it('starts one helper per name, however many sights come while it asks', async () => {
    const dir = store();
    const start = vi.fn();
    await Promise.all([startFill(dir, ASK, NOW, start), startFill(dir, ASK, NOW, start), startFill(dir, ASK, NOW + 1000, start)]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(dir, ASK);
  });

  it('starts a helper for another name beside the first', async () => {
    const dir = store();
    const start = vi.fn();
    await startFill(dir, ASK, NOW, start);
    await startFill(dir, { ...ASK, name: 'other-lib' }, NOW, start);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('takes over a lock older than five minutes, the mark of a helper that died, and not a younger one', async () => {
    const dir = store();
    const start = vi.fn();
    await startFill(dir, ASK, NOW, start);
    const lock = join(dir, lockOf(dir) ?? '');
    utimesSync(lock, new Date(NOW - FILL_LOCK_MS + 1000), new Date(NOW - FILL_LOCK_MS + 1000));
    await startFill(dir, ASK, NOW, start);
    expect(start).toHaveBeenCalledTimes(1);
    utimesSync(lock, new Date(NOW - FILL_LOCK_MS - 1000), new Date(NOW - FILL_LOCK_MS - 1000));
    await startFill(dir, ASK, NOW, start);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('never throws into the hook: a store that cannot be made, or a helper that cannot start, is an answer that does not come', async () => {
    const dir = store();
    await expect(startFill(join(dir, 'crossings.jsonl', 'x'), ASK, NOW, vi.fn())).resolves.toBeUndefined();
    await expect(
      startFill(
        dir,
        ASK,
        NOW,
        vi.fn(() => {
          throw new Error('spawn failed');
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('the fill: the helper', () => {
  const reader = (answer: RegistryAnswer): RegistryReader => () => Promise.resolve(answer);

  it('keeps a found answer in the cache, dated to the millisecond, and releases the lock', async () => {
    const dir = store();
    await startFill(dir, ASK, NOW, vi.fn());
    expect(lockOf(dir)).toBeDefined();
    await runFill(dir, ASK, { registry: reader({ state: 'found', latest: '1.0.0', created: '2020-01-01T00:00:00.000Z' }), now: () => NOW });
    expect(cacheOf(dir)).toEqual([
      { kind: 'registry', v: 1, day: '2026-11-04', ts: '2026-11-04T10:00:00.000Z', folder: folderKey(tmpdir()), class: 'npm-package', state: 'found', created: '2020-01-01T00:00:00.000Z', name: 'slow-lib', latest: '1.0.0' },
    ]);
    expect(lockOf(dir)).toBeUndefined();
  });

  it('keeps a not-found answer too', async () => {
    const dir = store();
    await runFill(dir, ASK, { registry: reader({ state: 'not-found', latest: null, created: null }), now: () => NOW });
    expect(cacheOf(dir).map((row) => row.kind === 'registry' && row.state)).toEqual(['not-found']);
  });

  it('writes nothing for a failed ask, and keeps the lock so a down registry is not asked again at once', async () => {
    const dir = store();
    await startFill(dir, ASK, NOW, vi.fn());
    await runFill(dir, ASK, { registry: reader({ state: 'unreachable', latest: null, created: null }), now: () => NOW });
    expect(existsSync(join(dir, 'gate-registry.jsonl'))).toBe(false);
    expect(lockOf(dir)).toBeDefined();
  });

  it('asks nothing about a name a registry could not hold', async () => {
    const dir = store();
    const registry = vi.fn<RegistryReader>(reader({ state: 'found', latest: '1.0.0', created: null }));
    await runFill(dir, { ...ASK, name: 'bad name; rm -rf' }, { registry, now: () => NOW });
    expect(registry).not.toHaveBeenCalled();
  });
});
