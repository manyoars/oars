// database-add-column: requests.priority, added by a new file in migrations/ (not by editing seed.sql or migration 001):
// TEXT NOT NULL DEFAULT 'normal', limited to low, normal, and high. Builds the run's database with its own build script.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildDb, check, expect, openDb, readText } from './_shared.mjs';

const MIGRATION_001 = `-- Marks items the supplier no longer carries; the order form hides them.
ALTER TABLE items ADD COLUMN discontinued INTEGER NOT NULL DEFAULT 0;
UPDATE items SET discontinued = 1 WHERE sku IN ('FIL-BOX', 'PCL-HB-24');
`;

const tryRun = (db, sql, ...params) => {
  try {
    db.prepare(sql).run(...params);
    return null;
  } catch (error) {
    return error;
  }
};

await check('database-add-column', async (run) => {
  expect(!/priority/i.test(readText(run, 'seed.sql') ?? ''), 'seed.sql was changed to hold the column; the task asks for a migration');
  const first = (readText(run, 'migrations/001-item-discontinued.sql') ?? '').replace(/\r\n/g, '\n');
  expect(first === MIGRATION_001, 'migrations/001-item-discontinued.sql was changed or removed');
  const added = readdirSync(join(run, 'migrations')).filter((name) => name.endsWith('.sql') && name !== '001-item-discontinued.sql');
  expect(added.some((name) => /priority/i.test(readText(run, `migrations/${name}`))), 'no new migration in migrations/ adds priority');
  const db = openDb(buildDb(run).path);
  const column = db.prepare('PRAGMA table_info(requests)').all().find((row) => row.name === 'priority');
  expect(column !== undefined, 'requests has no priority column after the build');
  expect(/^text$/i.test(column.type), `priority is ${column.type || 'untyped'}, not TEXT`);
  expect(column.notnull === 1, 'priority allows NULL');
  // SQLite keeps the default as written: 'normal', "normal", or either in parentheses are all the same default.
  expect(/^\(*\s*['"]normal['"]\s*\)*$/i.test(String(column.dflt_value)), `priority defaults to ${column.dflt_value}, not 'normal'`);
  const { odd } = db.prepare("SELECT count(*) AS odd FROM requests WHERE priority IS NOT 'normal'").get();
  expect(odd === 0, `${odd} existing requests are not normal priority`);
  const insert = "INSERT INTO requests (member_id, item_id, quantity, status, created_at, priority) VALUES (1, 1, 1, 'pending', '2026-07-01T09:00:00Z', ?)";
  for (const value of ['low', 'normal', 'high']) expect(tryRun(db, insert, value) === null, `a ${value} priority request is refused`);
  for (const value of ['urgent', 'HIGH', '']) expect(tryRun(db, insert, value) !== null, `a request with priority ${JSON.stringify(value)} is accepted`);
  expect(tryRun(db, insert, null) !== null, 'a request with a NULL priority is accepted');
  const plain = db.prepare("INSERT INTO requests (member_id, item_id, quantity, status, created_at) VALUES (1, 1, 1, 'pending', '2026-07-01T09:00:00Z')").run();
  const { priority } = db.prepare('SELECT priority FROM requests WHERE id = ?').get(plain.lastInsertRowid);
  expect(priority === 'normal', `a request saved without a priority gets ${priority}`);
  return `migration ${added.join(', ')}`;
});
