// Setup for repo-workflow-commit, run after the reset with the run folder as its argument. Stages a note-length limit (the
// change the task asks the agent to commit), leaves one unstaged doc edit and one untracked file that must stay out of the
// commit, sets a commit identity for the run, and records the starting commit in .git/v1-base for the check.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const run = process.argv[2];
if (!run) throw new Error('usage: node setup/repo-workflow-commit.mjs <run folder>');
const git = (...args) => execFileSync('git', args, { cwd: run, encoding: 'utf8' }).trim();

const swap = (file, from, to) => {
  const path = join(run, file);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) throw new Error(`${file} lacks ${from}`);
  writeFileSync(path, text.replace(from, () => to));
};

git('config', 'user.name', 'Many Oars Run');
git('config', 'user.email', 'run@example.invalid');
writeFileSync(join(run, '.git', 'v1-base'), `${git('rev-parse', 'HEAD')}\n`);

swap('src/lib/validate.ts', 'export const MAX_QUANTITY = 999;\n', 'export const MAX_QUANTITY = 999;\nexport const MAX_NOTE_LENGTH = 200;\n');
swap(
  'src/lib/validate.ts',
  "  const trimmed = typeof note === 'string' ? note.trim() : '';\n",
  "  const trimmed = typeof note === 'string' ? note.trim() : '';\n  if (trimmed.length > MAX_NOTE_LENGTH) throw new RangeError(`note must be at most ${MAX_NOTE_LENGTH} characters`);\n",
);
swap('test/lib.test.ts', "import { parseNewRequest, parseQuantity } from '../src/lib/validate.ts';", "import { MAX_NOTE_LENGTH, parseNewRequest, parseQuantity } from '../src/lib/validate.ts';");
appendFileSync(
  join(run, 'test', 'lib.test.ts'),
  [
    '',
    "describe('parseNewRequest note length', () => {",
    "  it('keeps a note of the longest allowed length', () => {",
    "    const note = 'x'.repeat(MAX_NOTE_LENGTH);",
    "    assert.equal(parseNewRequest({ member: 'teal-otter', item: 4, quantity: 2, note }).note, note);",
    '  });',
    '',
    "  it('rejects a longer note', () => {",
    "    const note = 'x'.repeat(MAX_NOTE_LENGTH + 1);",
    "    assert.throws(() => parseNewRequest({ member: 'teal-otter', item: 4, quantity: 2, note }), RangeError);",
    '  });',
    '});',
    '',
  ].join('\n'),
);
git('add', 'src/lib/validate.ts', 'test/lib.test.ts');

// Not part of this change: an edit to a doc, unstaged, and a scratch file, untracked.
appendFileSync(join(run, 'docs', 'faq.md'), '\n**Is there a limit on a note?** Yes, 200 characters.\n');
mkdirSync(join(run, 'notes'), { recursive: true });
writeFileSync(join(run, 'notes', 'todo.txt'), 'ask purchasing about the Thursday batch\n');
