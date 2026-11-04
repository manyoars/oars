import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../errors.js';
import type * as ReadModuleNamespace from './read.js';
import { deriveCells } from './cells.js';
import { currentPool, poolFiles, refreshPool, servedPool } from './pool.js';
import { cellsOf, incrementsOf, projectedStore } from './cell-increments.js';
import { error, frame, printOf, prompt, session, sessionsFrom, step, store, tool } from './pool-fixture.js';
import { skeletonOf } from './pool-wire.js';
import { shellReader } from './projection.js';
import { vocabulary } from './vocab-load.js';

type ReadModule = typeof ReadModuleNamespace;

const dirs: string[] = [];
const storeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'oars-pool-test-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const hasSteps = (value: unknown): value is { steps: object[] } => typeof value === 'object' && value !== null && 'steps' in value && Array.isArray(value.steps);

const one = store({ sessions: [session('s1')], prompts: [prompt('s1', 0)], tools: [tool('s1', 0, 'Read'), tool('s1', 1, 'Edit')] });

describe('refreshPool', () => {
  const reads = (dir: string): string[] => readdirSync(join(dir, 'reads')).sort();

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

  it('writes the cells the shared module computes, with the flag cells and floored numbers a raw derivation would not hold', async () => {
    const push = { program: 'git', sub: 'push', flags: ['--force', '--tags'] };
    const framed = frame({ shell: 'bash', stack: { languages: ['rust'], frameworks: ['astro'], size: 'xl' } });
    const local = store({
      sessions: [session('s1', { frame: framed })],
      prompts: [prompt('s1', 0, { frame: framed, usage: { input: 123456, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 } })],
      tools: [tool('s1', 0, 'Bash', { steps: [step(0, 0, 'shell.exec', { native: 'Bash', identity: push, cost: { tokens: 98765, durationMs: 4321 } })] })],
    });
    const keyed = (cells: readonly { motifId: string; frameBucket: string; day: string; exposed: boolean | number; sessions: number; ok: number; failed: number; tokens: number; durationMs: number }[]): string[] => cells.map(({ motifId, frameBucket, day, exposed, sessions, ok, failed, tokens, durationMs }) => `${motifId}/${frameBucket}/${day}/${String(Number(exposed))} ${String(sessions)} ${String(ok)} ${String(failed)} ${String(tokens)} ${String(durationMs)}`).sort();
    const [only] = sessionsFrom(local);
    const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', shellReader(vocabulary()), printOf);
    if (skeleton === null) throw new Error('the local store has no skeleton');
    const shared = [...incrementsOf(skeleton).cells.values()];
    const { pool } = await refreshPool(storeDir(), local);
    expect(shared.length).toBeGreaterThan(2);
    expect(keyed(pool.cells)).toEqual(keyed(shared));
    // The module reads the projected store, so a number is a floor: the raw derivation holds the exact 123456 and 98765.
    expect(keyed(pool.cells)).not.toEqual(keyed(deriveCells(local).cells));
    expect(keyed(pool.cells)).toEqual(keyed(cellsOf(projectedStore(local, shellReader(vocabulary()))).cells));
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
      return hasSteps(parsed) ? parsed.steps : [];
    });
    expect(steps.length).toBeGreaterThan(0);
    for (const held of steps) expect(Object.keys(held).sort()).toEqual(['action', 'identity']);
  });

  it('derives again over a file that holds no reads, and tells the operator to delete one that is not JSON', async () => {
    const dir = storeDir();
    const first = await refreshPool(dir, one);
    const file = poolFiles(dir).reads(first.pool.version);
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, '{}\n');
    expect((await refreshPool(dir, one)).reads).toEqual(first.reads);
    expect(readFileSync(file, 'utf8')).toBe(text);
    writeFileSync(file, 'not json\n');
    const refused = refreshPool(dir, one);
    await expect(refused).rejects.toBeInstanceOf(CliError);
    await expect(refused).rejects.toThrow(file);
    await expect(refused).rejects.toThrow(/[Dd]elete/);
    expect(readFileSync(file, 'utf8')).toBe('not json\n');
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

  it('derives again over a reads file written under the old live rule, since the rule version is in the pool version', async () => {
    const dir = storeDir();
    vi.resetModules();
    vi.doMock('./read.js', async (importOriginal) => {
      const actual = await importOriginal<ReadModule>();
      return { ...actual, METHODS: { ...actual.METHODS, live: { ...actual.METHODS.live, version: '1' } } };
    });
    let old: Awaited<ReturnType<typeof refreshPool>>;
    try {
      old = await (await import('./pool.js')).refreshPool(dir, one);
    } finally {
      vi.doUnmock('./read.js');
      vi.resetModules();
    }
    const current = await (await import('./pool.js')).refreshPool(dir, one);
    expect(current.pool.version).not.toBe(old.pool.version);
    expect(reads(dir)).toEqual([`${old.pool.version}.jsonl`, `${current.pool.version}.jsonl`].sort());
  });

  it('serves a stored read as frozen as a derived one', async () => {
    const dir = storeDir();
    await refreshPool(dir, one);
    const [read] = (await refreshPool(dir, one)).reads;
    expect(read !== undefined && Object.isFrozen(read)).toBe(true);
    expect(read !== undefined && Object.isFrozen(read.value)).toBe(true);
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

describe('currentPool', () => {
  it('writes one stderr line when the pool cannot be derived, and still answers undefined', async () => {
    const dir = storeDir();
    const first = await refreshPool(dir, one);
    writeFileSync(poolFiles(dir).reads(first.pool.version), 'not json\n');
    const written = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await currentPool(dir, one)).toBeUndefined();
      expect(written).toHaveBeenCalledTimes(1);
      expect(String(written.mock.calls[0]?.[0])).toMatch(/^oars: the read pool was not built, and answers keep their stand-ins: .*\n$/);
    } finally {
      written.mockRestore();
    }
  });
});

describe('servedPool', () => {
  const later = store({ ...one, tools: [...one.tools, tool('s1', 2, 'Read')] });
  const reads = (dir: string): string[] => readdirSync(join(dir, 'reads')).sort();

  it('answers from the newest stored reads with their cells and motifs, and writes nothing', async () => {
    const dir = storeDir();
    const derived = await refreshPool(dir, one);
    const before = { reads: reads(dir), cells: readFileSync(poolFiles(dir).cells, 'utf8'), stamp: statSync(poolFiles(dir).reads(derived.pool.version)).mtimeMs };
    const served = await servedPool(dir, later);
    expect(served?.reads).toEqual(derived.reads);
    expect(served?.pool.version).toBe(derived.pool.version);
    expect(served?.pool.cells).toEqual(derived.pool.cells);
    expect([...(served?.pool.motifs.keys() ?? [])]).toEqual([...derived.pool.motifs.keys()]);
    expect(served?.pool.lastDay).toBe(derived.pool.lastDay);
    expect(reads(dir)).toEqual(before.reads);
    expect(readFileSync(poolFiles(dir).cells, 'utf8')).toBe(before.cells);
    expect(statSync(poolFiles(dir).reads(derived.pool.version)).mtimeMs).toBe(before.stamp);
  });

  it('prefers the newest of several stored pools', async () => {
    const dir = storeDir();
    const first = await refreshPool(dir, one);
    utimesSync(poolFiles(dir).reads(first.pool.version), new Date(2020, 0, 1), new Date(2020, 0, 1));
    const second = await refreshPool(dir, later);
    expect((await servedPool(dir, one))?.pool.version).toBe(second.pool.version);
  });

  it('derives and writes the pool once when none is stored, then reads it', async () => {
    const dir = storeDir();
    const first = await servedPool(dir, one);
    expect(first?.reads.length).toBeGreaterThan(0);
    expect(reads(dir)).toHaveLength(1);
    const text = readFileSync(poolFiles(dir).reads(first?.pool.version ?? ''), 'utf8');
    expect((await servedPool(dir, later))?.pool.version).toBe(first?.pool.version);
    expect(reads(dir)).toHaveLength(1);
    expect(readFileSync(poolFiles(dir).reads(first?.pool.version ?? ''), 'utf8')).toBe(text);
  });

  it('derives again when reads are stored but their cells are gone', async () => {
    const dir = storeDir();
    await refreshPool(dir, one);
    rmSync(poolFiles(dir).cells);
    const served = await servedPool(dir, one);
    expect(served?.pool.cells.length).toBeGreaterThan(0);
    expect(readFileSync(poolFiles(dir).cells, 'utf8')).not.toBe('');
  });

  it('writes one stderr line and answers undefined when a stored file is damaged', async () => {
    const dir = storeDir();
    const first = await refreshPool(dir, one);
    writeFileSync(poolFiles(dir).reads(first.pool.version), 'not json\n');
    const written = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await servedPool(dir, one)).toBeUndefined();
      expect(written).toHaveBeenCalledTimes(1);
    } finally {
      written.mockRestore();
    }
  });
});
