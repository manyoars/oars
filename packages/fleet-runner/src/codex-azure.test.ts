// Proof of the Codex CLI on Azure OpenAI adapter against a stub `codex` (src/stub-codex.mjs), a tiny git repository made here, and a stub `npm`. No test starts the real `codex`, opens a
// network connection, or reads an Azure credential: the key is a made-up string handed in through the injected environment.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AZURE_KEY_NAME, makeCodexAzure, type CodexAzureSettings } from './codex-azure.js';
import { makeNodeSpawn, nodeSpawn, type Spawn, type StartTimer, type ToolUnderTest } from './harness-shared.js';
import type { RunRequest } from './harness.js';
import { isObject } from './json.js';
import { parseOrder } from './order.js';
import { comparisonText, FLEET } from './test-fixtures.js';

const STUB = join(dirname(fileURLToPath(import.meta.url)), 'stub-codex.mjs');
const SECRET = 'azure-key-not-real-0001';
const DEPLOYMENT = 'gpt-pinned-1';
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const NL = String.fromCharCode(10);

let scratch = '';
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'codex-test-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const SERVER: ToolUnderTest = { kind: 'server', name: 'playwright', package: '@playwright/mcp', entry: 'cli.js', args: ['--headless'] };
const RESET = { node: '>=20.0.0', install: 'node scripts/install.mjs', buildDb: 'node scripts/build-db.mjs' };

const rig = (patch: Partial<CodexAzureSettings> = {}, prompt = 'scenario: ok\nDo the task.'): { settings: CodexAzureSettings; commit: string } => {
  const fixture = join(scratch, 'fixture');
  if (!existsSync(fixture)) {
    mkdirSync(join(fixture, 'scripts'), { recursive: true });
    writeFileSync(join(fixture, 'seed.sql'), 'create table t(a);');
    writeFileSync(join(fixture, 'scripts', 'install.mjs'), NL);
    writeFileSync(join(fixture, 'scripts', 'build-db.mjs'), NL);
    git(fixture, 'init', '-q');
    git(fixture, 'add', '-A');
    git(fixture, 'commit', '-q', '-m', 'first');
    git(fixture, 'tag', 'taskset-v1');
  }
  const commit = git(fixture, 'rev-parse', 'HEAD');
  const set = join(scratch, 'taskset');
  mkdirSync(join(set, 'prompts'), { recursive: true });
  mkdirSync(join(set, 'checks'), { recursive: true });
  writeFileSync(join(set, 'manifest.json'), JSON.stringify({ version: 'v1', fixtureTag: 'taskset-v1', fixtureCommit: commit, reset: RESET, tasks: [{ id: 't1', category: 'browser', status: 'written' }] }));
  writeFileSync(join(set, 'prompts', 't1.md'), prompt);
  writeFileSync(join(set, 'checks', 't1.mjs'), 'process.exit(0);' + NL);
  const settings: CodexAzureSettings = {
    fixtureSource: fixture,
    fixtureTag: 'taskset-v1',
    taskSetDir: set,
    fleetManifestVersion: 'fleet-1',
    codexExecutable: process.execPath,
    codexArgs: [STUB],
    azureEndpoint: 'https://example.openai.azure.com/openai',
    deployment: DEPLOYMENT,
    apiVersion: '2025-04-01-preview',
    tool: SERVER,
    timeLimitMs: 20000,
    setupTimeLimitMs: 60000,
    transcriptOutDir: join(scratch, 'transcripts'),
    gitExecutable: 'git',
    npmExecutable: 'npm-stub',
    setupEnvNames: [],
    ...patch,
  };
  return { settings, commit };
};

/** Real spawn for everything but the stub `npm`, which writes the package a real install would. */
const withNpmStub: Spawn = async (spec) => {
  if (spec.command !== 'npm-stub') return nodeSpawn(spec);
  const prefix = spec.args[spec.args.indexOf('--prefix') + 1] ?? '';
  const dir = join(prefix, 'node_modules', '@playwright', 'mcp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@playwright/mcp', version: '1.0.0' }));
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, errorCode: null };
};

const ENV = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', [AZURE_KEY_NAME]: SECRET, OPENAI_API_KEY: 'personal-key', CODEX_HOME: 'C:\\Users\\someone\\.codex' };

const request = (arm: string, pin: string | null): RunRequest => ({
  runId: 'o-2-0001',
  sequence: 1,
  attempt: 1,
  order: parseOrder(comparisonText(), FLEET),
  taskId: 't1',
  category: 'browser',
  arm,
  side: null,
  repeat: 1,
  expected: { taskSetVersion: 'v1', fixtureTag: 'taskset-v1', manifestVersion: 'fleet-1', harnessVersion: '0.170.0', modelId: DEPLOYMENT, toolPins: pin === null ? [] : [{ name: arm, pin }] },
});

const names = (path: string): string[] => {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(value) ? value.map(String) : [];
};
const listing = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((entry) => entry.split('\\').join('/')).sort();

describe('construction', () => {
  it('refuses to start without the Azure key, an endpoint, or a deployment, never falling back to a ChatGPT sign-in', () => {
    const { settings } = rig();
    expect(() => makeCodexAzure(settings, { env: { PATH: ENV.PATH } })).toThrow(/AZURE_OPENAI_API_KEY is not set/);
    expect(() => makeCodexAzure({ ...settings, azureEndpoint: '' }, { env: ENV })).toThrow(/endpoint/);
    expect(() => makeCodexAzure({ ...settings, deployment: '' }, { env: ENV })).toThrow(/deployment/);
  });

  it('refuses a .cmd or .bat executable, and a tag setting or Node below the manifest, before any run', () => {
    const { settings } = rig();
    expect(() => makeCodexAzure({ ...settings, codexExecutable: 'codex.CMD' }, { env: ENV })).toThrow(/native codex/);
    expect(() => makeCodexAzure({ ...settings, codexExecutable: 'codex.bat' }, { env: ENV })).toThrow(/native codex/);
    expect(() => makeCodexAzure({ ...settings, fixtureTag: 'taskset-v2' }, { env: ENV })).toThrow(/is not the task-set manifest's/);
    expect(() => makeCodexAzure(settings, { env: ENV, nodeVersion: '18.0.0' })).toThrow(/Node 18 is below/);
  });
});

describe('shared checks through the Codex adapter', () => {
  it('accepts a 7 to 40 hex fixtureCommit as a prefix of the clone head, and reports a shorter, longer, or other one as a moved tag', async () => {
    const { settings, commit } = rig();
    for (const [wanted, moved] of [[commit.slice(0, 7), false], [commit.slice(0, 12), false], [commit.slice(0, 6), true], ['0000000', true]] as const) {
      writeFileSync(join(scratch, 'taskset', 'manifest.json'), JSON.stringify({ version: 'v1', fixtureTag: 'taskset-v1', fixtureCommit: wanted, reset: RESET, tasks: [{ id: 't1', category: 'browser', status: 'written' }] }));
      const prepared = await makeCodexAzure({ ...settings, tool: null }, { env: ENV }).prepare(request('no-tool', null));
      expect(prepared.fixtureTag === 'taskset-v1', wanted).toBe(!moved);
      await prepared.dispose();
    }
  });

  it('compares the Node floor as major.minor.patch, not only the major', () => {
    const { settings, commit } = rig();
    writeFileSync(join(scratch, 'taskset', 'manifest.json'), JSON.stringify({ version: 'v1', fixtureTag: 'taskset-v1', fixtureCommit: commit, reset: { ...RESET, node: '>=24.3.1' }, tasks: [{ id: 't1', category: 'browser', status: 'written' }] }));
    expect(() => makeCodexAzure(settings, { env: ENV, nodeVersion: '24.0.0' })).toThrow(/Node 24\.0\.0 is below the Node 24\.3\.1/);
    expect(() => makeCodexAzure(settings, { env: ENV, nodeVersion: '24.3.0' })).toThrow(/below/);
    expect(() => makeCodexAzure(settings, { env: ENV, nodeVersion: '24.3.1' })).not.toThrow();
  });
});

describe('prepare', () => {
  it('holds only the provider settings and the one server for the server arm, and only the provider settings for the no-tool arm, with no sign-in file', async () => {
    const { settings } = rig();
    const adapter = makeCodexAzure(settings, { env: ENV, spawn: withNpmStub });
    const server = await adapter.prepare(request('playwright', 'npm:1.0.0'));
    expect(listing(server.configDir)).toEqual(['config.toml', 'tool', 'tool/node_modules', 'tool/node_modules/@playwright', 'tool/node_modules/@playwright/mcp', 'tool/node_modules/@playwright/mcp/package.json']);
    const text = readFileSync(join(server.configDir, 'config.toml'), 'utf8');
    expect(text).toContain('model_provider = "azure"');
    expect(text).toContain('env_key = "AZURE_OPENAI_API_KEY"');
    // The shape of the documented Azure example (config-advanced, per-provider tuning).
    expect(text).toContain('base_url = "https://example.openai.azure.com/openai"');
    expect(text).toContain('query_params = { api-version = "2025-04-01-preview" }');
    expect(text.match(/\[mcp_servers\./g)).toHaveLength(1);
    expect(text).not.toMatch(/env_vars|^env =/m);
    // The default KEY/SECRET/TOKEN exclusion already drops the key; the explicit AZURE_ filter is a second guard the stub cannot tell apart, so pin it here.
    expect(text).toContain('"AZURE_*" = "exclude"');
    expect(text).toContain('ignore_default_excludes = false');
    expect(text).not.toContain(SECRET);
    await server.dispose();
    const none = await adapter.prepare(request('no-tool', null));
    expect(listing(none.configDir)).toEqual(['config.toml']);
    expect(readFileSync(join(none.configDir, 'config.toml'), 'utf8')).not.toContain('mcp_servers');
    await none.dispose();
  });

  it('puts a skill under the run HOME .agents/skills, and an api-version only when one is set', async () => {
    const skill = join(scratch, 'skill');
    mkdirSync(join(skill, 'skills', 'fill'), { recursive: true });
    writeFileSync(join(skill, 'skills', 'fill', 'SKILL.md'), '---\nname: fill\n---\n');
    git(skill, 'init', '-q');
    git(skill, 'add', '-A');
    git(skill, 'commit', '-q', '-m', 'first');
    const { settings } = rig({ tool: { kind: 'skill', name: 'fill', repo: skill, subdir: 'skills/fill' }, apiVersion: null });
    const adapter = makeCodexAzure(settings, { env: ENV });
    const prepared = await adapter.prepare(request('fill', `git:${git(skill, 'rev-parse', 'HEAD').slice(0, 10)}`));
    expect(existsSync(join(prepared.dir, 'home', '.agents', 'skills', 'fill', 'SKILL.md'))).toBe(true);
    expect(listing(prepared.configDir)).toEqual(['config.toml']);
    expect(listing(join(prepared.dir, 'home', '.agents', 'skills', 'fill'))).toEqual(['SKILL.md']);
    expect(readFileSync(join(prepared.configDir, 'config.toml'), 'utf8')).not.toContain('query_params');
    await prepared.dispose();
  });
});

describe('run', () => {
  const run = async (prompt: string, arm = 'playwright', patch: Partial<CodexAzureSettings> = {}, spawn: Spawn = withNpmStub) => {
    const { settings } = rig(patch, prompt);
    const adapter = makeCodexAzure(settings, { env: ENV, spawn });
    const req = request(arm, arm === 'no-tool' ? null : 'npm:1.0.0');
    const prepared = await adapter.prepare(req);
    return { prepared, result: await adapter.run(prepared, req) };
  };

  it('a clean run returns the rollout copy, version, model, and token counts, with the documented command and only the named environment', async () => {
    const { prepared, result } = await run('scenario: ok\nDo the task.');
    expect(result.exit).toEqual({ kind: 'ok', code: 0 });
    expect(result.harnessVersion).toBe('0.170.0');
    expect(result.modelId).toBe(DEPLOYMENT);
    // 1000 input of which 400 cached, then 2000 of which 1500 cached and 100 cache-written: 600 + 400 fresh, 400 + 1600 cache, 300 out.
    expect(result.tokens).toEqual({ input: 1000, cache: 2000, output: 300 });
    expect(result.transcriptPath).toBe(join(scratch, 'transcripts', 'o-2-0001.jsonl'));
    expect(readFileSync(result.transcriptPath ?? '', 'utf8')).toContain('session_meta');
    const seen: unknown = JSON.parse(readFileSync(join(prepared.configDir, 'stub-seen.json'), 'utf8'));
    if (!isObject(seen)) throw new Error('stub-seen.json is not an object');
    expect(seen['argv']).toEqual(['exec', '--json', '--sandbox', 'workspace-write', '--model', DEPLOYMENT, '--cd', prepared.runFolder, '--ignore-rules', '-']);
    expect(String(seen['prompt'])).toContain('Do the task.');
    const seenNames = seen['envNames'];
    const envNames = Array.isArray(seenNames) ? seenNames.map(String) : [];
    expect(envNames).toEqual(expect.arrayContaining(['AZURE_OPENAI_API_KEY', 'CODEX_HOME', 'HOME', 'USERPROFILE', 'PATH']));
    expect(envNames).not.toContain('OPENAI_API_KEY');
    expect(JSON.stringify(seen)).not.toContain('someone');
    await prepared.dispose();
  });

  it('the Azure key reaches codex but not the shell commands it starts, by the documented shell environment policy', async () => {
    const { prepared } = await run('scenario: ok\nx');
    const child = names(join(prepared.configDir, 'stub-child-seen.json'));
    expect(child).not.toContain(AZURE_KEY_NAME);
    expect(child).not.toContain('OPENAI_API_KEY');
    expect(child).toContain('PATH');
    await prepared.dispose();
  });

  it.each([
    ['crash', 'crash'],
    ['auth', 'auth-rejected'],
    ['rate', 'rate-limit'],
    ['network', 'network-down'],
    ['server', 'api-error'],
  ])('scenario %s is %s', async (scenario, kind) => {
    const { prepared, result } = await run(`scenario: ${scenario}\n`, 'no-tool');
    expect(result.exit.kind).toBe(kind);
    await prepared.dispose();
  });

  it('reports the version and the model the rollout names, and a null path when Codex wrote none', async () => {
    const version = await run('scenario: version\n', 'no-tool');
    expect(version.result.harnessVersion).toBe('9.9.9');
    await version.prepared.dispose();
    const model = await run('scenario: model\n', 'no-tool');
    expect(model.result.modelId).toBe('other-deployment');
    await model.prepared.dispose();
    const none = await run('scenario: norollout\n', 'no-tool');
    expect(none.result).toMatchObject({ transcriptPath: null, harnessVersion: 'unknown', modelId: 'unknown' });
    await none.prepared.dispose();
  });

  it('copies the own rollout of the run, not a later one from a spawned agent, and reads the version from it', async () => {
    const { result } = await run('scenario: subagent' + NL + 'x', 'no-tool');
    expect(result.harnessVersion).toBe('0.170.0');
    const copy = readFileSync(result.transcriptPath ?? '', 'utf8');
    expect(copy).toContain('"cli_version":"0.170.0"');
    expect(copy).not.toContain('parent_thread_id');
  });

  it('a timeout ends the harness and the processes it started', async () => {
    const LIMIT_MS = 1234;
    const { settings } = rig({ timeLimitMs: LIMIT_MS }, 'scenario: tree\n');
    let pidFile = '';
    const timer: StartTimer = (ms, fire) => {
      const state = { cancelled: false };
      if (ms !== LIMIT_MS) return () => undefined;
      void (async () => {
        for (let i = 0; i < 300 && !state.cancelled && !existsSync(pidFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
        if (!state.cancelled) fire();
      })();
      return () => {
        state.cancelled = true;
      };
    };
    const adapter = makeCodexAzure(settings, { env: ENV, spawn: async (spec) => (spec.timeoutMs === LIMIT_MS ? makeNodeSpawn(timer)(spec) : nodeSpawn(spec)) });
    const req = request('no-tool', null);
    const prepared = await adapter.prepare(req);
    pidFile = join(prepared.configDir, 'grandchild.pid');
    expect((await adapter.run(prepared, req)).exit).toEqual({ kind: 'crash', code: -1 });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive()).toBe(false);
    await prepared.dispose();
  }, 60000);

  it('checks, and deletes the temp folder, with the transcript copy surviving', async () => {
    const { settings } = rig();
    const adapter = makeCodexAzure(settings, { env: ENV, spawn: withNpmStub });
    const req = request('no-tool', null);
    const prepared = await adapter.prepare(req);
    await adapter.run(prepared, req);
    expect(await adapter.check(prepared, req)).toBe('pass');
    await prepared.dispose();
    expect(existsSync(prepared.dir)).toBe(false);
    expect(existsSync(join(scratch, 'transcripts', 'o-2-0001.jsonl'))).toBe(true);
  });
});
