// docs-fetch-version-bug: marked 15.0.0 moved HTML escaping from the tokenizers into the renderers ("escape html in renderers"),
// so a `codespan` override gets raw text at the pinned 18.2.0 and must escape it itself; the starting override does not, so the
// inline code <form id="request-form"> is a real form element. Reads the Getting started page the run's server serves, and calls
// the run's own `renderDoc` (src/docs.ts) on a probe, so a page fixed by editing docs/ with the renderer left broken fails.
// Entities are decoded by name and by number (&#34; and &quot; are the same quote). Wrong neighbors: deleting the override (the
// text shows, the `inline` class is lost) and writing the escaped text into the page.
import { buildDb, check, expect, importFrom, startServer } from './_shared.mjs';

const NAMED = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
const decode = (text) =>
  text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-z]+));/g, (whole, decimal, hex, name) => {
    if (decimal !== undefined) return String.fromCodePoint(Number(decimal));
    if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
    return NAMED[name] ?? whole;
  });
const spansOf = (html) => [...html.matchAll(/<code class="inline">(.*?)<\/code>/g)].map((match) => decode(match[1]));

await check('docs-fetch-version-bug', async (run) => {
  const docs = await importFrom(run, 'src/docs.ts');
  expect(typeof docs.renderDoc === 'function', 'src/docs.ts no longer exports renderDoc');
  const probe = docs.renderDoc('Use `<b class="x">&</b>` here.');
  expect(!probe.includes('<b'), `renderDoc puts the inline code in the page as markup: ${probe.trim().slice(0, 120)}`);
  expect(spansOf(probe).includes('<b class="x">&</b>'), `renderDoc does not show inline code as text with its inline class: ${probe.trim().slice(0, 120)}`);
  const base = await startServer(run, buildDb(run).path);
  const res = await fetch(`${base}/docs/getting-started`);
  expect(res.ok, `/docs/getting-started answers ${res.status}`);
  const html = await res.text();
  expect(!html.includes('<form'), 'the page still holds a real <form> element: the inline code is not escaped');
  expect(!html.includes('<code>'), 'an inline code span lost its inline class');
  const spans = spansOf(html);
  for (const want of ['<form id="request-form">', 'POST /api/requests']) {
    expect(spans.includes(want), `no inline code span shows ${want} as text (spans: ${JSON.stringify(spans)})`);
  }
  return 'inline code shows as text with its class';
});
