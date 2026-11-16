// database-count: the number of Facilities requests from January to March 2026 that were approved or delivered.
// The answer is fixed by the v1 seed (wrong neighbors: 15 counts every status, 27 the whole half year, 4 approved only).
import { answer, check, expect } from './_shared.mjs';

const EXPECTED = '12';

await check('database-count', async (run) => {
  const text = answer(run, 'answers/facilities-q1.txt');
  expect(/^\d+$/.test(text), `answers/facilities-q1.txt holds ${JSON.stringify(text)}, not digits only`);
  expect(text === EXPECTED, `answered ${text}, which is not the count`);
  return `answered ${text}`;
});
