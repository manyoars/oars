// database-broken-fk: request 88 points at member 31, who does not exist; it was amber-fox's. The build must report no
// foreign key violation, request 88 must belong to amber-fox with its other fields unchanged, and no request or member may
// be added or removed (a placeholder member 31 is a wrong answer).
import { buildDb, check, expect, openDb } from './_shared.mjs';

await check('database-broken-fk', async (run) => {
  const built = buildDb(run);
  expect(!/foreign key violation/i.test(built.output), `the build still warns: ${built.output.trim()}`);
  const db = openDb(built.path);
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  expect(violations.length === 0, `${violations.length} foreign key violations remain`);
  const { requests } = db.prepare('SELECT count(*) AS requests FROM requests').get();
  expect(requests === 240, `there are ${requests} requests, not 240`);
  const { members } = db.prepare('SELECT count(*) AS members FROM members').get();
  expect(members === 24, `there are ${members} members, not 24`);
  const sql = 'SELECT m.handle, r.item_id, r.quantity, r.status, r.created_at FROM requests r LEFT JOIN members m ON m.id = r.member_id WHERE r.id = 88';
  const row = db.prepare(sql).get();
  expect(row !== undefined, 'request 88 is gone');
  expect(row.handle === 'amber-fox', `request 88 belongs to ${row.handle ?? 'nobody'}, not amber-fox`);
  const same = row.item_id === 1 && row.quantity === 3 && row.status === 'delivered' && row.created_at === '2026-03-17T21:26:00Z';
  expect(same, `request 88's other fields changed: ${JSON.stringify({ ...row })}`);
  return 'request 88 is amber-fox, no violations';
});
