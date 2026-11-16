// Proof of the Claude Code on Bedrock adapter against a stub `claude` (scripts/stub-claude.mjs), a tiny git repository made here, and a stub `npm`. No test starts the real
// `claude`, opens a network connection, or reads an AWS credential: the credential is a made-up string handed in through the injected environment.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClaudeBedrock, nodeSpawn, type ClaudeBedrockSettings, type Spawn, type ToolUnderTest } from './claude-bedrock.js';
import type { RunRequest } from './harness.js';
import { isObject } from './json.js';
import { parseOrder } from './order.js';
import { comparisonText, FLEET } from './test-fixtures.js';

const STUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'stub-claude.mjs');
const SECRET = 'bedrock-key-not-real-0001';
const MODEL = 'sonnet-pinned-1';
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

const PASS_IF_SEED = [
  "import { existsSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "process.exit(existsSync(join(process.argv[2], 'seed.sql')) ? 0 : 3);",
  '',
].join('\n');

let scratch = '';
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'bedrock-test-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const makeRepo = (name: string, files: { [path: string]: string }, tag: string | null): { dir: string; commit: string } => {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  if (tag !== null) git(dir, 'tag', tag);
  return { dir, commit: git(dir, 'rev-parse', 'HEAD') };
};

const APPEND = (word: string): string => ["import { appendFileSync, writeFileSync } from 'node:fs';", `appendFileSync('order.txt', '${word},');`, ''].join(String.fromCharCode(10));

const RESET = { node: '20', commands: ['node scripts/install.mjs', 'node scripts/build-db.mjs'] };

const writeTask = (taskSetDir: string, prompt: string, reset: object = RESET): void => {
  mkdirSync(join(taskSetDir, 'tasks', 't1'), { recursive: true });
  writeFileSync(join(taskSetDir, 'manifest.json'), JSON.stringify({ version: 'v1', fixtureTag: 'taskset-v1', fixtureCommit: 'x', reset, tasks: [{ id: 't1', category: 'browser' }] }));
  writeFileSync(join(taskSetDir, 'tasks', 't1', 'prompt.md'), prompt);
  writeFileSync(join(taskSetDir, 'tasks', 't1', 'check.mjs'), PASS_IF_SEED);
};

const SERVER: ToolUnderTest = { kind: 'server', name: 'playwright', package: '@playwright/mcp', entry: 'cli.js', args: ['--headless'] };

interface Rig {
  settings: ClaudeBedrockSettings;
  fixtureCommit: string;
  skillRepo: { dir: string; commit: string };
  calls: string[];
}

const rig = (patch: Partial<ClaudeBedrockSettings> = {}, prompt = 'scenario: ok\nDo the task.'): Rig => {
  const fixture = makeRepo('fixture', { 'seed.sql': 'create table t(a);', 'README.md': 'hi', 'scripts/install.mjs': APPEND('install'), 'scripts/build-db.mjs': APPEND('build') + "writeFileSync('app.db', 'built');" + String.fromCharCode(10) }, 'taskset-v1');
  const skillRepo = makeRepo('skill', { 'skills/fill/SKILL.md': '---\nname: fill\n---\nFill forms.\n' }, null);
  writeTask(join(scratch, 'taskset'), prompt);
  const settings: ClaudeBedrockSettings = {
    fixtureSource: fixture.dir,
    fixtureTag: 'taskset-v1',
    fixtureCommit: fixture.commit,
    taskSetDir: join(scratch, 'taskset'),
    fleetManifestVersion: 'fleet-1',
    claudeExecutable: process.execPath,
    claudeArgs: [STUB],
    awsRegion: 'us-east-1',
    modelId: MODEL,
    tool: SERVER,
    timeLimitMs: 20000,
    transcriptOutDir: join(scratch, 'transcripts'),
    gitExecutable: 'git',
    npmExecutable: 'npm-stub',
    allowedTools: ['Bash', 'Read', 'Edit', 'Write'],
    setupEnvNames: [],
    ...patch,
  };
  return { settings, fixtureCommit: fixture.commit, skillRepo, calls: [] };
};

/** Real spawn for everything but the stub `npm`, which writes the package a real install would. `installed` overrides the version it "installs". */
const withNpmStub = (calls: string[], installed: string | null): Spawn => async (spec) => {
  if (spec.command !== 'npm-stub') return nodeSpawn(spec);
  calls.push(spec.args.join(' '));
  const prefix = spec.args[spec.args.indexOf('--prefix') + 1] ?? '';
  const target = spec.args.find((arg) => arg.startsWith('@playwright/mcp@')) ?? '';
  const dir = join(prefix, 'node_modules', '@playwright', 'mcp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@playwright/mcp', version: installed ?? target.split('@')[2] }));
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, errorCode: null };
};

const ENV = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', AWS_BEARER_TOKEN_BEDROCK: SECRET, ANTHROPIC_API_KEY: 'personal-key', HOME: 'C:\\Users\\someone', CLAUDE_CONFIG_DIR: 'C:\\Users\\someone\\.claude' };

const request = (arm: string, pin: string | null, patch: Partial<RunRequest['expected']> = {}): RunRequest => ({
  runId: 'o-2-0001',
  sequence: 1,
  attempt: 1,
  order: parseOrder(comparisonText(), FLEET),
  taskId: 't1',
  category: 'browser',
  arm,
  side: null,
  repeat: 1,
  expected: { taskSetVersion: 'v1', fixtureTag: 'taskset-v1', manifestVersion: 'fleet-1', harnessVersion: '2.1.30', modelId: MODEL, toolPins: pin === null ? [] : [{ name: arm, pin }], ...patch },
});

const listing = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((entry) => entry.split('\\').join('/')).sort() : []);
const strs = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

interface Seen {
  argv: string[];
  envNames: string[];
  cwd: string;
  prompt: string;
}
const seen = (configDir: string): Seen => {
  const value: unknown = JSON.parse(readFileSync(join(configDir, 'stub-seen.json'), 'utf8'));
  if (!isObject(value)) throw new Error('stub-seen.json is not an object');
  return { argv: strs(value['argv']), envNames: strs(value['envNames']), cwd: String(value['cwd']), prompt: String(value['prompt']) };
};

describe('prepare', () => {
  it('builds a fresh clone at the tag, records its commit, rebuilds the database, and holds an empty config folder for the no-tool arm', async () => {
    const r = rig();
    const adapter = makeClaudeBedrock(r.settings, { env: ENV });
    const prepared = await adapter.prepare(request('no-tool', null));
    expect(prepared.fixtureCommit).toBe(r.fixtureCommit);
    expect(prepared.fixtureTag).toBe('taskset-v1');
    expect(prepared.taskSetVersion).toBe('v1');
    expect(prepared.manifestVersion).toBe('fleet-1');
    expect(prepared.installedPins).toEqual([]);
    expect(readFileSync(join(prepared.runFolder, 'app.db'), 'utf8')).toBe('built');
    expect(listing(prepared.configDir)).toEqual([]);
    await prepared.dispose();
    expect(existsSync(prepared.dir)).toBe(false);
  });

  it('lists only the server and its mcp config for a server arm', async () => {
    const r = rig();
    const adapter = makeClaudeBedrock(r.settings, { env: ENV, spawn: withNpmStub(r.calls, null) });
    const prepared = await adapter.prepare(request('playwright', 'npm:1.0.0'));
    expect(listing(prepared.configDir)).toEqual(['mcp.json', 'tool', 'tool/node_modules', 'tool/node_modules/@playwright', 'tool/node_modules/@playwright/mcp', 'tool/node_modules/@playwright/mcp/package.json']);
    expect(prepared.installedPins).toEqual([{ name: 'playwright', pin: 'npm:1.0.0' }]);
    expect(r.calls[0]).toContain('@playwright/mcp@1.0.0');
    await prepared.dispose();
  });

  it('lists only the skill, without its git folder, for a skill arm', async () => {
    const r = rig({ tool: { kind: 'skill', name: 'fill', repo: join(scratch, 'skill'), subdir: 'skills/fill' } });
    const adapter = makeClaudeBedrock(r.settings, { env: ENV });
    const pin = `git:${r.skillRepo.commit.slice(0, 10)}`;
    const prepared = await adapter.prepare(request('fill', pin));
    expect(listing(prepared.configDir)).toEqual(['skills', 'skills/fill', 'skills/fill/SKILL.md']);
    expect(prepared.installedPins).toEqual([{ name: 'fill', pin }]);
    await prepared.dispose();
  });

  it('reports a fixture tag that now resolves to another commit so the runner voids it', async () => {
    const r = rig({ fixtureCommit: 'f'.repeat(40) });
    const adapter = makeClaudeBedrock(r.settings, { env: ENV });
    const prepared = await adapter.prepare(request('no-tool', null));
    expect(prepared.fixtureTag).toBe(`taskset-v1@${r.fixtureCommit}`);
    await prepared.dispose();
  });

  it('runs the manifest reset commands in order', async () => {
    const r = rig();
    const adapter = makeClaudeBedrock(r.settings, { env: ENV });
    const prepared = await adapter.prepare(request('no-tool', null));
    expect(readFileSync(join(prepared.runFolder, 'order.txt'), 'utf8')).toBe('install,build,');
    await prepared.dispose();
  });

  it('refuses a Node version below the manifest before any run', () => {
    const r = rig();
    writeTask(join(scratch, 'taskset'), 'scenario: ok', { node: '24', commands: [] });
    expect(() => makeClaudeBedrock(r.settings, { env: ENV, nodeVersion: '22.4.0' })).toThrow(/Node 22 is below the Node 24/);
    expect(() => makeClaudeBedrock(r.settings, { env: ENV, nodeVersion: '24.0.0' })).not.toThrow();
  });

  it('runs a task setup script once, after the reset and before the harness', async () => {
    const r = rig();
    mkdirSync(join(scratch, 'taskset', 'setup'), { recursive: true });
    writeFileSync(join(scratch, 'taskset', 'setup', 't1.mjs'), ["import { appendFileSync, existsSync } from 'node:fs';", "import { join } from 'node:path';", "const dir = process.argv[2] ?? '';", "appendFileSync(join(dir, 'order.txt'), `setup(db=${String(existsSync(join(dir, 'app.db')))}),`);", ''].join(String.fromCharCode(10)));
    const adapter = makeClaudeBedrock(r.settings, { env: ENV });
    const req = request('no-tool', null);
    const prepared = await adapter.prepare(req);
    expect(readFileSync(join(prepared.runFolder, 'order.txt'), 'utf8')).toBe('install,build,setup(db=true),');
    expect(existsSync(join(prepared.configDir, 'stub-seen.json'))).toBe(false);
    await adapter.run(prepared, req);
    expect(readFileSync(join(prepared.runFolder, 'order.txt'), 'utf8')).toBe('install,build,setup(db=true),');
    await prepared.dispose();
  });

  it('a setup script that exits non-zero is an error the runner sees, and the folder is deleted', async () => {
    const r = rig();
    mkdirSync(join(scratch, 'taskset', 'setup'), { recursive: true });
    writeFileSync(join(scratch, 'taskset', 'setup', 't1.mjs'), 'process.exit(4);' + String.fromCharCode(10));
    const roots: string[] = [];
    const adapter = makeClaudeBedrock(r.settings, { env: ENV, onTempFolder: (dir) => roots.push(dir) });
    await expect(adapter.prepare(request('no-tool', null))).rejects.toThrow(/setup script t1 failed/);
    expect(existsSync(roots[0] ?? '')).toBe(false);
  });

  it('deletes the temp folder when a reset command fails', async () => {
    const r = rig();
    writeTask(join(scratch, 'taskset'), 'scenario: ok', { node: '20', commands: ['node scripts/missing.mjs'] });
    const roots: string[] = [];
    const adapter = makeClaudeBedrock(r.settings, { env: ENV, onTempFolder: (dir) => roots.push(dir) });
    await expect(adapter.prepare(request('no-tool', null))).rejects.toThrow(/reset command/);
    expect(roots).toHaveLength(1);
    expect(existsSync(roots[0] ?? '')).toBe(false);
  });

  it('refuses to start without the Bedrock key or a region, never falling back to a personal sign-in', () => {
    const r = rig();
    const without = { ...ENV, AWS_BEARER_TOKEN_BEDROCK: undefined };
    expect(() => makeClaudeBedrock(r.settings, { env: without })).toThrow(/AWS_BEARER_TOKEN_BEDROCK/);
    expect(() => makeClaudeBedrock({ ...r.settings, awsRegion: '' }, { env: ENV })).toThrow(/region/);
  });
});

describe('run', () => {
  const run = async (prompt: string, patch: Partial<ClaudeBedrockSettings> = {}) => {
    const r = rig(patch, prompt);
    const adapter = makeClaudeBedrock(r.settings, { env: ENV, spawn: withNpmStub(r.calls, null) });
    const req = request('playwright', 'npm:1.0.0');
    const prepared = await adapter.prepare(req);
    const result = await adapter.run(prepared, req);
    return { r, prepared, result };
  };

  it('a clean run returns the transcript copy, version, model, and tokens, and starts claude as documented with only the named environment', async () => {
    const { r, prepared, result } = await run('scenario: ok\nDo the task.');
    expect(result.exit).toEqual({ kind: 'ok', code: 0 });
    expect(result.harnessVersion).toBe('2.1.30');
    expect(result.modelId).toBe(MODEL);
    expect(result.tokens).toEqual({ input: 1200, cache: 4500, output: 300 });
    expect(result.transcriptPath).toBe(join(r.settings.transcriptOutDir, 'o-2-0001.jsonl'));
    expect(readFileSync(result.transcriptPath ?? '', 'utf8')).toMatch(/^transcript of [0-9a-f-]{36}\n$/);
    expect(createHash('sha256').update(readFileSync(result.transcriptPath ?? '')).digest('hex')).toHaveLength(64);
    const s = seen(prepared.configDir);
    expect(s.cwd.toLowerCase()).toBe(prepared.runFolder.toLowerCase());
    expect(s.prompt).toBe('scenario: ok\nDo the task.');
    expect(s.argv).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', join(prepared.configDir, 'mcp.json'), '--model', MODEL, '--allowedTools']));
    expect(s.argv.join(' ')).toContain('Bash,Read,Edit,Write,mcp__playwright');
    expect(s.envNames).toEqual(expect.arrayContaining(['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'ANTHROPIC_MODEL', 'AWS_BEARER_TOKEN_BEDROCK', 'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER']));
    expect(s.envNames).not.toContain('ANTHROPIC_API_KEY');
    expect(JSON.stringify(s)).not.toContain('someone');
    expect(readFileSync(join(prepared.configDir, 'mcp.json'), 'utf8')).toContain('"--headless"]');
    await prepared.dispose();
  });

  it('a crash is a crash', async () => {
    const { result } = await run('scenario: crash\n');
    expect(result.exit).toEqual({ kind: 'crash', code: 139 });
    expect(result.transcriptPath).toBeNull();
  });

  it('a rejected key is auth-rejected, which the runner voids as sign-in-lost', async () => {
    expect((await run('scenario: auth\n')).result.exit.kind).toBe('auth-rejected');
  });

  it('a rate limit that ends the run is rate-limit', async () => {
    expect((await run('scenario: rate\n')).result.exit.kind).toBe('rate-limit');
  });

  it('a run past the time limit is killed and reported as a crash', async () => {
    const { result } = await run('scenario: hang\n', { timeLimitMs: 1500 });
    expect(result.exit).toEqual({ kind: 'crash', code: -1 });
  });

  it('reports the version the run saw so a difference voids it', async () => {
    expect((await run('scenario: version' + String.fromCharCode(10))).result.harnessVersion).toBe('9.9.9');
  });

  it('reports the model the transcript names so a difference voids it', async () => {
    expect((await run('scenario: model' + String.fromCharCode(10))).result.modelId).toBe('other-model-id');
  });

  it('an executable that cannot start is an error the runner sees', async () => {
    const r = rig({ claudeExecutable: join(scratch, 'missing-claude'), claudeArgs: [] });
    const adapter = makeClaudeBedrock(r.settings, { env: ENV });
    const req = request('no-tool', null);
    const prepared = await adapter.prepare(req);
    await expect(adapter.run(prepared, req)).rejects.toThrow(/start/);
    await prepared.dispose();
  });
});

describe('the tool pin', () => {
  it('does not start the harness when the installed npm server is not the pinned version', async () => {
    const r = rig({}, 'scenario: ok\n');
    const adapter = makeClaudeBedrock(r.settings, { env: ENV, spawn: withNpmStub(r.calls, '9.9.9') });
    const req = request('playwright', 'npm:1.0.0');
    const prepared = await adapter.prepare(req);
    const result = await adapter.run(prepared, req);
    expect(prepared.installedPins).toEqual([{ name: 'playwright', pin: 'npm:9.9.9' }]);
    expect(existsSync(join(prepared.configDir, 'stub-seen.json'))).toBe(false);
    expect(result.transcriptPath).toBeNull();
    expect(result.tokens).toEqual({ input: 0, cache: 0, output: 0 });
    await prepared.dispose();
  });

  it('reports a skill pin that is not the commit checked out (a tag name), and does not start the harness', async () => {
    const r = rig({ tool: { kind: 'skill', name: 'fill', repo: join(scratch, 'skill'), subdir: 'skills/fill' } }, 'scenario: ok' + String.fromCharCode(10));
    git(r.skillRepo.dir, 'tag', 'v1');
    const adapter = makeClaudeBedrock(r.settings, { env: ENV });
    const req = request('fill', 'git:v1');
    const prepared = await adapter.prepare(req);
    expect(prepared.installedPins).toEqual([{ name: 'fill', pin: `git:${r.skillRepo.commit}` }]);
    const result = await adapter.run(prepared, req);
    expect(result.transcriptPath).toBeNull();
    expect(existsSync(join(prepared.configDir, 'stub-seen.json'))).toBe(false);
    await prepared.dispose();
  });

  it('reads the version again before the run and notices a change', async () => {
    const r = rig({}, 'scenario: ok\n');
    const adapter = makeClaudeBedrock(r.settings, { env: ENV, spawn: withNpmStub(r.calls, null) });
    const req = request('playwright', 'npm:1.0.0');
    const prepared = await adapter.prepare(req);
    writeFileSync(join(prepared.configDir, 'tool', 'node_modules', '@playwright', 'mcp', 'package.json'), JSON.stringify({ version: '2.0.0' }));
    await adapter.run(prepared, req);
    expect(prepared.installedPins).toEqual([{ name: 'playwright', pin: 'npm:2.0.0' }]);
    expect(existsSync(join(prepared.configDir, 'stub-seen.json'))).toBe(false);
    await prepared.dispose();
  });
});

describe('check and cleanup', () => {
  it('maps exit 0 to pass and any other exit to fail', async () => {
    const r = rig();
    const adapter = makeClaudeBedrock(r.settings, { env: ENV });
    const req = request('no-tool', null);
    const prepared = await adapter.prepare(req);
    expect(await adapter.check(prepared, req)).toBe('pass');
    rmSync(join(prepared.runFolder, 'seed.sql'));
    expect(await adapter.check(prepared, req)).toBe('fail');
    await prepared.dispose();
  });

  it('a check that cannot start is an error, not a fail', async () => {
    const r = rig();
    rmSync(join(scratch, 'taskset', 'tasks', 't1', 'check.mjs'), { force: true });
    const adapter = makeClaudeBedrock(r.settings, { env: ENV });
    const req = request('no-tool', null);
    const prepared = await adapter.prepare(req);
    await expect(adapter.check(prepared, req)).rejects.toThrow(/check/);
    await prepared.dispose();
  });

  it('deletes the temp folder even when a step threw, and the copied transcript survives', async () => {
    const r = rig({}, 'scenario: ok\n');
    const adapter = makeClaudeBedrock(r.settings, { env: ENV });
    const req = request('no-tool', null);
    const prepared = await adapter.prepare(req);
    const result = await adapter.run(prepared, req);
    rmSync(join(scratch, 'taskset', 'tasks', 't1', 'check.mjs'), { force: true });
    await expect(adapter.check(prepared, req)).rejects.toThrow();
    await prepared.dispose();
    expect(existsSync(prepared.dir)).toBe(false);
    expect(existsSync(result.transcriptPath ?? '')).toBe(true);
  });
});
