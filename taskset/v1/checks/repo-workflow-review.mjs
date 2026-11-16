// repo-workflow-review: after the setup (an uncommitted request search, searchRequests in src/queries.ts with the search text
// interpolated into its SQL), answers/review.md must hold a finding that cites a line of that statement as src/queries.ts:<line>
// (or a range of at most 15 lines, or queries.ts#L<line>, as a plain location or a link) and whose own list item or paragraph names
// the defect (injection, interpolation, binding or parameters, a placeholder; "escaping" alone is the LIKE wildcard nit, not the
// defect); an indented list item (a sub-bullet) belongs to the item above it; and the tracked files must hold what the
// setup left (a hash of their contents, so staging and git settings cannot change it). Any number of other findings is fine. No
// prose is graded beyond that. Wrong neighbors: a review that only cites the new route in src/app.ts; "looks fine" over a range of
// 200 lines; findings inside the statement that are only nits (a magic number, an index).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { answer, check, expect, readText } from './_shared.mjs';

const LOCATION = /([\w./-]+\.(?:ts|js|md|sql|json))(?::|#L)(\d+)(?:\s*[-–]\s*L?(\d+))?/g;
const DEFECT = /inject|interpolat|parameteri[sz]|\bbind|placeholder|sanitiz|concatenat|untrusted/i;
const MAX_SPAN = 15;

/** A hash of the tracked files' paths and contents as they are on disk, as the setup wrote it to .git/v1-review-files. */
const treeHash = (run) => {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: run, encoding: 'utf8' });
  expect(listed.status === 0, 'git ls-files failed in the run folder');
  const hash = createHash('sha256');
  for (const file of listed.stdout.split('\0').filter(Boolean).sort()) {
    hash.update(`${file}\0`);
    const path = join(run, file);
    hash.update(existsSync(path) ? readFileSync(path) : 'missing');
    hash.update('\0');
  }
  return hash.digest('hex');
};

/** The review split into findings: a list item, or a paragraph; a heading belongs to what follows it. */
const findings = (review) => {
  const found = [];
  let current = [];
  const close = () => {
    if (current.length > 0) found.push(current.join('\n'));
    current = [];
  };
  const lines = review.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') {
      // An indented line after a blank line (a sub-bullet, a continued paragraph) still belongs to the open item.
      const next = lines.slice(index + 1).find((text) => text.trim() !== '');
      const continues = next !== undefined && /^\s+\S/.test(next);
      if (!continues && !current.every((text) => /^#{1,6}\s/.test(text))) close();
      continue;
    }
    // Only a marker at the left edge starts a finding; an indented one is a sub-bullet of the item above.
    const startsFinding = /^#{1,6}\s/.test(line) || /^(?:[-*+]|\d+[.)])\s/.test(line);
    if (startsFinding && current.length > 0 && !current.every((text) => /^#{1,6}\s/.test(text))) close();
    current.push(line);
  }
  close();
  return found;
};

await check('repo-workflow-review', async (run) => {
  const expected = readText(run, '.git/v1-review-files')?.trim();
  expect(expected, 'the task setup did not run in this folder (no .git/v1-review-files)');
  expect(treeHash(run) === expected, 'the working tree changed: a review leaves the code as it is');
  const review = answer(run, 'answers/review.md');

  const source = readText(run, 'src/queries.ts').split('\n');
  const start = source.findIndex((line) => line.includes('export const searchRequests'));
  expect(start >= 0, 'searchRequests is gone from src/queries.ts');
  const prepare = source.findIndex((line, index) => index > start && line.includes('.prepare('));
  const end = source.findIndex((line, index) => index > prepare && line.includes('.all('));
  const from = prepare + 1; // 1-based line of `.prepare(`
  const to = end + 1; // 1-based line of `.all(`

  const cited = [];
  let hit = null;
  for (const finding of findings(review)) {
    for (const match of finding.matchAll(LOCATION)) {
      const location = { file: match[1], first: Number(match[2]), last: Number(match[3] ?? match[2]) };
      cited.push(`${location.file}:${location.first}`);
      if (!location.file.endsWith('queries.ts') || location.first > to || location.last < from) continue;
      if (location.last - location.first + 1 > MAX_SPAN) continue;
      if (!DEFECT.test(finding)) continue;
      hit ??= location;
    }
  }
  expect(cited.length > 0, 'the review cites no location as path:line');
  expect(
    hit,
    `no finding cites a line of the search statement (src/queries.ts lines ${from} to ${to}, at most ${MAX_SPAN} lines in a range) and names what is wrong with it; cited: ${[...new Set(cited)].join(', ')}`,
  );
  return `names src/queries.ts:${hit.first}`;
});
