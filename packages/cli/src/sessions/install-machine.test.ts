// `oars sessions hook install --machine`: the host-independent entries a cloud VM, a VPS, or a runner runs, and the enrollment block of a user-scope file.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness } from '../test-support.js';
import { sessionsHookInstall, sessionsHookStatus, sessionsHookUninstall } from './command.js';
import { groupsOf, hasOwn, hooksOf, MACHINE_COMMAND, readSettings, type InstallRuntime } from './install.js';
import { machineOf } from './machine.js';

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'oars-machine-install-'));
  made.push(dir);
  return dir;
};

// Built per platform, like install.test.ts: a drive-letter literal is not absolute on Linux.
const NODE = resolve(tmpdir(), 'oars-scratch', 'node', 'node.exe');
const HOOK_BIN = resolve(tmpdir(), 'oars-scratch', 'dist', 'hook-bin.js');

const runtimeIn = (dir: string): InstallRuntime => ({
  platform: 'linux',
  nodePath: NODE,
  hookBin: HOOK_BIN,
  userSettings: join(dir, 'user', 'settings.json'),
  cwd: join(dir, 'repo'),
  schtasks: () => Promise.resolve({ code: 1, output: 'none' }),
});

const depsIn = (dir: string): Parameters<typeof sessionsHookInstall>[0] => ({ sessions: undefined, install: runtimeIn(dir), now: () => 0 });
const base = { scope: undefined, file: undefined, keepRetention: false, schedule: undefined } as const;
const mode = (file: string): number => statSync(file).mode & 0o777;
const isPosix = process.platform !== 'win32';

describe('hook install --machine at project scope', () => {
  it('writes the Stop and SessionEnd entries, and the command names no install path', async () => {
    const dir = scratch();
    const file = join(dir, 'repo', '.claude', 'settings.json');
    const outcome = await sessionsHookInstall(depsIn(dir), { ...base, scope: 'project', machine: true });
    const settings = await readSettings(file);
    const hooks = hooksOf(settings);
    expect(Object.keys(hooks).sort()).toEqual(['SessionEnd', 'Stop']);
    for (const event of ['Stop', 'SessionEnd']) {
      expect(groupsOf(hooks, event)).toEqual([{ hooks: [{ type: 'command', command: MACHINE_COMMAND, timeout: 10 }] }]);
    }
    expect(MACHINE_COMMAND).toBe('command -v oars-hook >/dev/null || exit 0; oars-hook stop --machine');
    // Nothing of the installing machine is in the file: not its node, not its hook-bin, not its checkout.
    const written = readFileSync(file, 'utf8');
    for (const own of [NODE, HOOK_BIN, dir, 'hook-bin', '[ -f']) expect(written).not.toContain(JSON.stringify(own).slice(1, -1));
    expect(settings).not.toHaveProperty('env');
    expect(settings).not.toHaveProperty('cleanupPeriodDays');
    expect(outcome.text).toContain('OARS_HOST_CLASS');
  });

  it('is removed by uninstall, with the operator hooks and settings left', async () => {
    const dir = scratch();
    const file = join(dir, 'repo', '.claude', 'settings.json');
    mkdirSync(join(dir, 'repo', '.claude'), { recursive: true });
    const theirs = { type: 'command', command: 'echo theirs' };
    writeFileSync(file, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [theirs] }], SessionEnd: [{ hooks: [theirs] }] } }));
    await sessionsHookInstall(depsIn(dir), { ...base, scope: 'project', machine: true });
    const installed = hooksOf(await readSettings(file));
    expect(hasOwn(groupsOf(installed, 'Stop'))).toBe(true);
    expect(hasOwn(groupsOf(installed, 'SessionEnd'))).toBe(true);
    expect(groupsOf(installed, 'Stop')).toHaveLength(2);
    // Installed twice is still one entry of ours per event.
    await sessionsHookInstall(depsIn(dir), { ...base, scope: 'project', machine: true });
    expect(groupsOf(hooksOf(await readSettings(file)), 'Stop')).toHaveLength(2);
    const outcome = await sessionsHookUninstall(depsIn(dir), { scope: 'project', file: undefined });
    expect(outcome.document).toMatchObject({ ok: true, removed: ['SessionEnd', 'Stop'] });
    const after = await readSettings(file);
    expect(after.model).toBe('opus');
    expect(hooksOf(after)).toEqual({ Stop: [{ hooks: [theirs] }], SessionEnd: [{ hooks: [theirs] }] });
  });

  it('refuses --env and --terms-file at project scope: that file is committed', async () => {
    const dir = scratch();
    const file = join(dir, 'repo', '.claude', 'settings.json');
    await expect(sessionsHookInstall(depsIn(dir), { ...base, scope: 'project', machine: true, env: ['OARS_HOST_CLASS=cloud'] })).rejects.toMatchObject({ exitCode: ExitCode.USAGE });
    await expect(sessionsHookInstall(depsIn(dir), { ...base, scope: 'project', machine: true, termsFile: 'terms.txt' })).rejects.toMatchObject({ exitCode: ExitCode.USAGE });
    expect(existsSync(file)).toBe(false);
  });

  it('refuses a file scope, a harness, and a schedule beside --machine, and --env without --machine', async () => {
    const dir = scratch();
    await expect(sessionsHookInstall(depsIn(dir), { ...base, scope: 'file', file: join(dir, 'x.json'), machine: true })).rejects.toThrow('--scope project');
    await expect(sessionsHookInstall(depsIn(dir), { ...base, machine: true, harness: 'codex' })).rejects.toThrow('do not apply');
    await expect(sessionsHookInstall(depsIn(dir), { ...base, machine: true, schedule: 'off' })).rejects.toThrow('do not apply');
    await expect(sessionsHookInstall(depsIn(dir), { ...base, env: ['OARS_HOST_CLASS=vps'] })).rejects.toThrow('belong to --machine');
  });

  it('refuses --keep-retention and --file beside --machine: it leaves the retention alone and names no file', async () => {
    const dir = scratch();
    await expect(sessionsHookInstall(depsIn(dir), { ...base, scope: 'user', machine: true, keepRetention: true, env: ['OARS_HOST_CLASS=vps'] })).rejects.toThrow('--keep-retention');
    await expect(sessionsHookInstall(depsIn(dir), { ...base, scope: 'user', machine: true, file: join(dir, 'x.json'), env: ['OARS_HOST_CLASS=vps'] })).rejects.toThrow('--file');
    expect(existsSync(join(dir, 'user', 'settings.json'))).toBe(false);
  });
});

describe('hook install --machine at user scope', () => {
  it('writes the enrollment block to the env block, keeps the operator entries, and makes the file owner-only', async () => {
    const dir = scratch();
    const file = join(dir, 'user', 'settings.json');
    mkdirSync(join(dir, 'user'), { recursive: true });
    writeFileSync(file, JSON.stringify({ env: { KEEP: 'me', OARS_HOST_CLASS: 'old' } }), { mode: 0o644 });
    const outcome = await sessionsHookInstall(depsIn(dir), {
      ...base,
      scope: 'user',
      machine: true,
      env: ['OARS_HOST_CLASS=vps', 'OARS_LAUNCHER=cron', 'OARS_ALLOW_REPOS=acme/api,acme/web', 'OARS_REPO_SALT=salt-a', 'OARS_EXCLUSION_TERMS_INLINE=acme corp\nsecret project'],
    });
    const settings = await readSettings(file);
    expect(settings.env).toEqual({ KEEP: 'me', OARS_HOST_CLASS: 'vps', OARS_LAUNCHER: 'cron', OARS_ALLOW_REPOS: 'acme/api,acme/web', OARS_REPO_SALT: 'salt-a', OARS_EXCLUSION_TERMS_INLINE: 'acme corp\nsecret project' });
    expect(hasOwn(groupsOf(hooksOf(settings), 'Stop'))).toBe(true);
    if (isPosix) expect(mode(file)).toBe(0o600);
    expect(outcome.text).toContain('owner only');
    // The gate and the block read back as one machine configuration.
    expect(machineOf({ OARS_HOST_CLASS: 'vps', OARS_LAUNCHER: 'cron', OARS_ALLOW_REPOS: 'acme/api,acme/web' })).toEqual({ hostClass: 'vps', launcher: 'cron', machine: undefined, allowRepos: ['acme/api', 'acme/web'] });
  });

  it('moves the terms to an owner-only file with --terms-file, and the settings file holds no term', async () => {
    const dir = scratch();
    const file = join(dir, 'user', 'settings.json');
    const termsFile = join(dir, 'terms', 'exclude.txt');
    const outcome = await sessionsHookInstall(depsIn(dir), { ...base, scope: 'user', machine: true, env: ['OARS_HOST_CLASS=vps', 'OARS_EXCLUSION_TERMS_INLINE=acme corp'], termsFile });
    const settings = await readSettings(file);
    expect(settings.env).toEqual({ OARS_HOST_CLASS: 'vps', OARS_EXCLUSION_TERMS: termsFile });
    expect(readFileSync(file, 'utf8')).not.toContain('acme corp');
    expect(readFileSync(termsFile, 'utf8')).toBe('acme corp\n');
    if (isPosix) {
      expect(mode(file)).toBe(0o600);
      expect(mode(termsFile)).toBe(0o600);
    }
    expect(outcome.text).toContain('OARS_EXCLUSION_TERMS');
  });

  it('a re-install that moves the terms to --terms-file leaves no inline terms in the settings file', async () => {
    const dir = scratch();
    const file = join(dir, 'user', 'settings.json');
    const termsFile = join(dir, 'terms', 'exclude.txt');
    await sessionsHookInstall(depsIn(dir), { ...base, scope: 'user', machine: true, env: ['OARS_HOST_CLASS=vps', 'OARS_EXCLUSION_TERMS_INLINE=acme corp'] });
    expect((await readSettings(file)).env).toMatchObject({ OARS_EXCLUSION_TERMS_INLINE: 'acme corp' });
    await sessionsHookInstall(depsIn(dir), { ...base, scope: 'user', machine: true, env: ['OARS_HOST_CLASS=vps', 'OARS_EXCLUSION_TERMS_INLINE=new corp'], termsFile });
    const { env } = await readSettings(file);
    expect(env).toEqual({ OARS_HOST_CLASS: 'vps', OARS_EXCLUSION_TERMS: termsFile });
    expect(readFileSync(file, 'utf8')).not.toContain('acme corp');
    // What a Stop reads back is the new term list, not the earlier inline one.
    expect(readFileSync(termsFile, 'utf8')).toBe('new corp\n');
  });

  it('a re-install that names OARS_EXCLUSION_TERMS drops the earlier inline terms, and the other way around', async () => {
    const dir = scratch();
    const file = join(dir, 'user', 'settings.json');
    const named = join(dir, 'terms', 'named.txt');
    await sessionsHookInstall(depsIn(dir), { ...base, scope: 'user', machine: true, env: ['OARS_HOST_CLASS=vps', 'OARS_EXCLUSION_TERMS_INLINE=acme corp'] });
    await sessionsHookInstall(depsIn(dir), { ...base, scope: 'user', machine: true, env: ['OARS_HOST_CLASS=vps', `OARS_EXCLUSION_TERMS=${named}`] });
    expect((await readSettings(file)).env).toEqual({ OARS_HOST_CLASS: 'vps', OARS_EXCLUSION_TERMS: named });
    await sessionsHookInstall(depsIn(dir), { ...base, scope: 'user', machine: true, env: ['OARS_HOST_CLASS=vps', 'OARS_EXCLUSION_TERMS_INLINE=other corp'] });
    expect((await readSettings(file)).env).toEqual({ OARS_HOST_CLASS: 'vps', OARS_EXCLUSION_TERMS_INLINE: 'other corp' });
  });

  it('says so when no terms were given, because a machine with no term file excludes every session', async () => {
    const dir = scratch();
    const outcome = await sessionsHookInstall(depsIn(dir), { ...base, scope: 'user', machine: true, env: ['OARS_HOST_CLASS=ci'] });
    expect(outcome.text).toContain('fail-closed');
  });

  it('refuses a bad block before it writes anything', async () => {
    const dir = scratch();
    const file = join(dir, 'user', 'settings.json');
    const refuse = async (env: string[], termsFile?: string): Promise<void> => {
      await expect(sessionsHookInstall(depsIn(dir), { ...base, scope: 'user', machine: true, env, termsFile })).rejects.toMatchObject({ exitCode: ExitCode.USAGE });
    };
    await refuse([]);
    await refuse(['OARS_HOST_CLASS=local']);
    await refuse(['OARS_HOST_CLASS=bogus']);
    await refuse(['OARS_HOST_CLASS=vps', 'OARS_NOT_A_NAME=1']);
    await refuse(['OARS_HOST_CLASS=vps', 'no-equals-sign']);
    await refuse(['OARS_HOST_CLASS=vps', 'OARS_EXCLUSION_TERMS_INLINE=a', 'OARS_EXCLUSION_TERMS=/x/terms']);
    await refuse(['OARS_HOST_CLASS=vps'], join(dir, 'terms.txt'));
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(dir, 'terms.txt'))).toBe(false);
  });

  it('is removed by uninstall at user scope', async () => {
    const dir = scratch();
    const file = join(dir, 'user', 'settings.json');
    await sessionsHookInstall(depsIn(dir), { ...base, scope: 'user', machine: true, env: ['OARS_HOST_CLASS=cloud'] });
    const outcome = await sessionsHookUninstall(depsIn(dir), { scope: 'user', file: undefined });
    expect(outcome.document).toMatchObject({ removed: ['SessionEnd', 'Stop'] });
    expect(hooksOf(await readSettings(file))).toEqual({});
  });
});

describe('the machine gate', () => {
  it('is a class other than local, and nothing else', () => {
    expect(machineOf({})).toBeUndefined();
    expect(machineOf({ OARS_HOST_CLASS: '' })).toBeUndefined();
    expect(machineOf({ OARS_HOST_CLASS: 'local' })).toBeUndefined();
    expect(machineOf({ OARS_HOST_CLASS: 'laptop' })).toBeUndefined();
    expect(machineOf({ OARS_HOST_CLASS: 'cloud', OARS_ALLOW_REPOS: ' Acme/Api\nacme/web ', OARS_MACHINE: 'm1' })).toEqual({ hostClass: 'cloud', launcher: undefined, machine: 'm1', allowRepos: ['acme/api', 'acme/web'] });
    expect(machineOf({ OARS_HOST_CLASS: 'hosted' })?.allowRepos).toEqual([]);
  });
});

describe('hook install --machine through the command line', () => {
  it('--scope project --machine writes the host-independent command, with no path of the installing machine', async () => {
    const dir = scratch();
    const { deps } = harness();
    deps.install = runtimeIn(dir);
    expect(await run(['sessions', 'hook', 'install', '--scope', 'project', '--machine'], deps)).toBe(ExitCode.OK);
    const hooks = hooksOf(await readSettings(join(dir, 'repo', '.claude', 'settings.json')));
    expect(groupsOf(hooks, 'Stop')).toEqual([{ hooks: [{ type: 'command', command: MACHINE_COMMAND, timeout: 10 }] }]);
  });

  it('--env and --terms-file reach the user-scope enrollment block', async () => {
    const dir = scratch();
    const termsFile = join(dir, 'terms', 'exclude.txt');
    const { deps } = harness();
    deps.install = runtimeIn(dir);
    const argv = ['sessions', 'hook', 'install', '--scope', 'user', '--machine', '--env', 'OARS_HOST_CLASS=vps', '--env', 'OARS_EXCLUSION_TERMS_INLINE=acme corp', '--terms-file', termsFile];
    expect(await run(argv, deps)).toBe(ExitCode.OK);
    expect((await readSettings(join(dir, 'user', 'settings.json'))).env).toEqual({ OARS_HOST_CLASS: 'vps', OARS_EXCLUSION_TERMS: termsFile });
  });
});

describe('a plain install and a machine install leave each other alone', () => {
  const commands = (groups: unknown[]): string[] => groups.flatMap((group) => {
    const hooks: unknown = typeof group === 'object' && group !== null ? Reflect.get(group, 'hooks') : undefined;
    return Array.isArray(hooks) ? hooks.flatMap((hook: unknown) => {
      const command: unknown = typeof hook === 'object' && hook !== null ? Reflect.get(hook, 'command') : undefined;
      return typeof command === 'string' ? [command] : [];
    }) : [];
  });

  it('a plain install keeps the machine Stop entry, and a machine install keeps the plain SessionEnd entry', async () => {
    const dir = scratch();
    const file = join(dir, 'user', 'settings.json');
    await sessionsHookInstall(depsIn(dir), { ...base, scope: 'user', machine: true, env: ['OARS_HOST_CLASS=vps'] });
    await sessionsHookInstall(depsIn(dir), { ...base, scope: 'user' });
    const hooks = hooksOf(await readSettings(file));
    expect(commands(groupsOf(hooks, 'Stop'))).toEqual([MACHINE_COMMAND]);
    expect(commands(groupsOf(hooks, 'SessionEnd'))).toHaveLength(2);
    // The other way around: a machine install after the plain one leaves the plain SessionEnd entry.
    await sessionsHookInstall(depsIn(dir), { ...base, scope: 'user', machine: true, env: ['OARS_HOST_CLASS=vps'] });
    const again = hooksOf(await readSettings(file));
    expect(commands(groupsOf(again, 'SessionEnd')).filter((command) => command.includes('hook-bin.js'))).toHaveLength(1);
    expect(commands(groupsOf(again, 'SessionEnd')).filter((command) => command === MACHINE_COMMAND)).toHaveLength(1);
    expect(commands(groupsOf(again, 'Stop'))).toEqual([MACHINE_COMMAND]);
  });

  it('status names Stop, and uninstall removes what both installs wrote', async () => {
    const dir = scratch();
    await sessionsHookInstall(depsIn(dir), { ...base, scope: 'user', machine: true, env: ['OARS_HOST_CLASS=vps'] });
    await sessionsHookInstall(depsIn(dir), { ...base, scope: 'user' });
    const status = await sessionsHookStatus(depsIn(dir), { file: undefined });
    expect(JSON.stringify(status.document)).toContain('"Stop"');
    const outcome = await sessionsHookUninstall(depsIn(dir), { scope: 'user', file: undefined });
    expect(Reflect.get(outcome.document, 'removed')).toContain('Stop');
    expect(hooksOf(await readSettings(join(dir, 'user', 'settings.json')))).toEqual({});
  });

  it('a settings file that cannot be read leaves no terms file written', async () => {
    const dir = scratch();
    const file = join(dir, 'user', 'settings.json');
    const termsFile = join(dir, 'terms', 'exclude.txt');
    mkdirSync(join(dir, 'user'), { recursive: true });
    writeFileSync(file, '{ not json');
    await expect(sessionsHookInstall(depsIn(dir), { ...base, scope: 'user', machine: true, env: ['OARS_HOST_CLASS=vps', 'OARS_EXCLUSION_TERMS_INLINE=acme'], termsFile })).rejects.toMatchObject({ exitCode: ExitCode.USAGE });
    expect(existsSync(termsFile)).toBe(false);
  });
});
