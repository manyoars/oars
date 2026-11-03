import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { poolFiles, refreshPool } from './pool.js';
import { error, prompt, session, step, store, tool } from './pool-fixture.js';

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

  it('writes byte-identical motifs from a reversed store, holding only action and identity per step', async () => {
    const git = { program: 'git', sub: 'status', flags: [] };
    const call = (id: string, status: 'ok' | 'error', tokens: number, durationMs: number) =>
      tool(id, 0, 'Bash', { status, steps: [step(0, 0, 'shell.exec', { identity: git, status, cost: { tokens, durationMs } })] });
    const forward = store({ sessions: [session('s1'), session('s2')], prompts: [prompt('s1', 0), prompt('s2', 0)], tools: [call('s1', 'ok', 7, 111), call('s2', 'error', 9, 222)] });
    const reversed = store({ ...forward, sessions: [...forward.sessions].reverse(), prompts: [...forward.prompts].reverse(), tools: [...forward.tools].reverse() });
    // A fresh module per run: the motif memo lives as long as the module, so one process would otherwise show one run's first window twice.
    const motifsFrom = async (from: typeof forward): Promise<string> => {
      vi.resetModules();
      const fresh = await import('./pool.js');
      const dir = storeDir();
      await fresh.refreshPool(dir, from);
      return readFileSync(poolFiles(dir).motifs, 'utf8');
    };
    const one = await motifsFrom(forward);
    expect(await motifsFrom(reversed)).toBe(one);
    const steps = one.trim().split('\n').flatMap((line) => {
      const parsed: unknown = JSON.parse(line);
      const held: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'steps') : undefined;
      const list: object[] = Array.isArray(held) ? held : [];
      return list;
    });
    expect(steps.length).toBeGreaterThan(0);
    for (const held of steps) expect(Object.keys(held).sort()).toEqual(['action', 'identity']);
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

  it('derives again when only the error rows recovery reads have changed', async () => {
    const dir = storeDir();
    const failing = { ...one, tools: [tool('s1', 0, 'Read', { status: 'error' }), tool('s1', 1, 'Edit')] };
    const first = await refreshPool(dir, { ...failing, errors: [error('s1', 'sig-a', { toolUseId: 'c0' })] });
    const later = await refreshPool(dir, { ...failing, errors: [error('s1', 'sig-a', { toolUseId: 'c0' }), error('s1', 'sig-a', { toolUseId: 'c1' })] });
    expect(later.pool.version).not.toBe(first.pool.version);
    const errorsOf = (reads: typeof first.reads) => reads.find((read) => read.family === 'recovery')?.value['errors'];
    expect(errorsOf(first.reads)).toBe(1);
    expect(errorsOf(later.reads)).toBe(2);
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
