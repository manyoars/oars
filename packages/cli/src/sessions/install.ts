// `oars sessions hook install|uninstall|status`: writes the three Claude Code hook entries into one settings file, merging with what is
// there. An entry is ours when its command ends with `hook-bin.js" <session-start|post-tool|stop>`, so uninstall removes those entries and nothing else. Also the retention floor
// (the harness deletes raw transcripts after `cleanupPeriodDays`, 30 when unset) and the Windows nightly task.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CliError, ExitCode } from '../errors.js';

export const RETENTION_FLOOR = 365;
export const DEFAULT_RETENTION = 30;
export const TASK_NAME = 'OarsSessionsNightly';
// The tail of a command this module wrote; anything else in a settings file is the operator's, whatever it is called.
const OWN_COMMAND = /hook-bin\.js" (?:session-start|post-tool|stop)$/;

/** What the install needs from the machine, so a test can stand in for each. */
export interface InstallRuntime {
  nodePath: string;
  /** Absolute path of the built `hook-bin.js`. */
  hookBin: string;
  /** `<claude config dir>/settings.json`. */
  userSettings: string;
  cwd: string;
  /** Runs `schtasks` with these arguments. */
  schtasks: (args: string[]) => Promise<{ code: number; output: string }>;
}

export type Scope = 'user' | 'project' | 'file';

interface HookSpec {
  event: 'SessionStart' | 'PostToolUseFailure' | 'SessionEnd';
  arg: 'session-start' | 'post-tool' | 'stop';
  /** Tools the group applies to; unset means every one. */
  matcher?: string;
  /** Seconds the harness waits; the hooks' own budgets are far lower, this is the ceiling. */
  timeout: number;
}

const SPECS: readonly HookSpec[] = [
  { event: 'SessionStart', arg: 'session-start', timeout: 5 },
  // A failed Bash call arrives as PostToolUseFailure with `error` = "Exit code N ...": PostToolUse itself fires on success only.
  { event: 'PostToolUseFailure', arg: 'post-tool', timeout: 5, matcher: 'Bash|PowerShell' },
  // SessionEnd fires once per session; Stop fires after every assistant turn and would re-extract the growing transcript each time.
  { event: 'SessionEnd', arg: 'stop', timeout: 30 },
];

/** A settings file is open-ended JSON the harness owns; only the keys named here are read or written. */
interface Json {
  [key: string]: unknown;
}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The post-tool command reads the event first in the hook shell (Git Bash on Windows, where the harness runs hooks) and starts node only
 * when the failure text carries `Exit code`: a fresh node costs 250 ms to seconds on Windows, the shell builtins a few milliseconds.
 */
export const commandOf = (runtime: InstallRuntime, arg: string): string => {
  const launch = `"${runtime.nodePath}" "${runtime.hookBin}" ${arg}`;
  if (arg !== 'post-tool') return launch;
  return `IFS= read -r event; case "$event" in *'Exit code'*) ;; *) exit 0;; esac; { printf '%s\\n' "$event"; cat; } | ${launch}`;
};

const isOwnHook = (hook: unknown): boolean => isObject(hook) && typeof hook.command === 'string' && OWN_COMMAND.test(hook.command);

/** The groups with our entries taken out; a group that held only ours goes, one that held others keeps them. */
const withoutOwn = (groups: unknown[]): unknown[] =>
  groups.flatMap((group) => {
    if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(isOwnHook)) return [group];
    const rest = group.hooks.filter((hook) => !isOwnHook(hook));
    return rest.length === 0 ? [] : [{ ...group, hooks: rest }];
  });

const hasOwn = (groups: unknown[]): boolean => groups.some((group) => isObject(group) && Array.isArray(group.hooks) && group.hooks.some(isOwnHook));

export const settingsPath = (runtime: InstallRuntime, scope: Scope, file: string | undefined): string => {
  if (scope === 'user') return runtime.userSettings;
  if (scope === 'project') return join(runtime.cwd, '.claude', 'settings.json');
  if (file === undefined) {
    throw new CliError('--scope file needs --file <settings path>; nothing is written to a settings file you have not named.', ExitCode.USAGE, 'usage');
  }
  return resolve(runtime.cwd, file);
};

export const readSettings = async (path: string): Promise<Json> => {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return {};
    throw new CliError(`Could not read ${path} (${error instanceof Error ? error.message : String(error)}); nothing was changed.`, ExitCode.USAGE, 'usage');
  }
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`${path} is not valid JSON; fix or remove it, nothing was changed.`, ExitCode.USAGE, 'usage');
  }
  if (!isObject(parsed)) throw new CliError(`${path} is not a JSON object; nothing was changed.`, ExitCode.USAGE, 'usage');
  return parsed;
};

const writeSettings = async (path: string, settings: Json): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
};

const hooksOf = (settings: Json): Json => (isObject(settings.hooks) ? settings.hooks : {});

const groupsOf = (hooks: Json, event: string): unknown[] => {
  const groups = hooks[event];
  return Array.isArray(groups) ? groups : [];
};

/** The retention the file sets: its `cleanupPeriodDays` when a number, else the harness default. */
export const effectiveRetention = (settings: Json): number => (typeof settings.cleanupPeriodDays === 'number' ? settings.cleanupPeriodDays : DEFAULT_RETENTION);

export interface InstallResult {
  file: string;
  installed: string[];
  retention: string;
}

export const installHooks = async (runtime: InstallRuntime, path: string, keepRetention: boolean): Promise<InstallResult> => {
  const settings = await readSettings(path);
  const hooks = hooksOf(settings);
  for (const spec of SPECS) {
    const others = withoutOwn(groupsOf(hooks, spec.event));
    const entry = { type: 'command', command: commandOf(runtime, spec.arg), timeout: spec.timeout };
    hooks[spec.event] = [...others, spec.matcher === undefined ? { hooks: [entry] } : { matcher: spec.matcher, hooks: [entry] }];
  }
  settings.hooks = hooks;
  const before = effectiveRetention(settings);
  const shown = typeof settings.cleanupPeriodDays === 'number' ? String(before) : `${String(before)} (unset, the default)`;
  let retention: string;
  if (keepRetention) {
    retention = `Left cleanupPeriodDays alone at ${shown} in ${path} (--keep-retention); the harness deletes raw transcripts older than that.`;
  } else if (before >= RETENTION_FLOOR) {
    retention = `cleanupPeriodDays is ${shown} in ${path}, at or above the ${String(RETENTION_FLOOR)} floor; left as is.`;
  } else {
    settings.cleanupPeriodDays = RETENTION_FLOOR;
    retention = `Raised cleanupPeriodDays from ${shown} to ${String(RETENTION_FLOOR)} in ${path}.`;
  }
  await writeSettings(path, settings);
  return { file: path, installed: SPECS.map((spec) => spec.event), retention };
};

export const uninstallHooks = async (path: string): Promise<{ file: string; removed: string[] }> => {
  const settings = await readSettings(path);
  const hooks = hooksOf(settings);
  const removed: string[] = [];
  for (const spec of SPECS) {
    const groups = groupsOf(hooks, spec.event);
    if (!hasOwn(groups)) continue;
    const kept = withoutOwn(groups);
    removed.push(spec.event);
    hooks[spec.event] = kept;
  }
  if (removed.length > 0) {
    // An event this call emptied goes; an event that was already an empty list in the file is the operator's and stays.
    const remaining = Object.entries(hooks).filter(([event, groups]) => !(removed.includes(event) && Array.isArray(groups) && groups.length === 0));
    // `undefined` is left out of the JSON, so an emptied `hooks` key goes.
    settings.hooks = remaining.length === 0 ? undefined : Object.fromEntries(remaining);
    await writeSettings(path, settings);
  }
  return { file: path, removed };
};

export interface FileStatus {
  file: string;
  scope: Scope;
  installed: string[];
  retentionDays: number;
}

export const hookStatus = async (runtime: InstallRuntime, extra: string | undefined): Promise<FileStatus[]> => {
  const targets: { file: string; scope: Scope }[] = [
    { file: runtime.userSettings, scope: 'user' },
    { file: join(runtime.cwd, '.claude', 'settings.json'), scope: 'project' },
    ...(extra === undefined ? [] : [{ file: resolve(runtime.cwd, extra), scope: 'file' as const }]),
  ];
  const statuses: FileStatus[] = [];
  for (const target of targets) {
    const settings = await readSettings(target.file);
    const hooks = hooksOf(settings);
    statuses.push({ ...target, installed: SPECS.filter((spec) => hasOwn(groupsOf(hooks, spec.event))).map((spec) => spec.event), retentionDays: effectiveRetention(settings) });
  }
  return statuses;
};

/** The `schtasks` arguments for the nightly task: the same node and hook-bin the hooks use, at a fixed hour. */
export const scheduleArgs = (runtime: InstallRuntime, hour: number): string[] => [
  '/Create',
  '/TN',
  TASK_NAME,
  '/TR',
  `"${runtime.nodePath}" "${runtime.hookBin}" nightly`,
  '/SC',
  'DAILY',
  '/ST',
  `${String(hour).padStart(2, '0')}:00`,
  '/F',
];

export const SCHEDULE_HOUR = 3;

export const setSchedule = async (runtime: InstallRuntime, mode: 'nightly' | 'off'): Promise<string> => {
  if (mode === 'nightly') {
    const created = await runtime.schtasks(scheduleArgs(runtime, SCHEDULE_HOUR));
    if (created.code !== 0) throw new CliError(`Could not register the scheduled task: ${created.output.trim()}`, ExitCode.UNEXPECTED, 'unexpected');
    return `Scheduled task ${TASK_NAME}: the full deposit and the recurrence refresh run daily at ${String(SCHEDULE_HOUR).padStart(2, '0')}:00.`;
  }
  const deleted = await runtime.schtasks(['/Delete', '/TN', TASK_NAME, '/F']);
  return deleted.code === 0 ? `Removed the scheduled task ${TASK_NAME}.` : `No scheduled task ${TASK_NAME} to remove.`;
};

export const scheduleStatus = async (runtime: InstallRuntime): Promise<string> => {
  const queried = await runtime.schtasks(['/Query', '/TN', TASK_NAME]);
  return queried.code === 0 ? `Scheduled task ${TASK_NAME}: registered.` : `Scheduled task ${TASK_NAME}: not registered.`;
};
