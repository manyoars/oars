// docs-fetch-license: the README of marked 18.2.0 warns that marked does not sanitize its output and recommends DOMPurify
// ("DOMPurify (recommended), sanitize-html or insane"). DOMPurify is not installed (the app depends on marked alone), and its
// license is the SPDX expression (MPL-2.0 OR Apache-2.0) at every 3.x version (npm registry, the package's LICENSE file). So the
// package name comes from the installed README, and the license cannot be read from the run folder. Wrong neighbors: the answer to
// the old question (marked's own MIT and the BSD-3-Clause text in its LICENSE, readable in node_modules), MIT, or one half of the pair.
import { answer, check, expect } from './_shared.mjs';

const normal = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

await check('docs-fetch-license', async (run) => {
  const fields = new Map();
  for (const line of answer(run, 'answers/marked-license.txt').split('\n')) {
    const match = /^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (match) fields.set(match[1].toLowerCase(), match[2]);
  }
  for (const key of ['package', 'license']) expect(fields.has(key), `answers/marked-license.txt has no "${key}:" line`);
  expect(normal(fields.get('package')) === 'dompurify', `package is ${fields.get('package')}, not the sanitizer the README recommends`);
  const license = fields.get('license');
  const ids = license.split(/\s+(?:or|OR)\s+|\s*\/\s*/).map(normal).sort();
  expect(JSON.stringify(ids) === JSON.stringify(['apache20', 'mpl20']), `license is ${license}, not (MPL-2.0 OR Apache-2.0)`);
  return 'dompurify, MPL-2.0 OR Apache-2.0';
});
