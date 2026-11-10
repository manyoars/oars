// Prints one version's section of a changelog: the body under `## <version>` (or `## <version> (<date>)`) up to the next `## ` heading, without the heading.
// Usage: node scripts/changelog-section.mjs <version> [changelog]   (default changelog: packages/cli/CHANGELOG.md)
// The release-cli workflow uses it for the GitHub Release notes. Exit 1 when the section is missing or empty, 2 on bad usage.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_CHANGELOG = fileURLToPath(new URL('../packages/cli/CHANGELOG.md', import.meta.url));

/**
 * @param {string} text the changelog
 * @param {string} version for example `0.4.1`
 * @returns {string} the section body, trimmed
 */
export const sectionOf = (text, version) => {
  const lines = text.split(/\r?\n/);
  // Exact version: the heading is `## <version>` alone or followed by a space and the date, so `0.4` never matches `0.4.1`.
  const start = lines.findIndex((line) => line === `## ${version}` || line.startsWith(`## ${version} `));
  if (start === -1) throw new Error(`no "## ${version}" section in the changelog`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  if (body === '') throw new Error(`the "## ${version}" section is empty`);
  return body;
};

const run = () => {
  const [version, file = DEFAULT_CHANGELOG] = process.argv.slice(2);
  if (version === undefined || version === '') {
    console.error('usage: node scripts/changelog-section.mjs <version> [changelog]');
    return 2;
  }
  try {
    process.stdout.write(`${sectionOf(readFileSync(file, 'utf8'), version)}\n`);
    return 0;
  } catch (error) {
    console.error(`changelog-section: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
};

// Only when run as a script, so importing sectionOf never sets the exit code.
if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = run();
