// Fails when the templates' copies of a shared file differ. `src/billing.ts` is one file in every template: it holds all the
// money handling, so a fix to one copy that misses the other is a bug waiting in a template developers copy.
//
//   node scripts/check-billing-sync.mjs [repository root]
//
// Exit 0: every copy is byte for byte the first template's. Exit 1: a copy differs or is missing; stderr names both paths.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The first template is the reference. Slice 10 adds 'src/recovery.ts' to SYNCED.
const TEMPLATES = ['paid-api', 'per-task-agent'];
const SYNCED = ['src/billing.ts'];

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));

/** @param {string} path @returns {Buffer | undefined} */
const readOrUndefined = (path) => {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
};

const problems = [];
for (const file of SYNCED) {
  const [reference, ...others] = TEMPLATES.map((template) => join(root, 'templates', template, file));
  const expected = readOrUndefined(reference ?? '');
  if (expected === undefined) problems.push(`missing: ${reference ?? ''}`);
  for (const path of others) {
    const actual = readOrUndefined(path);
    if (actual === undefined) problems.push(`missing: ${path}`);
    else if (expected !== undefined && !actual.equals(expected)) problems.push(`differs: ${path}\n     from: ${reference ?? ''}`);
  }
}

if (problems.length > 0) {
  console.error(`The templates must carry one ${SYNCED.join(', ')} byte for byte; make the same change in both.\n  ${problems.join('\n  ')}`);
  process.exitCode = 1;
}
