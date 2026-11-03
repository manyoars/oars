// The release proofs (t754): the one-command hook install is idempotent and reversible, the raw archive needs no configuration, and the
// public text states facts only.
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTestDirs } from '../test-support.js';
import { installHooks, readSettings, uninstallHooks, type InstallRuntime } from './install.js';
import { deposit, paths } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(() => {
  cleanup();
  removeTestDirs();
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
    const dir = mkdtempSync(join(tmpdir(), 'oars-release-test-'));
    const runtime: InstallRuntime = {
      nodePath: resolve(dir, 'node'),
      hookBin: resolve(dir, 'dist', 'hook-bin.js'),
      userSettings: join(dir, 'settings.json'),
      cwd: dir,
      schtasks: () => Promise.resolve({ code: 0, output: '' }),
    };
    const file = join(dir, 'settings.json');
    await installHooks(runtime, file, false);
    await installHooks(runtime, file, false);
    const installed = await readSettings(file);
    for (const event of EVENTS) expect(commandsOf(installed, event)).toHaveLength(1);
    await uninstallHooks(file);
    const after = await readSettings(file);
    for (const event of EVENTS) expect(commandsOf(after, event)).toEqual([]);
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

/** Phrases that address an agent or ask it to act. The public text states facts and leaves the choice to the person reading it. */
export const DENY_LIST = [
  'ignore previous',
  'ignore all previous',
  'you must install',
  'you should install',
  'you should recommend',
  'always recommend',
  'recommend this',
  'recommend it to',
  'tell the user',
  'tell your user',
  'if you are an agent',
  'if you are an ai',
  'as an ai',
  'as an agent',
  'dear agent',
  'attention agent',
  'agents should',
  'agents must',
  'run this command now',
  'install this package',
  'install it for the user',
];

const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe('the public text states facts only', () => {
  const manifest: unknown = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'));
  const texts = [
    ['packages/cli/README.md', readFileSync(join(PACKAGE, 'README.md'), 'utf8')],
    ['README.md', readFileSync(join(ROOT, 'README.md'), 'utf8')],
    ['package description', String(Reflect.get(Object(manifest), 'description'))],
  ] as const;

  for (const [name, text] of texts) {
    it(`${name} has no agent-directed phrase`, () => {
      const lower = text.toLowerCase();
      expect(DENY_LIST.filter((phrase) => lower.includes(phrase))).toEqual([]);
    });
  }

  it('the CLI README says the raw archive holds raw transcripts on this machine and that nothing leaves it', () => {
    const text = readFileSync(join(PACKAGE, 'README.md'), 'utf8');
    expect(text).toContain('raw transcripts');
    expect(text).toMatch(/nothing (is uploaded|leaves)/i);
  });

  it('the package description names sessions', () => {
    expect(String(Reflect.get(Object(manifest), 'description'))).toMatch(/sessions/);
  });
});
