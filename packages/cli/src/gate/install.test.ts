import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import type { InstallRuntime } from '../sessions/install.js';
import { cleanup, stage } from '../sessions/test-support.js';
import { harness, removeTestDirs } from '../test-support.js';
import { COMMAND, EVENT, installGateHook, MATCHER, uninstallGateHook } from './install.js';

afterEach(() => {
  cleanup();
  removeTestDirs();
});

interface Settings {
  [key: string]: unknown;
}

const scratch = (): string => mkdtempSync(join(tmpdir(), 'oars-gate-install-'));
const read = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
const vendorHook = { type: 'command', command: 'other-vendor audit', timeout: 3 };
const vendor = { matcher: 'Bash', hooks: [vendorHook] };
const ours = { matcher: MATCHER, hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] };

describe('gate install', () => {
  it('creates the settings file with one PreToolUse entry for Bash, PowerShell, Skill, and MCP tools', async () => {
    const file = join(scratch(), 'claude', 'settings.json');
    expect(await installGateHook(file)).toEqual({ file, changed: true });
    expect(read(file)).toEqual({ hooks: { [EVENT]: [ours] } });
    expect(MATCHER.split('|')).toEqual(['Bash', 'PowerShell', 'Skill', 'mcp__.*']);
  });

  it('calls the installed binary, never npx', () => {
    expect(COMMAND).toBe('command -v oars >/dev/null 2>&1 || exit 0; oars gate hook >/dev/null 2>&1; exit 0');
    expect(COMMAND).not.toContain('npx');
  });

  it('changes nothing on a rerun: no write, same bytes', async () => {
    const file = join(scratch(), 'settings.json');
    await installGateHook(file);
    const before = readFileSync(file, 'utf8');
    expect(await installGateHook(file)).toEqual({ file, changed: false });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  const table: { name: string; settings: Settings; expected: Settings }[] = [
    {
      name: "another vendor's PreToolUse hook, and keys and events of other kinds",
      settings: { model: 'x', env: { A: '1' }, hooks: { [EVENT]: [vendor], SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] }, permissions: { allow: ['Bash(ls)'] } },
      expected: { model: 'x', env: { A: '1' }, hooks: { [EVENT]: [vendor, ours], SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] }, permissions: { allow: ['Bash(ls)'] } },
    },
    { name: 'an empty file object', settings: {}, expected: { hooks: { [EVENT]: [ours] } } },
    { name: 'a hooks key with other events only', settings: { hooks: { Stop: [] } }, expected: { hooks: { Stop: [], [EVENT]: [ours] } } },
    {
      name: 'our entry sharing a group with the operator hook',
      settings: { hooks: { [EVENT]: [{ matcher: 'Bash', hooks: [vendorHook, { type: 'command', command: COMMAND }] }] } },
      expected: { hooks: { [EVENT]: [{ matcher: 'Bash', hooks: [vendorHook] }, ours] } },
    },
    {
      name: 'our entry already in place, with a group after it',
      settings: { hooks: { [EVENT]: [ours, vendor] } },
      expected: { hooks: { [EVENT]: [ours, vendor] } },
    },
    {
      name: 'our entry with an older matcher',
      settings: { hooks: { [EVENT]: [{ matcher: 'Bash', hooks: [{ type: 'command', command: COMMAND }] }, vendor] } },
      expected: { hooks: { [EVENT]: [ours, vendor] } },
    },
  ];
  it.each(table)('keeps every other key and hook as parsed JSON: $name', async ({ settings, expected }) => {
    const file = join(scratch(), 'settings.json');
    writeFileSync(file, JSON.stringify(settings));
    await installGateHook(file);
    expect(read(file)).toEqual(expected);
    expect(await installGateHook(file)).toMatchObject({ changed: false });
  });

  it.each([
    ['text that is not JSON', '{ hooks: '],
    ['a JSON array', '[]'],
    ['a hooks key that is a string', '{"hooks":"x"}'],
    ['a PreToolUse key that is an object', '{"hooks":{"PreToolUse":{}}}'],
  ])('refuses %s and writes nothing', async (_name, body) => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    writeFileSync(file, body);
    await expect(installGateHook(file)).rejects.toBeInstanceOf(CliError);
    await expect(uninstallGateHook(file)).rejects.toBeInstanceOf(CliError);
    expect(readFileSync(file, 'utf8')).toBe(body);
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });

  it('writes through a temp file and leaves none behind', async () => {
    const dir = scratch();
    await installGateHook(join(dir, 'settings.json'));
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });
});

describe('gate install on POSIX files', () => {
  const windows = process.platform === 'win32';

  it.skipIf(windows)('keeps the mode an operator set, and creates a new file 0600', async () => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ env: { TOKEN: 'x' } }));
    chmodSync(file, 0o600);
    await installGateHook(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const loose = join(dir, 'loose.json');
    writeFileSync(loose, '{}');
    chmodSync(loose, 0o640);
    await installGateHook(loose);
    expect(statSync(loose).mode & 0o777).toBe(0o640);
    const fresh = join(dir, 'fresh', 'settings.json');
    await installGateHook(fresh);
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
  });

  it.skipIf(windows)('keeps a symlinked settings file a symlink, and writes through it', async () => {
    const dir = scratch();
    const real = join(dir, 'dotfiles', 'settings.json');
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, JSON.stringify({ model: 'x' }));
    const link = join(dir, 'claude-settings.json');
    symlinkSync(real, link);
    await installGateHook(link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(read(real)).toEqual({ model: 'x', hooks: { [EVENT]: [ours] } });
    await uninstallGateHook(link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(read(real)).toEqual({ model: 'x' });
  });
});

describe('gate uninstall', () => {
  it('removes only its own entry and keeps the operator hook and every other key', async () => {
    const file = join(scratch(), 'settings.json');
    writeFileSync(file, JSON.stringify({ model: 'x', hooks: { [EVENT]: [vendor], Stop: [] } }));
    await installGateHook(file);
    expect(await uninstallGateHook(file)).toEqual({ file, removed: true });
    expect(read(file)).toEqual({ model: 'x', hooks: { [EVENT]: [vendor], Stop: [] } });
  });

  it('drops the event and the hooks key it emptied, and nothing else', async () => {
    const file = join(scratch(), 'settings.json');
    writeFileSync(file, JSON.stringify({ model: 'x' }));
    await installGateHook(file);
    await uninstallGateHook(file);
    expect(read(file)).toEqual({ model: 'x' });
  });

  it('keeps the other hooks of a group that shared our entry', async () => {
    const file = join(scratch(), 'settings.json');
    writeFileSync(file, JSON.stringify({ hooks: { [EVENT]: [{ matcher: 'Bash', hooks: [vendorHook, { type: 'command', command: COMMAND }] }] } }));
    await uninstallGateHook(file);
    expect(read(file)).toEqual({ hooks: { [EVENT]: [{ matcher: 'Bash', hooks: [vendorHook] }] } });
  });

  it('is a no-op, writing nothing, when the file is missing or holds no entry of ours', async () => {
    const dir = scratch();
    const missing = join(dir, 'none.json');
    expect(await uninstallGateHook(missing)).toEqual({ file: missing, removed: false });
    expect(existsSync(missing)).toBe(false);
    const file = join(dir, 'settings.json');
    const body = JSON.stringify({ hooks: { [EVENT]: [vendor] } });
    writeFileSync(file, body);
    expect(await uninstallGateHook(file)).toEqual({ file, removed: false });
    expect(readFileSync(file, 'utf8')).toBe(body);
  });
});

describe('the installed command', () => {
  // The harness runs hooks in a POSIX shell (Git Bash on Windows). Find one by absolute path so the test can give it a PATH that holds no `oars`.
  const findShell = (): string | undefined => {
    const names = process.platform === 'win32' ? ['sh.exe', 'bash.exe'] : ['sh'];
    const extra = process.platform === 'win32' ? [join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'usr', 'bin')] : [];
    for (const root of (process.env.PATH ?? '').split(delimiter).concat(extra)) {
      for (const name of names) {
        if (root !== '' && existsSync(join(root, name))) return join(root, name);
      }
    }
    return undefined;
  };
  const shell = findShell();

  it.skipIf(shell === undefined)('exits 0 with empty stdout when oars is not on the PATH', () => {
    const bare = scratch();
    const result = spawnSync(shell ?? '', ['-c', COMMAND], { input: '{"tool_name":"Bash"}', encoding: 'utf8', timeout: 30_000, env: { PATH: bare } });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  }, 60_000);

  it.skipIf(shell === undefined || process.platform === 'win32')('runs oars gate hook when it is on the PATH', () => {
    const bin = scratch();
    const script = join(bin, 'oars');
    writeFileSync(script, '#!/bin/sh\necho "ran $*" > "$MARK"\n');
    chmodSync(script, 0o755);
    const mark = join(bin, 'mark.txt');
    const result = spawnSync(shell ?? '', ['-c', COMMAND], { encoding: 'utf8', timeout: 30_000, env: { PATH: `${bin}${delimiter}${dirname(shell ?? '')}`, MARK: mark } });
    expect(result.status).toBe(0);
    expect(readFileSync(mark, 'utf8')).toBe('ran gate hook\n');
  }, 60_000);

  // Exit 2 from a PreToolUse hook blocks the tool call, and an `oars` without `gate hook` (a rollback, an older install) exits 2 with output.
  it.skipIf(shell === undefined)('exits 0 with empty stdout when oars prints and exits 2', () => {
    const bin = scratch();
    const script = join(bin, 'oars');
    writeFileSync(script, '#!/bin/sh\necho "unknown command"\necho "usage" >&2\nexit 2\n');
    chmodSync(script, 0o755);
    const result = spawnSync(shell ?? '', ['-c', COMMAND], { encoding: 'utf8', timeout: 30_000, env: { PATH: `${bin}${delimiter}${dirname(shell ?? '')}` } });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  }, 60_000);
});

describe('oars gate install and uninstall', () => {
  const setup = () => {
    const dir = scratch();
    const h = harness();
    const userSettings = join(dir, 'claude', 'settings.json');
    const staged = stage();
    const storeDir = staged.storeDir;
    const install: InstallRuntime = { nodePath: 'node', hookBin: 'hook-bin.js', userSettings, cwd: dir, schtasks: () => Promise.resolve({ code: 0, output: '' }) };
    h.deps.install = install;
    h.deps.sessions = staged.runtime;
    return { ...h, userSettings, storeDir };
  };

  it('installs at user scope, says what changed, and says nothing changed on a rerun', async () => {
    const { deps, out, userSettings } = setup();
    expect(await run(['gate', 'install'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain(`Installed the gate hook in ${userSettings}`);
    expect(read(userSettings)).toEqual({ hooks: { [EVENT]: [ours] } });
    out.length = 0;
    expect(await run(['gate', 'install'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('already installed');
    out.length = 0;
    expect(await run(['--json', 'gate', 'install'], deps)).toBe(ExitCode.OK);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: true, changed: false, event: EVENT, matcher: MATCHER, command: COMMAND });
  });

  it('tells the operator a replay seeds the index when a record exists with none', async () => {
    const { deps, out, storeDir } = setup();
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, 'crossings.jsonl'), '{"kind":"run"}\n');
    await run(['gate', 'install'], deps);
    expect(out.join('')).toContain('oars gate replay');
  });

  it('uninstalls, then reports there is nothing to remove', async () => {
    const { deps, out, userSettings } = setup();
    await run(['gate', 'install'], deps);
    out.length = 0;
    expect(await run(['gate', 'uninstall'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('Removed the gate hook');
    expect(read(userSettings)).toEqual({});
    out.length = 0;
    expect(await run(['--json', 'gate', 'uninstall'], deps)).toBe(ExitCode.OK);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: true, removed: false });
  });

  it('refuses unparsable settings with a usage error and leaves the file alone', async () => {
    const { deps, err, userSettings } = setup();
    mkdirSync(dirname(userSettings), { recursive: true });
    writeFileSync(userSettings, 'not json');
    expect(await run(['gate', 'install'], deps)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('nothing was changed');
    expect(readFileSync(userSettings, 'utf8')).toBe('not json');
  });

  it('fails plainly when this run has no install runtime', async () => {
    const { deps } = setup();
    deps.install = undefined;
    expect(await run(['gate', 'install'], deps)).toBe(ExitCode.UNEXPECTED);
    expect(await run(['gate', 'uninstall'], deps)).toBe(ExitCode.UNEXPECTED);
  });
});
