// Weekly version watch: fails when a harness's latest published version is past what its fixture was modeled on.
// Run by .github/workflows/harness-readers.yml only (never by ci), so a release cannot redden main or a task branch.
// Reads versions.json beside it and asks the npm registry (`npm view`, which installs nothing). No harness runs and no store is read.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @typedef {{ name: string, package: string | null, modeledOn: string | null, allowance: string, basis: string }} Entry */

export const REFRESH = 'Refresh: see packages/cli/src/sessions/harness-fixtures/README.md (run shape.mjs on a newer session file, update the fixture, set modeledOn in versions.json).';

/** @returns {Entry[]} */
export const loadEntries = () =>
  JSON.parse(readFileSync(fileURLToPath(new URL('./versions.json', import.meta.url)), 'utf8')).harnesses;

/** @param {string} version @returns {[number, number, number] | null} */
const parse = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};

/**
 * Whether `latest` is past the allowance of a fixture modeled on `modeled`. "minor" (the default) allows patch releases only: a different
 * major or minor is stale. "major" allows minor and patch releases; "patch" allows none.
 * @param {string} modeled @param {string} latest @param {string} allowance
 */
export const isStale = (modeled, latest, allowance) => {
  const a = parse(modeled);
  const b = parse(latest);
  if (a === null || b === null) return false;
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
  const stale = staleLines(entries, latest);
  if (stale.length === 0) return 0;
  console.error(`Fixtures behind the latest release:\n${stale.join('\n')}\n${REFRESH}`);
  return 1;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
