// Waits until the npm registry serves one exact version of a package, then exits 0; exits 1 with one line if it never does.
// Usage: node scripts/wait-for-npm-version.mjs <package> <version>
// The release-mcp workflow calls it before listing on the MCP registry: release-cli finishes its publish step before npm serves the new version
// (0.5.5 took about 3 minutes), and the MCP registry checks the npm package when it is called.
import { pathToFileURL } from 'node:url';

const INTERVAL_MS = 15_000;
const TIMEOUT_MS = 600_000;

/**
 * @param {{ name: string, version: string, fetch: (url: string) => Promise<{ status: number }>, sleep: (ms: number) => Promise<void>, now: () => number }} options
 * @returns {Promise<void>} resolves once the version is served
 */
export const waitForNpmVersion = async ({ name, version, fetch, sleep, now }) => {
  const url = `https://registry.npmjs.org/${name}/${version}`;
  const start = now();
  for (;;) {
    // Only a 200 is "found": a 404 is the race itself, and any other status or a network error is a registry hiccup to retry.
    const found = await fetch(url).then(
      (response) => response.status === 200,
      () => false,
    );
    if (found) return;
    if (now() - start + INTERVAL_MS > TIMEOUT_MS) break;
    await sleep(INTERVAL_MS);
  }
  throw new Error(`${name} ${version} was not on the npm registry after ${TIMEOUT_MS / 60_000} minutes`);
};

const run = async () => {
  const [name, version] = process.argv.slice(2);
  if (!name || !version) {
    console.error('usage: node scripts/wait-for-npm-version.mjs <package> <version>');
    return 2;
  }
  try {
    await waitForNpmVersion({
      name,
      version,
      fetch: (url) => fetch(url, { signal: AbortSignal.timeout(10_000) }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    });
    console.log(`${name} ${version} is on the npm registry`);
    return 0;
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
};

// Only when run as a script, so importing waitForNpmVersion never sets the exit code.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await run();
