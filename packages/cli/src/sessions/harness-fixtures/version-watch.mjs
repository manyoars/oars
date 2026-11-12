// Weekly version watch: fails when a harness's latest published version is past what its fixture was modeled on.
// Run by .github/workflows/harness-readers.yml only (never by ci), so a release cannot redden main or a task branch.
// Reads versions.json beside it and asks the npm registry (`npm view`, which installs nothing). No harness runs and no store is read.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @typedef {{ name: string, package: string | null, modeledOn: string | null, allowance: string, basis: string }} Entry */

export const REFRESH =
  'Refresh: node packages/cli/src/sessions/harness-fixtures/shape.mjs <harness> <session file>, then update the fixture and set modeledOn in versions.json (steps: packages/cli/src/sessions/harness-fixtures/README.md).';

/** @returns {Entry[]} */
export const loadEntries = () =>
  JSON.parse(readFileSync(fileURLToPath(new URL('./versions.json', import.meta.url)), 'utf8')).harnesses;

/** @param {string} version @returns {[number, number, number] | null} */
const parse = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};

/** @param {[number, number, number]} a @param {[number, number, number]} b @returns {number} negative when a is older than b */
const order = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Whether `latest` is newer than `modeled` and past the allowance of a fixture modeled on `modeled`. "minor" (the default) allows patch releases only: a different
 * major or minor is stale. "major" allows minor and patch releases; "patch" allows none.
 * @param {string} modeled @param {string} latest @param {string} allowance
 */
export const isStale = (modeled, latest, allowance) => {
  const a = parse(modeled);
  const b = parse(latest);
  if (a === null || b === null || order(a, b) >= 0) return false;
  if (allowance === 'major') return a[0] !== b[0];
  if (allowance === 'patch') return a.some((part, i) => part !== b[i]);
  return a[0] !== b[0] || a[1] !== b[1];
};

/**
 * The stale harnesses, as `harness: fixture X, latest Y` lines. A harness without a package, or without a stamped version, cannot be compared.
 * @param {Entry[]} entries @param {Record<string, string | undefined>} latest package name to latest version
 */
export const staleLines = (entries, latest) =>
  entries.flatMap((entry) => {
    const published = entry.package === null ? undefined : latest[entry.package];
    if (entry.modeledOn === null || published === undefined || !isStale(entry.modeledOn, published, entry.allowance)) return [];
    return [`${entry.name}: fixture ${entry.modeledOn}, latest ${published}`];
  });

/**
 * The harnesses whose fixture is stamped above every published release: nothing is stale, but the stamp cannot be right.
 * @param {Entry[]} entries @param {Record<string, string | undefined>} latest package name to latest version
 */
export const aheadLines = (entries, latest) =>
  entries.flatMap((entry) => {
    const published = entry.package === null ? undefined : latest[entry.package];
    const a = entry.modeledOn === null ? null : parse(entry.modeledOn);
    const b = published === undefined ? null : parse(published);
    if (a === null || b === null || order(a, b) <= 0) return [];
    return [`${entry.name}: fixture ${entry.modeledOn} is ahead of every release (latest ${published}); re-stamp versions.json`];
  });

/** @param {string} pkg */
const npmLatest = (pkg) => {
  try {
    return execFileSync('npm', ['view', pkg, 'version'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
  } catch {
    return undefined;
  }
};

const main = () => {
  const entries = loadEntries();
  /** @type {Record<string, string | undefined>} */
  const latest = {};
  for (const entry of entries) {
    if (entry.package === null) continue;
    latest[entry.package] = npmLatest(entry.package);
    console.log(`${entry.package} ${latest[entry.package] ?? 'unavailable'}`);
  }
  const ahead = aheadLines(entries, latest);
  if (ahead.length > 0) console.warn(`Fixture stamped above the latest release (warning, not a failure):\n${ahead.join('\n')}`);
  const stale = staleLines(entries, latest);
  if (stale.length === 0) return 0;
  console.error(`Fixtures behind the latest release:\n${stale.join('\n')}\n${REFRESH}`);
  return 1;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
