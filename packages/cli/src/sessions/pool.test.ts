import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { poolFiles, refreshPool } from './pool.js';
import { prompt, session, store, tool } from './pool-fixture.js';

const dirs: string[] = [];
const storeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'oars-pool-test-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const one = store({ sessions: [session('s1')], prompts: [prompt('s1', 0)], tools: [tool('s1', 0, 'Read'), tool('s1', 1, 'Edit')] });

describe('refreshPool', () => {
  it('writes byte-identical cells on a rerun, and dropping them and recomputing loses nothing', async () => {
    const dir = storeDir();
    await refreshPool(dir, one);
    const files = poolFiles(dir);
    const cells = readFileSync(files.cells, 'utf8');
    const motifs = readFileSync(files.motifs, 'utf8');
    expect(cells).not.toBe('');
    await refreshPool(dir, one);
    expect(readFileSync(files.cells, 'utf8')).toBe(cells);
    rmSync(files.cells);
    rmSync(files.motifs);
    await refreshPool(dir, one);
    expect(readFileSync(files.cells, 'utf8')).toBe(cells);
    expect(readFileSync(files.motifs, 'utf8')).toBe(motifs);
  });

  it('derives again over a file that holds no reads, and does not swallow an unreadable one', async () => {
    const dir = storeDir();
    const first = await refreshPool(dir, one);
    const file = poolFiles(dir).reads(first.pool.version);
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, '{}\n');
    expect((await refreshPool(dir, one)).reads).toEqual(first.reads);
    expect(readFileSync(file, 'utf8')).toBe(text);
    writeFileSync(file, 'not json\n');
    await expect(refreshPool(dir, one)).rejects.toThrow();
  });

  it('keeps a pool version file as first written, and gives new data a new file', async () => {
    const dir = storeDir();
    const first = await refreshPool(dir, one);
    const text = readFileSync(poolFiles(dir).reads(first.pool.version), 'utf8');
    const again = await refreshPool(dir, one);
    expect(again.reads.map((read) => read.readId)).toEqual(first.reads.map((read) => read.readId));
    expect(readFileSync(poolFiles(dir).reads(first.pool.version), 'utf8')).toBe(text);
    const later = await refreshPool(dir, store({ ...one, tools: [...one.tools, tool('s1', 2, 'Read')] }));
    expect(later.pool.version).not.toBe(first.pool.version);
    expect(readFileSync(poolFiles(dir).reads(first.pool.version), 'utf8')).toBe(text);
  });
});
