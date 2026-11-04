// The `--registry-state` option: what a registry says about a name, asked through `npm` or `pip` in the folder the call ran in. For a crossing made
// with npm, npx, pnpm, or pip whose command left the registry, the config, and the folder to their defaults (the replay asks for no other crossing),
// that is the registry the manager would contact, because those read the same project and user config; so a private name does not go to a public
// registry on the gate's account. Off by default; nothing here runs unless the operator asks.
import { execFile } from 'node:child_process';
import type { CrossingClass } from './checks.js';

export interface RegistryAsk {
  class: CrossingClass;
  name: string;
  cwd: string;
}

export interface RegistryAnswer {
  state: 'found' | 'not-found' | 'unreachable';
  latest: string | null;
  created: string | null;
}

export type RegistryReader = (ask: RegistryAsk) => Promise<RegistryAnswer>;

/** What a manager's run came back with: the exit code, null when it could not be started or ran out of time. */
export interface ManagerRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type ManagerRunner = (program: string, args: readonly string[], cwd: string) => Promise<ManagerRun>;

const TIMEOUT_MS = 20_000;

const UNREACHABLE: RegistryAnswer = { state: 'unreachable', latest: null, created: null };
const NOT_FOUND: RegistryAnswer = { state: 'not-found', latest: null, created: null };

// On Windows the managers are `.cmd` shims, which run only through a shell, so a name reaches a command line. These accept only what a registry
// can hold, which has no shell character, and nothing that a manager would read as a flag.
const NPM_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i;
const PYTHON_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

/** Whether a name can be asked about: a package class, spelled as a registry could hold it. */
export const askable = (cls: CrossingClass, name: string): boolean => (cls === 'npm-package' ? NPM_NAME.test(name) : cls === 'python-package' && PYTHON_NAME.test(name));

const textField = (value: unknown, key: string): string | null => {
  const field: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
  return typeof field === 'string' && field !== '' ? field : null;
};

/** `npm view <name> dist-tags.latest time.created --json`, as an object or a one-element array. A not-found answer is an `E404` on either stream. */
export const readNpmView = (run: ManagerRun): RegistryAnswer => {
  if (/\bE404\b/.test(run.stdout) || /\bE404\b/.test(run.stderr)) return NOT_FOUND;
  if (run.code !== 0) return UNREACHABLE;
  try {
    const answer: unknown = JSON.parse(run.stdout);
    // npm 12 wraps the two-field answer in a one-element array; older npm prints the object itself.
    const parsed: unknown = Array.isArray(answer) ? answer[0] : answer;
    const latest = textField(parsed, 'dist-tags.latest');
    return latest === null ? UNREACHABLE : { state: 'found', latest, created: textField(parsed, 'time.created') };
  } catch {
    return UNREACHABLE;
  }
};

/** `pip index versions <name>` prints `name (latest)` first. It states no dates, so a Python name's age stays unknown. */
export const readPipIndex = (run: ManagerRun): RegistryAnswer => {
  if (/No matching distribution/i.test(run.stdout) || /No matching distribution/i.test(run.stderr)) return NOT_FOUND;
  if (run.code !== 0) return UNREACHABLE;
  const latest = /^\S+ \(([^)]+)\)/m.exec(run.stdout)?.[1];
  return latest === undefined ? UNREACHABLE : { state: 'found', latest, created: null };
};

/**
 * How a manager is started. `cwd` comes from a transcript, and `cmd.exe` searches the current directory before PATH, so `NoDefaultCurrentDirectoryInExePath`
 * keeps an `npm.cmd` left there from running: nothing here runs package code.
 */
export const managerOptions = (cwd: string, platform: NodeJS.Platform = process.platform, timeout: number = TIMEOUT_MS) => ({
  cwd,
  timeout,
  shell: platform === 'win32',
  windowsHide: true,
  encoding: 'utf8' as const,
  env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' },
});

const runnerWith = (timeout: number): ManagerRunner => (program, args, cwd) =>
  new Promise((resolve) => {
    execFile(program, [...args], managerOptions(cwd, process.platform, timeout), (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
      resolve({ code, stdout, stderr });
    });
  });

/** The reader the option uses. `npm view` and `pip index` run no package code; the manager's own cache is the manager's. */
export const managerReader = (given?: ManagerRunner, timeout: number = TIMEOUT_MS): RegistryReader => async ({ class: cls, name, cwd }) => {
  const run = given ?? runnerWith(timeout);
  if (!askable(cls, name)) return UNREACHABLE;
  if (cls === 'npm-package') return readNpmView(await run('npm', ['view', name, 'dist-tags.latest', 'time.created', '--json', '--logs-max=0'], cwd));
  return readPipIndex(await run('pip', ['index', 'versions', name, '--disable-pip-version-check'], cwd));
};
