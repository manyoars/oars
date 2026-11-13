// Fails when a tracked file names the owner (first name, handle, or mailbox domain) as a whole word, case-insensitive. The repository
// is public and must not tie the project to a person by name; prose says "the owner" or "the operator". Offline and deterministic.
//
//   node scripts/check-owner-name.mjs [repository root]
//
// Exit 0: no tracked file matches. Exit 1: stderr lists each path:line (never the text). No allowlist: a hit is fixed, not excused.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTerms } from './check-private-names.mjs';

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));

// The given-name forms are inline. The handle and the mailbox domain must not be spelled in this public tree, so they come from the
// same untracked public denylist that check-private-names reads (a missing file warns and counts as empty, as there).
const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const listed = loadTerms('OARS_PUBLIC_DENYLIST', process.env.OARS_PUBLIC_DENYLIST || join(base, 'session-commons', 'public-denylist.txt'));
if (listed === null) {
  process.exit(1);
}
// Built from parts so this file does not match itself.
const terms = ['mat' + 't', 'mat' + 'thew', ...listed];

const r = spawnSync('git', ['-C', root, 'grep', '-n', '-I', '-i', '-w', '-F', ...terms.flatMap((t) => ['-e', t])], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
// git grep exits 1 for "no match", which is the pass.
if (r.status !== 0 && r.status !== 1) {
  console.error(`check-owner-name: git grep failed: ${r.stderr.trim()}`);
  process.exitCode = 1;
} else {
  const hits = r.stdout.split('\n').filter(Boolean).map((l) => l.split(':').slice(0, 2).join(':'));
  if (hits.length > 0) {
    console.error(`The owner's name must not appear in a tracked file; write "the owner" or "the operator" (${hits.length} hit(s)):\n  ${hits.join('\n  ')}`);
    process.exitCode = 1;
  }
}
