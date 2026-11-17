// What the real harness adapters share (Claude Code on Bedrock, Codex CLI on Azure OpenAI): the process spawner and its exit handlers, the task-set reset plan, the fixture clone and reset in a
// temp folder, the tool install and pin read, the check step, the transcript copy, and the temp-folder cleanup (spec sections 3 and 9). A harness adds only its own command line, environment, and config folder.
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { CheckResult, Prepared, RunRequest, RunResult, ToolPin } from './harness.js';
import { arrayAt, isObject, type JsonObject, objectAt, optionalStringAt, parseJson, stringAt } from './json.js';
import { loadTaskSet } from './manifest.js';

/** An environment handed to a child: every value is set. */
export interface ChildEnv {
  [name: string]: string;
}

/** The caller's environment, where a name may be unset. */
export type EnvMap = Partial<ChildEnv>;

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

/** A skill held in a git repository (`subdir` inside it), checked out at the pinned commit and copied into the harness's skills folder. */
export interface SkillTool {
  kind: 'skill';
  name: string;
  repo: string;
  subdir: string;
}

export type ToolUnderTest = ServerTool | SkillTool;

/** The settings every harness adapter takes: the fixture, the task set, the tool under test, the limits, and where transcripts go. */
export interface SharedSettings {
  /** A local path or a git URL of the fixture repository. */
  fixtureSource: string;
  fixtureTag: string;
  /** The task-set folder: `manifest.json`, `prompts/<id>.md`, `checks/<id>.mjs`, and the `setup/` scripts the manifest names (the repository's `taskset/v1/`). */
  taskSetDir: string;
  /** The fleet manifest version this adapter was built for; reported as the manifest the run saw. */
  fleetManifestVersion: string;
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
  /** Names copied from the caller's environment into the git and npm steps only (for example a credential helper's variable), never into the harness. */
  setupEnvNames: string[];
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  /** The child's whole environment; nothing else is inherited. */
  env: ChildEnv;
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
  /** The caller's environment: where the harness key and the names a child needs to start are read from. Nothing else reads `process.env`. */
  env: EnvMap;
  spawn?: Spawn;
  /** The Node version running the runner; defaults to this process's. A version below the manifest's is refused at construction. */
  nodeVersion?: string;
  /** Called with each temp folder as it is made (tests use it to prove the folder is gone after a failed prepare). */
  onTempFolder?: (dir: string) => void;
}

/** A node version as three numbers; a missing minor or patch is 0. */
export interface NodeVersion {
  major: number;
  minor: number;
  patch: number;
}

/** What a fresh run folder needs, read from the task-set manifest: `reset` is `{ "node": ">=24.0.0", "install": "npm ci ...", "buildDb": "node scripts/build-db.ts" }`, and a task may name a `setup` script. */
export interface ResetPlan {
  nodeFloor: NodeVersion;
  /** The manifest's `fixtureTag`: an adapter whose setting names another tag is refused at construction. */
  fixtureTag: string;
  commands: CommandSpec[];
  /** Task id to its setup script, relative to the task-set folder; a task without one is absent. */
  setups: ReadonlyMap<string, string>;
  /** Every task id the manifest lists. */
  taskIds: ReadonlySet<string>;
}

const commandLine = (reset: JsonObject, name: 'install' | 'buildDb'): CommandSpec => {
  const text = stringAt(reset, name, 'taskset.reset').trim();
  if (text === '') throw new Error(`taskset.reset.${name} must be a command line`);
  const [command = '', ...args] = text.split(/\s+/);
  return { command, args };
};

const numberOr0 = (text: string | undefined): number => Number.parseInt(text ?? '0', 10);

/** `24.1.2`, `v24.1`, or `24` as major, minor, and patch. */
export const parseNodeVersion = (text: string): NodeVersion => {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text.trim());
  if (match === null) throw new Error(`"${text}" is not a Node version`);
  return { major: numberOr0(match[1]), minor: numberOr0(match[2]), patch: numberOr0(match[3]) };
};

export const showVersion = (version: NodeVersion): string => `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;

export const loadResetPlan = (taskSetDir: string): ResetPlan => {
  const root = objectAt(parseJson(readFileSync(join(taskSetDir, 'manifest.json'), 'utf8'), 'task-set manifest'), 'task-set manifest');
  const reset = objectAt(root['reset'], 'taskset.reset');
  const floor = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(stringAt(reset, 'node', 'taskset.reset').trim());
  if (floor === null) throw new Error('taskset.reset.node must be a ">=" floor such as ">=24.0.0"');
  const setups = new Map<string, string>();
  const taskIds = new Set<string>();
  for (const [index, entry] of arrayAt(root, 'tasks', 'taskset').entries()) {
    const at = `taskset.tasks[${String(index)}]`;
    const task = objectAt(entry, at);
    const id = stringAt(task, 'id', at);
    taskIds.add(id);
    const setup = optionalStringAt(task, 'setup', at);
    if (setup !== undefined) setups.set(id, setup);
  }
  return { nodeFloor: parseNodeVersion(floor[1] ?? ''), fixtureTag: stringAt(root, 'fixtureTag', 'taskset'), commands: [commandLine(reset, 'install'), commandLine(reset, 'buildDb')], setups, taskIds };
};

/** Whether `running` is under `floor`, major then minor then patch. */
export const isBelow = (running: NodeVersion, floor: NodeVersion): boolean =>
  running.major !== floor.major ? running.major < floor.major : running.minor !== floor.minor ? running.minor < floor.minor : running.patch < floor.patch;

/** Reads the reset plan and refuses at construction what no run could satisfy: a Node below the manifest's floor (major, minor, and patch compared), or a tag setting that is not the manifest's. */
export const loadCheckedResetPlan = (settings: SharedSettings, nodeVersion: string | undefined): ResetPlan => {
  const reset = loadResetPlan(settings.taskSetDir);
  if (settings.fixtureTag !== reset.fixtureTag) throw new Error(`the fixture tag setting "${settings.fixtureTag}" is not the task-set manifest's "${reset.fixtureTag}"; no run was started`);
  const running = parseNodeVersion(nodeVersion ?? process.versions.node);
  const floor = reset.nodeFloor;
  const below = isBelow(running, floor);
  if (below) {
    const text = running.major === floor.major ? `Node ${showVersion(running)} is below the Node ${showVersion(floor)}` : `Node ${String(running.major)} is below the Node ${String(floor.major)}`;
    throw new Error(`${text} the fixture needs (task-set manifest reset.node); no run was started`);
  }
  return reset;
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

/** Starts the harness time limit; calls `fire` after `ms` and returns a function that cancels it. Injected so a test fires it at a chosen moment, not on the wall clock. */
export type StartTimer = (ms: number, fire: () => void) => () => void;

const wallClockTimer: StartTimer = (ms, fire) => {
  const handle = setTimeout(fire, ms);
  return () => {
    clearTimeout(handle);
  };
};

/** The part of `process` the runner's exit handlers use; a test passes an emitter of its own. */
export interface HostProcess {
  readonly pid: number;
  once(event: 'SIGINT' | 'SIGTERM' | 'exit', listener: () => void): unknown;
  kill(pid: number, signal: 'SIGINT' | 'SIGTERM'): unknown;
}

// The stream decodes, so a multibyte character split across two chunks is carried over instead of becoming U+FFFD. Returns what has arrived so far.
export const collectUtf8 = (stream: Readable): (() => string) => {
  let text = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    text += chunk;
  });
  return () => text;
};

export const makeNodeSpawn = (startTimer: StartTimer, host: HostProcess = process): Spawn => {
  // Children off Windows lead their own process group, so a Ctrl-C or SIGTERM that ends the runner would not reach them: end each one here, or it keeps drawing credit.
  const live = new Set<number>();
  let handlersInstalled = false;
  const killLive = (): void => {
    for (const pid of live) killTree(pid);
    live.clear();
  };
  const installHandlers = (): void => {
    if (handlersInstalled) return;
    handlersInstalled = true;
    host.once('exit', killLive);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      host.once(signal, () => {
        killLive();
        host.kill(host.pid, signal);
      });
    }
  };
  return (spec) =>
    new Promise((resolve) => {
      let timedOut = false;
      let settled = false;
      let cancelTimer: () => void = () => undefined;
      const finish = (outcome: SpawnOutcome): void => {
        if (settled) return;
        settled = true;
        cancelTimer();
        resolve(outcome);
      };
      installHandlers();
      // No shell: a `.cmd` wrapper would be the process killed on a timeout while the real program kept running (the constructors refuse one). Off Windows the child leads its own
      // process group so a timeout can end the whole group.
      const child = spawnChild(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      if (child.pid !== undefined) live.add(child.pid);
      cancelTimer = startTimer(spec.timeoutMs, () => {
        timedOut = true;
        killTree(child.pid);
      });
      const stdoutText = collectUtf8(child.stdout);
      const stderrText = collectUtf8(child.stderr);
      child.on('error', (error: NodeJS.ErrnoException) => {
        finish({ exitCode: null, signal: null, stdout: stdoutText(), stderr: stderrText(), timedOut, errorCode: error.code ?? 'UNKNOWN' });
      });
      child.on('close', (exitCode, signal) => {
        if (child.pid !== undefined) live.delete(child.pid);
        finish({ exitCode, signal, stdout: stdoutText(), stderr: stderrText(), timedOut, errorCode: null });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(spec.stdin ?? '');
    });
};

export const nodeSpawn: Spawn = makeNodeSpawn(wallClockTimer);

// What a process needs to start. HOME and the application-data folders are not here: they point into the run's own temp folder.
export const START_NAMES = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR'];

export const pick = (env: EnvMap, names: readonly string[]): ChildEnv => {
  const out: ChildEnv = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
};

/** True when `wanted` is a 7 to 40 hex prefix of the 40-hex commit `actual`; a shorter prefix names too many commits to prove a pin, so it never matches. */
export const hasPrefix = (actual: string, wanted: string): boolean => /^[0-9a-f]{7,40}$/.test(wanted) && actual.startsWith(wanted);

export const pinParts = (pin: string): { scheme: string; value: string } => {
  const at = pin.indexOf(':');
  return at < 0 ? { scheme: '', value: pin } : { scheme: pin.slice(0, at), value: pin.slice(at + 1) };
};

/** The tool this arm installs, or null for the no-tool arm. */
export const toolFor = (settings: SharedSettings, arm: string): ToolUnderTest | null => (settings.tool !== null && settings.tool.name === arm ? settings.tool : null);

/** The pin the order's request wants for this arm's tool. */
export const wantedPin = (request: RunRequest): string | undefined => request.expected.toolPins.find((pin) => pin.name === request.arm)?.pin;

/** A prepared run folder: the shared parts. A harness adds its own folders. */
export interface PreparedFolder extends Prepared {
  runFolder: string;
  configDir: string;
  fixtureCommit: string;
}

/** A tool and the pin the order wants for it. */
export interface Installing {
  tool: ToolUnderTest;
  wanted: string;
}

/** What differs between harnesses in the reset: the temp-folder name, the config folder's name, and how an installed tool is wired into the config folder. */
export interface Layout {
  tempPrefix: string;
  configName: string;
  /** Installs the tool at its pin and writes the harness's own config for it; `installing` is null for the no-tool arm, which still gets its config written. */
  wire: (installing: Installing | null, root: string, configDir: string) => Promise<void>;
}

export interface Steps {
  setupEnv: (root: string) => ChildEnv;
  step: (what: string, spec: SpawnSpec) => Promise<string>;
  readToolVersion: (tool: ToolUnderTest, root: string, configDir: string) => Promise<string>;
  installedPin: (tool: ToolUnderTest, found: string, wanted: string | undefined) => string;
  /** Installs the server at the pin under `<configDir>/tool` and returns the path of its entry script. */
  installServer: (tool: ServerTool, wanted: string, root: string, configDir: string) => Promise<string>;
  /** Clones the skill's repository at the pin under `<root>/tool-src` and returns the skill's folder inside it. */
  checkoutSkill: (tool: SkillTool, wanted: string, root: string) => Promise<string>;
  prepareRun: (request: RunRequest, layout: Layout, reset: ResetPlan) => Promise<PreparedFolder>;
  copyTranscript: (source: string, runId: string) => Promise<string | null>;
  /** Saves what the harness wrote to stdout as `<runId>.stdout.jsonl` beside the transcript copy, with each secret's value replaced; returns the path. */
  saveStdout: (stdout: string, runId: string, secrets: readonly string[]) => Promise<string>;
  runCheck: (folder: PreparedFolder, request: RunRequest) => Promise<CheckResult>;
  /** Reads the arm's tool pin from disk again, so a change since `prepare` is seen: returns the unstarted-harness result when it no longer matches the order (the runner voids the run), else null. */
  recheckPins: (folder: PreparedFolder, request: RunRequest) => Promise<RunResult | null>;
}

/** The folders one adapter prepared, so `run` and `check` refuse a folder made elsewhere. */
export interface Folders {
  remember: (folder: PreparedFolder) => void;
  folderOf: (prepared: Prepared) => PreparedFolder;
}

export const makeFolders = (): Folders => {
  const known = new WeakMap<Prepared, PreparedFolder>();
  return {
    remember: (folder) => {
      known.set(folder, folder);
    },
    folderOf: (prepared) => {
      const folder = known.get(prepared);
      if (folder === undefined) throw new Error('this folder was not prepared by this adapter');
      return folder;
    },
  };
};

/** Throws when the harness did not start; a full disk is the one start error the run reports instead. */
export const assertStarted = (outcome: SpawnOutcome, executable: string): void => {
  if (outcome.errorCode !== null && outcome.errorCode !== 'ENOSPC') throw new Error(`could not start ${executable} (${outcome.errorCode})`);
};

/** Copies a skill's folder without its `.git` data. */
export const copySkill = (from: string, to: string): Promise<void> => cp(from, to, { recursive: true, filter: (path) => !/[\\/]\.git([\\/]|$)/.test(path) });

export const makeSteps = (settings: SharedSettings, deps: Dependencies, spawn: Spawn): Steps => {
  // The environment of a git, npm, or database step: the start names, the folder's own home, and the operator's named extras.
  const setupEnv = (root: string): ChildEnv => ({ ...pick(deps.env, START_NAMES), ...pick(deps.env, settings.setupEnvNames), HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), GIT_TERMINAL_PROMPT: '0' });

  const step = async (what: string, spec: SpawnSpec): Promise<string> => {
    const outcome = await spawn(spec);
    if (outcome.errorCode !== null) throw new Error(`${what}: could not start ${spec.command} (${outcome.errorCode})`);
    if (outcome.timedOut) throw new Error(`${what} timed out after ${String(spec.timeoutMs)} ms`);
    if (outcome.exitCode !== 0) throw new Error(`${what} failed (exit ${String(outcome.exitCode)}): ${outcome.stderr.trim().slice(0, 300)}`);
    return outcome.stdout.trim();
  };

  const readToolVersion = async (tool: ToolUnderTest, root: string, configDir: string): Promise<string> => {
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

  const installServer = async (tool: ServerTool, wanted: string, root: string, configDir: string): Promise<string> => {
    const prefix = join(configDir, 'tool');
    await mkdir(prefix, { recursive: true });
    await step('install server', { command: settings.npmExecutable, args: ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--ignore-scripts', `${tool.package}@${pinParts(wanted).value}`], cwd: root, env: setupEnv(root), stdin: null, timeoutMs: settings.setupTimeLimitMs });
    return join(prefix, 'node_modules', ...tool.package.split('/'), tool.entry);
  };

  const checkoutSkill = async (tool: SkillTool, wanted: string, root: string): Promise<string> => {
    const env = setupEnv(root);
    const timeoutMs = settings.setupTimeLimitMs;
    const source = join(root, 'tool-src');
    await step('clone skill', { command: settings.gitExecutable, args: ['clone', '--quiet', tool.repo, source], cwd: root, env, stdin: null, timeoutMs });
    await step('check out skill', { command: settings.gitExecutable, args: ['checkout', '--quiet', '--detach', pinParts(wanted).value], cwd: source, env, stdin: null, timeoutMs });
    return join(source, tool.subdir);
  };

  const prepareRun = async (request: RunRequest, layout: Layout, reset: ResetPlan): Promise<PreparedFolder> => {
    if (!reset.taskIds.has(request.taskId)) throw new Error(`task ${request.taskId} is not in the task-set manifest`);
    const root = await mkdtemp(join(tmpdir(), layout.tempPrefix));
    deps.onTempFolder?.(root);
    const dispose = async (): Promise<void> => {
      await rm(root, { recursive: true, force: true });
    };
    try {
      const runFolder = join(root, 'repo');
      const configDir = join(root, layout.configName);
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
      const setupPath = reset.setups.get(request.taskId);
      if (setupPath !== undefined) await step(`setup script ${request.taskId}`, { command: process.execPath, args: [join(settings.taskSetDir, setupPath), runFolder], cwd: runFolder, env, stdin: null, timeoutMs });
      const tool = toolFor(settings, request.arm);
      const wanted = wantedPin(request);
      const installedPins: ToolPin[] = [];
      if (tool !== null) {
        if (wanted === undefined) throw new Error(`arm ${request.arm} has no pin to install`);
        await layout.wire({ tool, wanted }, root, configDir);
        installedPins.push({ name: tool.name, pin: installedPin(tool, await readToolVersion(tool, root, configDir), wanted) });
      } else {
        await layout.wire(null, root, configDir);
      }
      const taskSet = await loadTaskSet(settings.taskSetDir);
      return {
        dir: root,
        runFolder,
        configDir,
        fixtureCommit: commit,
        installedPins,
        taskSetVersion: taskSet.version,
        // The task-set manifest is the one source of the commit, written as a 7 to 40 hex prefix of the full commit; a tag that resolves elsewhere is reported as `<tag>@<commit>`, the `fixture-tag-changed` void.
        fixtureTag: hasPrefix(commit, taskSet.fixtureCommit) ? settings.fixtureTag : `${settings.fixtureTag}@${commit}`,
        manifestVersion: settings.fleetManifestVersion,
        dispose,
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  };

  const copyTranscript = async (source: string, runId: string): Promise<string | null> => {
    const target = join(settings.transcriptOutDir, `${runId}.jsonl`);
    return mkdir(settings.transcriptOutDir, { recursive: true }).then(() => cp(source, target)).then(() => target, () => null);
  };

  const saveStdout = async (stdout: string, runId: string, secrets: readonly string[]): Promise<string> => {
    const target = join(settings.transcriptOutDir, `${runId}.stdout.jsonl`);
    // The harness's output is the one written file the adapter did not make itself, so a key its own output echoes is replaced here; text with no key in it is written as it came.
    const clean = secrets.filter((secret) => secret !== '').reduce((text, secret) => text.split(secret).join('[redacted]'), stdout);
    await mkdir(settings.transcriptOutDir, { recursive: true });
    await writeFile(target, clean);
    return target;
  };

  const runCheck = async (folder: PreparedFolder, request: RunRequest): Promise<CheckResult> => {
    const script = join(settings.taskSetDir, 'checks', `${request.taskId}.mjs`);
    try {
      await readFile(script);
    } catch {
      throw new Error(`check script ${script} cannot be read`);
    }
    const outcome = await spawn({ command: process.execPath, args: [script, folder.runFolder], cwd: folder.runFolder, env: pick(deps.env, START_NAMES), stdin: null, timeoutMs: settings.setupTimeLimitMs });
    if (outcome.errorCode !== null || outcome.timedOut) throw new Error(`check script ${script} could not run (${outcome.errorCode ?? 'timed out'})`);
    return outcome.exitCode === 0 ? 'pass' : 'fail';
  };

  const recheckPins = async (folder: PreparedFolder, request: RunRequest): Promise<RunResult | null> => {
    const tool = toolFor(settings, request.arm);
    if (tool === null) return null;
    const wanted = wantedPin(request);
    folder.installedPins = [{ name: tool.name, pin: installedPin(tool, await readToolVersion(tool, folder.dir, folder.configDir), wanted) }];
    if (!folder.installedPins.some((pin) => pin.pin !== wanted)) return null;
    return { exit: { kind: 'ok', code: 0 }, transcriptPath: null, harnessVersion: request.expected.harnessVersion, modelId: request.expected.modelId, tokens: { input: 0, cache: 0, output: 0 }, poolSessionId: null };
  };

  return { setupEnv, step, readToolVersion, installedPin, installServer, checkoutSkill, prepareRun, copyTranscript, saveStdout, runCheck, recheckPins };
};
