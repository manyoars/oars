// What `deposit`, `recall`, and `books` say when there is nothing to show, so a first run reads as "nothing found here" and not as a broken tool.
import type { Source } from './sources.js';
import type { DepositResult, SessionsRuntime } from './store.js';

/** The two commands that get someone out of an empty store: fill it from their own sessions, or watch it work on made-up ones first. */
const WAYS_OUT = 'Fill it with `oars sessions deposit`, or see it work on made-up sessions first with `oars sessions try`.';

/** `recall` over a store with no sessions in it. */
export const EMPTY_RECALL = `Your store is empty, so there is nothing to recall. ${WAYS_OUT}`;

/** `books` over a store with no sessions in it; `what` is "prompts" or "pulls". */
export const emptyBooks = (what: string): string => `No ${what} in the store: it is empty. ${WAYS_OUT}`;

/**
 * The lines a deposit that read nothing adds: every place it looked and what it found there. A source with no root on this machine was
 * not looked in, so it is not listed. Paths are the reader's own, printed on their own terminal.
 */
export const nothingFoundLines = (result: DepositResult, runtime: SessionsRuntime, table: readonly Source[]): string[] => {
  const places = [
    `Claude Code: ${runtime.projectsRoot} (${String(result.folders.length)} project folders read, ${String(result.skippedFolders)} not on the allowlist)`,
    ...table.flatMap((source) => {
      const root = runtime.sourceRoots?.[source.name];
      return root === undefined ? [] : [`${source.label}: ${root} (${String(result.sources[source.name]?.read ?? 0)} sessions read)`];
    }),
  ];
  return ['Found no sessions. Looked in:', ...places.map((place) => `  ${place}`), 'Run it after a coding-agent session has run on this machine, or see oars work first with `oars sessions try`.'];
};

/** Entries named in the note before it says "and N more". */
const NOTE_ENTRIES = 5;

/**
 * One line when this run read from entries it was not given: they came from the list an earlier deposit saved (`state.json`), so a plain
 * `oars sessions deposit` is not reading every source. `applied` is what the run reads, `given` what it was handed.
 */
export const savedListNote = (applied: readonly string[], given: readonly string[], file: string): string[] => {
  const saved = applied.filter((entry) => !given.includes(entry));
  if (saved.length === 0) return [];
  const shown = saved.slice(0, NOTE_ENTRIES).join(', ');
  const more = saved.length > NOTE_ENTRIES ? `, and ${String(saved.length - NOTE_ENTRIES)} more` : '';
  return [`Used the --allow list saved by an earlier run (${shown}${more}), kept in ${file}. Name folders with --allow to change it.`];
};
