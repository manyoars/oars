import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { commandOf, effectiveRetention, hookStatus, installHooks, readSettings, scheduleArgs, setSchedule, settingsPath, uninstallHooks, type InstallRuntime } from './install.js';

afterEach(() => {
  removeTestDirs();
});

const calls: string[][] = [];

const runtimeIn = (dir: string, schtasksCode = 0): InstallRuntime => ({
  nodePath: 'C:\\node\\node.exe',
  hookBin: 'C:\\oars\\dist\\hook-bin.js',
  userSettings: join(dir, 'user', 'settings.json'),
  cwd: join(dir, 'repo'),
  schtasks: (args) => {
    calls.push(args);
    return Promise.resolve({ code: schtasksCode, output: schtasksCode === 0 ? 'SUCCESS' : 'ERROR: Access is denied.' });
  },
});

const scratch = (): string => mkdtempSync(join(tmpdir(), 'oars-install-test-'));
const readJson = readSettings;

describe('hook install', () => {
  it('creates the settings file with the three entries and the retention floor', async () => {
    const dir = scratch();
    const file = join(dir, 'new', 'settings.json');
    const result = await installHooks(runtimeIn(dir), file, false);
    const written = await readJson(file);
    expect(result.installed).toEqual(['SessionStart', 'PostToolUseFailure', 'SessionEnd']);
    for (const event of ['SessionStart', 'PostToolUseFailure', 'SessionEnd']) expect(written).toHaveProperty(['hooks', event]);
    expect(JSON.stringify(written.hooks)).toContain('hook-bin.js\\" post-tool');
    expect(written.cleanupPeriodDays).toBe(365);
    expect(result.retention).toBe(`Raised cleanupPeriodDays from 30 (unset, the default) to 365 in ${file}.`);
  });

  it('keeps an existing Stop hook and other settings, and is idempotent', async () => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    const rotation = { hooks: [{ type: 'command', command: 'node rotate-session.js' }] };
    writeFileSync(file, JSON.stringify({ model: 'opus', hooks: { Stop: [rotation], PreToolUse: [{ matcher: 'Bash', hooks: [] }] } }));
    await installHooks(runtimeIn(dir), file, false);
    await installHooks(runtimeIn(dir), file, false);
    const written = await readJson(file);
    expect(written.model).toBe('opus');
    expect(written.hooks).toMatchObject({ Stop: [rotation], SessionEnd: [expect.anything()], SessionStart: [expect.anything()], PreToolUse: [expect.anything()] });
  });

  it('uninstall removes only its own entries and prunes what it emptied', async () => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    const rotation = { hooks: [{ type: 'command', command: 'node rotate-session.js' }] };
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [rotation] } }));
    await installHooks(runtimeIn(dir), file, false);
    expect(await uninstallHooks(file)).toEqual({ file, removed: ['SessionStart', 'PostToolUseFailure', 'SessionEnd'] });
    const after = await readJson(file);
    expect(after.hooks).toEqual({ Stop: [rotation] });
    expect(after.cleanupPeriodDays).toBe(365);
    expect(await uninstallHooks(file)).toEqual({ file, removed: [] });
  });

  it('uninstall drops the hooks key once nothing else is under it, and tolerates a missing file', async () => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    await installHooks(runtimeIn(dir), file, true);
    await uninstallHooks(file);
    expect((await readJson(file)).hooks).toBeUndefined();
    expect(await uninstallHooks(join(dir, 'absent.json'))).toMatchObject({ removed: [] });
  });

  it('refuses a settings file that is not a JSON object, changing nothing', async () => {
    const dir = scratch();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ nope');
    await expect(installHooks(runtimeIn(dir), bad, false)).rejects.toThrow('not valid JSON');
    expect(readFileSync(bad, 'utf8')).toBe('{ nope');
    writeFileSync(bad, '[1]');
    await expect(installHooks(runtimeIn(dir), bad, false)).rejects.toThrow('not a JSON object');
    writeFileSync(bad, '  ');
    await installHooks(runtimeIn(dir), bad, true);
    expect((await readJson(bad)).hooks).toMatchObject({ SessionEnd: [expect.anything()] });
  });

  it('status lists what is installed in the user, project, and named files', async () => {
    const dir = scratch();
    const runtime = runtimeIn(dir);
    await installHooks(runtime, runtime.userSettings, false);
    const other = join(dir, 'other.json');
    const statuses = await hookStatus(runtime, other);
    expect(statuses.map((item) => [item.scope, item.installed.length, item.retentionDays])).toEqual([
      ['user', 3, 365],
      ['project', 0, 30],
      ['file', 0, 30],
    ]);
    expect(await hookStatus(runtime, undefined)).toHaveLength(2);
  });

  it('removes only its own entries from a mixed group and leaves an unrelated command that contains hook-bin', async () => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    const mine = (arg: string) => ({ type: 'command', command: `"C:\\node\\node.exe" "C:\\oars\\dist\\hook-bin.js" ${arg}` });
    const theirs = { type: 'command', command: 'bash my-hook-bin.sh' };
    const rotation = { type: 'command', command: 'node rotate-session.js' };
    writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [theirs, mine('session-start')] }], SessionEnd: [{ hooks: [rotation, theirs] }] } }));
    await installHooks(runtimeIn(dir), file, true);
    const installed = JSON.stringify((await readJson(file)).hooks);
    expect(installed).toContain('my-hook-bin.sh');
    expect(installed).toContain('rotate-session.js');
    expect(installed.match(/hook-bin\.js\\" session-start/g)).toHaveLength(1);
    await uninstallHooks(file);
    const after = (await readJson(file)).hooks;
    expect(after).toEqual({ SessionStart: [{ hooks: [theirs] }], SessionEnd: [{ hooks: [rotation, theirs] }] });
  });

  it('rejects, changing nothing, when the settings path cannot be read (a directory here)', async () => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    mkdirSync(file);
    await expect(installHooks(runtimeIn(dir), file, false)).rejects.toThrow('nothing was changed');
    await expect(uninstallHooks(file)).rejects.toThrow('nothing was changed');
    expect(statSync(file).isDirectory()).toBe(true);
  });

  it('limits the failure hook to the Bash and PowerShell tools', async () => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    await installHooks(runtimeIn(dir), file, true);
    expect(JSON.stringify((await readJson(file)).hooks)).toContain('"matcher":"Bash|PowerShell"');
  });
});

describe('post-tool pre-filter', () => {
  // The registered command runs under the shell the harness uses for hooks (Git Bash on Windows); `cat` stands in for node so the
  // test sees whether the hook process would have been launched and what it would have read.
  const available = spawnSync('bash', ['-c', 'echo ok']).status === 0;
  const runCommand = (stdin: string): string => {
    const runtime = { ...runtimeIn('D:\\scratch'), nodePath: 'cat', hookBin: '-' };
    return spawnSync('bash', ['-c', commandOf(runtime, 'post-tool')], { input: stdin, encoding: 'utf8' }).stdout;
  };

  it.skipIf(!available)('launches the hook with the whole event when the error starts with Exit code', () => {
    const event = JSON.stringify({ tool_name: 'Bash', error: 'Exit code 2\nbad', hook_event_name: 'PostToolUseFailure' });
    expect(runCommand(`${event}\n`)).toContain(event);
  });

  it.skipIf(!available)('launches nothing for an event with no Exit code, and for empty input', () => {
    expect(runCommand(`${JSON.stringify({ tool_name: 'Bash', error: 'The user rejected this tool call', hook_event_name: 'PostToolUseFailure' })}\n`)).toBe('');
    expect(runCommand('')).toBe('');
  });
});

describe('settings paths', () => {
  it('resolves user, project, and file scopes, and requires a file for scope file', () => {
    const runtime = runtimeIn('D:\\scratch');
    expect(settingsPath(runtime, 'user', undefined)).toBe(runtime.userSettings);
    expect(settingsPath(runtime, 'project', undefined)).toBe(join(runtime.cwd, '.claude', 'settings.json'));
    expect(settingsPath(runtime, 'file', 'x.json')).toBe(join(runtime.cwd, 'x.json'));
    expect(() => settingsPath(runtime, 'file', undefined)).toThrow('--scope file needs --file');
  });
});

describe('retention floor', () => {
  const settle = async (initial: object | undefined, keep: boolean) => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    if (initial !== undefined) writeFileSync(file, JSON.stringify(initial));
    const result = await installHooks(runtimeIn(dir), file, keep);
    return { days: (await readJson(file)).cleanupPeriodDays, line: result.retention, file };
  };

  it('raises an unset value to 365 and says so', async () => {
    const { days, line, file } = await settle(undefined, false);
    expect(days).toBe(365);
    expect(line).toBe(`Raised cleanupPeriodDays from 30 (unset, the default) to 365 in ${file}.`);
  });

  it('raises a lower value to 365', async () => {
    const { days, line, file } = await settle({ cleanupPeriodDays: 90 }, false);
    expect(days).toBe(365);
    expect(line).toBe(`Raised cleanupPeriodDays from 90 to 365 in ${file}.`);
  });

  it('leaves an equal value', async () => {
    const { days, line } = await settle({ cleanupPeriodDays: 365 }, false);
    expect(days).toBe(365);
    expect(line).toContain('at or above the 365 floor');
  });

  it('never lowers a higher value (3650 stays 3650)', async () => {
    const { days, line } = await settle({ cleanupPeriodDays: 3650 }, false);
    expect(days).toBe(3650);
    expect(line).toContain('cleanupPeriodDays is 3650');
  });

  it('--keep-retention leaves an unset or a low value alone and says so', async () => {
    const unset = await settle(undefined, true);
    expect(unset.days).toBeUndefined();
    expect(unset.line).toContain('Left cleanupPeriodDays alone at 30 (unset, the default)');
    const low = await settle({ cleanupPeriodDays: 7 }, true);
    expect(low.days).toBe(7);
    expect(low.line).toContain('alone at 7 in');
  });

  it('reads the harness default when the file sets none', () => {
    expect(effectiveRetention({})).toBe(30);
    expect(effectiveRetention({ cleanupPeriodDays: 12 })).toBe(12);
  });
});

describe('nightly schedule', () => {
  it('builds a daily task definition that runs hook-bin nightly with the same node', () => {
    const args = scheduleArgs(runtimeIn('D:\\scratch'), 3);
    expect(args).toEqual(['/Create', '/TN', 'OarsSessionsNightly', '/TR', '"C:\\node\\node.exe" "C:\\oars\\dist\\hook-bin.js" nightly', '/SC', 'DAILY', '/ST', '03:00', '/F']);
  });

  it('registers and removes the task, and reports a failed registration', async () => {
    calls.length = 0;
    const runtime = runtimeIn('D:\\scratch');
    expect(await setSchedule(runtime, 'nightly')).toContain('daily at 03:00');
    expect(await setSchedule(runtime, 'off')).toContain('Removed');
    expect(calls.map((args) => args[0])).toEqual(['/Create', '/Delete']);
    await expect(setSchedule(runtimeIn('D:\\scratch', 1), 'nightly')).rejects.toThrow('Access is denied');
    expect(await setSchedule(runtimeIn('D:\\scratch', 1), 'off')).toContain('No scheduled task');
  });
});

describe('oars sessions hook (CLI)', () => {
  it('installs, reports status, and uninstalls through the command line, with the schedule', async () => {
    calls.length = 0;
    const dir = scratch();
    const { deps, out, err } = harness();
    deps.install = runtimeIn(dir);
    const file = join(dir, 's.json');
    expect(await run(['sessions', 'hook', 'install', '--scope', 'file', '--file', file, '--schedule', 'nightly'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('Installed SessionStart, PostToolUseFailure, SessionEnd hooks');
    expect(out.join('')).toContain('Scheduled task OarsSessionsNightly');
    out.length = 0;
    expect(await run(['sessions', 'hook', 'status', '--file', file], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('file: ');
    expect(out.join('')).toContain('Scheduled task OarsSessionsNightly: registered.');
    out.length = 0;
    expect(await run(['sessions', 'hook', 'uninstall', '--file', file, '--json'], deps)).toBe(ExitCode.OK);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: true, removed: ['SessionStart', 'PostToolUseFailure', 'SessionEnd'] });
    out.length = 0;
    expect(await run(['sessions', 'hook', 'uninstall', '--file', file], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('No Many Oars hooks');
    expect(await run(['sessions', 'hook', 'install', '--scope', 'file'], deps)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('--file');
    expect(await run(['sessions', 'hook', 'install', '--scope', 'galaxy'], deps)).toBe(ExitCode.USAGE);
    expect(await run(['sessions', 'hook', 'install', '--schedule', 'weekly'], deps)).toBe(ExitCode.USAGE);
  });

  it('--schedule alone writes no settings file, and a run without install config fails clearly', async () => {
    calls.length = 0;
    const dir = scratch();
    const { deps, out } = harness();
    const runtime = runtimeIn(dir);
    deps.install = runtime;
    expect(await run(['sessions', 'hook', 'install', '--schedule', 'off'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toBe('Removed the scheduled task OarsSessionsNightly.\n');
    expect(() => readFileSync(runtime.userSettings)).toThrow();
    const bare = harness();
    expect(await run(['sessions', 'hook', 'status'], bare.deps)).toBe(ExitCode.UNEXPECTED);
  });
});
