// Rule 6: weekly cells and day cells share one table. A read of days answers from day cells alone and a read of weeks from week cells alone, so a table holding both grains gives each read
// the answer it gives holding only its own grain.
import { describe, expect, it } from 'vitest';
import type { Cell, Pool } from './cells.js';
import { tools } from './order-fixture.js';
import { error, frame, poolFrom, prompt, session, store, tool } from './pool-fixture.js';
import { deriveFirstOrder } from './pool.js';
import { fitReads } from './recall-reads.js';
import { deriveAdoption } from './read-adoption.js';
import { deriveCallShape } from './read-call-shape.js';
import { deriveChange } from './read-change.js';
import { deriveCost } from './read-cost.js';
import { deriveDayMove } from './read-day-move.js';
import { deriveFit } from './read-fit.js';
import { deriveLive } from './read-live.js';
import { deriveMethod } from './read-method.js';
import { deriveNextStep } from './read-next-step.js';
import { deriveRecovery } from './read-recovery.js';
import { deriveToolDay } from './read-tool-day.js';
import { type DeriveFamily } from './read-support.js';
import type { Store } from './store.js';

const SIG = 'Read | no such file';
const on = (day: string, index: number) => prompt('s1', index, { frame: frame({ day }) });

/** Four days across two UTC weeks, with failures, an error, and tools that follow each other. */
const spanning: Store = {
  ...store({
    sessions: [session('s1')],
    prompts: [on('2026-10-30', 0), on('2026-11-01', 1), on('2026-11-02', 2), on('2026-11-03', 3)],
    tools: [
      tool('s1', 0, 'Read', { prompt: 0 }),
      tool('s1', 1, 'Edit', { prompt: 0, status: 'error' }),
      tool('s1', 2, 'Read', { prompt: 1, status: 'error' }),
      tool('s1', 3, 'Edit', { prompt: 1 }),
      tool('s1', 4, 'Read', { prompt: 2 }),
      tool('s1', 5, 'Edit', { prompt: 2 }),
      tool('s1', 6, 'Read', { prompt: 3, status: 'error' }),
      tool('s1', 7, 'Edit', { prompt: 3 }),
    ],
  }),
  errors: [error('s1', SIG, { next: ['Edit'] })],
};

/** Three sessions on three days across a week boundary, each with twenty `Read` calls of the same input keys and three failures: above `FIT_FLOORS`, so call shape yields a read. */
const shaped = (framed: boolean): Store => {
  const rows = [['s1', '2026-11-01'], ['s2', '2026-11-02'], ['s3', '2026-11-03']] as const;
  return store({
    sessions: rows.map(([id]) => session(id)),
    prompts: rows.map(([id, day]) => prompt(id, 0, { frame: frame({ day: framed ? day : null }) })),
    tools: rows.flatMap(([id, day]) =>
      Array.from({ length: 20 }, (_, n) => tool(id, n, 'Read', { prompt: 0, keys: ['path'], status: n < 3 ? 'error' : 'ok', ts: `${day}T10:00:00.000Z` })),
    ),
  });
};

const both = poolFrom(spanning);
const only = (pool: Pool, grain: 'day' | 'week'): Pool => ({ ...pool, cells: pool.cells.filter((cell) => cell.grain === grain) });
const days = only(both, 'day');
const weeks = only(both, 'week');

const answers = (derive: DeriveFamily, pool: Pool) => derive({ pool, store: spanning });

describe('a grain filter on every read', () => {
  it('holds both grains in the table the reads share', () => {
    expect(days.cells.length).toBeGreaterThan(0);
    expect(weeks.cells.length).toBeGreaterThan(0);
    expect(both.cells.length).toBe(days.cells.length + weeks.cells.length);
  });

  it.each([
    ['live', deriveLive],
    ['tool-day', deriveToolDay],
    ['call shape', deriveCallShape],
  ] as const)('answers the day read %s from day cells alone', (_name, derive) => {
    expect(answers(derive, both)).toEqual(answers(derive, days));
  });

  it('answers call shape from day cells alone, with a read that cites them', () => {
    const dated = shaped(true);
    const all = poolFrom(dated);
    const dayCells = only(all, 'day');
    const shape = (pool: Pool) => deriveCallShape({ pool, store: dated });
    const [read] = shape(all);
    expect(read).toMatchObject({ family: 'fit', n: 9, value: { failed: 9, calls: 60 } });
    expect(read?.inputs.length).toBeGreaterThan(0);
    expect(shape(all)).toEqual(shape(dayCells));
    expect(shape(only(all, 'week'))).toEqual([]);
  });

  it('gives call shape nothing to cite when the frames of its failures have no day: a day cell exists for a known day only', () => {
    const undated = shaped(false);
    expect(fitReads(undated)).toHaveLength(1);
    expect(deriveCallShape({ pool: poolFrom(undated), store: undated })).toEqual([]);
  });

  it('answers recovery from day cells for the failed call and week cells for the step after it', () => {
    const oneStep = (cell: Cell): boolean => both.motifs.get(cell.motifId)?.steps.length === 1;
    const own: Pool = { ...both, cells: both.cells.filter((cell) => (cell.grain === 'day' ? true : !oneStep(cell))) };
    const dayOnly: Pool = { ...both, cells: days.cells };
    expect(answers(deriveRecovery, both)).toEqual(answers(deriveRecovery, own));
    expect(answers(deriveRecovery, both).length).toBeGreaterThan(0);
    expect(answers(deriveRecovery, own)).not.toEqual(answers(deriveRecovery, dayOnly));
  });

  it.each([
    ['fit', deriveFit],
    ['change', deriveChange],
    ['adoption', deriveAdoption],
    ['cost', deriveCost],
    ['method', deriveMethod],
    ['next step', deriveNextStep],
  ] as const)('answers the week read %s from week cells alone', (_name, derive) => {
    expect(answers(derive, both)).toEqual(answers(derive, weeks));
  });

  it('answers with something, so the comparison is not two empty lists', () => {
    for (const derive of [deriveLive, deriveToolDay, deriveFit, deriveChange, deriveAdoption, deriveRecovery, deriveCost, deriveMethod, deriveNextStep]) expect(answers(derive, both).length).toBeGreaterThan(0);
  });

  it('gives the day move the answer it gives from day cells alone, over the first-order reads of each table', () => {
    // A Sunday and the Monday after it: adjacent days in two weeks, each above the floor of steps, so the move has a failure rate and a share to state.
    const rows = [['2026-11-01', 100, 10, 100], ['2026-11-02', 300, 90, 100]] as const;
    const moving: Store = store({
      sessions: [session('s1')],
      prompts: rows.map(([day], index) => prompt('s1', index, { frame: frame({ day }) })),
      tools: rows.flatMap(([, reads, failed, edits], index) => [...tools('s1', index, [{ name: 'Read', count: reads }], failed), ...tools('s1', index, [{ name: 'Edit', count: edits }])]),
    });
    const all = poolFrom(moving);
    const dayCells = only(all, 'day');
    const moves = (pool: Pool) => deriveDayMove(deriveFirstOrder(pool, moving));
    expect(moves(dayCells).length).toBeGreaterThan(0);
    expect(moves(all)).toEqual(moves(dayCells));
    expect(moves(all).every((read) => read.family === 'day-move')).toBe(true);
  });

  it('would change a day answer if a week cell leaked in: a live read over the week cells alone finds nothing', () => {
    expect(answers(deriveLive, weeks)).toEqual([]);
    expect(answers(deriveFit, days)).not.toEqual(answers(deriveFit, weeks));
  });
});
