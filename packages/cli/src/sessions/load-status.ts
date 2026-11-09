// Did the harness load what existed: the session-start snapshot (`candidates.ts`) joined with the loaded set a transcript shows. A pure derivation, recomputed from those two
// records, so a change to a rule below bumps LOAD_STATUS_VERSION and needs no new capture. `load-status.jsonl` is rewritten from them and is safe to delete.
//
// The rule is what a fixture measured for each harness, not what a harness documents: a live session per case on a temp tree, reading only that session's own log. Each position
// is one of `load` (the harness read a file there), `skip` (it did not, by design), or `unmeasured` (the case was not measured). What was not measured stays `unknown`.
//
// What a log can show decides which kind gets a loaded or missed label. A transcript names each instruction file it loaded, so those kinds do. It lists skills only as one total with
// no source, and only when the session offers the Skill tool, and it records a hook only when the hook prints or is a Stop hook (as one total over every source), so a skill or hook
// that exists stays `unknown`. A hook in a folder above the working folder is the one by-design skip measured for them: those settings files do not run.
import { positionOfLevel, readCandidates, type CandidateSnapshot, type HookEventCounts, type HookSource, type InstructionPosition, type WorkingKind } from './candidates.js';
import type { LoadedInstructions, SessionObservation } from './schema.js';

export const LOAD_STATUS_VERSION = 3;
export const LOAD_STATUS_FILE = 'load-status.jsonl';

/** `loaded` the log shows it. `miss` a file existed, the rule loads it, the log does not show it. `excluded` a file existed where the rule skips by design. `absent` no file existed there. `unknown` this cannot be decided. */
export type LoadLabel = 'loaded' | 'miss' | 'excluded' | 'absent' | 'unknown';

export interface LoadStatus {
  v: number;
  session: string;
  harness: string;
  instructions: { [position in InstructionPosition]: LoadLabel };
  /** `CLAUDE.local.md`, `.claude/CLAUDE.md`, and the unconditional `.claude/rules/` files, in the working folder. */
  files: { [kind in WorkingKind]: LoadLabel };
  skills: { project: LoadLabel; user: LoadLabel };
  hooks: { [source in HookSource]: LoadLabel };
}

type Rule = 'load' | 'skip' | 'unmeasured';
type Rules = { [position in InstructionPosition]: Rule };
interface HarnessRule {
  positions: Rules;
  /** The other instruction-file kinds, in the working folder. */
  files: Rule;
  /** Settings files in the folders above the working folder. */
  hooksAbove: Rule;
}

const RULES: ReadonlyMap<string, HarnessRule> = new Map<string, HarnessRule>([
  [
    'claude-code',
    {
      // Climbs past the git root to the filesystem root. A linked worktree nested inside its main checkout skips exactly that span, and the climb resumes above it.
      positions: { working: 'load', parent: 'load', above: 'load', mainCheckout: 'skip', user: 'load' },
      files: 'load',
      // Project settings come from the working folder alone: a settings file in a parent folder, the repo root, or a worktree's main checkout did not run.
      hooksAbove: 'skip',
    },
  ],
  [
    'codex',
    {
      // Reads from the git root down to the working folder and stops there. The user-level file was not measured: this machine has none, and measuring needs a copied login.
      positions: { working: 'load', parent: 'load', above: 'skip', mainCheckout: 'skip', user: 'unmeasured' },
      files: 'unmeasured',
      hooksAbove: 'unmeasured',
    },
  ],
]);

const INSTRUCTION_NAME = 'claude.md';
const LOCAL_NAME = 'claude.local.md';

const segmentsOf = (path: string): string[] => {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '');
  // Only a path with a drive letter is compared without case: elsewhere two spellings can be two folders.
  return /^[A-Za-z]:$/.test(parts[0] ?? '') ? parts.map((part) => part.toLowerCase()) : parts;
};

const sameFolder = (folder: readonly string[], other: readonly string[]): boolean => folder.length === other.length && folder.every((part, index) => part === other[index]);

/**
 * The loaded set of a transcript's `instructions` record, as levels above the working folder: the path itself is read here and goes no further. `CLAUDE.md` files are placed by level;
 * `CLAUDE.local.md`, `.claude/CLAUDE.md`, and `.claude/rules/*.md` are counted when they sit in the working folder, the only place they were measured.
 */
export const loadedInstructionsOf = (files: readonly { path: string; type: string }[], cwd: string): LoadedInstructions => {
  const here = segmentsOf(cwd);
  const levels: number[] = [];
  let user = 0;
  const kinds = { local: 0, dotClaude: 0, rules: 0 };
  for (const { path, type } of files) {
    const segments = segmentsOf(path);
    const name = segments.at(-1)?.toLowerCase();
    const folder = segments.slice(0, -1);
    if (type === 'User') {
      if (name === INSTRUCTION_NAME) user += 1;
    } else if (type === 'Local') {
      if (name === LOCAL_NAME && sameFolder(folder, here)) kinds.local += 1;
    } else if (type === 'Project') {
      if (name === INSTRUCTION_NAME && sameFolder(folder, [...here, '.claude'])) kinds.dotClaude += 1;
      else if (name === INSTRUCTION_NAME) {
        if (folder.length <= here.length && folder.every((part, index) => part === here[index])) levels.push(here.length - folder.length);
      } else if (name?.endsWith('.md') === true && sameFolder(folder, [...here, '.claude', 'rules'])) kinds.rules += 1;
    }
  }
  return { user, levels, ...kinds };
};

/** How many files the log shows loaded at a position: the user count, or the project files whose folder level falls in the position. */
const seenAt = (position: InstructionPosition, snapshot: CandidateSnapshot, loaded: LoadedInstructions): number => {
  if (position === 'user') return loaded.user;
  return loaded.levels.filter((level) => positionOfLevel(level, snapshot) === position).length;
};

const instructionLabel = (position: InstructionPosition, snapshot: CandidateSnapshot, loaded: LoadedInstructions | undefined, rules: Rules): LoadLabel => {
  const present = snapshot.instructions[position];
  if (loaded === undefined) return present === 0 ? 'absent' : 'unknown';
  const seen = seenAt(position, snapshot, loaded);
  // What the log shows wins over what the snapshot counted and over the rule: the file was loaded.
  if (seen > 0) return 'loaded';
  if (present === 0) return 'absent';
  const rule = rules[position];
  if (rule === 'unmeasured') return 'unknown';
  // A file the harness does not read by design is not a candidate, so it is no miss; it is not absent either, since it exists.
  return rule === 'load' ? 'miss' : 'excluded';
};

/** A working-folder kind: the log shows how many of its files loaded, once a capture of version 30 or later recorded it. */
const kindLabel = (present: number, seen: number | undefined, rule: Rule): LoadLabel => {
  if (seen === undefined) return present === 0 ? 'absent' : 'unknown';
  if (seen > 0) return 'loaded';
  if (present === 0) return 'absent';
  if (rule === 'unmeasured') return 'unknown';
  return rule === 'load' ? 'miss' : 'excluded';
};

/** Skills have no source in the log, so a count above zero cannot be called either way. */
const countLabel = (count: number): LoadLabel => (count === 0 ? 'absent' : 'unknown');

const total = (counts: HookEventCounts): number => Object.values(counts).reduce((sum, count) => sum + count, 0);

/** A hook is `absent` at zero. Above zero the log cannot show it ran, so it is `unknown`, except where the rule skips its settings file by design. */
const hookLabel = (counts: HookEventCounts, rule: Rule): LoadLabel => {
  if (total(counts) === 0) return 'absent';
  return rule === 'skip' ? 'excluded' : 'unknown';
};

const allPositions = (label: (position: InstructionPosition) => LoadLabel): LoadStatus['instructions'] => ({
  working: label('working'),
  parent: label('parent'),
  above: label('above'),
  mainCheckout: label('mainCheckout'),
  user: label('user'),
});

export const loadStatusOf = ({ session, harness, snapshot, loaded }: { session: string; harness: string; snapshot: CandidateSnapshot | undefined; loaded: LoadedInstructions | undefined }): LoadStatus => {
  const rule = RULES.get(harness);
  // No snapshot means nothing is known of what existed: never `absent`.
  if (snapshot === undefined) {
    return {
      v: LOAD_STATUS_VERSION,
      session,
      harness,
      instructions: allPositions(() => 'unknown'),
      files: { local: 'unknown', dotClaude: 'unknown', rules: 'unknown' },
      skills: { project: 'unknown', user: 'unknown' },
      hooks: { user: 'unknown', working: 'unknown', ancestors: 'unknown' },
    };
  }
  const fileLabel = (kind: WorkingKind): LoadLabel => (rule === undefined ? 'unknown' : kindLabel(snapshot.workingKinds[kind], loaded?.[kind], rule.files));
  return {
    v: LOAD_STATUS_VERSION,
    session,
    harness,
    instructions: allPositions((position) => (rule === undefined ? 'unknown' : instructionLabel(position, snapshot, loaded, rule.positions))),
    files: { local: fileLabel('local'), dotClaude: fileLabel('dotClaude'), rules: fileLabel('rules') },
    skills: { project: countLabel(snapshot.skills.project), user: countLabel(snapshot.skills.user) },
    hooks: {
      user: hookLabel(snapshot.hooks.user, 'unmeasured'),
      working: hookLabel(snapshot.hooks.working, 'unmeasured'),
      ancestors: hookLabel(snapshot.hooks.ancestors, rule?.hooksAbove ?? 'unmeasured'),
    },
  };
};

/** One row per session, as the text of `load-status.jsonl`. Snapshots that cannot be read leave every session `unknown`: a store problem here must not stop a deposit. */
export const loadStatusLines = async (storeDir: string, sessions: readonly Pick<SessionObservation, 'session' | 'harness' | 'loadedInstructions'>[]): Promise<string> => {
  const snapshots = await readCandidates(storeDir).catch(() => new Map<string, CandidateSnapshot>());
  return sessions.map((session) => `${JSON.stringify(loadStatusOf({ session: session.session, harness: session.harness ?? 'claude-code', snapshot: snapshots.get(session.session), loaded: session.loadedInstructions }))}\n`).join('');
};
