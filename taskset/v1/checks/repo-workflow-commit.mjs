// repo-workflow-commit: after the setup (a staged note-length limit in src/lib/validate.ts and test/lib.test.ts, an unstaged
// edit to docs/faq.md, and an untracked notes/todo.txt), the run made exactly one commit on the starting commit
// (.git/v1-base) that holds exactly the two staged files, left nothing staged, and left the other two changes as they were.
// The message must say what changed and why: a subject of 8 to 72 characters, the word "note" in the message, and a body of at
// least 4 words (the why; a subject alone says what at most), or a subject that holds its own why clause ("..., so long notes
// cannot bloat the CSV"; so, because, to avoid, to keep). No prose is graded; a filler body ("Update the note check.") passes.
// Wrong neighbors: `git add -A` first, which commits the doc edit and the scratch file too; the right files with "Update note".
import { spawnSync } from 'node:child_process';
import { check, expect, readText } from './_shared.mjs';

const git = (run, ...args) => {
  const result = spawnSync('git', args, { cwd: run, encoding: 'utf8' });
  expect(result.status === 0, `git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
};
const lines = (text) => text.split('\n').filter((line) => line !== '');

await check('repo-workflow-commit', async (run) => {
  const base = readText(run, '.git/v1-base')?.trim();
  expect(base, 'the task setup did not run in this folder (no .git/v1-base)');
  expect(git(run, 'rev-parse', 'HEAD') !== base, 'no commit was made');
  expect(git(run, 'rev-list', '--count', `${base}..HEAD`) === '1', 'the run should add exactly one commit');
  expect(git(run, 'rev-parse', 'HEAD~1') === base, 'the new commit is not on the starting commit');
  const files = lines(git(run, 'diff', '--name-only', base, 'HEAD')).sort();
  expect(JSON.stringify(files) === JSON.stringify(['src/lib/validate.ts', 'test/lib.test.ts']), `the commit holds ${files.join(', ') || 'nothing'}; want only the two staged files`);
  expect(git(run, 'show', 'HEAD:src/lib/validate.ts').includes('MAX_NOTE_LENGTH'), 'the commit does not hold the staged note-length change');
  expect(git(run, 'diff', '--cached', '--name-only') === '', 'something is still staged');
  expect(JSON.stringify(lines(git(run, 'diff', '--name-only'))) === JSON.stringify(['docs/faq.md']), 'docs/faq.md should stay modified and unstaged, and nothing else should be modified');
  expect(JSON.stringify(lines(git(run, 'ls-files', '--others', '--exclude-standard'))) === JSON.stringify(['notes/todo.txt']), 'notes/todo.txt should stay untracked, and nothing else should be');
  const subject = git(run, 'log', '-1', '--format=%s');
  expect(subject.length >= 8 && subject.length <= 72, `the subject is ${subject.length} characters; want 8 to 72`);
  expect(/note/i.test(git(run, 'log', '-1', '--format=%B')), 'the message does not mention the note');
  const body = git(run, 'log', '-1', '--format=%b');
  // The why is a body of 4+ words, or a clause in the subject ("so ...", "because ...", "to avoid ...", "to keep ...") with 2+ words.
  const hasBody = body.split(/\s+/).filter((word) => /\w/.test(word)).length >= 4;
  const whyInSubject = /\b(so|because|to avoid|to keep)\s+\w+\s+\w+/i.test(subject);
  expect(hasBody || whyInSubject, 'the message has no body that says why, and its subject has no why clause (so, because, to avoid, to keep)');
  return `one commit, "${subject}"`;
});
