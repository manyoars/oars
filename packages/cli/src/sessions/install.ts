// `oars sessions hook install|uninstall|status`: writes the four Claude Code hook entries into one settings file, merging with what is
// there. An entry is ours when its command ends with `hook-bin.js" <session-start|pre-tool|post-tool|stop>`, so uninstall removes those entries and nothing else. Also the retention floor
// (the harness deletes raw transcripts after `cleanupPeriodDays`, 30 when unset) and removing the Windows task earlier versions registered.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CliError, ExitCode } from '../errors.js';
import { ACTION_TABLES } from './actions.js';
import type { CodexInstall } from './codex-hook-install.js';
import { writeOwnerOnly } from './owner-only.js';

export const RETENTION_FLOOR = 365;
export const DEFAULT_RETENTION = 30;
export const TASK_NAME = 'OarsSessionsNightly';
// The tail of a command this module wrote; anything else in a settings file is the operator's, whatever it is called.
// The machine command is host-independent: it names no install path, only the `oars-hook` bin on PATH (see `MACHINE_COMMAND`).
const OWN_COMMAND = /(?:hook-bin\.js" (?:session-start|prompt|pre-tool|post-tool|stop)|oars-hook stop --machine)$/;
/**
 * What `--machine` writes for Stop and SessionEnd. A settings file committed from one machine is read on another (a cloud VM, a runner), where the installing machine's node and `hook-bin.js` paths do not exist, so this names no path:
 * it resolves the `oars-hook` bin on PATH, and exits 0 when there is none (a hook that cannot start must not fail the session).
 */
export const MACHINE_COMMAND = 'command -v oars-hook >/dev/null || exit 0; oars-hook stop --machine';
const MACHINE_EVENTS = ['Stop', 'SessionEnd'] as const;
// The hook body is a node start and a detach (well under a second); this is the harness's ceiling, not its budget.
const MACHINE_TIMEOUT = 10;

/** What the install needs from the machine, so a test can stand in for each. */
export interface InstallRuntime {
  /** `process.platform`: only `win32` ever had the nightly task. */
  platform: NodeJS.Platform;
  nodePath: string;
  /** Absolute path of the built `hook-bin.js`. */
  hookBin: string;
  /** `<claude config dir>/settings.json`. */
  userSettings: string;
  cwd: string;
  /** Where the Codex recording hook goes (`--harness codex`); absent in a run that has none. */
  codex?: CodexInstall;
  /** Runs `schtasks` with these arguments; used only to remove the task an earlier version registered. */
  schtasks: (args: string[]) => Promise<{ code: number; output: string }>;
}

export type Scope = 'user' | 'project' | 'file';

interface HookSpec {
  event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUseFailure' | 'SessionEnd';
  arg: 'session-start' | 'prompt' | 'pre-tool' | 'post-tool' | 'stop';
  /** Tools the group applies to; unset means every one. */
  matcher?: string;
  /** Seconds the harness waits; the hooks' own budgets are far lower, this is the ceiling. */
  timeout: number;
}

const SPECS: readonly HookSpec[] = [
  { event: 'SessionStart', arg: 'session-start', timeout: 5 },
  // The split-positions table again, only when it changed since this session's last one (`hooks.ts`); a prompt with nothing new costs one node start and prints nothing.
  { event: 'UserPromptSubmit', arg: 'prompt', timeout: 5 },
  // Every tool (no matcher): the push is gated by the index's fit floors and lift, not by the tool's name, so a sharp read on any tool can fire. The cost is one node start per call.
  { event: 'PreToolUse', arg: 'pre-tool', timeout: 5 },
  // A failed call arrives as PostToolUseFailure (PostToolUse itself fires on success only); a shell tool's `error` starts "Exit code N". Every tool the action table maps can fail into a recovery read, so the matcher is the table's names and the MCP pattern, not the two shells.
  { event: 'PostToolUseFailure', arg: 'post-tool', timeout: 5, matcher: `${Object.keys(ACTION_TABLES['claude-code'].rows).filter((name) => !name.startsWith('mcp__')).join('|')}|mcp__.*` },
  // SessionEnd fires once per session; Stop fires after every assistant turn and would re-extract the growing transcript each time.
  { event: 'SessionEnd', arg: 'stop', timeout: 30 },
];

/** A settings file is open-ended JSON the harness owns; only the keys named here are read or written. */
export interface Json {
  [key: string]: unknown;
}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The post-tool command reads the event first in the hook shell (Git Bash on Windows, where the harness runs hooks). For a shell tool it starts node only
 * when the failure text carries `Exit code` (a refusal or an interrupt has none, and a fresh node costs 250 ms to seconds on Windows, the shell builtins a few
 * milliseconds); any other tool's failure goes straight to node, because its text has no such line and its recovery read does not need one.
 */
export const commandOf = (runtime: InstallRuntime, arg: string): string => {
  const launch = `"${runtime.nodePath}" "${runtime.hookBin}" ${arg}`;
  // Fails open: a settings file outlives the build it points at (a cloud worker, a clone with no build), and a hook that cannot start must not fail the session.
  const present = `[ -f "${runtime.hookBin}" ] || exit 0; `;
  if (arg !== 'post-tool') return `${present}${launch}`;
  return `${present}IFS= read -r event; case "$event" in '') exit 0;; *'"tool_name":"Bash"'*|*'"tool_name":"PowerShell"'*) case "$event" in *'Exit code'*) ;; *) exit 0;; esac;; esac; { printf '%s\\n' "$event"; cat; } | ${launch}`;
};

const isOwnHook = (hook: unknown, own: RegExp): boolean => isObject(hook) && typeof hook.command === 'string' && own.test(hook.command);

/** The groups with our entries taken out; a group that held only ours goes, one that held others keeps them. `own` tells ours by the command's tail. */
export const withoutOwn = (groups: unknown[], own: RegExp = OWN_COMMAND): unknown[] =>
  groups.flatMap((group) => {
    if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some((hook) => isOwnHook(hook, own))) return [group];
    const rest = group.hooks.filter((hook) => !isOwnHook(hook, own));
    return rest.length === 0 ? [] : [{ ...group, hooks: rest }];
  });

export const hasOwn = (groups: unknown[], own: RegExp = OWN_COMMAND): boolean =>
  groups.some((group) => isObject(group) && Array.isArray(group.hooks) && group.hooks.some((hook) => isOwnHook(hook, own)));

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

export const writeSettings = async (path: string, settings: Json): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
};

export const hooksOf = (settings: Json): Json => (isObject(settings.hooks) ? settings.hooks : {});

export const groupsOf = (hooks: Json, event: string): unknown[] => {
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

/** Events an earlier build registered our entries under; install and uninstall clear them so a stale entry cannot keep running. */
const LEGACY_EVENTS = ['Stop'];

/** Takes our entries out of `event`, dropping the key when that empties it. */
const clearLegacy = (hooks: Json, event: string): boolean => {
  const groups = groupsOf(hooks, event);
  if (!hasOwn(groups)) return false;
  const kept = withoutOwn(groups);
  if (kept.length === 0) Reflect.deleteProperty(hooks, event);
  else hooks[event] = kept;
  return true;
};

export const installHooks = async (runtime: InstallRuntime, path: string, keepRetention: boolean): Promise<InstallResult> => {
  const settings = await readSettings(path);
  const hooks = hooksOf(settings);
  for (const event of LEGACY_EVENTS) clearLegacy(hooks, event);
  for (const spec of SPECS) {
    const others = withoutOwn(groupsOf(hooks, spec.event));
    const entry = { type: 'command', command: commandOf(runtime, spec.arg), timeout: spec.timeout };
    hooks[spec.event] = [...others, spec.matcher === undefined ? { hooks: [entry] } : { matcher: spec.matcher, hooks: [entry] }];
  }
  settings.hooks = hooks;
  // A project or file scope overrides the user's `cleanupPeriodDays`, so a file with no number of its own takes the user's, lower or higher; that is the value reported.
  const own = effectiveRetention(settings);
  // Only a value the user file sets counts: its unset default must not outrank a lower value written on purpose here.
  const userDays = path === runtime.userSettings ? undefined : (await readSettings(runtime.userSettings)).cleanupPeriodDays;
  const userValue = typeof userDays === 'number' ? userDays : undefined;
  // A number this file sets overrides the user's, so the user's counts only when the file sets none.
  const inherited = typeof settings.cleanupPeriodDays === 'number' ? undefined : userValue;
  // With no number of its own the file takes the user's, lower or higher: that is what the harness deletes by.
  const before = inherited ?? own;
  const shown = inherited !== undefined ? `${String(before)} (from ${runtime.userSettings})` : typeof settings.cleanupPeriodDays === 'number' ? String(before) : `${String(before)} (unset, the default)`;
  let retention: string;
  if (keepRetention) {
    retention = `Left cleanupPeriodDays alone at ${shown} in ${path} (--keep-retention); the harness deletes raw transcripts older than that.`;
  } else if (before >= RETENTION_FLOOR) {
    retention = `cleanupPeriodDays is ${shown} in ${path}, at or above the ${String(RETENTION_FLOOR)} floor; left as is.`;
  } else {
    // The floor is per target file: a user-scope value never lands in a project file, which can be committed. Without a number of its own the
    // file reaches this branch only when the user value is below the floor too, so the floor is right there as well.
    settings.cleanupPeriodDays = RETENTION_FLOOR;
    retention = `Raised cleanupPeriodDays from ${shown} to ${String(RETENTION_FLOOR)} in ${path}.`;
  }
  await writeSettings(path, settings);
  return { file: path, installed: SPECS.map((spec) => spec.event), retention };
};

/**
 * `hook install --machine`: the Stop and SessionEnd entries that run `oars-hook stop --machine`, merged with what is there (only entries of ours are replaced). With `env`, the enrollment block goes to this file's `env`
 * block, merged with the operator's own entries, and the file is made owner-only, because it then holds the salts and the terms. A project file gets no `env`: it is committed.
 */
export const installMachineHooks = async (path: string, env: { [name: string]: string } | undefined): Promise<InstallResult> => {
  const settings = await readSettings(path);
  const hooks = hooksOf(settings);
  for (const event of MACHINE_EVENTS) {
    hooks[event] = [...withoutOwn(groupsOf(hooks, event)), { hooks: [{ type: 'command', command: MACHINE_COMMAND, timeout: MACHINE_TIMEOUT }] }];
  }
  settings.hooks = hooks;
  if (env === undefined) {
    await writeSettings(path, settings);
  } else {
    const merged = { ...(isObject(settings.env) ? settings.env : {}), ...env };
    // The terms are given once: a re-install that names one variable replaces the other. A Stop lets the inline list win, so an earlier one would silently outlive the new list and keep terms in a file the operator moved them out of.
    if (env.OARS_EXCLUSION_TERMS !== undefined) Reflect.deleteProperty(merged, 'OARS_EXCLUSION_TERMS_INLINE');
    if (env.OARS_EXCLUSION_TERMS_INLINE !== undefined) Reflect.deleteProperty(merged, 'OARS_EXCLUSION_TERMS');
    settings.env = merged;
    await mkdir(dirname(path), { recursive: true });
    await writeOwnerOnly(path, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return { file: path, installed: [...MACHINE_EVENTS], retention: 'Left cleanupPeriodDays alone: a machine builds its batch at each Stop, not from a stored transcript.' };
};

export const uninstallHooks = async (path: string): Promise<{ file: string; removed: string[] }> => {
  const settings = await readSettings(path);
  const hooks = hooksOf(settings);
  const removed: string[] = [];
  const cleared = LEGACY_EVENTS.map((event) => clearLegacy(hooks, event)).includes(true);
  for (const spec of SPECS) {
    const groups = groupsOf(hooks, spec.event);
    if (!hasOwn(groups)) continue;
    const kept = withoutOwn(groups);
    removed.push(spec.event);
    hooks[spec.event] = kept;
  }
  if (removed.length > 0 || cleared) {
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

/** What `hook install` says to someone who asks for the task that earlier versions registered: sends ride the hook and the commands now. */
export const SCHEDULE_REFUSED = 'oars no longer registers a scheduled task: sends now ride the session-end hook and any oars command (at most about hourly). Run: oars sessions hook install';

/**
 * Removes the nightly task an earlier version registered, and says so in one line; nothing when it is not there. Only Windows ever had one, so any other platform makes no call. Install and uninstall both
 * call this, so a machine that upgrades loses the task the first time either runs. A task that is there but refuses to go (policy) is reported, never failed: the hooks are the work of the command.
 */
export const removeSchedule = async (runtime: InstallRuntime): Promise<string | undefined> => {
  if (runtime.platform !== 'win32') return undefined;
  const queried = await runtime.schtasks(['/Query', '/TN', TASK_NAME]);
  if (queried.code !== 0) return undefined;
  const deleted = await runtime.schtasks(['/Delete', '/TN', TASK_NAME, '/F']);
  return deleted.code === 0
    ? `Removed the scheduled task ${TASK_NAME} that an earlier version registered; sends now ride the session-end hook and any oars command.`
    : `Could not remove the scheduled task ${TASK_NAME} (${deleted.output.trim()}); remove it yourself with: schtasks /Delete /TN ${TASK_NAME} /F`;
};

/** The status line for a task left over from an earlier version; nothing when there is none. */
export const scheduleStatus = async (runtime: InstallRuntime): Promise<string | undefined> => {
  if (runtime.platform !== 'win32') return undefined;
  const queried = await runtime.schtasks(['/Query', '/TN', TASK_NAME]);
  return queried.code === 0 ? `Scheduled task ${TASK_NAME}: registered by an earlier version; oars sessions hook install or uninstall removes it.` : undefined;
};
