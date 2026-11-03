import { describe, expect, it } from 'vitest';
import { firstOrderOf, tools } from './order-fixture.js';
import { frame, prompt, session, store } from './pool-fixture.js';
import { deriveDayMove, nextDay } from './read-day-move.js';
import type { Store } from './store.js';

/** Per day, as `[day, reads, failed reads, edits]`. */
const days = (rows: readonly (readonly [string, number, number, number])[]): Store =>
  store({
    sessions: [session('s1')],
    prompts: rows.map(([day], index) => prompt('s1', index, { frame: frame({ day }) })),
    tools: rows.flatMap(([, reads, failed, edits], index) => [...tools('s1', index, [{ name: 'Read', count: reads }], failed), ...tools('s1', index, [{ name: 'Edit', count: edits }])]),
  });

const movesOf = (from: Store) => deriveDayMove(firstOrderOf(from));

describe('day move', () => {
  it('reads a failure move and a share move between calendar-adjacent days, each with an interval from its inputs', () => {
    const moves = movesOf(days([['2026-10-20', 100, 10, 100], ['2026-10-21', 300, 90, 100]]));
    const failure = moves.find((read) => read.slice.motif === 'file.read' && read.slice.metric === 'failureRate');
    expect(failure?.slice).toEqual({ motif: 'file.read', level: 'shape', metric: 'failureRate', from: '2026-10-20', to: '2026-10-21' });
    expect(failure?.value).toEqual({ before: 0.1, after: 0.3, move: 0.2 });
    expect(failure?.n).toBe(100);
    expect(failure?.interval?.low).toBeGreaterThan(0);
    expect(failure?.interval?.high).toBeLessThan(0.3);
    const share = moves.find((read) => read.slice.motif === 'file.read' && read.slice.metric === 'share');
    expect(share?.value).toEqual({ before: 0.5, after: 0.75, move: 0.25 });
    expect(share?.interval?.low).toBeGreaterThan(0);
    expect(moves).toHaveLength(4);
  });

  it('states a move that is nothing as well, so a read over them is not selected on its outcome', () => {
    const moves = movesOf(days([['2026-10-20', 100, 10, 100], ['2026-10-21', 100, 10, 100]]));
    expect(moves).toHaveLength(4);
    expect(moves.every((read) => read.value.move === 0)).toBe(true);
  });

  it('does not read across a gap in the calendar, or a day below the floor', () => {
    expect(movesOf(days([['2026-10-20', 100, 0, 100], ['2026-10-22', 100, 0, 100]]))).toEqual([]);
    expect(movesOf(days([['2026-10-20', 29, 0, 29], ['2026-10-21', 100, 0, 100]]))).toEqual([]);
  });

  it('counts across a month and a year', () => {
    expect(nextDay('2026-10-31')).toBe('2026-11-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
  });
});
