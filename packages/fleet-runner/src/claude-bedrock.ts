// The real harness adapter: Claude Code on Amazon Bedrock, headless (`claude -p`), on a Bedrock API key (spec sections 3, 4, and 9). `prepare` does the section 3 reset in a
// new temp folder, `run` starts `claude` there with only the variables named below, `check` runs the task's check script. Docs (read 2026-11-16):
//   headless and flags   https://code.claude.com/docs/en/headless.md , https://code.claude.com/docs/en/cli-reference.md
//   Bedrock variables    https://code.claude.com/docs/en/amazon-bedrock.md , https://code.claude.com/docs/en/env-vars.md
//   transcript location  https://code.claude.com/docs/en/sessions.md#where-transcripts-are-stored
//   stream-json result   https://code.claude.com/docs/en/agent-sdk/typescript.md (SDKSystemMessage, SDKResultMessage, ModelUsage)
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import type { CheckResult, ExitKind, HarnessAdapter, Prepared, RunRequest, RunResult, TokenCounts, ToolPin } from './harness.js';
import { existsSync, readFileSync } from 'node:fs';
import { arrayAt, isObject, objectAt, parseJson, stringAt, optionalStringAt } from './json.js';
import { loadTaskSet } from './manifest.js';

export interface EnvMap {
  [name: string]: string | undefined;
}

export interface CommandSpec {
  command: string;
  args: string[];
}

/** An npm-installed MCP server: `package` is installed at the pin into the config folder, and `node <entry> <args>` starts it. */
export interface ServerTool {
  kind: 'server';
  name: string;
  package: string;
  /** The script to run, relative to the package folder. */
  entry: string;
  args: string[];
}

/** A skill held in a git repository (`subdir` inside it), checked out at the pinned commit and copied to `<config>/skills/<name>`. */
export interface SkillTool {
  kind: 'skill';
  name: string;
  repo: string;
  subdir: string;
}

export type ToolUnderTest = ServerTool | SkillTool;

export interface ClaudeBedrockSettings {
  /** A local path or a git URL of the fixture repository. */
  fixtureSource: string;
  fixtureTag: string;
  /** The task-set folder: `manifest.json`, and per task `tasks/<id>/prompt.md` and `tasks/<id>/check.mjs`. */
  taskSetDir: string;
  /** The fleet manifest version this adapter was built for; reported as the manifest the run saw. */
  fleetManifestVersion: string;
  claudeExecutable: string;
  /** Arguments placed before Claude Code's own (empty for the real executable). */
  claudeArgs: string[];
  awsRegion: string;
  modelId: string;
  /** The tool the arm named `tool.name` installs; any other arm is the no-tool arm. */
  tool: ToolUnderTest | null;
  /** The limit on the harness call alone. */
  timeLimitMs: number;
  /** The limit on each reset, setup, install, and check step, so a slow clone or build is never mistaken for a slow harness. */
  setupTimeLimitMs: number;
  /** Where each run's transcript is copied, outside the temp folder, as `<runId>.jsonl`. */
  transcriptOutDir: string;
  gitExecutable: string;
  npmExecutable: string;
  allowedTools: string[];
  /** Names copied from the caller's environment into the git and npm steps only (for example a credential helper's variable), never into `claude`. */
  setupEnvNames: string[];
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  /** The child's whole environment; nothing else is inherited. */
  env: { [name: string]: string };
  stdin: string | null;
  timeoutMs: number;
}

export interface SpawnOutcome {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** `ENOENT`, `ENOSPC`, and the like, when the process could not start. */
  errorCode: string | null;
}

export type Spawn = (spec: SpawnSpec) => Promise<SpawnOutcome>;

export interface Dependencies {
  /** The caller's environment: where the Bedrock key and the names a child needs to start are read from. Nothing else reads `process.env`. */
  env: EnvMap;
  spawn?: Spawn;
  /** The Node version running the runner; defaults to this process's. A version below the manifest's is refused at construction. */
  nodeVersion?: string;
  /** Called with each temp folder as it is made (tests use it to prove the folder is gone after a failed prepare). */
  onTempFolder?: (dir: string) => void;
}

export interface ClaudePrepared extends Prepared {
  runFolder: string;
  configDir: string;
  fixtureCommit: string;
}

/** What a fresh run folder needs, read from the task-set manifest's `reset` object: `{ "node": "24", "commands": ["npm ci", "node scripts/build-db.ts"] }`. */
export interface ResetPlan {
  nodeMajor: number;
  commands: CommandSpec[];
}

export const loadResetPlan = (taskSetDir: string): ResetPlan => {
  const root = objectAt(parseJson(readFileSync(join(taskSetDir, 'manifest.json'), 'utf8'), 'task-set manifest'), 'task-set manifest');
  const reset = objectAt(root['reset'], 'taskset.reset');
  const nodeMajor = Number.parseInt(stringAt(reset, 'node', 'taskset.reset'), 10);
  if (Number.isNaN(nodeMajor)) throw new Error('taskset.reset.node must start with a major version number');
  const commands = arrayAt(reset, 'commands', 'taskset.reset').map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') throw new Error(`taskset.reset.commands[${String(index)}] must be a command line`);
    const [command = '', ...args] = entry.trim().split(/\s+/);
    return { command, args };
  });
  return { nodeMajor, commands };
};

/** Ends a process and everything it started: the harness starts MCP servers of its own, and an orphan would keep drawing credit. */
const killTree = (pid: number | undefined): void => {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // The process already ended.
  }
};

export const nodeSpawn: Spawn = (spec) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (outcome: SpawnOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    // No shell: a `.cmd` wrapper would be the process killed on a timeout while the real program kept running (the constructor refuses one). Off Windows the child leads its own
    // process group so a timeout can end the whole group.
    const child = spawnChild(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, spec.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ exitCode: null, signal: null, stdout, stderr, timedOut, errorCode: error.code ?? 'UNKNOWN' });
    });
    child.on('close', (exitCode, signal) => {
      finish({ exitCode, signal, stdout, stderr, timedOut, errorCode: null });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(spec.stdin ?? '');
  });

// What a process needs to start. HOME and the application-data folders are not here: they point into the run's own temp folder.
const START_NAMES = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR'];

const pick = (env: EnvMap, names: readonly string[]): { [name: string]: string } => {
  const out: { [name: string]: string } = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
};

// A commit prefix of fewer than 7 hex characters names too many commits to prove a pin, so it never matches.
const hasPrefix = (actual: string, wanted: string): boolean => /^[0-9a-f]{7,40}$/.test(wanted) && actual.startsWith(wanted);

const AUTH_TEXT = /\b(401|403)\b|invalid (api key|token|security token)|not authorized|security token.*(invalid|expired)|unrecognizedclient/i;
const NETWORK_TEXT = /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|ENETUNREACH/;

interface StreamFacts {
  version: string | null;
  model: string | null;
  result: { isError: boolean; status: number | null } | null;
  tokens: TokenCounts;
}

const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** Reads stream-json lines: the `system/init` event (version, model) and the final `result` event (error state, per-model usage summed over the whole tree). */
export const parseStream = (stdout: string): StreamFacts => {
  const facts: StreamFacts = { version: null, model: null, result: null, tokens: { input: 0, cache: 0, output: 0 } };
  for (const line of stdout.split('\n')) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(event)) continue;
    if (event['type'] === 'system' && event['subtype'] === 'init') {
      const version = event['claude_code_version'];
      const model = event['model'];
      facts.version = typeof version === 'string' ? version : null;
      facts.model = typeof model === 'string' ? model : null;
    } else if (event['type'] === 'result') {
      const status = event['api_error_status'];
      facts.result = { isError: event['is_error'] === true, status: typeof status === 'number' ? status : null };
      const usageByModel = event['modelUsage'];
      if (isObject(usageByModel)) {
        for (const usage of Object.values(usageByModel)) {
          if (!isObject(usage)) continue;
          facts.tokens.input += num(usage['inputTokens']);
          facts.tokens.cache += num(usage['cacheReadInputTokens']) + num(usage['cacheCreationInputTokens']);
          facts.tokens.output += num(usage['outputTokens']);
        }
      }
    }
  }
  return facts;
};

const classify = (outcome: SpawnOutcome, facts: StreamFacts): ExitKind => {
  if (outcome.errorCode === 'ENOSPC') return 'disk-full';
  if (outcome.timedOut) return 'crash';
  if (facts.result !== null) {
    if (!facts.result.isError) return 'ok';
    if (facts.result.status === 401 || facts.result.status === 403) return 'auth-rejected';
    if (facts.result.status === 429) return 'rate-limit';
    return facts.result.status === null ? 'crash' : 'api-error';
  }
  const text = `${outcome.stderr}\n${outcome.stdout}`;
  if (AUTH_TEXT.test(text)) return 'auth-rejected';
  if (NETWORK_TEXT.test(text)) return 'network-down';
  return 'crash';
};

const pinParts = (pin: string): { scheme: string; value: string } => {
  const at = pin.indexOf(':');
  return at < 0 ? { scheme: '', value: pin } : { scheme: pin.slice(0, at), value: pin.slice(at + 1) };
};

/** The adapter, with `prepare` typed to return the richer folder so a caller can read its commit and paths. */
export interface ClaudeBedrockAdapter extends Omit<HarnessAdapter, 'prepare'> {
  prepare: (request: RunRequest) => Promise<ClaudePrepared>;
}

export const makeClaudeBedrock = (settings: ClaudeBedrockSettings, deps: Dependencies): ClaudeBedrockAdapter => {
  const key = deps.env['AWS_BEARER_TOKEN_BEDROCK'];
  if (key === undefined || key === '') throw new Error('AWS_BEARER_TOKEN_BEDROCK is not set: the fleet runs on a Bedrock API key and never falls back to a personal Claude sign-in');
  if (settings.awsRegion === '') throw new Error('the AWS region setting is empty: Bedrock needs a region');
  if (settings.modelId === '') throw new Error('the model ID setting is empty');
  if (['.cmd', '.bat'].includes(extname(settings.claudeExecutable).toLowerCase())) throw new Error(`${settings.claudeExecutable} is a batch wrapper: a timeout would kill the wrapper and leave claude running. Use the native claude executable, or node with cli.js through claudeArgs`);
  const reset = loadResetPlan(settings.taskSetDir);
  const nodeMajor = Number.parseInt(deps.nodeVersion ?? process.versions.node, 10);
  if (nodeMajor < reset.nodeMajor) throw new Error(`Node ${String(nodeMajor)} is below the Node ${String(reset.nodeMajor)} the fixture needs (task-set manifest reset.node); no run was started`);
  const spawn = deps.spawn ?? nodeSpawn;
  const folders = new WeakMap<Prepared, ClaudePrepared>();
  const folderOf = (prepared: Prepared): ClaudePrepared => {
    const folder = folders.get(prepared);
    if (folder === undefined) throw new Error('this folder was not prepared by this adapter');
    return folder;
  };

  // The environment of a git, npm, or database step: the start names, the folder's own home, and the operator's named extras.
  const setupEnv = (root: string): { [name: string]: string } => ({ ...pick(deps.env, START_NAMES), ...pick(deps.env, settings.setupEnvNames), HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), GIT_TERMINAL_PROMPT: '0' });

  const step = async (what: string, spec: SpawnSpec): Promise<string> => {
    const outcome = await spawn(spec);
    if (outcome.errorCode !== null) throw new Error(`${what}: could not start ${spec.command} (${outcome.errorCode})`);
    if (outcome.timedOut) throw new Error(`${what} timed out after ${String(spec.timeoutMs)} ms`);
    if (outcome.exitCode !== 0) throw new Error(`${what} failed (exit ${String(outcome.exitCode)}): ${outcome.stderr.trim().slice(0, 300)}`);
    return outcome.stdout.trim();
  };

  const readVersion = async (tool: ToolUnderTest, root: string, configDir: string): Promise<string> => {
    if (tool.kind === 'server') {
      const text = await readFile(join(configDir, 'tool', 'node_modules', ...tool.package.split('/'), 'package.json'), 'utf8');
      const manifest = parseJson(text, `${tool.package} package.json`);
      return `npm:${isObject(manifest) ? optionalStringAt(manifest, 'version', tool.package) ?? 'unknown' : 'unknown'}`;
    }
    return `git:${await step('read skill commit', { command: settings.gitExecutable, args: ['rev-parse', 'HEAD'], cwd: join(root, 'tool-src'), env: setupEnv(root), stdin: null, timeoutMs: settings.setupTimeLimitMs })}`;
  };

  /** The installed pin in the order's own form: a commit prefix the order gave stays that prefix when the checked-out commit starts with it. */
  const installedPin = (tool: ToolUnderTest, found: string, wanted: string | undefined): string => {
    if (tool.kind === 'skill' && wanted !== undefined && hasPrefix(pinParts(found).value, pinParts(wanted).value)) return wanted;
    return found;
  };

  const install = async (tool: ToolUnderTest, wanted: string, root: string, configDir: string): Promise<void> => {
    const env = setupEnv(root);
    const timeoutMs = settings.setupTimeLimitMs;
    const value = pinParts(wanted).value;
    if (tool.kind === 'server') {
      const prefix = join(configDir, 'tool');
      await mkdir(prefix, { recursive: true });
      await step('install server', { command: settings.npmExecutable, args: ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--ignore-scripts', `${tool.package}@${value}`], cwd: root, env, stdin: null, timeoutMs });
      const entry = join(prefix, 'node_modules', ...tool.package.split('/'), tool.entry);
      const mcp = { mcpServers: { [tool.name]: { command: 'node', args: [entry, ...tool.args] } } };
      await writeFile(join(configDir, 'mcp.json'), JSON.stringify(mcp));
      return;
    }
    const source = join(root, 'tool-src');
    await step('clone skill', { command: settings.gitExecutable, args: ['clone', '--quiet', tool.repo, source], cwd: root, env, stdin: null, timeoutMs });
    await step('check out skill', { command: settings.gitExecutable, args: ['checkout', '--quiet', '--detach', value], cwd: source, env, stdin: null, timeoutMs });
    await cp(join(source, tool.subdir), join(configDir, 'skills', tool.name), { recursive: true, filter: (path) => !/[\\/]\.git([\\/]|$)/.test(path) });
  };

  const prepare = async (request: RunRequest): Promise<ClaudePrepared> => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-claude-'));
    deps.onTempFolder?.(root);
    const dispose = async (): Promise<void> => {
      await rm(root, { recursive: true, force: true });
    };
    try {
      const runFolder = join(root, 'repo');
      const configDir = join(root, 'config');
      await mkdir(configDir, { recursive: true });
      await mkdir(join(root, 'home'), { recursive: true });
      const env = setupEnv(root);
      const timeoutMs = settings.setupTimeLimitMs;
      await step('clone fixture', { command: settings.gitExecutable, args: ['clone', '--quiet', settings.fixtureSource, runFolder], cwd: root, env, stdin: null, timeoutMs });
      await step('check out fixture tag', { command: settings.gitExecutable, args: ['checkout', '--quiet', '--detach', settings.fixtureTag], cwd: runFolder, env, stdin: null, timeoutMs });
      const commit = await step('read fixture commit', { command: settings.gitExecutable, args: ['rev-parse', 'HEAD'], cwd: runFolder, env, stdin: null, timeoutMs });
      for (const command of reset.commands) {
        const program = command.command === 'npm' ? settings.npmExecutable : command.command === 'node' ? process.execPath : command.command;
        await step(`reset command "${command.command} ${command.args.join(' ')}"`, { command: program, args: command.args, cwd: runFolder, env, stdin: null, timeoutMs });
      }
      // A task's own setup (spec: an optional Node script, the run folder as its first argument) runs after the reset and before the harness; a failure is the machine's, not the task's.
      const setupScript = join(settings.taskSetDir, 'setup', `${request.taskId}.mjs`);
      if (existsSync(setupScript)) await step(`setup script ${request.taskId}`, { command: process.execPath, args: [setupScript, runFolder], cwd: runFolder, env, stdin: null, timeoutMs });
      const tool = settings.tool !== null && settings.tool.name === request.arm ? settings.tool : null;
      const wanted = request.expected.toolPins.find((pin) => pin.name === request.arm)?.pin;
      const installedPins: ToolPin[] = [];
      if (tool !== null) {
        if (wanted === undefined) throw new Error(`arm ${request.arm} has no pin to install`);
        await install(tool, wanted, root, configDir);
        installedPins.push({ name: tool.name, pin: installedPin(tool, await readVersion(tool, root, configDir), wanted) });
      }
      const taskSet = await loadTaskSet(settings.taskSetDir);
      const made: ClaudePrepared = {
        dir: root,
        runFolder,
        configDir,
        fixtureCommit: commit,
        installedPins,
        taskSetVersion: taskSet.version,
        // The task-set manifest is the one source of the commit; a tag that resolves elsewhere is reported as `<tag>@<commit>`, the `fixture-tag-changed` void.
        fixtureTag: commit === taskSet.fixtureCommit ? settings.fixtureTag : `${settings.fixtureTag}@${commit}`,
        manifestVersion: settings.fleetManifestVersion,
        dispose,
      };
      folders.set(made, made);
      return made;
    } catch (error) {
      await dispose();
      throw error;
    }
  };

  const run = async (prepared: Prepared, request: RunRequest): Promise<RunResult> => {
    const folder = folderOf(prepared);
    const skipped: RunResult = { exit: { kind: 'ok', code: 0 }, transcriptPath: null, harnessVersion: request.expected.harnessVersion, modelId: request.expected.modelId, tokens: { input: 0, cache: 0, output: 0 }, poolSessionId: null };
    // The pin is read from disk again here, so a change since `prepare` is seen; a mismatch leaves the harness unstarted and the runner voids the run.
    const tool = settings.tool !== null && settings.tool.name === request.arm ? settings.tool : null;
    if (tool !== null) {
      const wanted = request.expected.toolPins.find((pin) => pin.name === request.arm)?.pin;
      folder.installedPins = [{ name: tool.name, pin: installedPin(tool, await readVersion(tool, folder.dir, folder.configDir), wanted) }];
      if (folder.installedPins.some((pin) => pin.pin !== wanted)) return skipped;
    }
    const prompt = await readFile(join(settings.taskSetDir, 'tasks', request.taskId, 'prompt.md'), 'utf8');
    const sessionId = randomUUID();
    const allowed = [...settings.allowedTools, ...(tool?.kind === 'server' ? [`mcp__${tool.name}`] : [])];
    const mcpFile = join(folder.configDir, 'mcp.json');
    if (tool?.kind !== 'server') await writeFile(mcpFile, JSON.stringify({ mcpServers: {} }));
    const args = [
      ...settings.claudeArgs,
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--session-id', sessionId,
      '--model', settings.modelId,
      '--strict-mcp-config',
      '--mcp-config', mcpFile,
      '--permission-mode', 'acceptEdits',
      '--allowedTools', allowed.join(','),
    ];
    const env = {
      ...pick(deps.env, START_NAMES),
      HOME: join(folder.dir, 'home'),
      USERPROFILE: join(folder.dir, 'home'),
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: settings.awsRegion,
      AWS_BEARER_TOKEN_BEDROCK: key,
      ANTHROPIC_MODEL: settings.modelId,
      // Pinned so background work (which runs on the haiku alias) uses the run's own model and no unpinned model draws credit: env-vars.md and model-config.md#environment-variables.
      ANTHROPIC_DEFAULT_HAIKU_MODEL: settings.modelId,
      // Strips the Bedrock key from the agent's Bash, hooks, and the tool's stdio MCP server (env-vars.md, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB); Claude Code keeps it for its own API calls.
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      CLAUDE_CONFIG_DIR: folder.configDir,
      CLAUDE_CODE_PROJECT_DIR_NAME: 'work',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    const outcome = await spawn({ command: settings.claudeExecutable, args, cwd: folder.runFolder, env, stdin: prompt, timeoutMs: settings.timeLimitMs });
    if (outcome.errorCode !== null && outcome.errorCode !== 'ENOSPC') throw new Error(`could not start ${settings.claudeExecutable} (${outcome.errorCode})`);
    const facts = parseStream(outcome.stdout);
    const kind = classify(outcome, facts);
    const source = join(folder.configDir, 'projects', 'work', `${sessionId}.jsonl`);
    const target = join(settings.transcriptOutDir, `${request.runId}.jsonl`);
    const transcriptPath = await mkdir(settings.transcriptOutDir, { recursive: true }).then(() => cp(source, target)).then(() => target, () => null);
    return {
      exit: { kind, code: outcome.timedOut ? -1 : (outcome.exitCode ?? -1) },
      transcriptPath,
      harnessVersion: facts.version ?? 'unknown',
      modelId: facts.model ?? 'unknown',
      tokens: facts.tokens,
      poolSessionId: null,
    };
  };

  const check = async (prepared: Prepared, request: RunRequest): Promise<CheckResult> => {
    const folder = folderOf(prepared);
    const script = join(settings.taskSetDir, 'tasks', request.taskId, 'check.mjs');
    try {
      await readFile(script);
    } catch {
      throw new Error(`check script ${script} cannot be read`);
    }
    const outcome = await spawn({ command: process.execPath, args: [script, folder.runFolder], cwd: folder.runFolder, env: pick(deps.env, START_NAMES), stdin: null, timeoutMs: settings.setupTimeLimitMs });
    if (outcome.errorCode !== null || outcome.timedOut) throw new Error(`check script ${script} could not run (${outcome.errorCode ?? 'timed out'})`);
    return outcome.exitCode === 0 ? 'pass' : 'fail';
  };

  return { prepare, run, check };
};
