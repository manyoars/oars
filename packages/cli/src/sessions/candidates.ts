// What a session could have loaded, recorded when it starts. A transcript holds the files the harness loaded, never the files that existed, and a working folder is often gone by
// the time anyone asks, so a later read cannot tell a file the harness missed from a file that was never there. The session-start hook writes this snapshot to `candidates.jsonl`.
//
// Kinds and counts only: no path, file name, skill name, or file content enters a record. The two levels are how many folders up the repo root and the main checkout sit, which is
// what lets a loaded file's own level be placed in a position later. The log is append-only and apart from `observations.jsonl`, because a snapshot cannot be captured again from
// a transcript the way a capture record can, and it never reaches a pool batch.
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { Stats } from 'node:fs';
import { HOOK_HARNESS } from '../telemetry/fields.js';
import { appendOwnerOnly } from './owner-only.js';

export const CANDIDATES_FILE = 'candidates.jsonl';
export const CANDIDATE_RECORD_VERSION = 1;

/** Where an instruction file sits relative to the session. `mainCheckout` is the span between a linked worktree and the main checkout that holds it, a span the harnesses treat apart. */
export const INSTRUCTION_POSITIONS = ['working', 'parent', 'above', 'mainCheckout', 'user'] as const;
export type InstructionPosition = (typeof INSTRUCTION_POSITIONS)[number];

/** Claude Code's hook events, the 33 in the installed harness's own list (2.1.319). A name not on this list is counted as `other`, so a settings file cannot put free text in a record. */
export const HOOK_EVENT_NAMES = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange', 'CwdChanged', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove',
  'PreCompact', 'PostCompact', 'Elicitation', 'ElicitationResult', 'Setup',
  'PostToolBatch', 'UserPromptExpansion', 'PreModelSwitch', 'PostModelSwitch', 'DirectoryAdded', 'MessageDisplay',
] as const;
export type HookEventName = (typeof HOOK_EVENT_NAMES)[number] | 'other';

export type InstructionCounts = { [position in InstructionPosition]: number };
export type HookEventCounts = { [event in HookEventName]?: number };

export interface CandidateCounts {
  instructions: InstructionCounts;
  skills: { project: number; user: number };
  hooks: HookEventCounts;
  /** Folders from the working folder up to the repo root; null when no repository holds it. */
  repoLevels: number | null;
  /** Folders from the working folder up to the main checkout of a linked worktree nested inside it; null otherwise. */
  mainLevels: number | null;
}

export interface CandidateSnapshot extends CandidateCounts {
  v: number;
  session: string;
  at: string;
  harness: typeof HOOK_HARNESS;
}

const INSTRUCTION_FILE = 'CLAUDE.md';
const SKILL_FILE = 'SKILL.md';
const EVENT_NAMES: ReadonlySet<string> = new Set(HOOK_EVENT_NAMES);

const isEventName = (name: string): name is HookEventName => EVENT_NAMES.has(name);

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

const isMissing = (error: unknown): boolean => {
  const code: unknown = isObject(error) ? Reflect.get(error, 'code') : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** A path's stat, undefined when nothing is there. Any other failure is thrown: a snapshot that could not look is not one that found nothing. */
const statOf = async (path: string): Promise<Stats | undefined> => {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

const isFile = async (path: string): Promise<boolean> => (await statOf(path))?.isFile() === true;

const samePath = (a: string, b: string): boolean => relative(a, b) === '';

/** The folder and each of its parents, nearest first. */
const chainOf = (dir: string): string[] => {
  const chain = [dir];
  for (let up = dirname(dir); up !== chain[chain.length - 1]; up = dirname(up)) chain.push(up);
  return chain;
};

/** The main checkout a linked worktree's `.git` pointer names; undefined for any other pointer (a submodule's). */
const mainCheckoutOf = (pointer: string, dir: string): string | undefined => {
  const target = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
  if (target === undefined) return undefined;
  const gitDir = resolve(dir, target);
  if (basename(dirname(gitDir)) !== 'worktrees') return undefined;
  const common = dirname(dirname(gitDir));
  return basename(common) === '.git' ? dirname(common) : undefined;
};

const levelsOf = async (chain: readonly string[]): Promise<Pick<CandidateCounts, 'repoLevels' | 'mainLevels'>> => {
  for (const [level, dir] of chain.entries()) {
    const git = await statOf(join(dir, '.git'));
    if (git === undefined) continue;
    if (git.isDirectory()) return { repoLevels: level, mainLevels: null };
    const main = mainCheckoutOf(await readFile(join(dir, '.git'), 'utf8'), dir);
    const mainLevel = main === undefined ? -1 : chain.findIndex((folder) => samePath(folder, main));
    return { repoLevels: level, mainLevels: mainLevel > level ? mainLevel : null };
  }
  return { repoLevels: null, mainLevels: null };
};

/** Which position a folder `level` steps above the working folder holds; the derivation places a loaded file's level with this same rule. */
export const positionOfLevel = (level: number, { repoLevels, mainLevels }: Pick<CandidateCounts, 'repoLevels' | 'mainLevels'>): Exclude<InstructionPosition, 'user'> => {
  if (level === 0) return 'working';
  if (repoLevels !== null && level <= repoLevels) return 'parent';
  if (mainLevels !== null && level <= mainLevels) return 'mainCheckout';
  return 'above';
};

const skillCount = async (skillsDir: string): Promise<number> => {
  let names: string[];
  try {
    names = await readdir(skillsDir);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  const found = await Promise.all(names.map((name) => isFile(join(skillsDir, name, SKILL_FILE))));
  return found.filter(Boolean).length;
};

const addHookCounts = async (file: string, counts: HookEventCounts): Promise<void> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  const hooks: unknown = isObject(parsed) ? Reflect.get(parsed, 'hooks') : undefined;
  if (!isObject(hooks)) return;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const commands = groups.reduce<number>((sum, group: unknown) => {
      const list: unknown = isObject(group) ? Reflect.get(group, 'hooks') : undefined;
      return sum + (Array.isArray(list) ? list.length : 0);
    }, 0);
    if (commands === 0) continue;
    const name = isEventName(event) ? event : 'other';
    counts[name] = (counts[name] ?? 0) + commands;
  }
};

/** Counts what exists around `cwd`, under the harness's config folder `claudeDir`. It throws on anything but a missing file. */
export const snapshotCandidates = async ({ cwd, claudeDir }: { cwd: string; claudeDir: string }): Promise<CandidateCounts> => {
  const chain = chainOf(cwd);
  const levels = await levelsOf(chain);
  // A session inside the config folder climbs through it: the file there is the user-level one, counted once below.
  const isConfigFolder = (dir: string): boolean => samePath(dir, claudeDir);
  const isConfigParent = (dir: string): boolean => samePath(join(dir, '.claude'), claudeDir);

  const instructions: InstructionCounts = { working: 0, parent: 0, above: 0, mainCheckout: 0, user: (await isFile(join(claudeDir, INSTRUCTION_FILE))) ? 1 : 0 };
  for (const [level, dir] of chain.entries()) {
    if (!isConfigFolder(dir) && (await isFile(join(dir, INSTRUCTION_FILE)))) instructions[positionOfLevel(level, levels)] += 1;
  }

  const projectFolders = chain.slice(0, (levels.repoLevels ?? 0) + 1).filter((dir) => !isConfigParent(dir));
  const skills = { project: 0, user: await skillCount(join(claudeDir, 'skills')) };
  for (const dir of projectFolders) skills.project += await skillCount(join(dir, '.claude', 'skills'));

  const hooks: HookEventCounts = {};
  await addHookCounts(join(claudeDir, 'settings.json'), hooks);
  const root = chain.at(levels.repoLevels ?? 0) ?? cwd;
  if (!isConfigParent(root)) {
    await addHookCounts(join(root, '.claude', 'settings.json'), hooks);
    await addHookCounts(join(root, '.claude', 'settings.local.json'), hooks);
  }
  return { instructions, skills, hooks, ...levels };
};

/**
 * Appends this session's snapshot. Fail-open: any error writes nothing and returns, because a hook must never fail or block a session, and a partial count would read as evidence
 * that files were absent. The counts are finished before the store is touched, so nothing partial can reach the file.
 */
export const recordCandidates = async (storeDir: string, { session, cwd, claudeDir, at }: { session: string; cwd: string; claudeDir: string; at: string }): Promise<void> => {
  try {
    const counts = await snapshotCandidates({ cwd, claudeDir });
    const record: CandidateSnapshot = { v: CANDIDATE_RECORD_VERSION, session, at, harness: HOOK_HARNESS, ...counts };
    await mkdir(storeDir, { recursive: true });
    await appendOwnerOnly(join(storeDir, CANDIDATES_FILE), `${JSON.stringify(record)}\n`);
  } catch {
    // Fail-open, as above.
  }
};

/** A line of this version with its three count groups: one without them (hand-edited, or written badly) would throw in the join, outside its guard. */
const isSnapshot = (value: unknown): value is CandidateSnapshot =>
  isObject(value) &&
  Reflect.get(value, 'v') === CANDIDATE_RECORD_VERSION &&
  typeof Reflect.get(value, 'session') === 'string' &&
  ['instructions', 'skills', 'hooks'].every((group) => isObject(Reflect.get(value, group)));

const parsedLine = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/** The first snapshot of each session (a resumed session starts again and appends another), by session id. A line of another version or a torn line is skipped. */
export const readCandidates = async (storeDir: string): Promise<Map<string, CandidateSnapshot>> => {
  const snapshots = new Map<string, CandidateSnapshot>();
  let text: string;
  try {
    text = await readFile(join(storeDir, CANDIDATES_FILE), 'utf8');
  } catch (error) {
    if (isMissing(error)) return snapshots;
    throw error;
  }
  for (const line of text.split('\n')) {
    const parsed = parsedLine(line);
    if (isSnapshot(parsed) && !snapshots.has(parsed.session)) snapshots.set(parsed.session, parsed);
  }
  return snapshots;
};
