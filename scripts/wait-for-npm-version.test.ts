import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { waitForNpmVersion } from './wait-for-npm-version.mjs';

// t1265: release-mcp ran before npm served the version release-cli had just published (0.5.5 took about 3 minutes). Time is driven by an injected clock and
// fetch, so no test sleeps or touches the network.
const clock = () => {
  let now = 0;
  return { now: () => now, sleep: (ms: number) => { now += ms; return Promise.resolve(); } };
};
const reply = (status: number) => Promise.resolve({ status });
const options = (fetchFn: (url: string) => Promise<{ status: number }>) => ({ ...clock(), fetch: fetchFn, name: '@manyoars/oars', version: '0.5.5' });

describe('waitForNpmVersion', () => {
  it('returns at once when the first poll finds the version, asking for the exact version url', async () => {
    const urls: string[] = [];
    const c = options((url) => { urls.push(url); return reply(200); });
    await waitForNpmVersion(c);
    expect(urls).toEqual(['https://registry.npmjs.org/@manyoars/oars/0.5.5']);
    expect(c.now()).toBe(0);
  });

  it('polls every 15 seconds until a later poll finds it', async () => {
    let calls = 0;
    const c = options(() => reply(++calls < 4 ? 404 : 200));
    await waitForNpmVersion(c);
    expect(calls).toBe(4);
    expect(c.now()).toBe(45_000);
  });

  it('fails after 10 minutes with a message naming the package, version, and time waited', async () => {
    const c = options(() => reply(404));
    await expect(waitForNpmVersion(c)).rejects.toThrow('@manyoars/oars 0.5.5 was not on the npm registry after 10 minutes');
    expect(c.now()).toBe(600_000);
  });

  it('retries a non-404 error status and a thrown fetch instead of treating them as found', async () => {
    let calls = 0;
    const c = options(() => {
      calls += 1;
      if (calls === 1) return reply(503);
      if (calls === 2) return Promise.reject(new Error('socket hang up'));
      return reply(200);
    });
    await waitForNpmVersion(c);
    expect(calls).toBe(3);
  });

  it('fails when every poll is a server error', async () => {
    await expect(waitForNpmVersion(options(() => reply(500)))).rejects.toThrow('after 10 minutes');
  });
});

// The script as the workflow runs it. Both cases stop at the argument check, before any request, so neither touches the network.
describe('wait-for-npm-version.mjs as a script', () => {
  const script = fileURLToPath(new URL('./wait-for-npm-version.mjs', import.meta.url));
  const USAGE = 'usage: node scripts/wait-for-npm-version.mjs <package> <version>';

  it('prints the usage line and exits non-zero with no arguments', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(result.stderr.trim()).toBe(USAGE);
    expect(result.stdout).toBe('');
    expect(result.status).toBe(2);
  });

  it('prints the usage line and exits non-zero when the version is missing', () => {
    const result = spawnSync(process.execPath, [script, '@manyoars/oars'], { encoding: 'utf8' });
    expect(result.stderr.trim()).toBe(USAGE);
    expect(result.stdout).toBe('');
    expect(result.status).toBe(2);
  });
});
