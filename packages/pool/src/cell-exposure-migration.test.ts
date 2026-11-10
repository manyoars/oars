// Migration 0021: a stored cell's exposure is shown, held, or unknown. A row stored before it was derived without the input, so it reads unknown, and the key it already has keeps its meaning.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startPool } from './test-pool.js';

const statementsOf = (file: string): string[] =>
  readFileSync(fileURLToPath(new URL(`../migrations/${file}`, import.meta.url)), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('--'));

const BEFORE = 'a1b2c3d4e5f60708/claude-code/2.1.31x/claude-opus-5-5/week/2026-11-02/0';

describe('0021_cell_exposure.sql', () => {
  it('reads every row stored before it as unknown, keeps its key, and refuses any other reading', async () => {
    const target = await startPool();
    try {
      const db = await target.db();
      // The table as it stood before the migration: without the column, holding a row the old derivation wrote.
      await db.prepare('ALTER TABLE cells DROP COLUMN exposure').run();
      await db.prepare('INSERT INTO cells (key, harness_bucket, motif_id, frame_bucket, grain, day, exposed, sessions, ok, failed, tokens, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(BEFORE, 'claude-code/2.1.31x', 'a1b2c3d4e5f60708', 'claude-code/2.1.31x/claude-opus-5-5', 'week', '2026-11-02', 0, 3, 2, 1, 0, 0).run();
      const statements = statementsOf('0021_cell_exposure.sql');
      expect(statements).toHaveLength(1);
      for (const statement of statements) await db.prepare(statement).run();
      expect(await db.prepare('SELECT key, exposed, exposure, sessions FROM cells').all()).toMatchObject({ results: [{ key: BEFORE, exposed: 0, exposure: 'unknown', sessions: 3 }] });
      await expect(db.prepare("UPDATE cells SET exposure = 'unexposed'").run()).rejects.toThrow();
      await db.prepare("UPDATE cells SET exposure = 'held'").run();
      expect(await db.prepare('SELECT exposure FROM cells').first()).toEqual({ exposure: 'held' });
    } finally {
      await target.dispose();
    }
  }, 60_000);
});
