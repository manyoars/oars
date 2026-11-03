// Pre-push guard: stops a push that would newly publish a listed private term, in an added line or a commit message.
// Usage: node scripts/check-private-names.mjs <sha-being-pushed>   (run from inside the repository)
//
// It reads two local term files, one term per line, matched case-insensitively. They never sit in this repository:
//   OARS_EXCLUSION_TERMS   default ~/.claude/session-commons/exclusion-terms.txt  (the session store's exclusion list)
//   OARS_PUBLIC_DENYLIST   default ~/.claude/session-commons/public-denylist.txt
// A missing file warns on stderr and counts as empty, because a public contributor has neither. A hit exits 1 and prints the
// commit, file, and line only: the output must not repeat the term or the text, since a log can be public too.
// It scans `git rev-list <sha> --not --remotes=origin`, so a name already on origin is out of reach (a limit, not a feature).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX = 512 * 1024 * 1024;
// git's "no newline at end of file" marker line starts with a backslash.
const NO_NEWLINE_MARK = String.fromCharCode(92);

const git = (/** @type {string[]} */ args) => {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: MAX });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout;
};

const loadTerms = (/** @type {string} */ name, /** @type {string} */ path) => {
  if (!existsSync(path)) {
    process.stderr.write(`check-private-names: ${name} not found, skipping that list\n`);
    return [];
  }
  return readFileSync(path, 'utf8').split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l !== '');
};

/** Added lines of one commit as [file, line number, text]; a merge shows only its conflict resolutions (combined diff). */
const addedLines = (/** @type {string} */ sha) => {
  /** @type {Array<[string, number, string]>} */
  const out = [];
  let file = '';
  let line = 0;
  let parents = 1;
  for (const raw of git(['show', '--format=', '-U0', '--no-color', '--no-ext-diff', sha]).split('\n')) {
    const head = /^(@@+) .*\+(\d+)(?:,\d+)? @@/.exec(raw);
    if (head) {
      parents = (head[1] ?? '').length - 1;
      line = Number(head[2]);
      continue;
    }
    const name = /^\+\+\+ b\/(.*)$/.exec(raw);
    if (name) {
      file = name[1] ?? '';
      continue;
    }
    if (/^diff --(git|cc|combined) /.test(raw)) {
      const cc = /^diff --(?:cc|combined) (.*)$/.exec(raw);
      file = cc ? (cc[1] ?? '') : file;
      continue;
    }
    if (line === 0 || raw === '' || raw.startsWith(NO_NEWLINE_MARK)) continue;
    const marks = raw.slice(0, parents);
    if (marks.includes('-')) continue;
    if (marks.includes('+')) out.push([file, line, raw.slice(parents)]);
    line += 1;
  }
  return out;
};

/** @param {string} sha @param {NodeJS.ProcessEnv} env */
export const main = (sha, env) => {
  const lists = [
    loadTerms('OARS_EXCLUSION_TERMS', env.OARS_EXCLUSION_TERMS || join(homedir(), '.claude', 'session-commons', 'exclusion-terms.txt')),
    loadTerms('OARS_PUBLIC_DENYLIST', env.OARS_PUBLIC_DENYLIST || join(homedir(), '.claude', 'session-commons', 'public-denylist.txt')),
  ];
  const terms = [...new Set(lists.flat())];
  if (terms.length === 0) return 0;
  const hits = (/** @type {string} */ text) => {
    const low = text.toLowerCase();
    return terms.some((t) => low.includes(t));
  };
  const found = [];
  for (const commit of git(['rev-list', sha, '--not', '--remotes=origin']).split('\n').filter(Boolean)) {
    const short = commit.slice(0, 10);
    if (hits(git(['log', '-1', '--format=%B', commit]))) found.push(`${short} message`);
    for (const [file, number, text] of addedLines(commit)) if (hits(text)) found.push(`${short} ${file}:${number}`);
  }
  if (found.length === 0) return 0;
  process.stderr.write(`check-private-names: ${found.length} listed term(s) in what this push would publish (term and text withheld):\n`);
  for (const f of found) process.stderr.write(`  ${f}\n`);
  return 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sha = process.argv[2];
  if (!sha) {
    process.stderr.write('usage: check-private-names.mjs <sha>\n');
    process.exit(2);
  }
  process.exit(main(sha, process.env));
}
