// browser-confirm-fix: every row the Recent requests table shows has the right unit price and total (quantity times unit
// price), checked against the database for up to 100 rows, not only the 25 the page asks for. The table is what the run's own
// page script builds from the run's own server, so a fix in the query or in the page both count.
// Wrong neighbor: making the total right by changing the unit price column to the total, which leaves every quantity-1 row correct.
// It does not require a clean console: the summary error of browser-console-error is in every starting state and is that task's alone.
import { buildDb, check, expect, openDb, startServer } from './_shared.mjs';
import { centsOf, renderPage } from './_page.mjs';

/** The page's request for the list asks for 100 rows, whatever limit (or none) the script puts on it. */
const askForAHundred = (url) => {
  const asked = new URL(url, 'http://page.invalid');
  if (asked.pathname !== '/api/requests') return url;
  asked.searchParams.set('limit', '100');
  return `${asked.pathname}${asked.search}`;
};

await check('browser-confirm-fix', async (run) => {
  const db = buildDb(run);
  const lookup = openDb(db.path, true).prepare('SELECT r.quantity, i.unit_cents FROM requests r JOIN items i ON i.id = r.item_id WHERE r.id = ?');
  const base = await startServer(run, db.path);
  const page = await renderPage(run, base, askForAHundred);
  expect(page.rows.length === 100, `the table lists ${page.rows.length} rows, expected 100`);
  let multiples = 0;
  for (const cells of page.rows) {
    const row = lookup.get(Number(cells[0]));
    expect(row !== undefined, `request ${cells[0]} is not in the database`);
    expect(centsOf(cells[4]) === row.unit_cents, `request ${cells[0]} shows unit price ${cells[4]}, the item costs ${row.unit_cents} cents`);
    expect(centsOf(cells[5]) === row.quantity * row.unit_cents, `request ${cells[0]} shows total ${cells[5]}, quantity ${row.quantity} at ${row.unit_cents} cents is ${row.quantity * row.unit_cents}`);
    if (row.quantity !== 1) multiples += 1;
  }
  expect(multiples > 0, 'no row with a quantity other than 1 was checked');
  return `100 rows right, ${multiples} with a quantity other than 1`;
});
