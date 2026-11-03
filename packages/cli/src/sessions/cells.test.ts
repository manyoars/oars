import { describe, expect, it, vi } from 'vitest';
import { bucketFields, cellIdOf, deriveCells, frameBucketOf, harnessBucket, poolOf, serializeCells, UNKNOWN, type Cell } from './cells.js';
import { classMotif, shapeId } from './motif.js';
import { error, frame, prompt, session, store, tool } from './pool-fixture.js';
import type * as ReadModule from './read.js';
import type { Store } from './store.js';

const READ = { action: 'file.read', identity: null } as const;
const EDIT = { action: 'file.edit', identity: null } as const;

const cellsOf = (input: Store, motifId: string): Cell[] => deriveCells(input).cells.filter((cell) => cell.motifId === motifId);

describe('harnessBucket', () => {
  it('buckets a patch by tens, because an exact version is stale in days', () => {
    expect(harnessBucket('2.1.314')).toBe('2.1.31x');
    expect(harnessBucket('2.1.319')).toBe('2.1.31x');
    expect(harnessBucket('2.1.320')).toBe('2.1.32x');
    expect(harnessBucket('2.1.3')).toBe('2.1.0x');
    expect(harnessBucket('2.1.314-beta.1')).toBe('2.1.31x');
  });

  it('keeps a version with no patch, and says when there is none or it is not a version', () => {
    expect(harnessBucket('2.1')).toBe('2.1');
    expect(harnessBucket('3')).toBe('3');
    expect(harnessBucket(null)).toBe(UNKNOWN);
    expect(harnessBucket('<literal>')).toBe('<literal>');
  });
});

describe('frameBucketOf', () => {
  it('writes a bucket a reader can split back into its fields', () => {
    const bucket = frameBucketOf(frame());
    expect(bucket).toBe('claude-code/2.1.31x/claude-opus-5-5/high');
    expect(bucketFields(bucket)).toEqual({ harness: 'claude-code', harnessBucket: '2.1.31x', model: 'claude-opus-5-5', effort: 'high' });
  });

  it('holds unknowns as a name', () => {
    expect(bucketFields(frameBucketOf(frame({ model: null, effort: null, harnessVersion: null })))).toEqual({ harness: 'claude-code', harnessBucket: UNKNOWN, model: UNKNOWN, effort: UNKNOWN });
  });

  it('reads an unknown from a bucket with fields missing', () => {
    expect(bucketFields('')).toEqual({ harness: '', harnessBucket: UNKNOWN, model: UNKNOWN, effort: UNKNOWN });
  });
});

describe('deriveCells', () => {
  const base: Store = store({
    sessions: [session('s1'), session('s2')],
    prompts: [prompt('s1', 0), prompt('s2', 0)],
    tools: [tool('s1', 0, 'Read'), tool('s1', 1, 'Edit', { status: 'error', durationMs: 30 }), tool('s2', 0, 'Read'), tool('s2', 1, 'Edit', { durationMs: 20 })],
  });

  it('counts a window by its last step, sums its cost, and counts sessions once', () => {
    expect(cellsOf(base, shapeId([READ, EDIT]))).toEqual([
      { motifId: shapeId([READ, EDIT]), frameBucket: 'claude-code/2.1.31x/claude-opus-5-5/high', day: '2026-11-01', sessions: 2, clusters: 1, ok: 1, failed: 1, tokens: 0, durationMs: 70, exposed: false },
    ]);
  });

  it('counts a call with no result in neither ok nor failed', () => {
    const none = store({ ...base, tools: [tool('s1', 0, 'Read', { status: 'none' })] });
    expect(cellsOf(none, shapeId([READ]))).toMatchObject([{ ok: 0, failed: 0, sessions: 1 }]);
  });

  it('marks nothing exposed: no consequence window exists yet', () => {
    expect(deriveCells(base).cells.every((cell) => !cell.exposed)).toBe(true);
  });

  it('states one cluster on one store', () => {
    expect(deriveCells(base).cells.every((cell) => cell.clusters === 1)).toBe(true);
  });

  it('does not run a window across prompts, or across a sidechain', () => {
    const split = store({
      sessions: [session('s1')],
      prompts: [prompt('s1', 0), prompt('s1', 1)],
      tools: [tool('s1', 0, 'Read'), tool('s1', 1, 'Edit', { prompt: 1 }), tool('s1', 2, 'Read', { prompt: 1, side: true }), tool('s1', 3, 'Edit', { prompt: 1 })],
    });
    const cells = cellsOf(split, shapeId([READ, EDIT]));
    expect(cells).toEqual([]);
    expect(cellsOf(split, shapeId([EDIT, EDIT]))).toMatchObject([{ ok: 1 }]);
  });

  it('puts one motif in two frames in two cells', () => {
    const framed = store({
      sessions: [session('s1'), session('s2')],
      prompts: [prompt('s1', 0, { frame: frame({ day: '2026-11-01' }) }), prompt('s2', 0, { frame: frame({ day: '2026-11-02', model: 'claude-sonnet-5-5' }) })],
      tools: [tool('s1', 0, 'Read'), tool('s2', 0, 'Read')],
    });
    expect(cellsOf(framed, shapeId([READ])).map((cell) => [cell.frameBucket.split('/')[2], cell.day])).toEqual([
      ['claude-opus-5-5', '2026-11-01'],
      ['claude-sonnet-5-5', '2026-11-02'],
    ]);
  });

  it('reads a record with no frame through its own prompt, tool, and session fields', () => {
    const old = store({
      sessions: [session('s1')],
      prompts: [prompt('s1', 0, { frame: undefined, ts: '2026-10-31T23:59:00+00:00', model: 'claude-haiku-5-5', efforts: [] })],
      tools: [tool('s1', 0, 'Read', { harnessVersion: '2.1.299' }), tool('s1', 1, 'Read')],
    });
    expect(cellsOf(old, shapeId([READ]))[0]).toMatchObject({ frameBucket: 'claude-code/2.1.29x/claude-haiku-5-5/unknown', day: '2026-10-31' });
  });

  it('reads an empty model on an old prompt as unknown', () => {
    const old = store({ sessions: [session('s1')], prompts: [prompt('s1', 0, { frame: undefined, model: '' })], tools: [tool('s1', 0, 'Read')] });
    expect(cellsOf(old, shapeId([READ]))[0]?.frameBucket).toBe('claude-code/2.1.30x/unknown/high');
  });

  it('frames a subagent line by its own session and counts it under the main session', () => {
    const agents = store({
      sessions: [session('s1')],
      subagents: [session('s1~a', { parent: 's1', frame: frame({ model: 'claude-haiku-5-5', day: '2026-11-03' }) })],
      tools: [tool('s1~a', 0, 'Read', { parent: 's1', prompt: null }), tool('s1~a', 1, 'Read', { parent: 's1', prompt: null })],
    });
    expect(cellsOf(agents, shapeId([READ]))).toMatchObject([{ sessions: 1, day: '2026-11-03', frameBucket: 'claude-code/2.1.31x/claude-haiku-5-5/high' }]);
  });

  it('reads an old subagent session by its most used model and its first timestamp', () => {
    const agents = store({
      subagents: [session('s1~a', { parent: 's1', models: { 'claude-opus-5-5': 1, 'claude-haiku-5-5': 2 }, tsFirst: '2026-11-04T01:00:00Z' })],
      tools: [tool('s1~a', 0, 'Read', { parent: 's1', prompt: null })],
    });
    expect(cellsOf(agents, shapeId([READ]))).toMatchObject([{ day: '2026-11-04', frameBucket: 'claude-code/2.1.30x/claude-haiku-5-5/unknown' }]);
  });

  it('breaks a model tie by name and reads no model and no day as unknown', () => {
    const tied = store({ subagents: [session('a', { models: { b: 1, 'claude-a': 1, 'claude-c': 1 } })], tools: [tool('a', 0, 'Read', { prompt: null })] });
    expect(cellsOf(tied, shapeId([READ]))[0]?.frameBucket).toBe('claude-code/2.1.30x/<literal>/unknown');
    const none = store({ subagents: [session('a')], tools: [tool('a', 0, 'Read', { prompt: null })] });
    expect(cellsOf(none, shapeId([READ]))[0]).toMatchObject({ frameBucket: 'claude-code/2.1.30x/unknown/unknown', day: UNKNOWN });
  });

  it('counts a prompt in its class motif, with its whole usage and wall time', () => {
    const usage = { input: 1, cacheWrite: 2, cacheRead: 3, output: 4, thinking: 99 };
    const classed = store({ sessions: [session('s1')], prompts: [prompt('s1', 0, { usage, wallSec: 2, errors: 1 }), prompt('s1', 1, { usage, wallSec: null })] });
    expect(cellsOf(classed, classMotif('edit-verify').motifId)).toMatchObject([{ sessions: 1, ok: 1, failed: 1, tokens: 20, durationMs: 2000 }]);
  });

  it('frames a version-2 prompt, whose session has no capture record, as unknown harness version', () => {
    const old = store({ prompts: [prompt('gone', 0, { frame: undefined })] });
    expect(cellsOf(old, classMotif('edit-verify').motifId)[0]?.frameBucket).toBe('claude-code/unknown/claude-opus-5-5/high');
  });

  it('skips a call whose session the store does not hold', () => {
    expect(deriveCells(store({ tools: [tool('gone', 0, 'Read')] })).cells).toEqual([]);
  });
});

describe('determinism', () => {
  const tools = [tool('s1', 0, 'Read'), tool('s1', 1, 'Edit'), tool('s2', 0, 'Bash'), tool('s2', 1, 'Read')];
  const one = store({ sessions: [session('s1'), session('s2')], prompts: [prompt('s1', 0), prompt('s2', 0)], tools });

  it('writes byte-identical cells on a rerun, whatever order the records came in', () => {
    const reversed = store({ ...one, sessions: [...one.sessions].reverse(), prompts: [...one.prompts].reverse(), tools: [...tools].reverse() });
    expect(serializeCells(deriveCells(reversed).cells)).toBe(serializeCells(deriveCells(one).cells));
  });

  it('gives a cell an ID by its content', () => {
    const [cell] = deriveCells(one).cells;
    if (cell === undefined) throw new Error('no cell');
    expect(cellIdOf(cell)).toMatch(/^cell:[0-9a-f]{16}$/);
    expect(cellIdOf({ ...cell })).toBe(cellIdOf(cell));
    expect(cellIdOf({ ...cell, ok: cell.ok + 1 })).not.toBe(cellIdOf(cell));
  });
});

describe('poolOf', () => {
  const one = store({ sessions: [session('s1')], prompts: [prompt('s1', 0)], tools: [tool('s1', 0, 'Read')] });

  it('versions the pool by its cells, and states its newest day', () => {
    const pool = poolOf(deriveCells(one), []);
    expect(pool.version).toBe(poolOf(deriveCells(one), []).version);
    expect(pool.lastDay).toBe('2026-11-01');
    const later = store({ ...one, tools: [...one.tools, tool('s1', 1, 'Read')] });
    expect(poolOf(deriveCells(later), []).version).not.toBe(pool.version);
  });

  it('versions the pool by the error rows recovery reads, whatever their order', () => {
    const rows = [error('s1', 'sig-a', { toolUseId: 'c0' }), error('s1', 'sig-b', { toolUseId: 'c1' })];
    const set = deriveCells(one);
    const version = poolOf(set, rows).version;
    expect(poolOf(set, [...rows].reverse()).version).toBe(version);
    expect(poolOf(set, rows.slice(0, 1)).version).not.toBe(version);
    expect(poolOf(set, [error('s1', 'sig-a', { toolUseId: 'c0' }), error('s1', 'sig-c', { toolUseId: 'c1' })]).version).not.toBe(version);
    expect(poolOf(set, [error('s1', 'sig-a', { toolUseId: 'c0', editFollowed: true }), rows[1] ?? error('s1', 'unused')]).version).not.toBe(version);
  });

  it('leaves the pool as it was when only an error field no read looks at changes', () => {
    const set = deriveCells(one);
    expect(poolOf(set, [error('s1', 'sig-a', { example: 'one' })]).version).toBe(poolOf(set, [error('s1', 'sig-a', { example: 'two' })]).version);
  });

  it('gives a new method version a new pool, so a stored file of the old method is not served', async () => {
    const before = poolOf(deriveCells(one), []).version;
    vi.resetModules();
    vi.doMock('./read.js', async (importActual) => {
      const actual = await importActual<typeof ReadModule>();
      return { ...actual, METHODS: { ...actual.METHODS, fit: { ...actual.METHODS.fit, version: '2' } } };
    });
    try {
      const fresh = await import('./cells.js');
      expect(fresh.poolOf(fresh.deriveCells(one), []).version).not.toBe(before);
    } finally {
      vi.doUnmock('./read.js');
      vi.resetModules();
    }
  });

  it('gives a new call-shape version a new pool, since that method has no row of its own in the table', async () => {
    const before = poolOf(deriveCells(one), []).version;
    vi.resetModules();
    vi.doMock('./read.js', async (importActual) => {
      const actual = await importActual<typeof ReadModule>();
      return { ...actual, CALL_SHAPE_METHOD: { ...actual.CALL_SHAPE_METHOD, version: '2' } };
    });
    try {
      const fresh = await import('./cells.js');
      expect(fresh.poolOf(fresh.deriveCells(one), []).version).not.toBe(before);
    } finally {
      vi.doUnmock('./read.js');
      vi.resetModules();
    }
  });

  it('finds every cell its motif', () => {
    const pool = poolOf(deriveCells(one), []);
    expect(pool.cells.every((cell) => pool.motifs.has(cell.motifId))).toBe(true);
  });

  it('states no day when no cell has one', () => {
    const none = store({ subagents: [session('a')], tools: [tool('a', 0, 'Read', { prompt: null })] });
    expect(poolOf(deriveCells(none), []).lastDay).toBeNull();
    expect(poolOf({ cells: [], motifs: [] }, []).lastDay).toBeNull();
  });
});
