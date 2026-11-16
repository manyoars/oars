// database-bad-row: the request whose quantity is below 1 (request 137, quantity -6). Request 88, the one with a missing
// member, is a different defect and is a wrong answer here.
import { answer, check, expect } from './_shared.mjs';

const EXPECTED = '137';

await check('database-bad-row', async (run) => {
  const text = answer(run, 'answers/bad-row.txt');
  expect(/^\d+$/.test(text), `answers/bad-row.txt holds ${JSON.stringify(text)}, not digits only`);
  expect(text === EXPECTED, `answered request ${text}, which is not the bad row`);
  return `answered ${text}`;
});
