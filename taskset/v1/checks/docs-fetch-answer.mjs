// docs-fetch-answer: marked 18.2.0's `breaks` option defaults to false, so a single line break stays a line break in the
// source and no <br> is made, and the option has existed since v0.2.7. Pinned fact: the options table of USING_ADVANCED.md at
// v18.2.0 ("breaks | boolean | false | v0.2.7"). The installed package shows the default (parse "a\nb": no <br>) but not the
// "since" column: lib/ and README.md hold no 0.2.7, so the answer needs the docs. Wrong neighbors: `breaks=true`, the common
// guess; `breaks=false` alone, which the installed package answers; another row's "since" (4.1.0 is `async`).
import { answer, check, expect } from './_shared.mjs';

await check('docs-fetch-answer', async (run) => {
  const lines = answer(run, 'answers/markdown-option.txt').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const since = lines.find((line) => /^since\s*=/i.test(line));
  const option = lines.find((line) => line !== since);
  const match = /^([A-Za-z]+)\s*=\s*(true|false)$/.exec(option ?? '');
  expect(match !== null, `answers/markdown-option.txt should hold a name=value line; it reads ${JSON.stringify(lines.join(' / ').slice(0, 80))}`);
  expect(match[1] === 'breaks', `the option that turns a line break into <br> is not ${match[1]}`);
  expect(match[2] === 'false', `breaks defaults to false, not ${match[2]}`);
  const version = /^since\s*=\s*v?(\d+\.\d+\.\d+)$/i.exec(since ?? '');
  expect(version !== null, 'answers/markdown-option.txt has no since=<version> line');
  expect(version[1] === '0.2.7', `breaks has existed since 0.2.7, not ${version[1]}`);
  return 'breaks=false, since 0.2.7';
});
