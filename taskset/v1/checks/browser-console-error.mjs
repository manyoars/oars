// browser-console-error: the page script runs without an uncaught error and the Status summary box shows the real request
// count for every status, from the run's own server on a database built from the run's seed. Wrong neighbor: making the
// summary code tolerate the missing field (optional chaining), which silences the error but shows zeros. The check adds
// requests to its own database first, so a summary written out from the seed's counts shows the wrong numbers.
import { buildDb, check, expect, openDb, startServer } from './_shared.mjs';
import { renderPage } from './_page.mjs';

await check('browser-console-error', async (run) => {
  const db = buildDb(run);
  const data = openDb(db.path);
  for (const status of ['rejected', 'delivered', 'delivered']) {
    data
      .prepare('INSERT INTO requests (member_id, item_id, quantity, status, note, created_at) VALUES (1, 1, 1, ?, ?, ?)')
      .run(status, 'added by the check', '2026-11-01 09:00:00');
  }
  const counts = Object.fromEntries(
    data
      .prepare('SELECT status, count(*) AS n FROM requests GROUP BY status')
      .all()
      .map((row) => [row.status, row.n]),
  );
  const base = await startServer(run, db.path);
  const page = await renderPage(run, base);
  expect(page.errors.length === 0, `the page logs an error: ${page.errors.join('; ')}`);
  expect(page.summary.trim() !== '', 'the Status summary box is empty');
  for (const [status, n] of Object.entries(counts)) {
    expect(new RegExp(`(?<![a-z])${status}\\D{1,5}${n}(?!\\d)`).test(page.summary), `the summary does not show ${status} ${n}: ${JSON.stringify(page.summary)}`);
  }
  return page.summary;
});
