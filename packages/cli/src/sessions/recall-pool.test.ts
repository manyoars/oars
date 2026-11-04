import { describe, expect, it } from 'vitest';
import { cellIdOf, type Cell, type Pool } from './cells.js';
import type { Read } from './read.js';
import { readsOfFamily } from './recall-pool.js';

const cell = (grain: Cell['grain'], day: string): Cell => ({ motifId: 'm', frameBucket: 'claude-code/2.1.31x/claude-opus-5-5', grain, day, sessions: 2, clusters: 1, ok: 1, failed: 1, tokens: 0, durationMs: 0, exposed: false });

const readOver = (cells: Cell[], day: string | null): Read => ({
  readId: 'read:a',
  family: 'adoption',
  method: 'm',
  methodVersion: '1',
  inputs: cells.map(cellIdOf),
  order: 1,
  slice: {},
  value: {},
  n: 3,
  clusters: 1,
  interval: null,
  asOf: { pool: 'p', day },
  basis: 'all',
});

const poolOf = (cells: Cell[]): Pool => ({ cells, motifs: new Map(), version: 'p', lastDay: null });

const answer = (cells: Cell[], day: string | null) => readsOfFamily('adoption', { pool: poolOf(cells), reads: [readOver(cells, day)] })[0];

describe('a stored read over a week cell', () => {
  const week = cell('week', '2026-11-02');

  it('answers no later than the pool it was read from: a week cell may hold seven days, but not days after its pool', () => {
    // Wednesday 2026-11-04 is the newest day in the pool; the week cell closes on Sunday 2026-11-08.
    expect(answer([week], '2026-11-04')).toMatchObject({ firstDay: '2026-11-02', lastDay: '2026-11-04' });
  });

  it('answers the Sunday that closes the week when the pool has no known day', () => {
    expect(answer([week], null)?.lastDay).toBe('2026-11-08');
  });

  it('leaves a day cell and a week that closes before the pool as they are', () => {
    expect(answer([cell('day', '2026-11-03')], '2026-11-04')?.lastDay).toBe('2026-11-03');
    expect(answer([week], '2026-11-20')?.lastDay).toBe('2026-11-08');
  });
});
