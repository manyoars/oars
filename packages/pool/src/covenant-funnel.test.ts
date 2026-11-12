// The saved V17(2) query (queries/covenant-funnel.sql) run against a local D1 with every migration applied and fixture rows only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fieldOf } from './http.js';
import { startPool, type TestDb, type TestPool } from './test-pool.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-11-10T12:00:00Z');
const EDIT = "SELECT '' AS named";
const SQL = readFileSync(fileURLToPath(new URL('../queries/covenant-funnel.sql', import.meta.url)), 'utf8');

/** The file with its one edit made, the way an operator makes it. */
const forVersion = (version: string): string => {
  expect(SQL).toContain(EDIT);
  return SQL.replace(EDIT, `SELECT '${version}' AS named`);
};

const run = async (db: TestDb, sql: string): Promise<unknown> => (await db.prepare(sql).all()).results[0];

const installsOn = (db: TestDb, day: string, from: number, count: number): Promise<unknown> =>
  db
    .prepare(`WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO telemetry_install_days (day, install, account, batches, events, measures) SELECT ?, printf('install-%04d', i), '', 1, 1, '{}' FROM n`)
    .bind(from, from + count - 1, day)
    .run();

const accept = (db: TestDb, account: string, version: string, at: number): Promise<unknown> => db.prepare('INSERT INTO covenant_acceptances (account, version, accepted_at) VALUES (?, ?, ?)').bind(account, version, at).run();

const deposit = (db: TestDb, account: string, id: string, countedAt: number | null, tier = 'skeleton'): Promise<unknown> =>
  db.prepare("INSERT INTO deposits (account, id, skeleton, tier, counted_at) VALUES (?, ?, '{}', ?, ?)").bind(account, id, tier, countedAt).run();

const rowsOf = async (db: TestDb, sql: string): Promise<readonly unknown[]> => (await db.prepare(sql).all()).results;

describe('queries/covenant-funnel.sql', () => {
  let pool: TestPool;
  let db: TestDb;

  beforeAll(async () => {
    pool = await startPool({ COVENANT_VERSION: '' });
    db = await pool.db();
    await db.prepare("INSERT INTO covenant_served (version, first_served_at) VALUES ('v1', ?), ('v2', ?)").bind(START - 30 * DAY, START).run();
    // Installs: one first seen before the start (it comes back after, which does not make it new), then 312 first seen on or after it.
    await db.prepare("INSERT INTO telemetry_install_days (day, install, account, batches, events, measures) VALUES ('2026-11-08', 'veteran', '', 1, 1, '{}'), ('2026-11-12', 'veteran', '', 1, 1, '{}')").run();
    await installsOn(db, '2026-11-10', 1, 100);
    await installsOn(db, '2026-11-11', 101, 150);
    await installsOn(db, '2026-11-12', 251, 62);
    const accounts = ['stopped', 'day27', 'day28', 'tiered', 'older', 'seeded'];
    for (const id of accounts) await db.prepare('INSERT INTO accounts (id) VALUES (?)').bind(id).run();
    await db.prepare("UPDATE accounts SET source = 'input' WHERE id = 'seeded'").run();
    await accept(db, 'stopped', 'v2', START + DAY);
    await accept(db, 'day27', 'v2', START + 2 * DAY);
    await accept(db, 'day28', 'v2', START + 3 * DAY);
    await accept(db, 'tiered', 'v2', START + 4 * DAY);
    await accept(db, 'older', 'v1', START - 20 * DAY);
    await accept(db, 'seeded', 'v2', START + DAY);
    await deposit(db, 'stopped', 'd1', START + 2 * DAY);
    await deposit(db, 'day27', 'd1', START + 2 * DAY + 27 * DAY);
    await deposit(db, 'day28', 'd1', START + 3 * DAY + 28 * DAY);
    await deposit(db, 'tiered', 'd1', START + 4 * DAY + 40 * DAY, 'none');
    await deposit(db, 'tiered', 'd2', null);
    await deposit(db, 'older', 'd1', START + 40 * DAY);
    await deposit(db, 'seeded', 'd1', START + DAY + 30 * DAY);
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  it('documents a run that prints rows: a remote read goes through --command with --json, because a remote --file is an import that returns only totals', () => {
    const header = SQL.split(/\r?\n/)
      .filter((line) => line.startsWith('--'))
      .join(' ');
    expect(header).toContain('--remote --json --command="$(cat queries/covenant-funnel.sql)"');
    expect(header).not.toContain('--remote --file');
  });

  it('prints the three counts for the named version, and the total before the cap', async () => {
    expect(await run(db, forVersion('v2'))).toEqual({ version: 'v2', start_day: '2026-11-10', country: '(all)', installs: 300, installs_before_cap: 312, accepted: 4, depositing_4w: 1, raw_yes: 0, raw_yes_share: 0 });
  });

  it('counts a deposit 28 days after the account\'s own acceptance, and not one at 27 days', async () => {
    await db.prepare("INSERT INTO covenant_acceptances (account, version, accepted_at) SELECT id, 'v3', ? FROM accounts WHERE id IN ('day27', 'day28')").bind(START + 100 * DAY).run();
    await db.prepare("INSERT INTO covenant_served (version, first_served_at) VALUES ('v3', ?)").bind(START + 99 * DAY).run();
    await deposit(db, 'day27', 'late-27', START + 100 * DAY + 28 * DAY - 1);
    expect(await run(db, forVersion('v3'))).toMatchObject({ accepted: 2, depositing_4w: 0, installs: 0, installs_before_cap: 0 });
    await deposit(db, 'day28', 'late-28', START + 100 * DAY + 28 * DAY);
    expect(await run(db, forVersion('v3'))).toMatchObject({ accepted: 2, depositing_4w: 1 });
  });

  it('reads the version served most recently when the edit is left empty', async () => {
    expect(await run(db, SQL)).toMatchObject({ version: 'v3', accepted: 2 });
  });

  it('prints a row of nulls and zeros for a version the pool never served, and no verdict column', async () => {
    const row = await run(db, forVersion('v0'));
    expect(row).toEqual({ version: 'v0', start_day: null, country: '(all)', installs: 0, installs_before_cap: 0, accepted: 0, depositing_4w: 0, raw_yes: 0, raw_yes_share: null });
    expect((typeof row === 'object' && row !== null ? Object.keys(row) : [])).toEqual(['version', 'start_day', 'country', 'installs', 'installs_before_cap', 'accepted', 'depositing_4w', 'raw_yes', 'raw_yes_share']);
  });

  describe('by request country', () => {
    const takeIn = async (id: string, country: string | null, depositing: boolean, raw: boolean): Promise<void> => {
      await db.prepare('INSERT INTO accounts (id, raw_consent) VALUES (?, ?)').bind(id, raw ? START : null).run();
      await db.prepare("INSERT INTO covenant_acceptances (account, version, accepted_at, request_country) VALUES (?, 'v4', ?, ?)").bind(id, START, country).run();
      if (depositing) await deposit(db, id, 'd1', START + 28 * DAY);
    };

    beforeAll(async () => {
      // v4 is never served, so no install cohort: the country rows read acceptances only. IN has five accounts (shown), DE two and FR one (folded to other), and one has no country.
      await takeIn('in1', 'IN', true, true);
      await takeIn('in2', 'IN', true, true);
      await takeIn('in3', 'IN', true, false);
      await takeIn('in4', 'IN', false, false);
      await takeIn('in5', 'IN', false, false);
      await takeIn('de1', 'DE', true, true);
      await takeIn('de2', 'DE', false, false);
      await takeIn('fr1', 'FR', true, true);
      await takeIn('nu1', null, false, false);
    });

    it('the funnel splits by request country', async () => {
      const rows = await rowsOf(db, forVersion('v4'));
      expect(rows.map((row) => fieldOf(row, 'country'))).toEqual(['(all)', '(none)', 'IN', 'other']);
      const by = (country: string): unknown => rows.find((row) => fieldOf(row, 'country') === country);
      expect(by('(all)')).toMatchObject({ accepted: 9, depositing_4w: 5, raw_yes: 4, raw_yes_share: 0.444 });
      expect(by('IN')).toMatchObject({ accepted: 5, depositing_4w: 3, raw_yes: 2, raw_yes_share: 0.4, installs: null });
      expect(by('other')).toMatchObject({ accepted: 3, depositing_4w: 2, raw_yes: 2, raw_yes_share: 0.667 });
    });

    it('a null country gets its own row', async () => {
      const rows = await rowsOf(db, forVersion('v4'));
      expect(rows.find((row) => fieldOf(row, 'country') === '(none)')).toMatchObject({ accepted: 1, depositing_4w: 0, raw_yes: 0, raw_yes_share: 0 });
    });

    it('prints counts only: no account id on any row, and no country with fewer than five accounts', async () => {
      const text = JSON.stringify(await rowsOf(db, forVersion('v4')));
      expect(text).not.toMatch(/in[1-5]|de[12]|fr1|nu1/);
      expect(text).not.toContain('"DE"');
      expect(text).not.toContain('"FR"');
    });
  });
});
