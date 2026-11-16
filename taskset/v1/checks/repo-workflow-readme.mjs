// repo-workflow-readme: the app serves a CSV export at GET /api/requests.csv, narrowed by one query parameter, `status`, which takes
// pending, approved, rejected, or delivered; the README does not say so. The README must name the path exactly, name the parameter
// (`status=`, or `status` in code quotes or bold), cite no other .csv path under /api, and give no value for it that the app does
// not take. It reads the README only; no prose is graded. Wrong neighbors: a README that documents an invented path and parameter
// (/api/export.csv?state=); the right path with invented values (`status=open`, "takes `open` or `closed`").
import { check, expect, readText } from './_shared.mjs';

const STATUSES = ['pending', 'approved', 'rejected', 'delivered'];
const INVENTED = /[`*"'](open|closed|active|done|completed|cancelled|canceled|shipped|paid|resolved|fulfilled|archived)[`*"']/i;

await check('repo-workflow-readme', async (run) => {
  const text = readText(run, 'README.md');
  expect(text !== null, 'README.md is gone');
  expect(text.includes('/api/requests.csv'), 'README.md does not mention /api/requests.csv');
  const others = [...text.matchAll(/\/api\/[\w/.-]*\.csv/g)].map((match) => match[0]).filter((path) => path !== '/api/requests.csv');
  expect(others.length === 0, `README.md also names ${others.join(', ')}, which the app does not serve`);
  expect(/\bstatus\s*=|[`*]status[`*]/.test(text), 'README.md does not name the status parameter');
  // A placeholder (STATUS, <status>, {status}) after status= stands for any of the values and is skipped.
  const values = [...text.matchAll(/\bstatus\s*=\s*([\w-]+)/g)].map((match) => match[1]).filter((value) => !/^[A-Z_]+$/.test(value));
  const bad = values.filter((value) => !STATUSES.includes(value));
  expect(bad.length === 0, `README.md gives status the value ${bad.join(', ')}; the app takes ${STATUSES.join(', ')}`);
  const invented = INVENTED.exec(text);
  expect(invented === null, `README.md lists ${invented?.[1]} as a status; the app takes ${STATUSES.join(', ')}`);
  expect(text.includes('npm ci') && text.includes('npm test'), 'README.md lost its setup commands');
  return 'names /api/requests.csv and its status parameter';
});
