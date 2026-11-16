// repo-workflow-add-test: src/lib/csv.ts has no test. A test file that mentions csvField, toCsv, or lib/csv must pass on the
// run's code and fail on each of three mutants of the starting csv.ts (checks/_original/csv.ts): a comma is not quoted, a
// double quote is not doubled, a line break is not quoted. Wrong neighbor: a test that only checks plain fields and the header.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, expect, runTests, tempFolder, testFilesMatching } from './_shared.mjs';

const ORIGINAL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '_original', 'csv.ts'), 'utf8');
const MUTANTS = [
  { name: 'comma not quoted', from: '/[",\\r\\n]/', to: '/["\\r\\n]/' },
  { name: 'double quote not doubled', from: "text.replace(/\"/g, '\"\"')", to: 'text' },
  { name: 'line break not quoted', from: '/[",\\r\\n]/', to: '/[",]/' },
];

await check('repo-workflow-add-test', async (run) => {
  const files = testFilesMatching(run, /\bcsvField\b|\btoCsv\b|lib\/csv/);
  expect(files.length > 0, 'no test file mentions csvField, toCsv, or lib/csv');
  const now = runTests(run, files);
  expect(now.status === 0, `the csv tests fail on the run's code: ${now.tail}`);
  const copy = join(tempFolder('csv-mutants'), 'repo');
  cpSync(run, copy, { recursive: true, filter: (source) => !/[\/](\.git|data|answers)$/.test(source) });
  for (const mutant of MUTANTS) {
    expect(ORIGINAL.includes(mutant.from), `internal: the starting csv.ts lacks ${mutant.from}`);
    writeFileSync(join(copy, 'src', 'lib', 'csv.ts'), ORIGINAL.replace(mutant.from, () => mutant.to));
    expect(runTests(copy, files).status !== 0, `no test fails when ${mutant.name} (${files.join(', ')})`);
  }
  return `${files.join(', ')} green now and red on ${MUTANTS.length} mutants`;
});
