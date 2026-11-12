// The saved proof sheet (queries/proof-sheet.sql) run against a local D1 with every migration applied and fixture rows only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fieldOf } from './http.js';
import { startPool, type TestDb, type TestPool } from './test-pool.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-11-10T12:00:00Z');
const EDIT = "SELECT '' AS named";
const SQL = readFileSync(fileURLToPath(new URL('../queries/proof-sheet.sql', import.meta.url)), 'utf8');

const forVersion = (version: string): string => {
  expect(SQL).toContain(EDIT);
  return SQL.replace(EDIT, `SELECT '${version}' AS named`);
};

type Line = unknown;
const lines = async (db: TestDb, sql: string): Promise<readonly Line[]> => (await db.prepare(sql).all()).results;
const lineOf = (rows: readonly Line[], metric: string, detail = '(all)'): Line => rows.find((row) => fieldOf(row, 'metric') === metric && fieldOf(row, 'detail') === detail);
const valueOf = (rows: readonly Line[], metric: string, detail = '(all)'): unknown => fieldOf(lineOf(rows, metric, detail), 'value');

const install = (db: TestDb, day: string, id: string, account: string): Promise<unknown> =>
  db.prepare("INSERT INTO telemetry_install_days (day, install, account, batches, events, measures) VALUES (?, ?, ?, 1, 1, '{}')").bind(day, id, account).run();
const accept = (db: TestDb, account: string, at: number): Promise<unknown> => db.prepare("INSERT INTO covenant_acceptances (account, version, accepted_at) VALUES (?, 'v2', ?)").bind(account, at).run();
const deposit = (db: TestDb, account: string, id: string, countedAt: number): Promise<unknown> =>
  db.prepare("INSERT INTO deposits (account, id, skeleton, tier, counted_at) VALUES (?, ?, '{}', 'committed', ?)").bind(account, id, countedAt).run();
const week = (db: TestDb, account: string, on: string, sessions: number, harnesses: string[]): Promise<unknown> =>
  db.prepare('INSERT INTO account_weeks (account, week, sessions, tool_steps, failed_steps, day_mask, harnesses) VALUES (?, ?, ?, 1, 0, 1, ?)').bind(account, on, sessions, JSON.stringify(harnesses)).run();
const cell = (db: TestDb, key: string, clusters: number, clustersAny: number, sessions = 3): Promise<unknown> =>
  db
    .prepare("INSERT INTO cells (key, harness_bucket, motif_id, frame_bucket, day, exposed, sessions, clusters, clusters_any, ok, failed, tokens, duration_ms) VALUES (?, 'h', 'm', 'claude/x', '2026-11-10', 0, ?, ?, ?, 1, 0, 0, 0)")
    .bind(key, sessions, clusters, clustersAny)
    .run();

describe('queries/proof-sheet.sql', () => {
  let pool: TestPool;
  let db: TestDb;
  let rows: readonly Line[] = [];

  beforeAll(async () => {
    pool = await startPool({ COVENANT_VERSION: '' });
    db = await pool.db();
    await db.prepare("INSERT INTO covenant_served (version, first_served_at) VALUES ('v2', ?)").bind(START).run();
    for (const id of ['acc-a', 'acc-b', 'acc-c', 'acc-seed']) await db.prepare('INSERT INTO accounts (id) VALUES (?)').bind(id).run();
    await db.prepare("UPDATE accounts SET source = 'input' WHERE id = 'acc-seed'").run();
    // Installs: veteran predates the start; a1 is seen on two days and counts once; b1 has an account that never accepted; c1 has no account; d1 names an account on one day and none on another.
    await install(db, '2026-11-08', 'veteran', 'acc-a');
    await install(db, '2026-11-10', 'a1', 'acc-a');
    await install(db, '2026-11-11', 'a1', 'acc-a');
    await install(db, '2026-11-11', 'b1', 'acc-b');
    await install(db, '2026-11-12', 'c1', '');
    await install(db, '2026-11-12', 'd1', '');
    await install(db, '2026-11-12', 'd1', 'acc-c');
    await accept(db, 'acc-a', START + DAY);
    await accept(db, 'acc-c', START + 2 * DAY);
    await accept(db, 'acc-seed', START + DAY);
    await deposit(db, 'acc-a', 'd1', START + DAY + 28 * DAY);
    await deposit(db, 'acc-c', 'd1', START + 2 * DAY + 10 * DAY);
    await week(db, 'acc-a', '2026-11-09', 4, ['claude']);
    await week(db, 'acc-b', '2026-11-09', 2, ['claude']);
    await week(db, 'acc-c', '2026-11-09', 5, ['codex']);
    await week(db, 'acc-c', '2026-11-16', 1, ['claude', 'codex']);
    await week(db, 'acc-seed', '2026-11-09', 50, ['claude']);
    await cell(db, 'k1', 5, 5);
    await cell(db, 'k2', 2, 6);
    await cell(db, 'k3', 4, 4);
    await cell(db, 'k4', 9, 9, 0);
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  it('documents a run that prints rows through --command with --json', () => {
    const header = SQL.split(/\r?\n/).filter((line) => line.startsWith('--')).join(' ');
    expect(header).toContain('--remote --json --command="$(cat queries/proof-sheet.sql)"');
  });

  it('the proof sheet counts match the seeded store', async () => {
    rows = await lines(db, forVersion('v2'));
    expect(valueOf(rows, 'installs')).toBe(4);
    expect(valueOf(rows, 'accepted')).toBe(2);
    expect(valueOf(rows, 'depositing_4w')).toBe(1);
    expect(valueOf(rows, 'pack_grade_sessions', 'claude')).toBe(6);
    expect(valueOf(rows, 'pack_grade_sessions', 'codex')).toBe(5);
    expect(valueOf(rows, 'pack_grade_sessions', 'mixed')).toBe(1);
    expect(valueOf(rows, 'served_cells')).toBe(2);
    expect(fieldOf(lineOf(rows, 'installs'), 'as_of')).toBe('2026-11-12');
    expect(fieldOf(lineOf(rows, 'accepted'), 'as_of')).toBe('2026-11-12');
  });

  it('joins installs to accounts: the install of an accepting account counts as an accepted install', () => {
    expect(valueOf(rows, 'installs_with_account')).toBe(3);
    expect(valueOf(rows, 'accepted_installs')).toBe(2);
    expect(valueOf(rows, 'depositing_4w_installs')).toBe(1);
  });

  it('an install with no account is counted once as an install', () => {
    // c1 names no account and d1 names one on only one of its days: both are in the 4 installs, and a1 seen on two days is one.
    expect(valueOf(rows, 'installs')).toBe(4);
    expect(valueOf(rows, 'installs_with_account')).toBe(3);
  });

  it('prints zeros for a version the pool never served, and no account id', async () => {
    const none = await lines(db, forVersion('v0'));
    expect(valueOf(none, 'installs')).toBe(0);
    expect(valueOf(none, 'accepted')).toBe(0);
    expect(JSON.stringify(rows)).not.toContain('acc-');
  });
});
