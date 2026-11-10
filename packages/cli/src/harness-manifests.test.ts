// The manifests that list oars in each harness (Claude Code plugin and marketplace, Codex plugin and repo marketplace, Gemini CLI extension, the MCP
// registry's server.json, and the skill) are read from the repo root and held to the CLI: each names the version in packages/cli/package.json and a
// command this program has, so a release that forgets one fails here instead of shipping a listing that installs a stale or missing command.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { installHooks, type InstallRuntime, type Json } from './sessions/install.js';
import { harness } from './test-support.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

const readText = (path: string): string => readFileSync(join(root, path), 'utf8');

const readJson = (path: string): Json => {
  const parsed: unknown = JSON.parse(readText(path));
  if (!isRecord(parsed)) throw new Error(`${path} is not an object`);
  return parsed;
};

const objectAt = (source: Json, key: string): Json => {
  const value = source[key];
  if (!isRecord(value)) throw new Error(`${key} is not an object`);
  return value;
};

const listAt = (source: Json, key: string): unknown[] => {
  const value = source[key];
  if (!Array.isArray(value)) throw new Error(`${key} is not a list`);
  return value;
};

const cli = readJson('packages/cli/package.json');
const version = String(cli.version);

/** The one MCP server every manifest declares for recall. */
const RECALL_ARGS = ['sessions', 'recall', '--mcp'];

describe('the version the manifests name', () => {
  it('is the CLI version, in every file that carries one', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readJson('.claude-plugin/plugin.json').version).toBe(version);
    expect(readJson('plugin.json').version).toBe(version);
    expect(readJson('gemini-extension.json').version).toBe(version);
    const server = readJson('server.json');
    expect(server.version).toBe(version);
    expect(listAt(server, 'packages').map((entry) => (isRecord(entry) ? entry.version : undefined))).toEqual([version]);
    expect(listAt(readJson('.claude-plugin/marketplace.json'), 'plugins').map((entry) => (isRecord(entry) ? entry.version : undefined))).toEqual([version]);
  });
});

describe('the recall server each manifest starts', () => {
  const servers = {
    'Claude Code plugin': objectAt(objectAt(readJson('.claude-plugin/plugin.json'), 'mcpServers'), 'oars'),
    'Codex plugin': objectAt(objectAt(readJson('mcp.json'), 'mcpServers'), 'oars'),
    'Gemini extension': objectAt(objectAt(readJson('gemini-extension.json'), 'mcpServers'), 'oars'),
  };

  for (const [surface, server] of Object.entries(servers)) {
    it(`${surface} runs the installed oars binary with the recall arguments`, () => {
      expect(server.command).toBe('oars');
      expect(server.args).toEqual(RECALL_ARGS);
    });
  }

  it('is a command and an option this program has', async () => {
    const h = harness();
    const code = await run([...RECALL_ARGS.filter((token) => !token.startsWith('--')), '--help'], h.deps);
    expect(code).toBe(0);
    expect(h.out.join('')).toContain('--mcp');
  });

  it('is the one the registry entry passes to the npm package', () => {
    const [entry] = listAt(readJson('server.json'), 'packages');
    if (!isRecord(entry)) throw new Error('no package entry');
    const args = listAt(entry, 'packageArguments').map((argument) => (isRecord(argument) ? argument.value ?? argument.name : undefined));
    expect(args).toEqual(RECALL_ARGS);
    expect(entry.registryType).toBe('npm');
    expect(entry.identifier).toBe(cli.name);
    expect(objectAt(entry, 'transport').type).toBe('stdio');
  });
});

describe('the Claude Code plugin and marketplace', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  const marketplace = readJson('.claude-plugin/marketplace.json');

  it('lists the plugin by the name its manifest carries, from the repository root', () => {
    const [entry] = listAt(marketplace, 'plugins');
    if (!isRecord(entry)) throw new Error('no plugin entry');
    expect(entry.name).toBe(plugin.name);
    expect(entry.source).toBe('./');
    expect(entry.description).toBe(plugin.description);
    expect(objectAt(marketplace, 'owner').name).toBeTruthy();
  });

  it('writes the hooks `oars sessions hook install` writes, through the oars-hook bin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oars-manifest-test-'));
    const runtime: InstallRuntime = {
      platform: 'linux',
      nodePath: 'node',
      hookBin: join(dir, 'hook-bin.js'),
      userSettings: join(dir, 'settings.json'),
      cwd: dir,
      schtasks: () => Promise.resolve({ code: 0, output: '' }),
    };
    await installHooks(runtime, runtime.userSettings, true);
    const installed = objectAt(JSON.parse(readFileSync(runtime.userSettings, 'utf8')) as Json, 'hooks');
    const shape = (hooks: Json, launch: RegExp): unknown =>
      Object.fromEntries(
        Object.entries(hooks).map(([event, groups]) => {
          if (!Array.isArray(groups)) throw new Error(`${event} is not a list`);
          return [
            event,
            groups.map((group: unknown) => {
              if (!isRecord(group)) throw new Error(`${event} holds a non-object`);
              const [handler] = listAt(group, 'hooks');
              if (!isRecord(handler)) throw new Error(`${event} has no handler`);
              const argument = launch.exec(String(handler.command))?.[1];
              return { matcher: group.matcher, argument, timeout: handler.timeout };
            }),
          ];
        }),
      );
    // The plugin runs the same events with the same matcher, argument, and timeout; only the launcher differs (the bin on PATH, not a path to this build).
    expect(shape(objectAt(plugin, 'hooks'), /oars-hook (\S+)$/)).toEqual(shape(installed, /hook-bin\.js" (\S+)$/));
    expect(cli.bin).toMatchObject({ 'oars-hook': expect.any(String) as string });
  });

  it('exits quietly when the oars-hook bin is not on PATH', () => {
    for (const groups of Object.values(objectAt(plugin, 'hooks'))) {
      for (const group of Array.isArray(groups) ? groups : []) {
        const [handler] = listAt(group as Json, 'hooks');
        expect(String(isRecord(handler) ? handler.command : '')).toMatch(/^command -v oars-hook >\/dev\/null \|\| exit 0; oars-hook \S+$/);
      }
    }
  });
});

describe('the MCP registry entry', () => {
  const server = readJson('server.json');

  it('names the package by mcpName and keeps the description within the registry limit', () => {
    expect(cli.mcpName).toBe('io.github.manyoars/oars');
    expect(server.name).toBe(cli.mcpName);
    expect(String(server.description).length).toBeLessThanOrEqual(100);
    expect(server.$schema).toBe('https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
  });
});

describe('the Gemini extension and the Codex marketplace', () => {
  it('names the extension in the lowercase-and-dashes form Gemini CLI expects', () => {
    expect(readJson('gemini-extension.json').name).toMatch(/^[a-z0-9-]+$/);
  });

  it('lists the Codex plugin by the name its manifest carries, from the repository root', () => {
    const marketplace = readJson('.agents/plugins/marketplace.json');
    const [entry] = listAt(marketplace, 'plugins');
    if (!isRecord(entry)) throw new Error('no plugin entry');
    expect(entry.name).toBe(readJson('plugin.json').name);
    expect(objectAt(entry, 'source')).toEqual({ source: 'local', path: './' });
    expect(objectAt(entry, 'policy')).toEqual({ installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  });
});

describe('the skill', () => {
  const skill = readText('skills/oars-recall/SKILL.md');

  it('carries the name and description a skills index reads, and the tool it teaches', () => {
    expect(skill).toMatch(/^---\nname: oars-recall\ndescription: .+\n---\n/);
    expect(skill).toContain('oars_recall');
  });

  // The hard limit: nothing a model reads asks it to install, star, or recommend anything.
  it('never tells an agent to install, star, or recommend anything', () => {
    for (const text of [skill, readText('mcp.json'), readText('.claude-plugin/plugin.json'), readText('gemini-extension.json'), readText('server.json')]) {
      expect(text).not.toMatch(/\b(install|npm i|npx|star|recommend|sponsor|subscribe)\b/i);
    }
  });
});
