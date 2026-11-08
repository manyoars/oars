import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { sessionsHookInstall, sessionsHookUninstall } from './command.js';
import { commandOf, effectiveRetention, hookStatus, installHooks, readSettings, removeSchedule, SCHEDULE_REFUSED, scheduleStatus, settingsPath, uninstallHooks, type InstallRuntime } from './install.js';

afterEach(() => {
  removeTestDirs();
});

const calls: string[][] = [];

// Built per platform: a drive-letter literal is not absolute on Linux, so the resolver would prepend the cwd.
const SCRATCH = resolve(tmpdir(), 'oars-scratch');
const NODE = resolve(SCRATCH, 'node', 'node.exe');
const HOOK_BIN = resolve(SCRATCH, 'dist', 'hook-bin.js');

const runtimeIn = (dir: string, schtasksCode = 0, platform: NodeJS.Platform = 'linux'): InstallRuntime => ({
  platform,
  nodePath: NODE,
  hookBin: HOOK_BIN,
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
  it('creates the settings file with the five entries and the retention floor', async () => {
    const dir = scratch();
    const file = join(dir, 'new', 'settings.json');
    const result = await installHooks(runtimeIn(dir), file, false);
    const written = await readJson(file);
    expect(result.installed).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUseFailure', 'SessionEnd']);
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUseFailure', 'SessionEnd']) expect(written).toHaveProperty(['hooks', event]);
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
    const preTool: unknown = expect.stringMatching(/hook-bin\.js" pre-tool$/);
    expect(written.model).toBe('opus');
    expect(written.hooks).toMatchObject({ Stop: [rotation], SessionEnd: [expect.anything()], SessionStart: [expect.anything()], PreToolUse: [{ matcher: 'Bash', hooks: [] }, { hooks: [{ command: preTool }] }] });
  });

  it('writes the pre-tool entry with no matcher, so it runs on every tool', async () => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    await installHooks(runtimeIn(dir), file, false);
    const preTool: unknown = expect.stringMatching(/hook-bin\.js" pre-tool$/);
    const groups = (await readJson(file)).hooks;
    expect(groups).toMatchObject({ PreToolUse: [{ hooks: [{ command: preTool }] }] });
    expect(JSON.stringify(Reflect.get(Object(groups), 'PreToolUse'))).not.toContain('matcher');
  });

  it('replaces the old four-tool pre-tool entry and adds no second one', async () => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    const old = { matcher: 'PowerShell|Monitor|Edit|Agent', hooks: [{ type: 'command', command: '"C:/node/node.exe" "C:/oars/dist/hook-bin.js" pre-tool', timeout: 5 }] };
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [old] } }));
    await installHooks(runtimeIn(dir), file, false);
    const groups: unknown = Reflect.get(Object((await readJson(file)).hooks), 'PreToolUse');
    expect(groups).toHaveLength(1);
    expect(JSON.stringify(groups)).not.toContain('matcher');
  });

  it('removes a per-turn Stop entry the first build wrote and keeps the rotation hook, on install and on uninstall', async () => {
    const rotation = { hooks: [{ type: 'command', command: 'node rotate-session.js' }] };
    const old = { hooks: [{ type: 'command', command: '"C:/node/node.exe" "C:/oars/dist/hook-bin.js" stop' }] };
    for (const run of ['install', 'uninstall'] as const) {
      const dir = scratch();
      const file = join(dir, 'settings.json');
      writeFileSync(file, JSON.stringify({ hooks: { Stop: [rotation, old] } }));
      if (run === 'install') await installHooks(runtimeIn(dir), file, false);
      else await uninstallHooks(file);
      expect((await readJson(file)).hooks).toMatchObject({ Stop: [rotation] });
    }
  });

  it('uninstall removes only its own entries and prunes what it emptied', async () => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    const rotation = { hooks: [{ type: 'command', command: 'node rotate-session.js' }] };
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [rotation] } }));
    await installHooks(runtimeIn(dir), file, false);
    expect(await uninstallHooks(file)).toEqual({ file, removed: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUseFailure', 'SessionEnd'] });
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
      ['user', 5, 365],
      ['project', 0, 30],
      ['file', 0, 30],
    ]);
    expect(await hookStatus(runtime, undefined)).toHaveLength(2);
  });

  it('removes only its own entries from a mixed group and leaves an unrelated command that contains hook-bin', async () => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    const mine = (arg: string) => ({ type: 'command', command: `"${NODE}" "${HOOK_BIN}" ${arg}` });
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

  it('matches the failure hook to every tool the action table maps, and to MCP calls', async () => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    await installHooks(runtimeIn(dir), file, true);
    const groups: unknown = Reflect.get(Object((await readJson(file)).hooks), 'PostToolUseFailure');
    const matcher = String(Reflect.get(Object(Array.isArray(groups) ? groups[0] : {}), 'matcher'));
    const names = matcher.split('|');
    for (const tool of ['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'Grep', 'WebFetch']) expect(names).toContain(tool);
    expect(names).toContain('mcp__.*');
    expect(names.filter((name) => name.startsWith('mcp__') && name !== 'mcp__.*')).toEqual([]);
  });

  it('installs the prompt hook for UserPromptSubmit with no matcher', async () => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    await installHooks(runtimeIn(dir), file, true);
    const groups: unknown = Reflect.get(Object((await readJson(file)).hooks), 'UserPromptSubmit');
    expect(JSON.stringify(groups)).toContain('hook-bin.js\\" prompt');
    expect(JSON.stringify(groups)).not.toContain('matcher');
  });
});

describe('post-tool pre-filter', () => {
  // The registered command runs under the shell the harness uses for hooks (Git Bash on Windows); `cat` stands in for node so the
  // test sees whether the hook process would have been launched and what it would have read.
  // Resolve Git Bash explicitly: on Windows a bare `bash` on PATH can be the WSL launcher in System32, which is not the hook shell.
  const gitBash = join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe');
  const shell = process.platform === 'win32' ? gitBash : 'bash';
  const available = (process.platform !== 'win32' || existsSync(gitBash)) && spawnSync(shell, ['-c', 'echo ok'], { timeout: 30_000 }).status === 0;
  const runCommand = (stdin: string): string => {
    // The command guards on the hook-bin existing, so run it in a folder holding a file named `-`, which `cat` reads as stdin.
    const folder = scratch();
    writeFileSync(join(folder, '-'), '');
    const runtime = { ...runtimeIn(SCRATCH), nodePath: 'cat', hookBin: '-' };
    return spawnSync(shell, ['-c', commandOf(runtime, 'post-tool')], { input: stdin, encoding: 'utf8', timeout: 30_000, cwd: folder }).stdout;
  };

  it.skipIf(!available)('launches the hook with the whole event when the error starts with Exit code', () => {
    const event = JSON.stringify({ tool_name: 'Bash', error: 'Exit code 2\nbad', hook_event_name: 'PostToolUseFailure' });
    expect(runCommand(`${event}\n`)).toContain(event);
  }, 60_000);

  it.skipIf(!available)('launches nothing for an event with no Exit code, and for empty input', () => {
    expect(runCommand(`${JSON.stringify({ tool_name: 'Bash', error: 'The user rejected this tool call', hook_event_name: 'PostToolUseFailure' })}\n`)).toBe('');
    expect(runCommand('')).toBe('');
  }, 60_000);

  it.skipIf(!available)('sends a failure of a tool that is not a shell to the hook, with or without an Exit code line', () => {
    const event = JSON.stringify({ tool_name: 'Read', error: 'File does not exist.', hook_event_name: 'PostToolUseFailure' });
    expect(runCommand(`${event}
`)).toContain(event);
  }, 60_000);

  it.skipIf(!available)('starts no process for an event with no Exit code, and does for one with it', () => {
    // The 100 ms budget exists to spare the hook a node start, so assert that directly instead of a wall-clock bound that a loaded machine fails:
    // `touch` stands in for node and creates a file named after the hook argument, which exists only if the launch was reached.
    const launched = (error: string): boolean => {
      const folder = scratch();
      writeFileSync(join(folder, 'hook-bin.js'), '');
      const runtime = { ...runtimeIn(SCRATCH), nodePath: 'touch', hookBin: 'hook-bin.js' };
      const event = JSON.stringify({ tool_name: 'Bash', error, hook_event_name: 'PostToolUseFailure' });
      const result = spawnSync(shell, ['-c', commandOf(runtime, 'post-tool')], { input: `${event}\n`, encoding: 'utf8', timeout: 30_000, cwd: folder });
      expect(result.status).toBe(0);
      return existsSync(join(folder, 'post-tool'));
    };
    expect(launched('The user rejected this tool call')).toBe(false);
    expect(launched('Exit code 2\nbad')).toBe(true);
  }, 60_000);

  it.skipIf(!available)('launches the hook when the hook-bin is an existing absolute path', () => {
    const existing = join(scratch(), 'hook-bin.js');
    writeFileSync(existing, '');
    const runtime = { ...runtimeIn(SCRATCH), nodePath: 'echo', hookBin: existing };
    const result = spawnSync(shell, ['-c', commandOf(runtime, 'session-start')], { input: '{}\n', encoding: 'utf8', timeout: 30_000 });
    expect(result.stdout).toContain('session-start');
  }, 60_000);
});

describe('absent hook-bin', () => {
  const gitBash = join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe');
  const shell = process.platform === 'win32' ? gitBash : 'bash';
  const available = (process.platform !== 'win32' || existsSync(gitBash)) && spawnSync(shell, ['-c', 'echo ok'], { timeout: 30_000 }).status === 0;

  it.skipIf(!available)('exits 0 and prints nothing for every hook when the hook-bin is absent', () => {
    const missing = join(scratch(), 'dist', 'hook-bin.js');
    const runtime = { ...runtimeIn(SCRATCH), nodePath: 'definitely-not-a-program', hookBin: missing };
    for (const arg of ['session-start', 'post-tool', 'stop']) {
      const result = spawnSync(shell, ['-c', commandOf(runtime, arg)], { input: '{}\n', encoding: 'utf8', timeout: 30_000 });
      expect({ arg, status: result.status, out: result.stdout, err: result.stderr }).toEqual({ arg, status: 0, out: '', err: '' });
    }
  }, 60_000);

  it('keeps the ending uninstall matches, so the guarded commands are still taken out', async () => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    await installHooks(runtimeIn(dir), file, true);
    expect(JSON.stringify((await readJson(file)).hooks)).toContain('[ -f ');
    await uninstallHooks(file);
    expect((await readJson(file)).hooks).toBeUndefined();
  });
});

describe('settings paths', () => {
  it('resolves user, project, and file scopes, and requires a file for scope file', () => {
    const runtime = runtimeIn(SCRATCH);
    expect(settingsPath(runtime, 'user', undefined)).toBe(runtime.userSettings);
    expect(settingsPath(runtime, 'project', undefined)).toBe(join(runtime.cwd, '.claude', 'settings.json'));
    expect(settingsPath(runtime, 'file', 'x.json')).toBe(join(runtime.cwd, 'x.json'));
    const absolute = resolve(SCRATCH, 'elsewhere', 'x.json');
    expect(settingsPath(runtime, 'file', absolute)).toBe(absolute);
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

  it('keeps the larger of the user and project values, so a project install never lowers the user retention', async () => {
    const dir = scratch();
    const runtime = runtimeIn(dir);
    mkdirSync(join(dir, 'user'), { recursive: true });
    writeFileSync(runtime.userSettings, JSON.stringify({ cleanupPeriodDays: 3650 }));
    const file = join(dir, 'repo', '.claude', 'settings.json');
    const result = await installHooks(runtime, file, false);
    expect((await readJson(file)).cleanupPeriodDays).toBeUndefined();
    expect(result.retention).toContain(`3650 (from ${runtime.userSettings})`);
    expect(result.retention).toContain('left as is');
    writeFileSync(runtime.userSettings, JSON.stringify({ cleanupPeriodDays: 90 }));
    await installHooks(runtime, file, false);
    expect((await readJson(file)).cleanupPeriodDays).toBe(365);
  });

  it('raises a lower value the target file sets itself to the floor, never copying the user value into the file', async () => {
    const dir = scratch();
    const runtime = runtimeIn(dir);
    mkdirSync(join(dir, 'user'), { recursive: true });
    writeFileSync(runtime.userSettings, JSON.stringify({ cleanupPeriodDays: 3650 }));
    const file = join(dir, 'repo', '.claude', 'settings.json');
    mkdirSync(join(dir, 'repo', '.claude'), { recursive: true });
    writeFileSync(file, JSON.stringify({ cleanupPeriodDays: 30 }));
    const result = await installHooks(runtime, file, false);
    expect((await readJson(file)).cleanupPeriodDays).toBe(365);
    expect(result.retention).toContain('Raised cleanupPeriodDays from 30 to 365');
  });

  it('reports a user value under 30 as the retention in force when the file sets no number, not the default', async () => {
    const dir = scratch();
    const runtime = runtimeIn(dir);
    mkdirSync(join(dir, 'user'), { recursive: true });
    writeFileSync(runtime.userSettings, JSON.stringify({ cleanupPeriodDays: 20 }));
    const file = join(dir, 'repo', '.claude', 'settings.json');
    const kept = await installHooks(runtime, file, true);
    expect(kept.retention).toContain(`alone at 20 (from ${runtime.userSettings})`);
    expect(kept.retention).not.toContain('unset, the default');
  });

  it('reports a user value of 0 as the retention in force, not the default (0 is a value, not "unset")', async () => {
    const dir = scratch();
    const runtime = runtimeIn(dir);
    mkdirSync(join(dir, 'user'), { recursive: true });
    writeFileSync(runtime.userSettings, JSON.stringify({ cleanupPeriodDays: 0 }));
    const file = join(dir, 'repo', '.claude', 'settings.json');
    const kept = await installHooks(runtime, file, true);
    expect(kept.retention).toContain(`alone at 0 (from ${runtime.userSettings})`);
    expect(kept.retention).not.toContain('unset, the default');
  });

  it('raises a user value of 0 to the floor in the target file when --keep-retention is off', async () => {
    const dir = scratch();
    const runtime = runtimeIn(dir);
    mkdirSync(join(dir, 'user'), { recursive: true });
    writeFileSync(runtime.userSettings, JSON.stringify({ cleanupPeriodDays: 0 }));
    const file = join(dir, 'repo', '.claude', 'settings.json');
    const raised = await installHooks(runtime, file, false);
    expect(raised.retention).toBe(`Raised cleanupPeriodDays from 0 (from ${runtime.userSettings}) to 365 in ${file}.`);
    expect((await readJson(file)).cleanupPeriodDays).toBe(365);
  });

  it('reads the harness default when the file sets none', () => {
    expect(effectiveRetention({})).toBe(30);
    expect(effectiveRetention({ cleanupPeriodDays: 12 })).toBe(12);
  });
});

/** A Windows runtime whose `schtasks` answers `/Query` with `present` (0 or 1) and `/Delete` with `deleteCode`, recording every call. */
const windowsWith = (dir: string, present: boolean, deleteCode = 0): InstallRuntime => ({
  ...runtimeIn(dir, 0, 'win32'),
  schtasks: (args) => {
    calls.push(args);
    const code = args[0] === '/Query' ? (present ? 0 : 1) : args[0] === '/Delete' ? deleteCode : 99;
    return Promise.resolve({ code, output: code === 0 ? 'SUCCESS' : 'ERROR: Access is denied.' });
  },
});

describe('the task an earlier version registered', () => {
  const plain = { scope: 'file' as const, keepRetention: false, schedule: undefined };
  const alone = { scope: undefined, file: undefined, keepRetention: false };
  const verbs = (): string[] => calls.map((args) => args[0] ?? '');

  it('is removed and reported when it is there', async () => {
    calls.length = 0;
    const line = await removeSchedule(windowsWith(SCRATCH, true));
    expect(verbs()).toEqual(['/Query', '/Delete']);
    expect(calls[1]).toEqual(['/Delete', '/TN', 'OarsSessionsNightly', '/F']);
    expect(line).toContain('Removed the scheduled task OarsSessionsNightly');
    expect(line).toContain('sends now ride the session-end hook and any oars command');
  });

  it('is not deleted when it is not there: one query, no delete, nothing said', async () => {
    calls.length = 0;
    expect(await removeSchedule(windowsWith(SCRATCH, false))).toBeUndefined();
    expect(verbs()).toEqual(['/Query']);
  });

  it('is never queried off Windows', async () => {
    calls.length = 0;
    expect(await removeSchedule(runtimeIn(SCRATCH, 0, 'linux'))).toBeUndefined();
    expect(await removeSchedule(runtimeIn(SCRATCH, 0, 'darwin'))).toBeUndefined();
    expect(await scheduleStatus(runtimeIn(SCRATCH, 0, 'linux'))).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('is reported, not failed, when Windows refuses to remove it, with the command to run', async () => {
    calls.length = 0;
    const line = await removeSchedule(windowsWith(SCRATCH, true, 1));
    expect(line).toContain('Could not remove the scheduled task OarsSessionsNightly (ERROR: Access is denied.)');
    expect(line).toContain('schtasks /Delete /TN OarsSessionsNightly /F');
  });

  it('shows in status while it is there, and not once it is gone', async () => {
    expect(await scheduleStatus(windowsWith(SCRATCH, true))).toContain('registered by an earlier version');
    expect(await scheduleStatus(windowsWith(SCRATCH, false))).toBeUndefined();
  });

  it('is removed by a plain hook install, which says so in its own line', async () => {
    calls.length = 0;
    const dir = scratch();
    const outcome = await sessionsHookInstall({ sessions: undefined, install: windowsWith(dir, true), now: () => 0 }, { ...plain, file: join(dir, 's.json') });
    expect(verbs()).toEqual(['/Query', '/Delete']);
    expect(outcome.text).toContain('Installed SessionStart');
    expect(outcome.text.split('\n').filter((line) => line.includes('Removed the scheduled task'))).toHaveLength(1);
    expect(JSON.stringify(outcome.document)).toContain('Removed the scheduled task');
  });

  it('is not touched by a hook install when absent, or on another platform, and the document has no schedule', async () => {
    const dir = scratch();
    calls.length = 0;
    const absent = await sessionsHookInstall({ sessions: undefined, install: windowsWith(dir, false), now: () => 0 }, { ...plain, file: join(dir, 'a.json') });
    expect(verbs()).toEqual(['/Query']);
    expect(absent.document).not.toHaveProperty('schedule');
    calls.length = 0;
    const linux = await sessionsHookInstall({ sessions: undefined, install: runtimeIn(dir, 0, 'linux'), now: () => 0 }, { ...plain, file: join(dir, 'b.json') });
    expect(calls).toEqual([]);
    expect(linux.document).not.toHaveProperty('schedule');
  });

  it('is removed by a hook uninstall too, and said in the same output', async () => {
    calls.length = 0;
    const dir = scratch();
    const file = join(dir, 's.json');
    await sessionsHookInstall({ sessions: undefined, install: runtimeIn(dir, 0, 'linux'), now: () => 0 }, { ...plain, file });
    const outcome = await sessionsHookUninstall({ sessions: undefined, install: windowsWith(dir, true), now: () => 0 }, { scope: 'file', file });
    expect(verbs()).toEqual(['/Query', '/Delete']);
    expect(outcome.text).toContain('Removed SessionStart');
    expect(outcome.text).toContain('Removed the scheduled task OarsSessionsNightly');
    expect(outcome.document).toMatchObject({ ok: true });
    expect(JSON.stringify(outcome.document)).toContain('Removed the scheduled task');
  });

  it('is left alone by an uninstall when absent', async () => {
    calls.length = 0;
    const dir = scratch();
    const outcome = await sessionsHookUninstall({ sessions: undefined, install: windowsWith(dir, false), now: () => 0 }, { scope: 'file', file: join(dir, 'none.json') });
    expect(verbs()).toEqual(['/Query']);
    expect(outcome.text).toBe(`No Many Oars hooks in ${join(dir, 'none.json')}.`);
    expect(outcome.document).not.toHaveProperty('schedule');
  });

  it('is never registered: --schedule nightly is refused before anything is written, in one line', async () => {
    calls.length = 0;
    const dir = scratch();
    const file = join(dir, 's.json');
    const refused = sessionsHookInstall({ sessions: undefined, install: windowsWith(dir, false), now: () => 0 }, { ...plain, file, schedule: 'nightly' });
    await expect(refused).rejects.toThrow(SCHEDULE_REFUSED);
    expect(SCHEDULE_REFUSED).not.toContain('\n');
    expect(SCHEDULE_REFUSED).toContain('sends now ride the session-end hook and any oars command');
    expect(calls).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it('--schedule off records the opt-out and says so; --schedule on clears it', async () => {
    const dir = scratch();
    const store = join(dir, 'sessions');
    const deps = { sessions: { storeDir: store, projectsRoot: join(dir, 'projects'), stdin: process.stdin, stdout: { write: () => true } }, install: runtimeIn(dir, 0, 'linux'), now: () => 0 };
    const off = await sessionsHookInstall(deps, { ...alone, schedule: 'off' });
    expect(readFileSync(join(store, 'schedule.json'), 'utf8')).toBe('{"schedule":"off"}\n');
    expect(off.document).toMatchObject({ ok: true, sends: 'off' });
    expect(off.text).toContain('Background sweeps and sends are off');
    expect(off.text).toContain('--schedule on');
    const on = await sessionsHookInstall(deps, { ...alone, schedule: 'on' });
    expect(existsSync(join(store, 'schedule.json'))).toBe(false);
    expect(on.document).toMatchObject({ ok: true, sends: 'on' });
    expect(on.text).toContain('Background sweeps and sends are on');
    expect(on.text).not.toContain('No scheduled task');
  });

  it('--schedule off on Linux or macOS says there is no task to remove, and on Windows with none says the same without the platform note', async () => {
    const dir = scratch();
    const deps = { sessions: undefined, install: runtimeIn(dir, 0, 'linux'), now: () => 0 };
    const linux = await sessionsHookInstall(deps, { ...alone, schedule: 'off' });
    expect(linux.text.split('\n')[0]).toBe('No scheduled task to remove (only Windows ever had one).');
    const windows = await sessionsHookInstall({ ...deps, install: windowsWith(dir, false) }, { ...alone, schedule: 'off' });
    expect(windows.text.split('\n')[0]).toBe('No scheduled task to remove.');
  });

  it('--schedule off alone writes no settings file and only removes the task', async () => {
    calls.length = 0;
    const dir = scratch();
    const { deps, out } = harness();
    const runtime = windowsWith(dir, true);
    deps.install = runtime;
    expect(await run(['sessions', 'hook', 'install', '--schedule', 'off'], deps)).toBe(ExitCode.OK);
    expect(verbs()).toEqual(['/Query', '/Delete']);
    expect(out.join('')).toContain('Removed the scheduled task OarsSessionsNightly');
    expect(() => readFileSync(runtime.userSettings)).toThrow();
  });
});

describe('oars sessions hook (CLI)', () => {
  it('installs, reports status, and uninstalls through the command line, and refuses --schedule nightly', async () => {
    calls.length = 0;
    const dir = scratch();
    const { deps, out, err } = harness();
    deps.install = runtimeIn(dir);
    const file = join(dir, 's.json');
    expect(await run(['sessions', 'hook', 'install', '--scope', 'file', '--file', file], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('Installed SessionStart, UserPromptSubmit, PreToolUse, PostToolUseFailure, SessionEnd hooks');
    expect(await run(['sessions', 'hook', 'install', '--scope', 'file', '--file', file, '--schedule', 'nightly'], deps)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('sends now ride the session-end hook and any oars command');
    err.length = 0;
    out.length = 0;
    expect(await run(['sessions', 'hook', 'status', '--file', file], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('file: ');
    expect(out.join('')).not.toContain('Scheduled task');
    out.length = 0;
    deps.install = windowsWith(dir, true);
    expect(await run(['sessions', 'hook', 'status', '--file', file], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('registered by an earlier version');
    deps.install = runtimeIn(dir);
    out.length = 0;
    expect(await run(['sessions', 'hook', 'uninstall', '--file', file, '--json'], deps)).toBe(ExitCode.OK);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: true, removed: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUseFailure', 'SessionEnd'] });
    out.length = 0;
    expect(await run(['sessions', 'hook', 'uninstall', '--file', file], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('No Many Oars hooks');
    expect(await run(['sessions', 'hook', 'install', '--scope', 'file'], deps)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('--file');
    expect(await run(['sessions', 'hook', 'install', '--scope', 'galaxy'], deps)).toBe(ExitCode.USAGE);
    expect(await run(['sessions', 'hook', 'install', '--schedule', 'weekly'], deps)).toBe(ExitCode.USAGE);
  });

  it('a run without install config fails clearly', async () => {
    const bare = harness();
    expect(await run(['sessions', 'hook', 'status'], bare.deps)).toBe(ExitCode.UNEXPECTED);
  });
});
