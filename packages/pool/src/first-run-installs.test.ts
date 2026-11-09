// The saved query for first runs (queries/first-run-installs.sql) run against a local D1 with every migration applied and fixture rows only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPool, type TestDb, type TestPool } from './test-pool.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-11-10T12:00:00Z');
const EDIT = "SELECT '' AS named";
const SQL = readFileSync(fileURLToPath(new URL('../queries/first-run-installs.sql', import.meta.url)), 'utf8');

/** The file with its one edit made, the way an operator makes it. */
const forVersion = (version: string): string => {
  expect(SQL).toContain(EDIT);
  return SQL.replace(EDIT, `SELECT '${version}' AS named`);
};

const run = async (db: TestDb, sql: string): Promise<readonly unknown[]> => (await db.prepare(sql).all()).results;

/** The cell the rollup keeps for a first run (`firstRunMeasures`): the surface in the metric, a hit for a run in CI. */
const firstRun = (surface: string, inCi: boolean): object => ({ metric: `first-run.${surface}`, dimension: 'cli', value: '0.4.0', kind: 'rate', n: 1, hits: inCi ? 1 : 0, buckets: [] });
const command = (): object => ({ metric: 'command.doctor.latency', dimension: 'cli', value: '0.4.0', kind: 'latency', n: 1, hits: 0, buckets: [[3, 1]] });

const day = (db: TestDb, on: string, install: string, cells: object[]): Promise<unknown> =>
  db.prepare("INSERT INTO telemetry_install_days (day, install, account, batches, events, measures) VALUES (?, ?, '', 1, 1, ?)").bind(on, install, JSON.stringify(cells)).run();

describe('queries/first-run-installs.sql', () => {
  let pool: TestPool;
  let db: TestDb;

  beforeAll(async () => {
    pool = await startPool({ COVENANT_VERSION: '' });
    db = await pool.db();
    await db.prepare("INSERT INTO covenant_served (version, first_served_at) VALUES ('v1', ?), ('v2', ?)").bind(START - 30 * DAY, START).run();
    // Before the start: counted for v1, not v2, and its later day does not make it new.
    await day(db, '2026-11-09', 'early', [firstRun('npx', false)]);
    await day(db, '2026-11-12', 'early', [command()]);
    // On the start day (day grain), on later days, in CI, and from an unrecognized place.
    await day(db, '2026-11-10', 'on-start', [firstRun('npx', false)]);
    await day(db, '2026-11-11', 'in-ci', [command(), firstRun('npm-global', true)]);
    await day(db, '2026-11-11', 'twice', [firstRun('claude-plugin', false)]);
    await day(db, '2026-11-12', 'twice', [firstRun('claude-plugin', false)]);
    await day(db, '2026-11-12', 'elsewhere', [firstRun('unknown', false)]);
    await day(db, '2026-11-12', 'second-ci', [firstRun('npx', true)]);
    // Seen on a day after the start but with no first-run cell: an install that did not send one is not counted.
    await day(db, '2026-11-12', 'no-event', [command()]);
    await day(db, '2026-11-12', 'empty', []);
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  it('documents a run that prints rows: a remote read goes through --command with --json, because a remote --file is an import that returns only totals', () => {
    const header = SQL.split(/\r?\n/)
      .filter((line) => line.startsWith('--'))
      .join(' ');
    expect(header).toContain('--remote --json --command="$(cat queries/first-run-installs.sql)"');
    expect(header).not.toContain('--remote --file');
  });

  it('names the install that sends no first-run event as the settings file kept without its install id, not the reverse', () => {
    const words = SQL.split(/\r?\n/)
      .filter((line) => line.startsWith('--'))
      .map((line) => line.replace(/^--\s?/, ''))
      .join(' ');
    expect(words).toContain('the settings file kept without its install id');
    expect(words).not.toContain('the install id kept without its settings file');
  });

  it('names the rollup\'s read limit, since a first-run event is sent once and an install in an unread batch is lost from this count', () => {
    const words = SQL.split(/\r?\n/)
      .filter((line) => line.startsWith('--'))
      .map((line) => line.replace(/^--\s?/, ''))
      .join(' ');
    expect(words).toContain('A day past the rollup\'s 800 batch read limit (docs/pool.md, Bounds) undercounts, and an install whose first run fell in the unread batches is not counted.');
  });

  it('counts distinct first-run installs on or after the day the covenant was first served, CI runs apart, with a row for each surface', async () => {
    expect(await run(db, forVersion('v2'))).toEqual([
      { version: 'v2', start_day: '2026-11-10', surface: '(all)', first_run_installs: 5, ci_installs: 2, non_ci_installs: 3 },
      { version: 'v2', start_day: '2026-11-10', surface: 'claude-plugin', first_run_installs: 1, ci_installs: 0, non_ci_installs: 1 },
      { version: 'v2', start_day: '2026-11-10', surface: 'npm-global', first_run_installs: 1, ci_installs: 1, non_ci_installs: 0 },
      { version: 'v2', start_day: '2026-11-10', surface: 'npx', first_run_installs: 2, ci_installs: 1, non_ci_installs: 1 },
      { version: 'v2', start_day: '2026-11-10', surface: 'unknown', first_run_installs: 1, ci_installs: 0, non_ci_installs: 1 },
    ]);
  });

  it('reads an earlier start day as a wider window: v1 was served before every first run, so the early install counts too', async () => {
    expect(await run(db, forVersion('v1'))).toMatchObject([{ version: 'v1', surface: '(all)', first_run_installs: 6, ci_installs: 2, non_ci_installs: 4 }, {}, {}, { surface: 'npx', first_run_installs: 3 }, {}]);
  });

  it('reads the version served most recently when the edit is left empty', async () => {
    expect(await run(db, SQL)).toMatchObject([{ version: 'v2', surface: '(all)', first_run_installs: 5 }, {}, {}, {}, {}]);
  });

  it('prints one row of nulls and zeros for a version the pool never served, and no verdict column', async () => {
    const rows = await run(db, forVersion('v0'));
    expect(rows).toEqual([{ version: 'v0', start_day: null, surface: '(all)', first_run_installs: 0, ci_installs: 0, non_ci_installs: 0 }]);
    const first = rows[0];
    expect(typeof first === 'object' && first !== null ? Object.keys(first) : []).toEqual(['version', 'start_day', 'surface', 'first_run_installs', 'ci_installs', 'non_ci_installs']);
  });

  it('prints the first-run counts and nothing that joins to an account, a deposit, or an install id', async () => {
    const printed = JSON.stringify(await run(db, forVersion('v2')));
    for (const id of ['early', 'on-start', 'in-ci', 'twice', 'elsewhere', 'second-ci', 'no-event']) expect(printed).not.toContain(id);
    const code = SQL.split(/\r?\n/).filter((line) => !line.startsWith('--')).join('\n');
    expect(code).not.toMatch(/covenant_acceptances|deposits|accounts|\baccount\b/);
  });
});
