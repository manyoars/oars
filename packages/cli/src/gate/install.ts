// `oars gate install` and `oars gate uninstall`: one PreToolUse entry in Claude Code's user settings that runs `oars gate hook`. The entry is ours when its command is
// exactly `COMMAND`, so uninstall removes that entry and nothing else, and every other key and hook in the file is carried through as parsed JSON. The command calls the
// installed `oars`, never `npx` (which would fetch a package on the hook's clock), and does nothing when `oars` is not on the PATH, so a settings file that outlives the
// install cannot cost a session its tool calls.
import { chmod, lstat, mkdir, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CliError, ExitCode } from '../errors.js';
import { readSettings } from '../sessions/install.js';

/** The tools whose calls can cross: shell commands (both shells), skills, and every MCP tool. */
export const MATCHER = 'Bash|PowerShell|Skill|mcp__.*';
export const EVENT = 'PreToolUse';
/** Seconds the harness waits for the hook; the hook ends itself in under one, so this is only the ceiling for a cold node start. */
export const TIMEOUT_SECONDS = 5;
/**
 * Run by the harness's shell (Git Bash on Windows). `command -v` is a shell builtin, so a missing `oars` costs a few milliseconds and no node start. The harness reads this command's stdout, so what
 * `oars gate hook` prints (a note or a deny) is passed through, and only when it exits 0: an `oars` with no `gate hook` prints and exits 2, which would block the tool call, so that output is dropped.
 * The trailing `exit 0` matters for the same reason.
 */
export const COMMAND = `command -v oars >/dev/null 2>&1 || exit 0; out=$(oars gate hook 2>/dev/null) && printf '%s' "$out"; exit 0`;
/** The command an earlier build wrote, which discarded the hook's output. Still ours, so a rerun replaces it and an uninstall removes it. */
export const PREVIOUS_COMMAND = 'command -v oars >/dev/null 2>&1 || exit 0; oars gate hook >/dev/null 2>&1; exit 0';

interface Json {
  [key: string]: unknown;
}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

const isOwnHook = (hook: unknown): boolean => isObject(hook) && (hook.command === COMMAND || hook.command === PREVIOUS_COMMAND);

const holdsOwn = (group: unknown): group is Json & { hooks: unknown[] } => isObject(group) && Array.isArray(group.hooks) && group.hooks.some(isOwnHook);

/** The group we write: our matcher, our one entry. */
const ownGroup = (): Json => ({ matcher: MATCHER, hooks: [{ type: 'command', command: COMMAND, timeout: TIMEOUT_SECONDS }] });

/** A group of the operator's, with our entry taken out of it; `[]` when ours was all it held. */
const remainder = (group: Json & { hooks: unknown[] }): unknown[] => {
  const rest = group.hooks.filter((hook) => !isOwnHook(hook));
  return rest.length === 0 ? [] : [{ ...group, hooks: rest }];
};

/** Our group put in the place our entry already holds, or at the end. Placing it where it is keeps a rerun from moving it past a group someone added after it. */
const withOwn = (groups: unknown[]): unknown[] => {
  const first = groups.findIndex(holdsOwn);
  if (first === -1) return [...groups, ownGroup()];
  return groups.flatMap((group, at) => {
    if (!holdsOwn(group)) return [group];
    const kept = remainder(group);
    return at === first ? [...kept, ownGroup()] : kept;
  });
};

const withoutOwn = (groups: unknown[]): unknown[] => groups.flatMap((group) => (holdsOwn(group) ? remainder(group) : [group]));

/** Where a symlink that points at nothing yet would land, so the rename writes the file it names and leaves the link a link. `undefined` when `path` is not a symlink. */
const danglingTarget = async (path: string): Promise<string | undefined> => {
  try {
    return (await lstat(path)).isSymbolicLink() ? resolve(dirname(path), await readlink(path)) : undefined;
  } catch {
    return undefined;
  }
};

/** The file as it stands, followed through a symlink (a dotfile manager's), with its permission bits. `mode` is `undefined` when there is no file yet; `target` is then where it will land. */
const existing = async (path: string): Promise<{ target: string; mode: number | undefined } | undefined> => {
  try {
    const target = await realpath(path);
    return { target, mode: (await stat(target)).mode & 0o777 };
  } catch {
    const target = await danglingTarget(path);
    return target === undefined ? undefined : { target, mode: undefined };
  }
};

/** Whole and atomic: a half-written settings file would take every other hook in it down too. The temp file sits beside the real target with the file's own mode (0600 when new: `env` can hold secrets), and the rename lands on the resolved path, so a symlinked settings file stays a symlink. The mode is set after the write because the umask masks the one `writeFile` is given; a failed rename leaves no temp file behind. */
const writeSettings = async (path: string, settings: Json): Promise<void> => {
  const found = await existing(path);
  const target = found?.target ?? path;
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${String(process.pid)}.oars-gate.tmp`;
  const mode = found?.mode ?? 0o600;
  try {
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}
`, { mode });
    await chmod(temp, mode);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
};

// A `hooks` key, or a PreToolUse key under it, of another shape is the operator's and this version cannot merge into it: refuse it, and write nothing.
const hooksOf = (settings: Json, path: string): Json => {
  if (settings.hooks === undefined) return {};
  if (!isObject(settings.hooks)) throw new CliError(`"hooks" in ${path} is not an object; nothing was changed.`, ExitCode.USAGE, 'usage');
  return settings.hooks;
};

const groupsOf = (hooks: Json, path: string): unknown[] => {
  const groups = hooks[EVENT];
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) throw new CliError(`"hooks.${EVENT}" in ${path} is not a list; nothing was changed.`, ExitCode.USAGE, 'usage');
  return groups;
};

export interface GateInstallResult {
  file: string;
  /** False when the file already held exactly this entry: nothing was written. */
  changed: boolean;
}

/** Unparsable settings are refused by `readSettings` before anything is written. */
export const installGateHook = async (path: string): Promise<GateInstallResult> => {
  const settings = await readSettings(path);
  const before = JSON.stringify(settings);
  const hooks = hooksOf(settings, path);
  hooks[EVENT] = withOwn(groupsOf(hooks, path));
  settings.hooks = hooks;
  if (JSON.stringify(settings) === before) return { file: path, changed: false };
  await writeSettings(path, settings);
  return { file: path, changed: true };
};

export interface GateUninstallResult {
  file: string;
  removed: boolean;
}

export const uninstallGateHook = async (path: string): Promise<GateUninstallResult> => {
  const settings = await readSettings(path);
  const hooks = hooksOf(settings, path);
  const groups = groupsOf(hooks, path);
  if (!groups.some(holdsOwn)) return { file: path, removed: false };
  const kept = withoutOwn(groups);
  // An event this call emptied goes, and so does a `hooks` key it emptied; anything else the operator wrote stays where it was.
  if (kept.length === 0) Reflect.deleteProperty(hooks, EVENT);
  else hooks[EVENT] = kept;
  settings.hooks = Object.keys(hooks).length === 0 ? undefined : hooks;
  await writeSettings(path, settings);
  return { file: path, removed: true };
};
