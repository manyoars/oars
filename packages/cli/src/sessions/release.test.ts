// The release proofs (t754): the one-command hook install is idempotent and reversible, the raw archive needs no configuration.
// (The public-text proofs live in ../pack.test.ts.) Both are characterization of behavior that already shipped.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionsHookInstall, sessionsHookUninstall } from './command.js';
import { readSettings, type InstallRuntime } from './install.js';
import { deposit, paths } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(() => {
  cleanup();
});

const EVENTS = ['SessionStart', 'PostToolUseFailure', 'SessionEnd'];

const commandsOf = (settings: Awaited<ReturnType<typeof readSettings>>, event: string): string[] => {
  const groups: unknown = Reflect.get(Reflect.get(settings, 'hooks') ?? {}, event);
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group: unknown) => {
    const inner: unknown = Reflect.get(Object(group), 'hooks');
    return Array.isArray(inner) ? inner.flatMap((hook: unknown) => String(Reflect.get(Object(hook), 'command'))) : [];
  });
};

describe('one command installs and removes the hooks', () => {
  it('twice leaves one entry per hook, and uninstall leaves none', async () => {
    const dir = stage().root;
    const file = join(dir, 'settings.json');
    const runtime: InstallRuntime = {
      nodePath: resolve(dir, 'node'),
      hookBin: resolve(dir, 'dist', 'hook-bin.js'),
      userSettings: file,
      cwd: dir,
      schtasks: () => Promise.resolve({ code: 0, output: '' }),
    };
    // The command wiring, as `oars sessions hook install --scope user` reaches it.
    const deps = { sessions: undefined, install: runtime, now: () => NOW };
    const target = { scope: 'user', file: undefined } as const;
    await sessionsHookInstall(deps, { ...target, keepRetention: false, schedule: undefined });
    await sessionsHookInstall(deps, { ...target, keepRetention: false, schedule: undefined });
    const installed = await readSettings(file);
    for (const event of EVENTS) expect(commandsOf(installed, event)).toHaveLength(1);
    await sessionsHookUninstall(deps, target);
    const after = await readSettings(file);
    for (const event of EVENTS) expect(commandsOf(after, event)).toEqual([]);
  });

  it('refuses the bare forms, which name no settings file, so the README must give --scope', async () => {
    const dir = stage().root;
    const runtime: InstallRuntime = { nodePath: dir, hookBin: dir, userSettings: join(dir, 'settings.json'), cwd: dir, schtasks: () => Promise.resolve({ code: 0, output: '' }) };
    const deps = { sessions: undefined, install: runtime, now: () => NOW };
    await expect(sessionsHookInstall(deps, { scope: undefined, file: undefined, keepRetention: false, schedule: undefined })).rejects.toThrow('--scope file needs --file');
    await expect(sessionsHookUninstall(deps, { scope: undefined, file: undefined })).rejects.toThrow('--scope file needs --file');
  });
});

describe('the raw archive is on by default', () => {
  it('holds the transcript under raw/ after the first deposit from a fresh store with no config', async () => {
    const staged = stage();
    expect(existsSync(staged.storeDir)).toBe(false);
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const raw = join(paths(staged.storeDir).raw, 'proj');
    const archived = readdirSync(raw).filter((name) => name.endsWith('.jsonl'));
    expect(archived.length).toBeGreaterThan(0);
    const source = readdirSync(join(staged.projectsRoot, 'proj')).filter((name) => name.endsWith('.jsonl'));
    expect(archived.sort()).toEqual(source.sort());
    for (const name of archived) expect(readFileSync(join(raw, name), 'utf8')).toEqual(readFileSync(join(staged.projectsRoot, 'proj', name), 'utf8'));
  });
});
