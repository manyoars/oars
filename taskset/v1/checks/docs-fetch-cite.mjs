// docs-fetch-cite: a comment directly above the `new Marked` call in src/docs.ts cites the marked documentation page for custom
// renderers, https://marked.js.org/using_pro#renderer (the prompt asks for "the section's URL": the #renderer anchor is required,
// a bare using_pro link fails; the installed README holds only the bare link, so the anchor comes from the docs page), the page
// the 13.0.0 release notes point renderer authors to. A comment may be // lines or a /* ... */ block.
// Pinned fact: that page and anchor exist at the docs site for 18.x (marked.js.org shows the latest release, so it can drift from
// 18.2.0). The same page's source, docs/USING_PRO.md on github.com/markedjs/marked, counts. Besides it the comment may cite one
// other marked.js.org page. Wrong neighbors: the options page (using_advanced) alone, and the URL in a comment somewhere else.
import { check, expect, readText } from './_shared.mjs';

const PRO = /^https:\/\/marked\.js\.org\/using_pro\/?#renderer$|^https:\/\/github\.com\/markedjs\/marked\/blob\/[\w.-]+\/docs\/USING_PRO\.md#renderer$/;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)|\*\/\s*$/;

await check('docs-fetch-cite', async (run) => {
  const text = readText(run, 'src/docs.ts');
  expect(text !== null, 'src/docs.ts is missing');
  const lines = text.split('\n');
  const call = lines.findIndex((line) => line.includes('new Marked('));
  expect(call >= 0, 'src/docs.ts has no new Marked call');
  // The comment block directly above the call's line (blank lines between its lines are fine).
  // Inside a /* ... */ block every line counts, whether or not it starts with a *.
  let first = call;
  let inBlock = false;
  const kept = [];
  while (first > 0) {
    const line = lines[first - 1];
    if (inBlock) {
      kept.push(line);
      if (line.includes('/*')) inBlock = false;
    } else if (/\*\/\s*$/.test(line)) {
      kept.push(line);
      inBlock = !line.includes('/*');
    } else if (COMMENT_LINE.test(line)) {
      kept.push(line);
    } else if (line.trim() !== '') {
      break;
    }
    first--;
  }
  const above = kept.join('\n');
  const urls = [...above.matchAll(/https?:\/\/[^\s)>\]"'`]+/g)].map((match) => match[0].replace(/[.,;:]+$/, ''));
  expect(urls.length > 0, 'no URL in a comment directly above the new Marked call');
  const pro = urls.find((url) => PRO.test(url));
  expect(pro !== undefined, `none of ${urls.join(', ')} is the page about custom renderers (https://marked.js.org/using_pro#renderer)`);
  const others = urls.filter((url) => url !== pro && /^https?:\/\/marked\.js\.org/.test(url));
  expect(others.length <= 1, `the comment cites ${others.length} other marked.js.org pages; at most one more is fine`);
  return pro;
});
