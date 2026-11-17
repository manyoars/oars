// `npm run preflight -w packages/fleet-runner -- --taskset <folder> [--fleet <file>] --fixture-source <path or URL> [--claude <exe>] [--git <exe>] [--npm <exe>] [--run-book <file> --allowed-signers <file>]`:
// tells the operator whether this machine is ready for a real Claude Code on Bedrock run. It makes no model call and spends nothing. The only real executables it starts are `claude --version`,
// `git --version`, `npm --version`, and `git ls-remote` (the one network call); it never starts `claude` with a prompt. The key is checked for presence only: its value is never read into a
// line, and every printed line is passed through a redaction that removes the value if it ever appeared (a stderr from a tool, say).
// `claude --version` prints the version number (https://code.claude.com/docs/en/cli-reference.md, the `--version` row); the check reads the first `x.y.z` in the output.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { loadResetPlan, nodeSpawn, type ChildEnv, type EnvMap, type ResetPlan, type Spawn } from './claude-bedrock.js';
import { isBelow, parseNodeVersion, showVersion } from './harness-shared.js';
import { parseFleet, loadTaskSet } from './manifest.js';
import { verifyRunBook } from './sign.js';

export interface PreflightDeps {
  env: EnvMap;
  spawn?: Spawn;
  nodeVersion?: string;
  /** The package's fleet manifest, used when `--fleet` is absent. The script passes it because a bundle's `import.meta.url` does not point into the package. */
  defaultFleet?: string;
}

type Verdict = 'ok' | 'missing' | 'wrong';

// What a tool needs to start; the key and every other name stay out of the children.
const START_NAMES = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE'];
const TOOL_LIMIT_MS = 30_000;
const HARNESS = 'claude-code-bedrock';
// A new test placeholder for any harness goes into these sets (today a Codex entry is caught only by the `UNSET-` prefix).
// Values the tests and the first manifest used before the real pins; a paid run must never start from one. `UNSET-` marks a pin nobody has read yet.
const PLACEHOLDER_VERSIONS = new Set(['2.1.30']);
const PLACEHOLDER_MODEL_IDS = new Set(['sonnet-pinned-1']);
const isPlaceholder = (value: string, known: Set<string>): boolean => known.has(value) || value.startsWith('UNSET-');
const SEMVER = /\d+\.\d+\.\d+/;

const flag = (argv: string[], name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

const onPath = (exe: string, env: EnvMap): string | null => {
  const extensions = ['', ...(process.platform === 'win32' ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : [])];
  const folders = isAbsolute(exe) ? [''] : (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter((folder) => folder !== '');
  for (const folder of folders) for (const extension of extensions) if (existsSync(join(folder, `${exe}${extension}`))) return join(folder, `${exe}${extension}`);
  return null;
};

const USAGE = 'usage: preflight --taskset <folder> [--fleet <file>] --fixture-source <path or URL> [--claude <exe>] [--git <exe>] [--npm <exe>] [--run-book <file> --allowed-signers <file>]';

export const main = async (argv: string[], print: (line: string) => void, deps: PreflightDeps = { env: process.env }): Promise<number> => {
  const taskSetArg = flag(argv, '--taskset');
  const fleetArg = flag(argv, '--fleet') ?? deps.defaultFleet;
  const source = flag(argv, '--fixture-source');
  const runBook = flag(argv, '--run-book');
  const allowed = flag(argv, '--allowed-signers');
  if (taskSetArg === undefined || fleetArg === undefined || source === undefined || (runBook === undefined) !== (allowed === undefined)) {
    print(USAGE);
    return 2;
  }
  const spawn = deps.spawn ?? nodeSpawn;
  const key = deps.env['AWS_BEARER_TOKEN_BEDROCK'] ?? '';
  const childEnv: ChildEnv = {};
  for (const name of START_NAMES) {
    const value = deps.env[name];
    if (value !== undefined && value !== '') childEnv[name] = value;
  }
  // The one place a line leaves this command: a key value that reached it is replaced, never printed.
  const out = (line: string): void => {
    print(key === '' ? line : line.split(key).join('[key removed]'));
  };
  const state = { failed: false };
  const report = (verdict: Verdict, what: string, detail: string): void => {
    if (verdict !== 'ok') state.failed = true;
    out(`${verdict.padEnd(7)} ${what}: ${detail}`);
  };
  const tool = async (command: string, args: string[]): Promise<{ text: string; started: boolean; exitCode: number | null }> => {
    const outcome = await spawn({ command, args, cwd: process.cwd(), env: childEnv, stdin: null, timeoutMs: TOOL_LIMIT_MS });
    return { text: `${outcome.stdout}\n${outcome.stderr}`.trim(), started: outcome.errorCode === null, exitCode: outcome.exitCode };
  };

  try {
    const taskSetDir = resolve(taskSetArg);
    const fleet = parseFleet(await readFile(resolve(fleetArg), 'utf8'));
    const harness = fleet.harnesses.find((entry) => entry.name === HARNESS);
    const claude = flag(argv, '--claude') ?? 'claude';
    const git = flag(argv, '--git') ?? 'git';
    const npm = flag(argv, '--npm') ?? 'npm';

    // 0. No placeholder pin anywhere in the manifest: every harness it names, each by name.
    const placeholders = fleet.harnesses.flatMap((entry) => [
      ...(isPlaceholder(entry.version, PLACEHOLDER_VERSIONS) ? [`${entry.name} version ${entry.version}`] : []),
      ...entry.modelIds.filter((id) => isPlaceholder(id, PLACEHOLDER_MODEL_IDS)).map((id) => `${entry.name} model ID ${id}`),
    ]);
    if (placeholders.length > 0) report('wrong', 'fleet manifest', `placeholder pins (${placeholders.join('; ')}); set the real pins before a paid run`);
    else report('ok', 'fleet manifest', `${fleet.version}: ${fleet.harnesses.map((entry) => `${entry.name} ${entry.version}`).join(', ')}`);

    // 1. claude on PATH at the pinned version.
    const pinned = harness?.version;
    const seen = await tool(claude, ['--version']);
    if (!seen.started) report('missing', 'claude', `${claude} did not start; install the native Claude Code executable and put it on PATH`);
    else if (pinned === undefined) report('wrong', 'claude', `the fleet manifest names no ${HARNESS} harness, so there is no pinned version`);
    else {
      const version = SEMVER.exec(seen.text)?.[0];
      if (version === pinned) report('ok', 'claude', `version ${version}`);
      else report('wrong', 'claude', `version ${version ?? 'unreadable'}, pinned ${pinned}; install Claude Code ${pinned}`);
    }

    // 2. Node at the task set's floor.
    // A task set that cannot load must not end the run: its reason prints at check 4 and the checks that need no task set still run.
    let plan: ResetPlan | null = null;
    let loadFailure = '';
    try {
      plan = loadResetPlan(taskSetDir);
    } catch (error) {
      loadFailure = error instanceof Error ? error.message : 'could not load';
    }
    const running = parseNodeVersion(deps.nodeVersion ?? process.versions.node);
    if (plan === null) report('wrong', 'node', 'the task set did not load, so its Node floor is unknown');
    else if (!isBelow(running, plan.nodeFloor)) report('ok', 'node', `${showVersion(running)} (floor ${showVersion(plan.nodeFloor)})`);
    else report('wrong', 'node', `${showVersion(running)} is below the task set's floor ${showVersion(plan.nodeFloor)}; install Node ${showVersion(plan.nodeFloor)} or later`);

    // 3. git and npm. npm is a `.cmd` wrapper on Windows, which a spawn without a shell cannot start, so it is looked for on PATH instead of run.
    const ranGit = await tool(git, ['--version']);
    if (ranGit.started && ranGit.exitCode === 0) report('ok', 'git', ranGit.text.split(String.fromCharCode(10))[0] ?? '');
    else if (ranGit.started) report('wrong', 'git', `exited ${String(ranGit.exitCode)}`);
    else report('missing', 'git', `${git} did not start; put it on PATH`);
    const npmFound = onPath(npm, deps.env);
    if (npmFound === null) report('missing', 'npm', `${npm} was not found on PATH; install Node with npm`);
    else report('ok', 'npm', npmFound);

    // 4. The task-set folder: every task has its prompt and check, and its setup file where the manifest names one.
    const absent: string[] = [];
    for (const id of plan?.taskIds ?? []) {
      for (const path of [join('prompts', `${id}.md`), join('checks', `${id}.mjs`)]) if (!existsSync(join(taskSetDir, path))) absent.push(path);
      const setup = plan?.setups.get(id);
      if (setup !== undefined && !existsSync(join(taskSetDir, setup))) absent.push(setup);
    }
    if (plan === null) report('wrong', 'task set', loadFailure);
    else if (absent.length === 0) report('ok', 'task set', `${String(plan.taskIds.size)} tasks, each with its prompt, check, and setup file`);
    else report('wrong', 'task set', `missing files: ${absent.join(', ')}`);

    // 5. The fixture remote answers for the pinned tag, and the tag is the manifest's commit.
    const taskSet = plan === null ? null : await loadTaskSet(taskSetDir);
    if (taskSet !== null) {
      const remote = await tool(git, ['ls-remote', source, `refs/tags/${taskSet.fixtureTag}`, `refs/tags/${taskSet.fixtureTag}^{}`]);
      const lines = remote.text.split('\n').filter((line) => line.includes('refs/tags/'));
      if (!remote.started || remote.exitCode !== 0) report('missing', 'fixture remote', `git ls-remote did not answer for the fixture source; check the source and your access`);
      else if (lines.length === 0) report('missing', 'fixture remote', `the remote has no tag ${taskSet.fixtureTag}`);
      else {
        // An annotated tag lists the tag object and, peeled with ^{}, its commit; the commit is the peeled line.
        const commit = ((lines.find((line) => line.endsWith('^{}')) ?? lines[0]) ?? '').split(/\s/)[0] ?? '';
        if (commit !== '' && commit.startsWith(taskSet.fixtureCommit)) report('ok', 'fixture tag', `${taskSet.fixtureTag} is ${commit.slice(0, 12)}, the manifest's commit`);
        else report('wrong', 'fixture tag', `${taskSet.fixtureTag} is ${commit.slice(0, 12)}, the manifest says ${taskSet.fixtureCommit.slice(0, 12)}; the tag moved or the manifest is stale`);
      }
    }

    // 6. The Bedrock settings: presence only.
    for (const name of ['AWS_REGION', 'AWS_BEARER_TOKEN_BEDROCK']) {
      const value = deps.env[name];
      if (value !== undefined && value !== '') report('ok', name, 'set');
      else report('missing', name, `not set; set ${name} in this shell`);
    }

    // 7. The run book, when one is named: signed and verified. A first run has none yet.
    if (runBook === undefined || allowed === undefined) out('ok      run book: none named (a first run has none yet; name one with --run-book and --allowed-signers to verify it)');
    else {
      const verified = await verifyRunBook(resolve(runBook), resolve(allowed));
      if (verified.ok) report('ok', 'run book', 'signature verifies');
      else report('wrong', 'run book', `signature not verified: ${verified.message}`);
    }
  } catch (error) {
    out(`preflight: could not finish: ${error instanceof Error ? error.message : 'failed'}`);
    return 1;
  }
  out(state.failed ? 'preflight: not ready; fix each line that is not ok' : 'preflight: ready');
  return state.failed ? 1 : 0;
};
