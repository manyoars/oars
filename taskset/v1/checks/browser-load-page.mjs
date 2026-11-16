// browser-load-page: the main heading as the page shows it (set by the page script from the open count, not the static
// <h1> in index.html) and the number of rows in the Recent requests table. Both come from the run's own page script and
// server on a database built from the run's seed. Wrong neighbor: "Supply Desk", the heading in the HTML file alone.
// It does not require a clean console: the summary error of browser-console-error is in every starting state and is that task's alone.
import { answer, buildDb, check, expect, startServer } from './_shared.mjs';
import { renderPage } from './_page.mjs';

await check('browser-load-page', async (run) => {
  const base = await startServer(run, buildDb(run).path);
  const page = await renderPage(run, base);
  expect(/open requests$/.test(page.heading) && page.rows.length > 0, 'the page did not load its heading and table');

  const lines = answer(run, 'answers/page.txt').split(/\r?\n/).map((line) => line.trim());
  expect(lines[0] === page.heading, `line 1 is ${JSON.stringify(lines[0])}, the page shows ${JSON.stringify(page.heading)}`);
  expect(lines[1] === String(page.rows.length), `line 2 is ${JSON.stringify(lines[1])}, the table lists ${page.rows.length} requests`);
  return `${page.heading}, ${page.rows.length} rows`;
});
