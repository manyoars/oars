// The built `dist/bin.js` run as the harness runs it: `gate hook` with a payload on stdin, in a temp home. It proves the dispatch in `bin.ts` and the process-level exit 0 with
// empty stdout, which the in-process tests cannot. Like `pack.test.ts` it reads `dist/`, which the root `check` builds before the tests run; without a build it is skipped.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const runHook = (input: string, extra: readonly string[] = [], pathHead?: string, given?: string): { status: number | null; stdout: string; home: string } => {
  const home = given ?? mkdtempSync(join(tmpdir(), 'oars-gate-bin-'));
  if (given === undefined) made.push(home);
  const result = spawnSync(process.execPath, [bin, 'gate', 'hook', ...extra], {
    input,
    encoding: 'utf8',
    timeout: 30_000,
    cwd: home,
    env: { PATH: [pathHead, process.env.PATH].filter((part) => part !== undefined && part !== '').join(delimiter), APPDATA: home, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home },
  });
  return { status: result.status, stdout: result.stdout, home };
};

// A folder holding `npm` and `npm.cmd` that only write a marker. First on PATH, it shows whether the hook starts an `npm view` child: the marker exists if it did.
const fakeNpm = (): { folder: string; marker: string } => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-gate-fakenpm-'));
  made.push(folder);
  const marker = join(folder, 'npm-started');
  writeFileSync(join(folder, 'npm'), `#!/bin/sh\necho started > "${marker}"\n`);
  chmodSync(join(folder, 'npm'), 0o755);
  writeFileSync(join(folder, 'npm.cmd'), `@echo off\r\necho started> "${marker}"\r\n`);
  return { folder, marker };
};

// A manager that answers 2 s late, past the hook's 650 ms cut: a script that sleeps, then prints what `npm view` prints. It logs each start, one line apiece.
const slowNpm = (): { folder: string; log: string } => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-gate-slownpm-'));
  made.push(folder);
  const log = join(folder, 'npm-starts');
  const answer = '{"dist-tags.latest":"1.0.0","time.created":"2020-01-01T00:00:00.000Z"}';
  writeFileSync(join(folder, 'npm'), `#!/bin/sh\necho started >> "${log}"\nsleep 2\necho '${answer}'\n`);
  chmodSync(join(folder, 'npm'), 0o755);
  writeFileSync(join(folder, 'npm.cmd'), `@echo off\r\necho started>> "${log}"\r\nping -n 3 127.0.0.1 >nul\r\necho ${answer}\r\n`);
  return { folder, log };
};

// A manager that answers an `E404` at once, as `npm view` does for a name the registry it is configured for does not have.
const missingNpm = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-gate-missingnpm-'));
  made.push(folder);
  writeFileSync(join(folder, 'npm'), `#!/bin/sh\necho 'npm error code E404' >&2\nexit 1\n`);
  chmodSync(join(folder, 'npm'), 0o755);
  writeFileSync(join(folder, 'npm.cmd'), `@echo off\r\necho npm error code E404 1>&2\r\nexit /b 1\r\n`);
  return folder;
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

  it('shows the command description for `gate hook --help`, as it does for any other command', () => {
    // Only the bare `oars gate hook` goes to the hook entry; an argument sends it to the full CLI, whose help names the hook.
    const result = runHook('', ['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PreToolUse hook');
    expect(crossingFiles(result.home)).toEqual([]);
  });

  it('records one row for a crossing, still with empty stdout and exit 0', () => {
    // yarn is never asked of the registry (ASKED_PROGRAMS), so no `npm view` child outlives the test and writes into the temp home after its cleanup.
    const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'yarn add left-pad' }, cwd: tmpdir(), permission_mode: 'default' });
    const npm = fakeNpm();
    const result = runHook(payload, [], npm.folder);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(npm.marker)).toBe(false);
    const [file] = crossingFiles(result.home);
    expect(file).toBeDefined();
    const lines = readFileSync(join(result.home, file ?? ''), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ kind: 'crossing', via: 'hook', name: 'left-pad', registryState: 'not-read' });
  });

  it('fills the cache after a cut ask: the first sight reads not-read, the next reads found', () => {
    const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install slow-lib' }, cwd: tmpdir(), permission_mode: 'default' });
    const npm = slowNpm();
    const first = runHook(payload, [], npm.folder);
    expect(first.status).toBe(0);
    const cache = join(first.home, 'oars', 'sessions', 'gate-registry.jsonl');
    // The helper outlives the hook: wait for its answer to land before the next sight, and before cleanup removes the home under it.
    for (let waited = 0; waited < 30_000 && !existsSync(cache); waited += 250) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    expect(existsSync(cache)).toBe(true);
    const second = runHook(payload.replace('"u1"', '"u2"'), [], npm.folder, first.home);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe('');
    const [file] = crossingFiles(first.home);
    const rows: unknown[] = readFileSync(join(first.home, file ?? ''), 'utf8').trim().split('\n').map((line): unknown => JSON.parse(line));
    expect(rows).toMatchObject([{ registryState: 'not-read' }, { registryState: 'found' }]);
  });

  it('prints a labeled deny on stdout and exits 0 when the policy says block and the manager answered not found', () => {
    const home = mkdtempSync(join(tmpdir(), 'oars-gate-bin-'));
    made.push(home);
    const store = join(home, 'oars', 'sessions');
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'gate-policy.json'), '{"classes":{"not-found":"block"}}');
    const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install ghost-lib' }, cwd: tmpdir(), permission_mode: 'default' });
    const result = runHook(payload, [], missingNpm(), home);
    expect(result.status).toBe(0);
    const output: unknown = JSON.parse(result.stdout);
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Blocked by your gate policy: ghost-lib was not found in the registry your package manager uses.',
      },
    });
    const [file] = crossingFiles(home);
    const lines = readFileSync(join(home, file ?? ''), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ name: 'ghost-lib', registryState: 'not-found', arm: 'none', lineShown: 'not-found-block', policy: 'file' });
  });

  it('stays silent on stdout for the same name under the default policy', () => {
    const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install ghost-lib' }, cwd: tmpdir(), permission_mode: 'default' });
    const result = runHook(payload, [], missingNpm());
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('deny');
  });
});
