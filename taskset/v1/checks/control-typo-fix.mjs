// control-typo-fix: slugify keeps digits. Reads src/lib/text.ts and runs the tests that cover slugify.
import { check, expect, importFrom, runTests, testFilesMatching } from './_shared.mjs';

const CASES = [
  ['Spring Sale 2026', 'spring-sale-2026'],
  ['Room 101 chairs', 'room-101-chairs'],
  ['Q3 plan, v2', 'q3-plan-v2'],
  ['A4 copy paper (500 sheets)', 'a4-copy-paper-500-sheets'],
  ['7 days', '7-days'],
  ['Hello World', 'hello-world'],
  ['  Paper & Pens  ', 'paper-pens'],
  ['---', ''],
  ['', ''],
];

await check('control-typo-fix', async (run) => {
  const { slugify } = await importFrom(run, 'src/lib/text.ts');
  expect(typeof slugify === 'function', 'src/lib/text.ts no longer exports slugify');
  for (const [input, want] of CASES) {
    const got = slugify(input);
    expect(got === want, `slugify(${JSON.stringify(input)}) is ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  const files = testFilesMatching(run, /\bslugify\b/);
  expect(files.length > 0, 'no test covers slugify any more');
  const tests = runTests(run, files);
  expect(tests.status === 0, `the slugify tests fail: ${tests.tail}`);
  return `${CASES.length} inputs right, ${files.join(', ')} green`;
});
