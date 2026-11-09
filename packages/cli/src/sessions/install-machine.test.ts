// `oars sessions hook install --machine`: the host-independent entries a cloud VM, a VPS, or a runner runs, and the enrollment block of a user-scope file.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../errors.js';
import { sessionsHookInstall, sessionsHookUninstall } from './command.js';
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
    expect(outcome.document).toMatchObject({ ok: true, removed: ['SessionEnd'] });
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
    expect(outcome.document).toMatchObject({ removed: ['SessionEnd'] });
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
