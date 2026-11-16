// browser-fill-form: the New request form was really submitted. The run's own database (data/app.db) must hold
// exactly one request with the note "for the onboarding kits", for member teal-otter, the 12 pack of yellow 3x3 sticky
// notes, quantity 4, status pending (what the form saves), and the request number in answers/new-request.txt must be that row's id. Wrong neighbor: the right
// number written to the answer file without submitting the form (no row), the form submitted twice (two rows), or a row
// written straight into the database (not pending).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { answer, check, expect, openDb } from './_shared.mjs';

await check('browser-fill-form', async (run) => {
  const path = join(run, 'data', 'app.db');
  expect(existsSync(path), `no database at ${path}: the app was never started on it`);
  const db = openDb(path, true);
  const rows = db
    .prepare(
      `SELECT r.id, m.handle AS member, i.name AS item, r.quantity, r.status, r.note
       FROM requests r JOIN members m ON m.id = r.member_id JOIN items i ON i.id = r.item_id
       WHERE r.note = ?`,
    )
    .all('for the onboarding kits');
  expect(rows.length > 0, 'no request with the note "for the onboarding kits" was saved');
  expect(rows.length === 1, `${rows.length} requests were saved with that note, expected one`);
  const [row] = rows;
  expect(row.member === 'teal-otter', `the request is for ${row.member}, not teal-otter`);
  expect(row.item === 'Sticky notes, 3x3, yellow (12 pack)', `the request is for ${row.item}`);
  expect(row.quantity === 4, `the request has quantity ${row.quantity}, not 4`);
  expect(row.status === 'pending', `the request is "${row.status}", not pending: the form saves a pending request`);

  const text = answer(run, 'answers/new-request.txt');
  expect(/^\d+$/.test(text), `answers/new-request.txt holds ${JSON.stringify(text)}, not digits only`);
  expect(Number(text) === row.id, `answered ${text}, the saved request is #${row.id}`);
  return `request #${row.id}`;
});
