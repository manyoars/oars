// docs-fetch-api-change: marked 13.0.0 changed renderer functions to take one token object ({ href, title, tokens }) instead
// of positional arguments; the old renderer was removed in 14.0.0. At the pinned 18.2.0 the old `link(href, title, text)` gets
// the token as `href`, so the page shows href="[object Object]" and the text "undefined". Reads the FAQ page the run's server
// serves, and calls the run's own `renderDoc` (src/docs.ts) on a probe, so a page fixed by editing docs/ with the renderer left
// broken fails. Wrong neighbors: dropping the link renderer (the text shows, `ordering.md` stays the address), and the same plus
// an edited FAQ.
import { buildDb, check, expect, importFrom, startServer } from './_shared.mjs';

const EXPECTED = [
  { text: 'How ordering works', href: '/docs/ordering' },
  { text: 'the item list', href: '/api/items' },
];

await check('docs-fetch-api-change', async (run) => {
  const docs = await importFrom(run, 'src/docs.ts');
  expect(typeof docs.renderDoc === 'function', 'src/docs.ts no longer exports renderDoc');
  const probe = docs.renderDoc('[the order guide](returns-policy.md) and [outside](https://example.com/a "Title")');
  expect(!/\[object Object\]|undefined/.test(probe), `renderDoc still renders a link as [object Object] or undefined: ${probe.trim().slice(0, 120)}`);
  expect(probe.includes('<a href="/docs/returns-policy">the order guide</a>'), `renderDoc does not send a link to returns-policy.md to /docs/returns-policy: ${probe.trim().slice(0, 120)}`);
  expect(probe.includes('<a href="https://example.com/a" title="Title">outside</a>'), `renderDoc changed another link's address or text: ${probe.trim().slice(0, 120)}`);
  const base = await startServer(run, buildDb(run).path);
  const res = await fetch(`${base}/docs/faq`);
  expect(res.ok, `/docs/faq answers ${res.status}`);
  const html = await res.text();
  expect(!/\[object Object\]|undefined/.test(html), 'the FAQ page still shows [object Object] or undefined');
  const links = [...html.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((match) => ({ text: match[2], href: match[1] }));
  for (const want of EXPECTED) {
    const found = links.find((link) => link.text === want.text);
    expect(found !== undefined, `no link with the text "${want.text}" on the FAQ page`);
    expect(found.href === want.href, `the "${want.text}" link goes to ${found.href}, not ${want.href}`);
    const opened = await fetch(`${base}${found.href}`);
    expect(opened.ok, `${found.href} answers ${opened.status}`);
  }
  return 'renderDoc and both FAQ links show their text and open';
});
