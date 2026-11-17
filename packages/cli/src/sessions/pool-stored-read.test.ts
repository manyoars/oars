// The stored pool is read line by line, never as one string of a whole file (t1403): `servedPool` over `cells.jsonl` and `motifs.jsonl`, and `refreshPool`'s read of the reads file. On the operator's store
// `cells.jsonl` is 288 MB, and a whole-file read holds that string, its split lines, and the parsed rows at once.
import type * as fsp from 'node:fs/promises';
import type * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../errors.js';
import type { Motif } from './motif.js';
import { frozenRead, type Read } from './read.js';
import { currentPool, poolFiles, refreshPool, servedPool } from './pool.js';
import { prompt, session, store, tool } from './pool-fixture.js';

// Every path handed to `readFile`; a whole-file read of a pool file shows here.
const wholeReads: string[] = [];
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsp>();
  const readFile = vi.fn((...args: Parameters<typeof actual.readFile>) => {
    if (typeof args[0] === 'string') wholeReads.push(args[0]);
    return actual.readFile(...args);
  });
  return { ...actual, readFile };
});

// Every path handed to `createReadStream`: the three pool files must each be read this way, so a return to a sync or whole-file read of one fails the guard below.
const streamed: string[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const createReadStream = vi.fn((...args: Parameters<typeof actual.createReadStream>) => {
    if (typeof args[0] === 'string') streamed.push(args[0]);
    return actual.createReadStream(...args);
  });
  return { ...actual, createReadStream };
});

const dirs: string[] = [];
const storeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'oars-pool-stored-read-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  wholeReads.length = 0;
  streamed.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const one = store({ sessions: [session('s1')], prompts: [prompt('s1', 0)], tools: [tool('s1', 0, 'Read'), tool('s1', 1, 'Edit')] });

// A stream reads 64 KiB at a time by default, so a file of this many bytes spans at least three chunks.
const CHUNK = 64 * 1024;
const THREE_CHUNKS = 3 * CHUNK;

/** What the whole-file reader made of a file before t1403: the lines split on `\n`, blanks dropped, each parsed. */
const oldRows = (file: string): unknown[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line): unknown[] => (line === '' ? [] : [JSON.parse(line)]));

const isRead = (value: unknown): value is Read => typeof value === 'object' && value !== null && 'readId' in value && 'family' in value;
const isMotif = (value: unknown): value is Motif => typeof value === 'object' && value !== null && 'motifId' in value && 'level' in value;

/** The lines of `file` repeated until it holds at least `bytes`, then a blank last line. */
const grown = (file: string, bytes: number): string[] => {
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
  const out: string[] = [];
  let size = 0;
  for (let at = 0; size < bytes; at += 1) {
    const line = lines[at % lines.length] ?? '';
    out.push(line);
    size += line.length + 1;
  }
  writeFileSync(file, `${out.join('\n')}\n\n`);
  return out;
};

describe('the stored pool is read as a stream', () => {
  it('never reads cells.jsonl, motifs.jsonl, or the reads file whole through readFile', async () => {
    const dir = storeDir();
    const derived = await refreshPool(dir, one);
    const files = poolFiles(dir);
    wholeReads.length = 0;
    streamed.length = 0;
    expect((await servedPool(dir, one))?.reads).toEqual(derived.reads);
    expect((await refreshPool(dir, one)).reads).toEqual(derived.reads);
    const poolFilesRead = [files.cells, files.motifs, files.reads(derived.pool.version)];
    expect(wholeReads.filter((file) => poolFilesRead.includes(file))).toEqual([]);
    for (const file of poolFilesRead) expect(streamed).toContain(file);
  });

  it('serves the same pool from files of several chunks, a blank last line, and a character cut by a chunk boundary', async () => {
    const dir = storeDir();
    const derived = await refreshPool(dir, one);
    const files = poolFiles(dir);
    const cellRows = grown(files.cells, THREE_CHUNKS);
    grown(files.motifs, THREE_CHUNKS);
    const readRows = grown(files.reads(derived.pool.version), THREE_CHUNKS);
    expect(cellRows.length).toBeGreaterThan(1);
    // An emoji is four bytes: starting two before the boundary, it is cut by it.
    const head = '{"motifId":"m","frameBucket":"f","grain":"week","day":"2026-01-05","note":"';
    const cut = `${head}${'x'.repeat(CHUNK - 2 - head.length)}\u{1F600}"}`;
    writeFileSync(files.cells, `${cut}\n${readFileSync(files.cells, 'utf8')}`);
    const served = await servedPool(dir, one);
    expect(served?.pool.cells).toEqual(oldRows(files.cells));
    expect(served?.pool.cells[0]).toEqual(JSON.parse(cut));
    expect(served?.pool.cells).toHaveLength(cellRows.length + 1);
    expect(served?.pool.motifs).toEqual(new Map(oldRows(files.motifs).filter(isMotif).map((motif) => [motif.motifId, motif])));
    expect(served?.reads).toEqual(oldRows(files.reads(derived.pool.version)).filter(isRead).map(frozenRead));
    expect(served?.reads).toHaveLength(readRows.length);
  });

  it('answers a store with no pool files yet as it answers the same store twice, deriving and writing once', async () => {
    const fresh = storeDir();
    const reference = storeDir();
    const first = await currentPool(fresh, one);
    expect(first).toEqual(await refreshPool(reference, one));
    expect(await currentPool(fresh, one)).toEqual(first);
    expect(await servedPool(fresh, one)).toEqual(first);
  });

  it('reads back a reads file of several chunks as the whole-file reader did', async () => {
    const dir = storeDir();
    const derived = await refreshPool(dir, one);
    const file = poolFiles(dir).reads(derived.pool.version);
    const rows = grown(file, THREE_CHUNKS);
    const current = await currentPool(dir, one);
    expect(current?.reads).toEqual(oldRows(file).filter(isRead).map(frozenRead));
    expect(current?.reads).toHaveLength(rows.length);
    expect(current?.pool).toEqual(derived.pool);
  });

  it('still refuses a line that is not JSON after a row of the wrong kind, and still derives again over rows of the wrong kind alone', async () => {
    const dir = storeDir();
    const derived = await refreshPool(dir, one);
    const file = poolFiles(dir).reads(derived.pool.version);
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, '{"a":1}\nnot json\n');
    const refused = refreshPool(dir, one);
    await expect(refused).rejects.toBeInstanceOf(CliError);
    await expect(refused).rejects.toThrow(file);
    writeFileSync(file, '{"a":1}\n{"b":2}\n');
    expect((await refreshPool(dir, one)).reads).toEqual(derived.reads);
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('reads a last line with no newline after it', async () => {
    const dir = storeDir();
    const derived = await refreshPool(dir, one);
    const file = poolFiles(dir).reads(derived.pool.version);
    writeFileSync(file, readFileSync(file, 'utf8').trimEnd());
    expect((await refreshPool(dir, one)).reads).toEqual(derived.reads);
  });
});
