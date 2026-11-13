// The saved query for the join (queries/join-funnel.sql) run against a local D1 with every migration applied and fixture rows only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPool, type TestDb, type TestPool } from './test-pool.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-11-10T12:00:00Z');
const EDIT = "SELECT '' AS named";
const SQL = readFileSync(fileURLToPath(new URL('../queries/join-funnel.sql', import.meta.url)), 'utf8');

const forVersion = (version: string): string => {
  expect(SQL).toContain(EDIT);
  return SQL.replace(EDIT, `SELECT '${version}' AS named`);
};

const run = async (db: TestDb, sql: string): Promise<readonly unknown[]> => (await db.prepare(sql).all()).results;

/** The cell the rollup keeps for a join step (`joinStepMeasures`). */
const cell = (step: string, state: string): object => ({ metric: `join-step.${step}.${state}`, dimension: 'cli', value: '0.4.0', kind: 'rate', n: 1, hits: 1, buckets: [] });

const day = (db: TestDb, on: string, install: string, cells: object[]): Promise<unknown> =>
  db.prepare("INSERT INTO telemetry_install_days (day, install, account, batches, events, measures) VALUES (?, ?, '', 1, 1, ?)").bind(on, install, JSON.stringify(cells)).run();

describe('queries/join-funnel.sql', () => {
  let pool: TestPool;
  let db: TestDb;

  beforeAll(async () => {
    pool = await startPool({ COVENANT_VERSION: '' });
    db = await pool.db();
    await db.prepare("INSERT INTO covenant_served (version, first_served_at) VALUES ('v1', ?), ('v2', ?)").bind(START - 30 * DAY, START).run();
    // Reaches every step in one run.
    await day(db, '2026-11-11', 'whole', ['signin', 'region', 'terms', 'batch', 'outbox', 'covenant', 'send'].map((step) => cell(step, 'done')));
    // Stopped at the covenant; a later day resumes past it, so it is reached and no longer stopped.
    await day(db, '2026-11-11', 'resumed', [...['signin', 'region', 'terms', 'batch', 'outbox'].map((step) => cell(step, 'done')), cell('covenant', 'stopped')]);
    await day(db, '2026-11-12', 'resumed', [cell('signin', 'skipped'), cell('covenant', 'done'), cell('send', 'done')]);
    // Stopped at the terms and never resumed.
    await day(db, '2026-11-12', 'stuck', [cell('signin', 'done'), cell('region', 'done'), cell('terms', 'stopped')]);
    // No session was ready: covenant and send are `none`, which is not reached (it must not read as a counting deposit).
    await day(db, '2026-11-12', 'nothing', [cell('signin', 'done'), cell('region', 'skipped'), cell('terms', 'done'), cell('batch', 'done'), cell('outbox', 'done'), cell('covenant', 'none'), cell('send', 'none')]);
    // Before the start of v2: in v1's window only. An event of another kind, and an empty day, count nothing.
    await day(db, '2026-11-09', 'early', [cell('signin', 'done')]);
    await day(db, '2026-11-12', 'other', [{ metric: 'first-run.npx', dimension: 'cli', value: '0.4.0', kind: 'rate', n: 1, hits: 0, buckets: [] }]);
    await day(db, '2026-11-12', 'empty', []);
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  it('documents a run that prints rows, through --command with --json', () => {
    const header = SQL.split(/\r?\n/)
      .filter((line) => line.startsWith('--'))
      .join(' ');
    expect(header).toContain('--remote --json --command="$(cat queries/join-funnel.sql)"');
    expect(header).not.toContain('--remote --file');
  });

  it('counts, for each step in the order of the join, the installs that reached it and the installs that stopped there', async () => {
    expect(await run(db, forVersion('v2'))).toEqual([
      { version: 'v2', start_day: '2026-11-10', step: 'signin', installs: 4, reached: 4, stopped: 0 },
      { version: 'v2', start_day: '2026-11-10', step: 'region', installs: 4, reached: 4, stopped: 0 },
      { version: 'v2', start_day: '2026-11-10', step: 'terms', installs: 4, reached: 3, stopped: 1 },
      { version: 'v2', start_day: '2026-11-10', step: 'batch', installs: 4, reached: 3, stopped: 0 },
      { version: 'v2', start_day: '2026-11-10', step: 'outbox', installs: 4, reached: 3, stopped: 0 },
      { version: 'v2', start_day: '2026-11-10', step: 'covenant', installs: 4, reached: 2, stopped: 0 },
      { version: 'v2', start_day: '2026-11-10', step: 'send', installs: 4, reached: 2, stopped: 0 },
    ]);
  });

  it('reads an earlier start day as a wider window: v1 was served before every event, so the early install counts too', async () => {
    expect(await run(db, forVersion('v1'))).toMatchObject([{ step: 'signin', installs: 5, reached: 5 }, {}, {}, {}, {}, {}, { step: 'send', installs: 5, reached: 2 }]);
  });
});
