// The built `dist/bin.js` run as a terminal status line runs it: `oars statusline [--color]` in a temp home holding a seeded store. It proves the dispatch in `bin.ts`, the store
// path in `statusline-main.ts`, the `--color` read, the exit 0, and that stdin is never read, none of which the in-process tests reach. Like `hook-bin.test.ts` it reads `dist/`,
// which the root `check` builds before the tests run; without a build it is skipped.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { prompt, session } from './sessions/pool-fixture.js';
import { STATUSLINE_ID } from './sessions/statusline.js';

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
});

// Local noon of the day `back` days ago: a 23- or 25-hour day at a clock change cannot fold two of these onto one date.
const noonAgo = (back: number): string => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12).toISOString();
};
// A home whose store holds two sessions, one yesterday and one two days ago: two sessions on two active days in any time zone.
const seededHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'oars-statusline-bin-'));
  made.push(home);
  const store = join(home, 'oars', 'sessions');
  mkdirSync(store, { recursive: true });
  const rows = [
    session('a'),
    session('b'),
    prompt('a', 0, { ts: noonAgo(1) }),
    prompt('b', 0, { ts: noonAgo(2) }),
  ];
  writeFileSync(join(store, 'observations.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return home;
};

const listing = (home: string): string[] => readdirSync(home, { recursive: true, encoding: 'utf8' }).sort();

const spawnBin = (home: string, args: string[], input: string | undefined): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, APPDATA: home, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home },
    ...(input === undefined ? { stdio: ['ignore', 'pipe', 'pipe'] } : { input }),
    timeout: 60_000,
  });

describe.skipIf(!existsSync(bin))('the built oars statusline', () => {
  const plain = `${STATUSLINE_ID} 7d: 2 sessions, 2 active days`;
  const bold = `\u001b[1m${STATUSLINE_ID}\u001b[0m${plain.slice(STATUSLINE_ID.length)}`;
  const payload = JSON.stringify({ model: { display_name: 'x' }, workspace: { current_dir: '/somewhere/secret' } });

  for (const [name, input] of [['with a JSON payload on stdin', payload], ['with stdin ignored', undefined]] as const) {
    it(`prints the line and nothing else, ${name}`, () => {
      const home = seededHome();
      const before = listing(home);
      const result = spawnBin(home, ['statusline'], input);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${plain}\n`);
      expect(result.stderr).toBe('');
      expect(listing(home)).toEqual(before);
    });

    it(`bolds the identifier only with --color, ${name}`, () => {
      const home = seededHome();
      const before = listing(home);
      const result = spawnBin(home, ['statusline', '--color'], input);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${bold}\n`);
      expect(result.stderr).toBe('');
      expect(listing(home)).toEqual(before);
    });
  }

  it('prints the zero line and creates no oars folder when there is no store at all', () => {
    const home = mkdtempSync(join(tmpdir(), 'oars-statusline-bin-'));
    made.push(home);
    const result = spawnBin(home, ['statusline'], undefined);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${STATUSLINE_ID} 7d: 0 sessions, 0 active days
`);
    expect(result.stderr).toBe('');
    expect(listing(home)).toEqual([]);
  });

  it('hands `statusline --help` to the full CLI, which prints the commander help', () => {
    const home = seededHome();
    const result = spawnBin(home, ['statusline', '--help'], undefined);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: oars statusline [options]');
    expect(result.stdout).toContain('--color');
  });
});
