// A stored cell names its exposure as shown, held, or unknown, and the cells table's CHECK refuses anything else, so a reading off the list can only come from a table that was changed under the pool. The reader surfaces that as a fault
// and does not serve the row as some other reading. The rows here are handed to `storedOf` by a stub binding, since the real table would refuse the row.
import { describe, expect, it } from 'vitest';
import { DEFAULT_FLOORS } from './floors.js';
import type { Bound, Env } from './http.js';
import { storedOf } from './stored.js';

const cellRow = (exposure: string): unknown => ({
  motif_id: 'm1',
  frame_bucket: 'claude-code/2.1.314/-',
  grain: 'week',
  day: '2026-11-02',
  exposed: 0,
  exposure,
  sessions: 3,
  clusters: 3,
  clusters_any: 3,
  ok: 3,
  failed: 0,
  tokens: 0,
  token_sessions: 0,
  token_prompts: 0,
  duration_ms: 0,
});

/** A binding that answers the cells query with the rows given and every other query with none; the panel row is today's, so no count is read. */
const bindingOf = (cells: readonly unknown[], day: string): Env['DB'] => ({
  prepare: (sql) => ({
    bind: (): Bound => ({
      first: () => Promise.resolve(sql.startsWith('SELECT day, accounts FROM panel') ? { day, accounts: 0 } : null),
      all: () => Promise.resolve({ results: sql.startsWith('SELECT motif_id, frame_bucket, grain, day, exposed, exposure') ? cells : [] }),
      run: () => Promise.resolve({ meta: { changes: 0 } }),
    }),
  }),
  batch: () => Promise.resolve([]),
});

const NOW = Date.parse('2026-11-09T12:00:00.000Z');

describe('the exposure a stored cell is read with', () => {
  it.each(['shown', 'held', 'unknown'] as const)('reads %s as itself', async (exposure) => {
    const stored = await storedOf({ DB: bindingOf([cellRow(exposure)], '2026-11-09') }, 'claude-code', '2.1.314', DEFAULT_FLOORS, NOW);
    expect(stored.cells.map((cell) => cell.exposure)).toEqual([exposure]);
  });

  it('throws on a stored reading off the list, and does not serve it as another', async () => {
    await expect(storedOf({ DB: bindingOf([cellRow('unexposed')], '2026-11-09') }, 'claude-code', '2.1.314', DEFAULT_FLOORS, NOW)).rejects.toThrow('a stored cell names no exposure');
  });
});
