import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { defaultConfigDir } from '../credentials.js';
import { ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { sessionsHookInstall, sessionsHookStatus, sessionsHookUninstall } from './command.js';
import { CODEX_TRUST_NOTICE, codexHookStatus, codexHooksFile, installCodexHook, uninstallCodexHook, type CodexInstall } from './codex-hook-install.js';
import { readSettings, type InstallRuntime, type Json } from './install.js';

afterEach(() => {
  vi.unstubAllEnvs();
  removeTestDirs();
});

const SCRATCH = resolve(tmpdir(), 'oars-scratch');
const EVENTS = ['SessionStart', 'PostToolUse', 'PostModelRequest'];

const stage = (): { dir: string; codex: CodexInstall; deps: { sessions: undefined; install: InstallRuntime; now: () => number } } => {
  const dir = mkdtempSync(join(tmpdir(), 'oars-codex-install-'));
  // Store safety: the store path is under this temp folder before anything runs, so the run(...) route can reach no real store.
  vi.stubEnv('APPDATA', join(dir, 'appdata'));
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'config'));
  const storeDir = join(defaultConfigDir(process.env, process.platform, dir), 'oars', 'sessions');
  if (!storeDir.startsWith(dir)) throw new Error(`The store path ${storeDir} is outside the temp folder ${dir}.`);
  const codex = { home: join(dir, 'codex'), nodePath: resolve(SCRATCH, 'node', 'node.exe'), hookBin: resolve(SCRATCH, 'dist', 'sessions', 'codex-hook-bin.js') };
  const install: InstallRuntime = { platform: 'linux', nodePath: codex.nodePath, hookBin: '', userSettings: join(dir, 'settings.json'), cwd: dir, codex, schtasks: () => Promise.resolve({ code: 0, output: '' }) };
  return { dir, codex, deps: { sessions: undefined, install, now: () => 0 } };
};

const fileOf = (codex: CodexInstall): Promise<Json> => readSettings(codexHooksFile(codex));

describe('oars sessions hook install --harness codex', () => {
  it('writes one entry per event to hooks.json in the Codex home, with no bypass flag', async () => {
    const { codex } = stage();
    const result = await installCodexHook(codex);
    expect(result).toEqual({ file: join(codex.home, 'hooks.json'), installed: EVENTS });
    const written = await fileOf(codex);
    expect(written).toMatchObject({ hooks: { SessionStart: [expect.anything()], PostToolUse: [expect.anything()], PostModelRequest: [expect.anything()] } });
    expect(JSON.stringify(written)).toContain('codex-hook-bin.js');
    expect(JSON.stringify(written)).not.toMatch(/bypass|trust/i);
  });

  it('keeps every hook that is not ours, installs once on a rerun, and removes only its own', async () => {
    const { codex } = stage();
    mkdirSync(codex.home, { recursive: true });
    const theirs = { hooks: [{ type: 'command', command: 'echo mine' }] };
    writeFileSync(codexHooksFile(codex), JSON.stringify({ model: 'x', hooks: { PostToolUse: [theirs], Stop: [theirs] } }));
    await installCodexHook(codex);
    await installCodexHook(codex);
    expect(await fileOf(codex)).toMatchObject({ hooks: { PostToolUse: [theirs, expect.anything()] } });
    expect(await codexHookStatus(codex)).toEqual({ file: codexHooksFile(codex), installed: EVENTS });
    expect((await uninstallCodexHook(codex)).removed).toEqual(EVENTS);
    expect(await fileOf(codex)).toEqual({ model: 'x', hooks: { PostToolUse: [theirs], Stop: [theirs] } });
    expect((await uninstallCodexHook(codex)).removed).toEqual([]);
  });

  it('drops the hooks key when the entries were the only ones', async () => {
    const { codex } = stage();
    await installCodexHook(codex);
    await uninstallCodexHook(codex);
    expect((await fileOf(codex)).hooks).toBeUndefined();
    expect(await codexHookStatus(codex)).toMatchObject({ installed: [] });
  });

  it('says Codex asks to trust the entry, and refuses a Claude Code settings flag beside it', async () => {
    const { deps, codex } = stage();
    const outcome = await sessionsHookInstall(deps, { scope: undefined, file: undefined, keepRetention: false, schedule: undefined, harness: 'codex' });
    expect(outcome.text).toContain(CODEX_TRUST_NOTICE);
    expect(outcome.text).toContain('Codex asks you to review and trust');
    expect(outcome.document).toMatchObject({ ok: true, harness: 'codex', installed: EVENTS });
    expect((await sessionsHookStatus(deps, { file: undefined, harness: 'codex' })).text).toBe(`codex: ${codexHooksFile(codex)}: ${EVENTS.join(', ')}`);
    await expect(sessionsHookInstall(deps, { scope: 'user', file: undefined, keepRetention: false, schedule: undefined, harness: 'codex' })).rejects.toThrow(/--scope and --file/);
    await expect(sessionsHookInstall(deps, { scope: undefined, file: undefined, keepRetention: false, schedule: 'off', harness: 'codex' })).rejects.toThrow(/--schedule/);
    expect((await sessionsHookUninstall(deps, { scope: undefined, file: undefined, harness: 'codex' })).text).toContain(`Removed ${EVENTS.join(', ')}`);
    expect((await sessionsHookUninstall(deps, { scope: undefined, file: undefined, harness: 'codex' })).text).toContain('No Many Oars hooks');
    expect((await sessionsHookStatus(deps, { file: undefined, harness: 'codex' })).text).toContain('no hooks');
  });

  it('is not configured in a run with no Codex home', async () => {
    const { deps } = stage();
    const bare = { ...deps, install: { ...deps.install, codex: undefined } };
    await expect(sessionsHookInstall(bare, { scope: undefined, file: undefined, keepRetention: false, schedule: undefined, harness: 'codex' })).rejects.toThrow(/not configured/);
  });

  it('changes nothing for an install without --harness', async () => {
    const { deps, codex } = stage();
    await sessionsHookInstall(deps, { scope: 'file', file: join(deps.install.cwd, 'claude.json'), keepRetention: true, schedule: undefined });
    expect(() => readFileSync(codexHooksFile(codex))).toThrow();
  });

  it('is reachable from the command line, and --harness takes only codex', async () => {
    const { deps, codex } = stage();
    const cli = harness();
    cli.deps.install = deps.install;
    expect(await run(['sessions', 'hook', 'install', '--harness', 'codex'], cli.deps)).toBe(ExitCode.OK);
    expect(cli.out.join('')).toContain('Codex asks you to review and trust');
    expect((await fileOf(codex)).hooks).toBeDefined();
    cli.out.length = 0;
    expect(await run(['sessions', 'hook', 'status', '--harness', 'codex'], cli.deps)).toBe(ExitCode.OK);
    expect(cli.out.join('')).toContain(EVENTS.join(', '));
    expect(await run(['sessions', 'hook', 'uninstall', '--harness', 'codex'], cli.deps)).toBe(ExitCode.OK);
    expect(await run(['sessions', 'hook', 'install', '--harness', 'copilot'], cli.deps)).toBe(ExitCode.USAGE);
  });
});
