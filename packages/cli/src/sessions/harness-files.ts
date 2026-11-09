// Per harness, how many session files the readers saw, how many yielded records, and how many were in a form the reader could not parse.
// A harness whose log format moved then shows up as a count an operator can read, not as quietly thinner data. The counts are read from the
// harness's own store on this machine and sent nowhere. This file is the one place the three counts are defined; `sessions verify` prints them.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { compileAllow } from './allow.js';
import { captureSession } from './extract.js';
import { holdsOnlyKinds } from './head-only.js';
import { makeRedactor } from './redact.js';
import type { Harness } from './schema.js';
import type { SourceSession, SourceStore } from './sources.js';
import { listDir, mainTranscript, projectFolders, readState, sessionFolders, sourceRoots, sourcesOf, subagentTranscripts, type SessionsRuntime, type Transcript } from './store.js';

export interface FileCounts {
  /** Files the reader selected and opened: `yielded + unreadable`, always. */
  seen: number;
  /** Seen files that gave at least one record (a user or assistant turn). */
  yielded: number;
  /** Seen files the reader could not read, or that gave no record from a form it does not know. */
  unreadable: number;
}

/** What the docs and the tests quote: where each kind of file goes, so `seen` is the sum of the outcomes. */
export const FILE_COUNT_RULES =
  'A file counts once. It is seen when the reader opened it and it is not empty; seen files either yielded (at least one user or assistant turn came out) or are unreadable ' +
  '(the read failed, or the text gave no turn, torn or with a record of a kind the reader does not know). An empty file (nothing in it to parse), a file with no turn whose ' +
  'records are all head records its own format defines (a session started and quit), and a file skipped by a rule (an id that is not a safe file name, a revert folded into ' +
  'its thread, a session folded into another) are not seen. A file a reader dropped before it was a session (a Gemini chat that holds nothing, an OpenTelemetry file with no span found) is seen and unreadable when it held records in a shape the reader does not know. Where a store is a database, a session is the unit.';

export type FileOutcome = 'yielded' | 'unreadable' | 'empty';

/** `records` is undefined when the read itself failed; `headOnly` is the reader's word that a file with no turn holds only head records. */
export const outcomeOf = (file: { size: number; records: number | undefined; headOnly?: boolean }): FileOutcome => {
  if (file.records === undefined) return 'unreadable';
  if (file.size === 0) return 'empty';
  if (file.records > 0) return 'yielded';
  return file.headOnly === true ? 'empty' : 'unreadable';
};

/** The Claude Code record types that carry no turn by design: a compaction summary, a file-history snapshot, the permission mode, an attachment, and a system notice. A transcript of these alone is a session started and quit. */
const CLAUDE_HEAD_KINDS: ReadonlySet<string> = new Set(['summary', 'file-history-snapshot', 'permission-mode', 'attachment', 'system']);

export const tally = (outcomes: readonly FileOutcome[]): FileCounts => {
  const yielded = outcomes.filter((outcome) => outcome === 'yielded').length;
  const unreadable = outcomes.filter((outcome) => outcome === 'unreadable').length;
  return { seen: yielded + unreadable, yielded, unreadable };
};

export interface HarnessFiles {
  [harness: string]: FileCounts;
}

const NO_ONE = makeRedactor([]);

/** The turns a transcript's text gives once the reader's lines go through the same capture the deposit runs; nothing is stored. */
const recordsOf = (text: string, harness: Harness, subagent?: Transcript['subagent']): number => {
  const { session } = captureSession({ text, session: 'count', project: 'count', rev: 0, at: new Date(0).toISOString(), bytes: Buffer.byteLength(text), redact: NO_ONE, harness, ...(subagent === undefined ? {} : { subagent }) });
  return session.userTurns + session.assistantTurns;
};

const claudeOutcomes = async (runtime: SessionsRuntime, allows: (name: string) => boolean): Promise<FileOutcome[]> => {
  const outcomes: FileOutcome[] = [];
  for (const project of (await projectFolders(runtime.projectsRoot)).filter(allows)) {
    const folder = join(runtime.projectsRoot, project);
    const mains = (await listDir(folder)).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => mainTranscript(folder, entry.name));
    for (const transcript of [...mains, ...(await subagentTranscripts(folder, await sessionFolders(folder)))]) {
      try {
        const size = (await stat(transcript.file)).size;
        const text = await readFile(transcript.file, 'utf8');
        outcomes.push(outcomeOf({ size, records: recordsOf(text, 'claude-code', transcript.subagent), headOnly: holdsOnlyKinds(text, CLAUDE_HEAD_KINDS) }));
      } catch {
        outcomes.push('unreadable');
      }
    }
  }
  return outcomes;
};

const sessionOutcome = async (store: SourceStore, session: SourceSession, harness: Harness): Promise<FileOutcome> => {
  try {
    const records = recordsOf(await store.transcript(session), harness, session.subagent);
    // Asked only of a file that gave no turn: the reader is not read twice for a file that yielded.
    return outcomeOf({ size: session.size, records, headOnly: records === 0 && (await store.headOnly?.(session)) === true });
  } catch {
    return 'unreadable';
  }
};

/**
 * The counts for every harness the store reads that has files on this machine, and that the saved allowlist lets a deposit read. A harness with nothing
 * to read has no entry. Read-only: it opens each store as the deposit does, reads each transcript, and writes nothing.
 */
export const harnessFileCounts = async (runtime: SessionsRuntime): Promise<HarnessFiles> => {
  const allow = compileAllow((await readState(runtime.storeDir)).allow);
  const found: HarnessFiles = {};
  const claude = await claudeOutcomes(runtime, allow.allows);
  if (claude.length > 0) found['claude-code'] = tally(claude);
  const roots = sourceRoots(runtime);
  for (const source of sourcesOf(runtime)) {
    const root = roots.get(source.name);
    if (root === undefined || !allow.allows(source.name)) continue;
    const outcomes: FileOutcome[] = [];
    try {
      const store = await source.open(root);
      if (store === undefined) continue;
      try {
        // A session folded into another is no file of its own; an item the store could not inspect is one unreadable file.
        outcomes.push(...store.unreadable.map((): FileOutcome => 'unreadable'));
        // Files the reader dropped before they were sessions while they held records in a shape it does not know: seen, and unreadable.
        for (let dropped = 0; dropped < (store.shapeMoved ?? 0); dropped += 1) outcomes.push('unreadable');
        for (const session of store.sessions.filter((one) => one.supersededBy === undefined)) outcomes.push(await sessionOutcome(store, session, source.harness));
      } finally {
        store.close();
      }
    } catch {
      // A store that cannot be opened is one unreadable item, as the deposit reports it.
      outcomes.push('unreadable');
    }
    const counts = tally(outcomes);
    if (counts.seen > 0) found[source.harness] = counts;
  }
  return found;
};
