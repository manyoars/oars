// The built `dist/bin.js` run as the harness runs it: `gate hook` with a payload on stdin, in a temp home. It proves the dispatch in `bin.ts` and the process-level exit 0 with
// empty stdout, which the in-process tests cannot. Like `pack.test.ts` it reads `dist/`, which the root `check` builds before the tests run; without a build it is skipped.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const runHook = (input: string): { status: number | null; stdout: string; home: string } => {
  const home = mkdtempSync(join(tmpdir(), 'oars-gate-bin-'));
  made.push(home);
  const result = spawnSync(process.execPath, [bin, 'gate', 'hook'], {
    input,
    encoding: 'utf8',
    timeout: 30_000,
    cwd: home,
    env: { PATH: process.env.PATH ?? '', APPDATA: home, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home },
  });
  return { status: result.status, stdout: result.stdout, home };
};

const crossingFiles = (home: string): string[] => readdirSync(home, { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('crossings.jsonl'));

describe.skipIf(!existsSync(bin))('the built oars gate hook', () => {
  it('exits 0 with empty stdout on bad stdin, and writes no record', () => {
    for (const input of ['', 'not json', '{"tool_name":', '[]']) {
      const result = runHook(input);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(crossingFiles(result.home)).toEqual([]);
    }
  });

  it('records one row for a crossing, still with empty stdout and exit 0', () => {
    // yarn is never asked of the registry (ASKED_PROGRAMS), so no `npm view` child outlives the test and writes into the temp home after its cleanup.
    const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'yarn add left-pad' }, cwd: tmpdir(), permission_mode: 'default' });
    const result = runHook(payload);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    const [file] = crossingFiles(result.home);
    expect(file).toBeDefined();
    const lines = readFileSync(join(result.home, file ?? ''), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ kind: 'crossing', via: 'hook', name: 'left-pad', registryState: 'not-read' });
  });
});
