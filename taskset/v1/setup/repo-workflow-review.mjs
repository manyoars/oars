// Setup for repo-workflow-review, run after the reset with the run folder as its argument. Leaves an uncommitted change in
// the working tree: a request search by note text, with a route. The planted defect is the text interpolated into the SQL
// of searchRequests in src/queries.ts. Records a hash of the tracked files (paths and contents on disk) in .git/v1-review-files so
// the check can tell the agent changed nothing; contents, not `git diff` output, so staging and git settings cannot change it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const run = process.argv[2];
if (!run) throw new Error('usage: node setup/repo-workflow-review.mjs <run folder>');
const git = (...args) => execFileSync('git', args, { cwd: run, encoding: 'utf8' });

const swap = (file, from, to) => {
  const path = join(run, file);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) throw new Error(`${file} lacks ${from}`);
  writeFileSync(path, text.replace(from, () => to));
};

git('config', 'user.name', 'Many Oars Run');
git('config', 'user.email', 'run@example.invalid');

appendFileSync(
  join(run, 'src', 'queries.ts'),
  [
    '',
    '/** Requests whose note holds the text, newest first. */',
    'export const searchRequests = (db: DatabaseSync, text: string): RequestRow[] =>',
    '  db',
    '    .prepare(',
    '      `SELECT r.id, m.handle AS member, i.name AS item, r.quantity, i.unit_cents, r.quantity * i.unit_cents AS total_cents,',
    '              r.status, r.note, r.created_at',
    '       FROM requests r',
    '       JOIN members m ON m.id = r.member_id',
    '       JOIN items i ON i.id = r.item_id',
    "       WHERE r.note LIKE '%${text}%'",
    '       ORDER BY r.created_at DESC, r.id DESC',
    '       LIMIT 50`,',
    '    )',
    '    .all() as unknown as RequestRow[];',
    '',
  ].join('\n'),
);
swap('src/app.ts', 'recentRequests, requestsForMember, statusSummary }', 'recentRequests, requestsForMember, searchRequests, statusSummary }');
swap(
  'src/app.ts',
  "  if (path === '/api/requests') {",
  "  if (path === '/api/requests/search') return json(res, 200, searchRequests(db, url.searchParams.get('q') ?? ''));\n  if (path === '/api/requests') {",
);

// The same hash as checks/repo-workflow-review.mjs computes.
const hash = createHash('sha256');
for (const file of git('ls-files', '-z').split('\0').filter(Boolean).sort()) {
  hash.update(`${file}\0`);
  const path = join(run, file);
  hash.update(existsSync(path) ? readFileSync(path) : 'missing');
  hash.update('\0');
}
writeFileSync(join(run, '.git', 'v1-review-files'), `${hash.digest('hex')}\n`);
