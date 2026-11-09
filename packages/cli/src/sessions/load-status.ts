// Did the harness load what existed: the session-start snapshot (`candidates.ts`) joined with the loaded set a transcript shows. A pure derivation, recomputed from those two
// records, so a change to a rule below bumps LOAD_STATUS_VERSION and needs no new capture. `load-status.jsonl` is rewritten from them and is safe to delete.
//
// The rule is what a fixture measured for each harness, not what a harness documents: a live session per case on a temp tree, reading only that session's own log. Each position
// is one of `load` (the harness read a file there), `skip` (it did not, by design), or `unmeasured` (the fixture could not run the case). What was not measured stays `unknown`.
import { INSTRUCTION_POSITIONS, positionOfLevel, readCandidates, type CandidateSnapshot, type InstructionPosition } from './candidates.js';
import type { LoadedInstructions, SessionObservation } from './schema.js';

export const LOAD_STATUS_VERSION = 2;
export const LOAD_STATUS_FILE = 'load-status.jsonl';

/** `loaded` the log shows it. `miss` a file existed, the rule loads it, the log does not show it. `excluded` a file existed where the rule skips by design. `absent` no file existed there. `unknown` this cannot be decided. */
export type LoadLabel = 'loaded' | 'miss' | 'excluded' | 'absent' | 'unknown';

export interface LoadStatus {
  v: number;
  session: string;
  harness: string;
  instructions: { [position in InstructionPosition]: LoadLabel };
  skills: { project: LoadLabel; user: LoadLabel };
  hooks: LoadLabel;
}

type Rule = 'load' | 'skip' | 'unmeasured';
type Rules = { [position in InstructionPosition]: Rule };

const RULES: ReadonlyMap<string, Rules> = new Map<string, Rules>([
  // Climbs past the git root to the filesystem root. A linked worktree nested inside its main checkout skips exactly that span, and the climb resumes above it.
  ['claude-code', { working: 'load', parent: 'load', above: 'load', mainCheckout: 'skip', user: 'load' }],
  // Reads from the git root down to the working folder and stops there. The user-level file could not be measured: this machine has none.
  ['codex', { working: 'load', parent: 'load', above: 'skip', mainCheckout: 'skip', user: 'unmeasured' }],
]);

const INSTRUCTION_NAME = 'claude.md';

const segmentsOf = (path: string): string[] => {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '');
  // Only a path with a drive letter is compared without case: elsewhere two spellings can be two folders.
  return /^[A-Za-z]:$/.test(parts[0] ?? '') ? parts.map((part) => part.toLowerCase()) : parts;
};

/** The loaded set of a transcript's `instructions` record, as levels above the working folder: the path itself is read here and goes no further. */
export const loadedInstructionsOf = (files: readonly { path: string; type: string }[], cwd: string): LoadedInstructions => {
  const here = segmentsOf(cwd);
  const levels: number[] = [];
  let user = 0;
  for (const { path, type } of files) {
    const segments = segmentsOf(path);
    if (segments.at(-1)?.toLowerCase() !== INSTRUCTION_NAME) continue;
    if (type === 'User') user += 1;
    else if (type === 'Project') {
      const folder = segments.slice(0, -1);
      if (folder.length <= here.length && folder.every((part, index) => part === here[index])) levels.push(here.length - folder.length);
    }
  }
  return { user, levels };
};

/** How many files the log shows loaded at a position; undefined when one undivided record covers several positions and cannot be split. */
const seenAt = (position: InstructionPosition, snapshot: CandidateSnapshot, loaded: LoadedInstructions, rules: Rules): number | undefined => {
  if (position === 'user') return loaded.user;
  if (loaded.levels !== undefined) return loaded.levels.filter((level) => positionOfLevel(level, snapshot) === position).length;
  if (loaded.any !== true) return 0;
  const candidates = INSTRUCTION_POSITIONS.filter((each) => each !== 'user' && rules[each] === 'load' && snapshot.instructions[each] > 0);
  if (candidates.length > 1 && candidates.includes(position)) return undefined;
  return candidates.includes(position) ? 1 : 0;
};

const instructionLabel = (position: InstructionPosition, snapshot: CandidateSnapshot, loaded: LoadedInstructions | undefined, rules: Rules): LoadLabel => {
  const present = snapshot.instructions[position];
  if (loaded === undefined) return present === 0 ? 'absent' : 'unknown';
  const seen = seenAt(position, snapshot, loaded, rules);
  if (seen === undefined) return 'unknown';
  // What the log shows wins over what the snapshot counted and over the rule: the file was loaded.
  if (seen > 0) return 'loaded';
  if (present === 0) return 'absent';
  const rule = rules[position];
  if (rule === 'unmeasured') return 'unknown';
  // A file the harness does not read by design is not a candidate, so it is no miss; it is not absent either, since it exists.
  return rule === 'load' ? 'miss' : 'excluded';
};

/** Skills and hooks have no measured rule, and a harness logs them too rarely to read their silence, so a count above zero cannot be called either way. */
const countLabel = (count: number): LoadLabel => (count === 0 ? 'absent' : 'unknown');

const allPositions = (label: (position: InstructionPosition) => LoadLabel): LoadStatus['instructions'] => ({
  working: label('working'),
  parent: label('parent'),
  above: label('above'),
  mainCheckout: label('mainCheckout'),
  user: label('user'),
});

export const loadStatusOf = ({ session, harness, snapshot, loaded }: { session: string; harness: string; snapshot: CandidateSnapshot | undefined; loaded: LoadedInstructions | undefined }): LoadStatus => {
  const rules = RULES.get(harness);
  // No snapshot means nothing is known of what existed: never `absent`.
  if (snapshot === undefined) return { v: LOAD_STATUS_VERSION, session, harness, instructions: allPositions(() => 'unknown'), skills: { project: 'unknown', user: 'unknown' }, hooks: 'unknown' };
  return {
    v: LOAD_STATUS_VERSION,
    session,
    harness,
    instructions: allPositions((position) => (rules === undefined ? 'unknown' : instructionLabel(position, snapshot, loaded, rules))),
    skills: { project: countLabel(snapshot.skills.project), user: countLabel(snapshot.skills.user) },
    hooks: countLabel(Object.values(snapshot.hooks).reduce((sum, count) => sum + count, 0)),
  };
};

/** One row per session, as the text of `load-status.jsonl`. Snapshots that cannot be read leave every session `unknown`: a store problem here must not stop a deposit. */
export const loadStatusLines = async (storeDir: string, sessions: readonly Pick<SessionObservation, 'session' | 'harness' | 'loadedInstructions'>[]): Promise<string> => {
  const snapshots = await readCandidates(storeDir).catch(() => new Map<string, CandidateSnapshot>());
  return sessions.map((session) => `${JSON.stringify(loadStatusOf({ session: session.session, harness: session.harness ?? 'claude-code', snapshot: snapshots.get(session.session), loaded: session.loadedInstructions }))}\n`).join('');
};
