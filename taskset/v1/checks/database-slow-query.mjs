// database-slow-query: one member's requests are found without reading the whole requests table. Reads the query the app
// runs (REQUESTS_FOR_MEMBER_SQL in src/queries.ts), asks SQLite for its plan on a database built by the run's own build
// script, and checks requestsForMember still returns exactly what the starting query returns, for every member.
import { buildDb, check, expect, importFrom, openDb, sameRows } from './_shared.mjs';

const STARTING_SQL = `
  SELECT r.id, m.handle AS member, i.name AS item, r.quantity, i.unit_cents, r.quantity * i.unit_cents AS total_cents,
         r.status, r.note, r.created_at
  FROM requests r
  JOIN members m ON m.id = r.member_id
  JOIN items i ON i.id = r.item_id
  WHERE m.handle = ?
  ORDER BY r.created_at DESC, r.id DESC`;

const KEYWORDS = new Set(['join', 'where', 'on', 'inner', 'left', 'cross', 'natural', 'order', 'group', 'indexed', 'not']);

/** The name the query gives the requests table in its plan: its alias after FROM or JOIN, or `requests`. */
const requestsAlias = (sql) => {
  // The alias may be quoted ("r", `r`, [r]); SQLite's plan prints it without the quotes.
  const match = /\b(?:from|join)\s+["`[]?requests["`\]]?(?:\s+(?:as\s+)?["`[]?(\w+)["`\]]?)?/i.exec(sql);
  const alias = match?.[1];
  return alias && !KEYWORDS.has(alias.toLowerCase()) ? alias : 'requests';
};

await check('database-slow-query', async (run) => {
  const queries = await importFrom(run, 'src/queries.ts');
  expect(typeof queries.REQUESTS_FOR_MEMBER_SQL === 'string', 'src/queries.ts no longer exports REQUESTS_FOR_MEMBER_SQL');
  expect(typeof queries.requestsForMember === 'function', 'src/queries.ts no longer exports requestsForMember');
  const db = openDb(buildDb(run).path);
  const sql = queries.REQUESTS_FOR_MEMBER_SQL;
  const alias = requestsAlias(sql);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('teal-otter').map((row) => row.detail);
  const scan = plan.find((detail) => new RegExp(`^SCAN (${alias}|requests)\\b`).test(detail));
  expect(scan === undefined, `the plan still reads the whole requests table: ${plan.join(' | ')}`);
  const handles = db.prepare('SELECT handle FROM members ORDER BY id').all().map((row) => row.handle);
  for (const handle of [...handles, 'no-such-member']) {
    const want = db.prepare(STARTING_SQL).all(handle);
    const got = queries.requestsForMember(db, handle);
    expect(sameRows(got, want), `requestsForMember(${handle}) returns different rows than before`);
  }
  return plan.join(' | ');
});
