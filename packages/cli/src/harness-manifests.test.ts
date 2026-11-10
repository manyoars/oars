// The manifests that list oars in each harness (Claude Code plugin and marketplace, Codex plugin and repo marketplace, Gemini CLI extension, the MCP
// registry's server.json, and the skill) are read from the repo root and held to the CLI: each names the version in packages/cli/package.json and a
// command this program has, so a release that forgets one fails here instead of shipping a listing that installs a stale or missing command.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { installHooks, type InstallRuntime, type Json } from './sessions/install.js';
import { handleMessage, TOOL_NAME } from './sessions/mcp.js';
import { cleanup, NOW, stage } from './sessions/test-support.js';
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
    try {
      const hookBin = join(dir, 'hook-bin.js');
      const runtime: InstallRuntime = {
        platform: 'linux',
        nodePath: 'node',
        hookBin,
        userSettings: join(dir, 'settings.json'),
        cwd: dir,
        schtasks: () => Promise.resolve({ code: 0, output: '' }),
      };
      await installHooks(runtime, runtime.userSettings, true);
      const settings: unknown = JSON.parse(readFileSync(runtime.userSettings, 'utf8'));
      if (!isRecord(settings)) throw new Error('settings is not an object');
      // Only the launcher differs: the bin on PATH, not a path to this build. Normalized, the whole command must match, so the post-tool prefilter cannot drift.
      const launcher = (command: string): string =>
        command.replace(`[ -f "${hookBin}" ] || exit 0; `, 'command -v oars-hook >/dev/null || exit 0; ').replace(`"node" "${hookBin}"`, 'oars-hook');
      const shape = (hooks: Json, normalize: (command: string) => string): unknown =>
        Object.fromEntries(
          Object.entries(hooks).map(([event, groups]) => {
            if (!Array.isArray(groups)) throw new Error(`${event} is not a list`);
            return [
              event,
              groups.map((group: unknown) => {
                if (!isRecord(group)) throw new Error(`${event} holds a non-object`);
                const [handler] = listAt(group, 'hooks');
                if (!isRecord(handler)) throw new Error(`${event} has no handler`);
                return { matcher: group.matcher, command: normalize(String(handler.command)), timeout: handler.timeout };
              }),
            ];
          }),
        );
      expect(shape(objectAt(plugin, 'hooks'), (command) => command)).toEqual(shape(objectAt(settings, 'hooks'), launcher));
      expect(Object.keys(objectAt(cli, 'bin'))).toContain('oars-hook');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits quietly when the oars-hook bin is not on PATH', () => {
    for (const groups of Object.values(objectAt(plugin, 'hooks'))) {
      for (const group of Array.isArray(groups) ? groups : []) {
        if (!isRecord(group)) throw new Error('hook group is not an object');
        const [handler] = listAt(group, 'hooks');
        expect(String(isRecord(handler) ? handler.command : '')).toMatch(/^command -v oars-hook >\/dev\/null \|\| exit 0; /);
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
  afterEach(cleanup);

  /** The tool the server lists, asked the way a client asks. */
  const served = async (): Promise<{ name: string; properties: Json }> => {
    const { runtime } = stage();
    const reply = await handleMessage(runtime, () => NOW, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const [tool] = listAt(objectAt(isRecord(reply) ? reply : {}, 'result'), 'tools');
    if (!isRecord(tool)) throw new Error('the server lists no tool');
    return { name: String(tool.name), properties: objectAt(objectAt(tool, 'inputSchema'), 'properties') };
  };

  it('carries the name and description a skills index reads', () => {
    expect(skill).toMatch(/^---\nname: oars-recall\ndescription: .+\n---\n/);
  });

  it('names the tool the server serves, and only inputs that tool takes', async () => {
    const { name, properties } = await served();
    expect(name).toBe(TOOL_NAME);
    expect(skill).toContain(`\`${name}\``);
    const section = (/^## Calls\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(skill) ?? [])[1] ?? '';
    const named = [...section.matchAll(/^- `([A-Za-z]+)`:/gm)].map((match) => match[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const input of named) expect(Object.keys(properties)).toContain(input);
    expect(named.sort()).toEqual(Object.keys(properties).sort());
  });

  it('lists the prompt classes the server lists', async () => {
    const { properties } = await served();
    const description = String(objectAt(properties, 'class').description);
    const listed = (text: string): string[] => (/:\s*([a-z-]+(?:, [a-z-]+)+)/.exec(text)?.[1] ?? '').split(', ');
    const [line] = skill.match(/^- `class`:.*$/m) ?? [''];
    const inSkill = [...line.matchAll(/`([a-z-]+)`/g)].map((match) => match[1]).filter((word) => word !== 'class');
    expect(inSkill.length).toBeGreaterThan(0);
    expect(inSkill).toEqual(listed(description));
  });

  // The hard limit: nothing a model reads asks it to install, star, or recommend anything.
  it('never tells an agent to install, star, or recommend anything', () => {
    const files = ['mcp.json', 'plugin.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json', 'gemini-extension.json', 'server.json'];
    for (const text of [skill, ...files.map(readText)]) {
      expect(text).not.toMatch(/\b(install|npm i|npx|star|recommend|sponsor|subscribe)\b/i);
    }
  });
});
