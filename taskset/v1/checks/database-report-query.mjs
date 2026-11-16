// database-report-query: spendByTeam(db, month) in src/reports.ts. Compared with a reference query for every month of the
// seed and an empty one, then again after the check adds rows of its own, so a hard-coded answer fails.
import { buildDb, check, expect, importFrom, openDb } from './_shared.mjs';

const REFERENCE = `
  SELECT t.name AS team,
         COALESCE(SUM(CASE WHEN r.status IN ('approved', 'delivered') AND substr(r.created_at, 1, 7) = ?
                           THEN r.quantity * i.unit_cents END), 0) AS cents
  FROM teams t
  LEFT JOIN members m ON m.team_id = t.id
  LEFT JOIN requests r ON r.member_id = m.id
  LEFT JOIN items i ON i.id = r.item_id
  GROUP BY t.id
  ORDER BY cents DESC, team ASC`;

const MONTHS = ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];

const compare = (db, spendByTeam, label) => {
  for (const month of MONTHS) {
    const want = db.prepare(REFERENCE).all(month).map((row) => ({ team: row.team, cents: Number(row.cents) }));
    let got;
    try {
      got = spendByTeam(db, month);
    } catch (error) {
      expect(false, `spendByTeam(db, '${month}') throws ${error}`);
    }
    expect(Array.isArray(got), `spendByTeam(db, '${month}') does not return an array`);
    const shaped = got.map((row) => ({ team: row?.team, cents: typeof row?.cents === 'bigint' ? Number(row.cents) : row?.cents }));
    const same = JSON.stringify(shaped) === JSON.stringify(want);
    expect(same, `${label}: spendByTeam(db, '${month}') is ${JSON.stringify(shaped)}, want ${JSON.stringify(want)}`);
  }
};

await check('database-report-query', async (run) => {
  const { spendByTeam } = await importFrom(run, 'src/reports.ts');
  expect(typeof spendByTeam === 'function', 'src/reports.ts does not export spendByTeam');
  const db = openDb(buildDb(run).path);
  compare(db, spendByTeam, 'seed');
  const add = db.prepare('INSERT INTO requests (member_id, item_id, quantity, status, created_at) VALUES (?, ?, ?, ?, ?)');
  add.run(5, 25, 7, 'approved', '2026-02-14T10:00:00Z');
  add.run(5, 25, 9, 'pending', '2026-02-15T10:00:00Z');
  add.run(10, 21, 3, 'delivered', '2026-07-02T10:00:00Z');
  add.run(22, 2, 2, 'rejected', '2026-07-03T10:00:00Z');
  compare(db, spendByTeam, 'after new rows');
  return `${MONTHS.length} months right, before and after new rows`;
});
