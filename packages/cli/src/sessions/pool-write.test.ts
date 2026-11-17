// The pool's cells.jsonl and motifs.jsonl are written in bounded pieces, never as one string of the whole file (t1407): on the operator's store `cells.jsonl` is 284 MB, and serializing it to one string and handing it to one `writeFile` held about 1,000 MB more than the cells themselves.
import type * as fsp from 'node:fs/promises';
import type * as fs from 'node:fs';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { serializeCells, type Cell } from './cells.js';
import type { Motif } from './motif.js';
import { poolFiles, refreshPool } from './pool.js';
import { poolFoldsOf, type PoolFolds } from './pool-fold.js';
import { prompt, session, store, tool } from './pool-fixture.js';

/** Every `writeFile` call: the file, and the bytes handed to that one call. */
const wholeWrites: { file: string; bytes: number }[] = [];
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsp>();
  const writeFile = vi.fn((...args: Parameters<typeof actual.writeFile>) => {
    const [file, data] = args;
    if (typeof file === 'string') wholeWrites.push({ file, bytes: typeof data === 'string' || data instanceof Uint8Array ? Buffer.byteLength(data) : 0 });
    return actual.writeFile(...args);
  });
  return { ...actual, writeFile };
});

/** Every `createWriteStream`: the file, and its `write` spy, whose calls are the chunks handed to the stream. */
const streams: { file: string; write: MockInstance<(chunk: string | Uint8Array) => boolean> }[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const createWriteStream = vi.fn((...args: Parameters<typeof actual.createWriteStream>) => {
    const stream = actual.createWriteStream(...args);
    // The spy calls through: the stream still writes the file.
    if (typeof args[0] === 'string') streams.push({ file: args[0], write: vi.spyOn(stream, 'write') as unknown as MockInstance<(chunk: string | Uint8Array) => boolean> });
    return stream;
  });
  return { ...actual, createWriteStream };
});

const dirs: string[] = [];
const storeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'oars-pool-write-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  wholeWrites.length = 0;
  streams.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const one = store({ sessions: [session('s1')], prompts: [prompt('s1', 0)], tools: [tool('s1', 0, 'Read'), tool('s1', 1, 'Edit')] });

const CHUNK = 64 * 1024;
/** The most bytes any one piece of a pool file may hold: a piece is flushed at 64 KiB of text, so it ends within one line of that, and a character is up to three bytes per UTF-16 unit. */
const BOUND = 4 * CHUNK;

/** Cells whose lines hold multi-byte characters throughout, so some character sits at every chunk edge, and one cell whose line is long. */
const cellsOf = (count: number): Cell[] =>
  Array.from({ length: count }, (_, at): Cell => ({
    motifId: `m${String(at)}\u{1F600}`,
    frameBucket: `claude-code/2.1/\u00e9\u4e2d${'x'.repeat(at === 7 ? 20_000 : at % 13)}`,
    grain: at % 2 === 0 ? 'day' : 'week',
    day: '2026-01-05',
    sessions: 1,
    clusters: 1,
    ok: at,
    failed: 0,
    tokens: null,
    durationMs: at,
    exposed: false,
  }));

const motifsOf = (count: number): Motif[] => Array.from({ length: count }, (_, at): Motif => ({ motifId: `mo${String(at)}\u{1F680}`, level: 'class', steps: [], cls: `c${String(at)}` }));

const folded = (cells: Cell[], motifs: Motif[]): PoolFolds => ({ ...poolFoldsOf([], one), cells: { cells, motifs } });

/** The bytes handed to the writes of one pool file (its temp file included), by call. */
const writtenTo = (file: string): number[] => [
  ...wholeWrites.filter((write) => write.file.startsWith(file)).map(({ bytes }) => bytes),
  ...streams.filter((stream) => stream.file.startsWith(file)).flatMap(({ write }) => write.mock.calls.map(([chunk]) => Buffer.byteLength(chunk))),
];

describe('refreshPool writes the pool files in bounded pieces', () => {
  it('hands cells.jsonl and motifs.jsonl to the disk in pieces of at most a bounded size, and writes the bytes serializeCells makes', async () => {
    const dir = storeDir();
    const files = poolFiles(dir);
    const cells = cellsOf(6000);
    const motifs = motifsOf(2500);
    await refreshPool(dir, one, folded(cells, motifs));
    const whole = serializeCells(cells);
    expect(Buffer.byteLength(whole)).toBeGreaterThan(3 * BOUND);
    expect(readFileSync(files.cells, 'utf8')).toBe(whole);
    expect(readFileSync(files.motifs, 'utf8')).toBe(motifs.map((motif) => `${JSON.stringify(motif)}\n`).join(''));
    const pieces = writtenTo(files.cells);
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...pieces)).toBeLessThanOrEqual(BOUND);
    expect(pieces.reduce((sum, bytes) => sum + bytes, 0)).toBe(Buffer.byteLength(whole));
    expect(Math.max(...writtenTo(files.motifs))).toBeLessThanOrEqual(BOUND);
  });

  it('writes an empty pool as two empty files', async () => {
    const dir = storeDir();
    const files = poolFiles(dir);
    await refreshPool(dir, one, folded([], []));
    expect(existsSync(files.cells)).toBe(true);
    expect(statSync(files.cells).size).toBe(0);
    expect(statSync(files.motifs).size).toBe(0);
  });

  it('leaves no temp file beside the pool files, and replaces what an earlier refresh wrote', async () => {
    const dir = storeDir();
    const files = poolFiles(dir);
    await refreshPool(dir, one, folded(cellsOf(2000), motifsOf(10)));
    await refreshPool(dir, one, folded(cellsOf(5), motifsOf(1)));
    expect(readFileSync(files.cells, 'utf8')).toBe(serializeCells(cellsOf(5)));
    expect(readdirSync(join(files.cells, '..')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
