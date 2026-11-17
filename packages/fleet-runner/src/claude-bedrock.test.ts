// Proof of the Claude Code on Bedrock adapter against a stub `claude` (src/stub-claude.mjs), a tiny git repository made here, and a stub `npm`. No test starts the real
// `claude`, opens a network connection, or reads an AWS credential: the credential is a made-up string handed in through the injected environment.
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClaudeBedrock, makeNodeSpawn, nodeSpawn, type ClaudeBedrockSettings, type HostProcess, type Spawn, type StartTimer, type ToolUnderTest } from './claude-bedrock.js';
import type { RunRequest } from './harness.js';
import { readFirstRun } from './first-run-read.js';
import { isObject } from './json.js';
import { parseOrder } from './order.js';
import { comparisonText, FLEET } from './test-fixtures.js';

const STUB = join(dirname(fileURLToPath(import.meta.url)), 'stub-claude.mjs');
const SECRET = 'bedrock-key-not-real-0001';
const MODEL = 'global.anthropic.claude-sonnet-5-5';
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

/** A repository's files: path to text. */
interface RepoFiles {
  [path: string]: string;
}

const makeRepo = (name: string, files: RepoFiles, tag: string | null): { dir: string; commit: string } => {
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

const RESET = { node: '>=20.0.0', install: 'node scripts/install.mjs', buildDb: 'node scripts/build-db.mjs' };

/** The real task-set layout: `manifest.json`, `prompts/<id>.md`, `checks/<id>.mjs`, and a task's `setup` path (relative to the folder) when it has one. */
const writeTask = (taskSetDir: string, prompt: string, reset: object = RESET, fixtureCommit = 'x', setup: string | null = null): void => {
  mkdirSync(join(taskSetDir, 'prompts'), { recursive: true });
  mkdirSync(join(taskSetDir, 'checks'), { recursive: true });
  const task = { id: 't1', category: 'browser', status: 'written', ...(setup === null ? {} : { setup }) };
  writeFileSync(join(taskSetDir, 'manifest.json'), JSON.stringify({ version: 'v1', fixtureTag: 'taskset-v1', fixtureCommit, reset, tasks: [task] }));
  writeFileSync(join(taskSetDir, 'prompts', 't1.md'), prompt);
  writeFileSync(join(taskSetDir, 'checks', 't1.mjs'), PASS_IF_SEED);
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
  writeTask(join(scratch, 'taskset'), prompt, RESET, fixture.commit);
  const settings: ClaudeBedrockSettings = {
    fixtureSource: fixture.dir,
    fixtureTag: 'taskset-v1',
    taskSetDir: join(scratch, 'taskset'),
    fleetManifestVersion: 'fleet-1',
    claudeExecutable: process.execPath,
    claudeArgs: [STUB],
    awsRegion: 'us-east-1',
    modelId: MODEL,
    tool: SERVER,
    timeLimitMs: 20000,
    setupTimeLimitMs: 60000,
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
const withNpmStub = (calls: string[], installed: string | null, base: Spawn = nodeSpawn): Spawn => async (spec) => {
  if (spec.command !== 'npm-stub') return base(spec);
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
  expected: { taskSetVersion: 'v1', fixtureTag: 'taskset-v1', manifestVersion: 'fleet-1', harnessVersion: '2.1.326', modelId: MODEL, toolPins: pin === null ? [] : [{ name: arm, pin }], ...patch },
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
    const r = rig();
    const moved = join(scratch, 'fixture');
    writeFileSync(join(moved, 'README.md'), 'moved');
    git(moved, 'commit', '-q', '-am', 'second');
    git(moved, 'tag', '-f', 'taskset-v1');
    const adapter = makeClaudeBedrock(r.settings, { env: ENV });
    const prepared = await adapter.prepare(request('no-tool', null));
    expect(prepared.fixtureCommit).not.toBe(r.fixtureCommit);
    expect(prepared.fixtureTag).toBe(`taskset-v1@${prepared.fixtureCommit}`);
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
    writeTask(join(scratch, 'taskset'), 'scenario: ok', { ...RESET, node: '>=24.0.0' }, r.fixtureCommit);
    expect(() => makeClaudeBedrock(r.settings, { env: ENV, nodeVersion: '22.4.0' })).toThrow(/Node 22 is below the Node 24/);
    expect(() => makeClaudeBedrock(r.settings, { env: ENV, nodeVersion: '24.0.0' })).not.toThrow();
  });

  it('accepts a 7 to 40 hex fixtureCommit as a prefix of the clone head, and reports a shorter, longer, or other one as a moved tag', async () => {
    const r = rig();
    for (const [commit, moved] of [[r.fixtureCommit.slice(0, 7), false], [r.fixtureCommit.slice(0, 12), false], [r.fixtureCommit.slice(0, 6), true], ['0000000', true], ['x', true]] as const) {
      writeTask(join(scratch, 'taskset'), 'scenario: ok', RESET, commit);
      const prepared = await makeClaudeBedrock(r.settings, { env: ENV }).prepare(request('no-tool', null));
      expect(prepared.fixtureTag === 'taskset-v1', commit).toBe(!moved);
      await prepared.dispose();
    }
  });

  it('compares the Node floor as major.minor.patch, not only the major', () => {
    const r = rig();
    writeTask(join(scratch, 'taskset'), 'scenario: ok', { ...RESET, node: '>=24.3.1' }, r.fixtureCommit);
    expect(() => makeClaudeBedrock(r.settings, { env: ENV, nodeVersion: '24.0.0' })).toThrow(/Node 24\.0\.0 is below the Node 24\.3\.1/);
    expect(() => makeClaudeBedrock(r.settings, { env: ENV, nodeVersion: '24.3.0' })).toThrow(/below/);
    expect(() => makeClaudeBedrock(r.settings, { env: ENV, nodeVersion: '24.3.1' })).not.toThrow();
    expect(() => makeClaudeBedrock(r.settings, { env: ENV, nodeVersion: '25.0.0' })).not.toThrow();
  });

  it('refuses at construction a fixtureTag setting that is not the manifest fixtureTag', () => {
    const r = rig();
    expect(() => makeClaudeBedrock({ ...r.settings, fixtureTag: 'taskset-v2' }, { env: ENV })).toThrow(/"taskset-v2" is not the task-set manifest's "taskset-v1"/);
  });

  it('refuses a manifest whose reset.node is not a ">=" floor, and one missing install or buildDb', () => {
    const r = rig();
    writeTask(join(scratch, 'taskset'), 'scenario: ok', { ...RESET, node: '24' }, r.fixtureCommit);
    expect(() => makeClaudeBedrock(r.settings, { env: ENV })).toThrow(/reset\.node/);
    writeTask(join(scratch, 'taskset'), 'scenario: ok', { node: '>=24.0.0', install: 'npm ci' }, r.fixtureCommit);
    expect(() => makeClaudeBedrock(r.settings, { env: ENV })).toThrow(/buildDb/);
    writeTask(join(scratch, 'taskset'), 'scenario: ok', { ...RESET, install: ' ' }, r.fixtureCommit);
    expect(() => makeClaudeBedrock(r.settings, { env: ENV })).toThrow(/reset\.install/);
  });

  it('refuses a task the manifest does not list, before it clones anything', async () => {
    const r = rig();
    const roots: string[] = [];
    const adapter = makeClaudeBedrock(r.settings, { env: ENV, onTempFolder: (dir) => roots.push(dir) });
    await expect(adapter.prepare({ ...request('no-tool', null), taskId: 'nope' })).rejects.toThrow(/task nope is not in the task-set manifest/);
    expect(roots).toHaveLength(0);
  });

  it('runs a task setup script once, after the reset and before the harness', async () => {
    const r = rig();
    mkdirSync(join(scratch, 'taskset', 'setup'), { recursive: true });
    writeTask(join(scratch, 'taskset'), 'scenario: ok', RESET, r.fixtureCommit, 'setup/t1.mjs');
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
    writeTask(join(scratch, 'taskset'), 'scenario: ok', RESET, r.fixtureCommit, 'setup/t1.mjs');
    writeFileSync(join(scratch, 'taskset', 'setup', 't1.mjs'), 'process.exit(4);' + String.fromCharCode(10));
    const roots: string[] = [];
    const adapter = makeClaudeBedrock(r.settings, { env: ENV, onTempFolder: (dir) => roots.push(dir) });
    await expect(adapter.prepare(request('no-tool', null))).rejects.toThrow(/setup script t1 failed/);
    expect(existsSync(roots[0] ?? '')).toBe(false);
  });

  it('a setup step past its own limit is an error the runner sees, and the folder is deleted', async () => {
    const r = rig({ setupTimeLimitMs: 1 });
    const roots: string[] = [];
    const adapter = makeClaudeBedrock(r.settings, { env: ENV, onTempFolder: (dir) => roots.push(dir) });
    await expect(adapter.prepare(request('no-tool', null))).rejects.toThrow(/timed out/);
    expect(existsSync(roots[0] ?? '')).toBe(false);
  });

  it('deletes the temp folder when a reset command fails', async () => {
    const r = rig();
    writeTask(join(scratch, 'taskset'), 'scenario: ok', { ...RESET, buildDb: 'node scripts/missing.mjs' }, r.fixtureCommit);
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
    expect(result.harnessVersion).toBe('2.1.326');
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
    expect(s.envNames).toContain('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB');
    expect(s.envNames).not.toContain('ANTHROPIC_API_KEY');
    expect(strs(JSON.parse(readFileSync(join(prepared.configDir, 'stub-child-seen.json'), 'utf8')))).not.toContain('AWS_BEARER_TOKEN_BEDROCK');
    expect(JSON.stringify(s)).not.toContain('someone');
    expect(readFileSync(join(prepared.configDir, 'mcp.json'), 'utf8')).toContain('"--headless"]');
    await prepared.dispose();
  });

  it('saves the harness stdout beside the transcript copy, byte for byte as the child wrote it', async () => {
    const { r, prepared } = await run('scenario: ok\nDo the task.');
    const saved = join(r.settings.transcriptOutDir, 'o-2-0001.stdout.jsonl');
    expect(readFileSync(saved, 'utf8')).toBe(readFileSync(join(prepared.configDir, 'stub-stdout.txt'), 'utf8'));
    expect(readFileSync(saved, 'utf8').split('\n').filter((text) => text !== '')).toHaveLength(2);
  });

  it.each(['auth', 'rate', 'crash'])('saves the harness stdout when the run ends as %s', async (scenario) => {
    const { r, prepared } = await run(`scenario: ${scenario}\n`);
    expect(readFileSync(join(r.settings.transcriptOutDir, 'o-2-0001.stdout.jsonl'), 'utf8')).toBe(readFileSync(join(prepared.configDir, 'stub-stdout.txt'), 'utf8'));
  });

  it('saves the harness stdout when the run times out', async () => {
    const { r } = await run('scenario: hang\n', { timeLimitMs: 1 });
    expect(existsSync(join(r.settings.transcriptOutDir, 'o-2-0001.stdout.jsonl'))).toBe(true);
  });

  it('leaves the key value out of the saved stdout', async () => {
    const { r } = await run('scenario: echokey\n');
    const text = readFileSync(join(r.settings.transcriptOutDir, 'o-2-0001.stdout.jsonl'), 'utf8');
    expect(text).toContain('key is ');
    expect(text).not.toContain(SECRET);
  });

  it('the first-run read takes the saved stdout and the transcript copy as the adapter left them and prints seven lines', async () => {
    const { r, result } = await run('scenario: ok\nDo the task.');
    const book = join(scratch, 'run-book.jsonl');
    writeFileSync(book, `${JSON.stringify({ runId: 'o-2-0001', cacheTokens: 4500 })}\n`);
    const output = readFileSync(join(r.settings.transcriptOutDir, 'o-2-0001.stdout.jsonl'), 'utf8');
    const lines = readFirstRun({ transcript: readFileSync(result.transcriptPath ?? '', 'utf8'), output, runBook: readFileSync(book, 'utf8'), modelId: MODEL, runId: 'o-2-0001', allowServers: ['playwright'], allowSkills: [] });
    expect(lines).toHaveLength(7);
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

  it('a run past the time limit is killed and reported as a crash, while the reset and setup steps keep their own limit', async () => {
    const { result } = await run('scenario: hang\n', { timeLimitMs: 1 });
    expect(result.exit).toEqual({ kind: 'crash', code: -1 });
  });

  it('a timeout ends the harness and the processes it started', async () => {
    const HARNESS_LIMIT_MS = 1234;
    const r = rig({ timeLimitMs: HARNESS_LIMIT_MS }, 'scenario: tree' + String.fromCharCode(10));
    const req = request('no-tool', null);
    // Only the harness call gets this timer, and it fires once the grandchild exists, so the kill never races the stub's startup.
    let pidFile = '';
    const timer: StartTimer = (ms, fire) => {
      const state = { cancelled: false };
      if (ms !== HARNESS_LIMIT_MS) return () => undefined;
      void (async () => {
        for (let i = 0; i < 300 && !state.cancelled && !existsSync(pidFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
        if (!state.cancelled) fire();
      })();
      return () => {
        state.cancelled = true;
      };
    };
    const driven = makeClaudeBedrock(r.settings, { env: ENV, spawn: async (spec) => (spec.timeoutMs === HARNESS_LIMIT_MS ? makeNodeSpawn(timer)(spec) : nodeSpawn(spec)) });
    const prepared = await driven.prepare(req);
    pidFile = join(prepared.configDir, 'grandchild.pid');
    const result = await driven.run(prepared, req);
    expect(result.exit).toEqual({ kind: 'crash', code: -1 });
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

  it('a SIGTERM, SIGINT, or exit of the runner ends the harness it started', async () => {
    const r = rig({}, 'scenario: hang' + String.fromCharCode(10));
    for (const event of ['SIGTERM', 'SIGINT', 'exit'] as const) {
      const host = new EventEmitter();
      const raised: string[] = [];
      const fakeHost: HostProcess = { pid: 4242, once: (name, listener) => host.once(name, listener), kill: (_pid, signal) => raised.push(signal) };
      // The harness call's timer never fires, so only the handler can end the stub; setup steps keep a real limit.
      const timer: StartTimer = (ms, fire) => {
        if (ms === r.settings.timeLimitMs) return () => undefined;
        const handle = setTimeout(fire, ms);
        return () => {
          clearTimeout(handle);
        };
      };
      const adapter = makeClaudeBedrock(r.settings, { env: ENV, spawn: makeNodeSpawn(timer, fakeHost) });
      const req = request('no-tool', null);
      const prepared = await adapter.prepare(req);
      const seen = join(prepared.configDir, 'stub-seen.json');
      const running = adapter.run(prepared, req);
      for (let i = 0; i < 300 && !existsSync(seen); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(existsSync(seen)).toBe(true);
      host.emit(event);
      // The stub would run for a minute; a missing kill fails at the deadline instead of hanging.
      let deadline: NodeJS.Timeout | undefined;
      const limit = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          reject(new Error('the stub was not ended by ' + event));
        }, 30000);
      });
      const result = await Promise.race([running, limit]).finally(() => {
        clearTimeout(deadline);
      });
      expect(result.exit.kind).not.toBe('ok');
      expect(raised).toEqual(event === 'exit' ? [] : [event]);
      await prepared.dispose();
    }
  }, 120000);

  it('refuses a .cmd or .bat executable, which would leave the real claude running after a timeout', () => {
    const r = rig();
    expect(() => makeClaudeBedrock({ ...r.settings, claudeExecutable: 'claude.CMD' }, { env: ENV })).toThrow(/native claude/);
    expect(() => makeClaudeBedrock({ ...r.settings, claudeExecutable: 'claude.bat' }, { env: ENV })).toThrow(/native claude/);
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

  const skillRig = (): Rig => rig({ tool: { kind: 'skill', name: 'fill', repo: join(scratch, 'skill'), subdir: 'skills/fill' } }, 'scenario: ok' + String.fromCharCode(10));

  it('re-reads a commit-pinned skill before the run and does not start the harness when another commit is checked out', async () => {
    const r = skillRig();
    const adapter = makeClaudeBedrock(r.settings, { env: ENV });
    const req = request('fill', `git:${r.skillRepo.commit.slice(0, 10)}`);
    const prepared = await adapter.prepare(req);
    expect(prepared.installedPins).toEqual([{ name: 'fill', pin: req.expected.toolPins[0]?.pin }]);
    writeFileSync(join(r.skillRepo.dir, 'skills', 'fill', 'SKILL.md'), 'changed');
    git(r.skillRepo.dir, 'commit', '-q', '-am', 'second');
    const second = git(r.skillRepo.dir, 'rev-parse', 'HEAD');
    const source = join(prepared.dir, 'tool-src');
    git(source, 'fetch', '-q', 'origin');
    git(source, 'checkout', '-q', '-f', '--detach', second);
    const result = await adapter.run(prepared, req);
    expect(prepared.installedPins).toEqual([{ name: 'fill', pin: `git:${second}` }]);
    expect(result.transcriptPath).toBeNull();
    expect(existsSync(join(prepared.configDir, 'stub-seen.json'))).toBe(false);
    await prepared.dispose();
  });

  it('treats a commit pin shorter than 7 hex characters as a mismatch', async () => {
    const r = skillRig();
    const adapter = makeClaudeBedrock(r.settings, { env: ENV });
    const req = request('fill', `git:${r.skillRepo.commit.slice(0, 6)}`);
    const prepared = await adapter.prepare(req);
    expect(prepared.installedPins).toEqual([{ name: 'fill', pin: `git:${r.skillRepo.commit}` }]);
    await adapter.run(prepared, req);
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
    rmSync(join(scratch, 'taskset', 'checks', 't1.mjs'), { force: true });
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
    rmSync(join(scratch, 'taskset', 'checks', 't1.mjs'), { force: true });
    await expect(adapter.check(prepared, req)).rejects.toThrow();
    await prepared.dispose();
    expect(existsSync(prepared.dir)).toBe(false);
    expect(existsSync(result.transcriptPath ?? '')).toBe(true);
  });
});

describe('makeNodeSpawn output', () => {
  it('keeps a multibyte character that arrives split across two writes', async () => {
    const script = "const b = Buffer.from('\u20ac'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 150);";
    const outcome = await nodeSpawn({ command: process.execPath, args: ['-e', script], cwd: tmpdir(), env: {}, stdin: null, timeoutMs: 20000 });
    expect(outcome.stdout).toBe('\u20ac');
  });
});
