// browser-broken-link: every link on the page (the anchors in index.html and the footer links the page script builds)
// opens on the run's own server, the Returns policy link points at the Returns policy doc, and the other footer links
// still point where they did. Wrong neighbor: adding a docs/returns-polcy.md file, which makes the typo'd link open a page
// but leaves the link pointing at a misspelled address.
// It does not require a clean console: the summary error of browser-console-error is in every starting state and is that task's alone.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDb, check, expect, startServer } from './_shared.mjs';
import { renderPage } from './_page.mjs';

const EXPECTED_FOOTER = [
  { text: 'Getting started', href: '/docs/getting-started' },
  { text: 'How ordering works', href: '/docs/ordering' },
  { text: 'Returns policy', href: '/docs/returns-policy' },
  { text: 'FAQ', href: '/docs/faq' },
];

await check('browser-broken-link', async (run) => {
  const base = await startServer(run, buildDb(run).path);
  const page = await renderPage(run, base);
  expect(JSON.stringify(page.footer) === JSON.stringify(EXPECTED_FOOTER), `the footer links are ${JSON.stringify(page.footer)}, expected ${JSON.stringify(EXPECTED_FOOTER)}`);

  const html = readFileSync(join(run, 'public', 'index.html'), 'utf8');
  const hrefs = [...html.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((match) => match[1]);
  const links = [...new Set([...hrefs, ...page.footer.map((link) => link.href)])];
  for (const href of links) {
    if (!href.startsWith('/')) continue;
    const res = await fetch(`${base}${href}`);
    expect(res.ok, `${href} answers ${res.status}`);
  }
  return `${links.length} links open`;
});
