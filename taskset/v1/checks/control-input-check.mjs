// control-input-check: pageSize rejects a bad limit with a RangeError, and a test proves it. Every test file must pass on
// the run's code, and at least one must fail when only the body of pageSize is swapped for the starting one (in a copy of the
// run, so its other exports and every test file, in test/lib.test.ts or test/api.test.ts or anywhere else, still load), so a
// happy-path-only test does not count and a test of some other helper does not either.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, expect, importFrom, runTests, tempFolder, testFilesMatching } from './_shared.mjs';

// The starting suite has one red file that belongs to another task (money.test.ts, formatCents), so it cannot be required green here.
const STARTING_RED = new Set(['test/money.test.ts']);
const STARTING_BODY = `(raw: string | null): number => (raw === null ? 25 : Number(raw));`;

const GOOD = [
  [null, 25],
  ['1', 1],
  ['25', 25],
  ['100', 100],
];
const BAD = ['0', '-5', '101', '2.5', 'abc', ''];

await check('control-input-check', async (run) => {
  const { pageSize } = await importFrom(run, 'src/lib/pagination.ts');
  expect(typeof pageSize === 'function', 'src/lib/pagination.ts no longer exports pageSize');
  for (const [raw, want] of GOOD) {
    let got;
    try {
      got = pageSize(raw);
    } catch (error) {
      expect(false, `pageSize(${JSON.stringify(raw)}) throws ${error}, want ${want}`);
    }
    expect(got === want, `pageSize(${JSON.stringify(raw)}) is ${got}, want ${want}`);
  }
  for (const raw of BAD) {
    let thrown = null;
    try {
      pageSize(raw);
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof RangeError, `pageSize(${JSON.stringify(raw)}) does not throw a RangeError`);
  }
  const files = testFilesMatching(run, /./).filter((file) => !STARTING_RED.has(file));
  expect(files.length > 0, 'there is no test file under test/ besides the starting red one');
  const now = runTests(run, files);
  expect(now.status === 0, `the tests fail: ${now.tail}`);
  const copy = join(tempFolder('old-pagesize'), 'repo');
  cpSync(run, copy, { recursive: true, filter: (source) => !/[\/](\.git|data|answers)$/.test(source) });
  const file = join(copy, 'src', 'lib', 'pagination.ts');
  const source = readFileSync(file, 'utf8');
  // The run's own pageSize is renamed out of the way and the starting body takes its name, so the file's other exports stay.
  const declaration = /export\s+(const|function)\s+pageSize\b/;
  expect(declaration.test(source), 'src/lib/pagination.ts no longer declares pageSize as "export const pageSize" or "export function pageSize"');
  writeFileSync(file, `${source.replace(declaration, '$1 pageSizeAnswered')}\nexport const pageSize = ${STARTING_BODY}\n`);
  const before = runTests(copy, files);
  expect(before.status !== 0, `no test fails on the starting pageSize, so no test checks the input (${files.join(', ')})`);
  return `${BAD.length} bad limits rejected; ${files.length} test files green now, and red with the starting pageSize body`;
});
