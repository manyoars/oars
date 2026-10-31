// Fails when a dependency that ships to developers carries a license nobody has approved. `@manyoars/oars` and `@manyoars/oars-client`
// are public packages, so a copyleft or unlicensed dependency in what they install is a legal problem the day it publishes. This reads
// only package-lock.json: offline and deterministic, so it belongs in `just check`. Known advisories move with a network feed and are
// `just audit`'s job, kept out of `just check` so a new advisory cannot turn an unrelated pull request red.
//
//   node scripts/check-licenses.mjs [repository root]
//
// Exit 0: every shipped lockfile entry is under an allowed license. Exit 1: stderr names each offender's path and license.
//
// Skipped on purpose: the root entry (the repo itself), workspace links (`link: true`; the target is its own entry), and every
// `dev: true` entry. Development tools (the 12 MPL-2.0 `lightningcss*` packages, `argparse`, a few unlicensed `validate.io-*`) run
// on a contributor's machine and in CI but are not in the published packages, so their licenses do not bind what developers receive.
// Every other entry must be allowed, which makes a shipped MPL-2.0 or other copyleft dependency fail until a person adds it to
// ALLOWED_LICENSES below: a new license is a decision, not a default. An entry with no `license` field fails for the same reason.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// SPDX identifiers the project has approved for dependencies that ship.
const ALLOWED_LICENSES = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD']);

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));

/**
 * Whether an SPDX license expression is allowed: `OR` needs one allowed alternative, `AND` needs every part allowed (`AND` binds
 * tighter, parentheses group). Anything this grammar does not parse, such as `WITH` exceptions or `SEE LICENSE IN ...`, is not allowed.
 * @param {string} expression
 */
const isAllowed = (expression) => {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;

  const parseTerm = () => {
    const token = tokens[position++];
    if (token === '(') {
      const inner = parseOr();
      if (tokens[position++] !== ')') throw new Error('unclosed parenthesis');
      return inner;
    }
    if (token === undefined || token === ')' || token === 'AND' || token === 'OR') throw new Error('expected a license');
    return ALLOWED_LICENSES.has(token);
  };
  // Both operands are always parsed (no short circuit), so a malformed tail still throws.
  const parseAnd = () => {
    let allowed = parseTerm();
    while (tokens[position] === 'AND') {
      position++;
      const next = parseTerm();
      allowed = allowed && next;
    }
    return allowed;
  };
  const parseOr = () => {
    let allowed = parseAnd();
    while (tokens[position] === 'OR') {
      position++;
      const next = parseAnd();
      allowed = allowed || next;
    }
    return allowed;
  };

  try {
    const allowed = parseOr();
    return allowed && position === tokens.length;
  } catch {
    return false;
  }
};

const lockfilePath = join(root, 'package-lock.json');
const problems = [];
let packages = {};
try {
  packages = JSON.parse(readFileSync(lockfilePath, 'utf8')).packages ?? {};
} catch (error) {
  problems.push(`cannot read ${lockfilePath}: ${error instanceof Error ? error.message : String(error)}`);
}

for (const [path, entry] of Object.entries(packages)) {
  if (path === '' || entry.link === true || entry.dev === true) continue;
  const where = entry.version === undefined ? path : `${path}@${entry.version}`;
  if (typeof entry.license !== 'string') problems.push(`${where}: no license field`);
  else if (!isAllowed(entry.license)) problems.push(`${where}: ${entry.license}`);
}

if (problems.length > 0) {
  console.error(
    `Dependencies that ship must be under ${[...ALLOWED_LICENSES].join(', ')}. To approve another license, add it to ALLOWED_LICENSES in scripts/check-licenses.mjs.\n  ${problems.join('\n  ')}`,
  );
  process.exitCode = 1;
}
