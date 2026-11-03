// Recovery (t752, rank 1; spec Section 7): each signature record, as a read. A signature's text is class A, so the read holds its hash (the same value on any account,
// computed by the asker's client) and public names only; `recall()` is still how an operator reads the text. Confounders: `editFollowed` is not success, and refusals and
// hook denials are local policy. Its evidence is the cells holding the failed call and the step after it, on the days the signature occurred and the days their frames were written.
import { ACTION_TABLES, actionOf, type CanonicalAction } from './actions.js';
import { UNKNOWN, type Cell } from './cells.js';
import { utcDay } from './frame.js';
import { shapeMotif } from './motif.js';
import { contentHash } from './read.js';
import { body, groupBy, type DeriveFamily, type FamilyInput, type ReadBody } from './read-support.js';
import { harnessOf, type ErrorObservation } from './schema.js';
import { signatureRecord } from './store.js';

const shapeOf = (actions: readonly CanonicalAction[]): string => shapeMotif(actions.map((action) => ({ action, identity: null }))).motifId;

const isEarlier = (a: string | null, b: string | null): boolean => a !== null && (b === null || a < b);

/**
 * One row per session and tool-use id (t752, t762). The tool fold leaves every error line in place, so a store not yet captured again keeps a replayed result's line beside the
 * first, and fit's folded `failed` would disagree with these counts. The earliest copy stands for the call, whatever order they came in; a row with no id is its own call.
 */
const oneRowPerCall = (errors: readonly ErrorObservation[]): ErrorObservation[] => {
  const calls = new Map<string, ErrorObservation>();
  const rows: ErrorObservation[] = [];
  for (const error of errors) {
    if (error.toolUseId === undefined || error.toolUseId === null) {
      rows.push(error);
      continue;
    }
    const key = `${error.agent ?? error.session}\n${error.toolUseId}`;
    const held = calls.get(key);
    if (held === undefined || isEarlier(error.ts, held.ts)) calls.set(key, error);
  }
  return [...rows, ...calls.values()];
};

/** Why a signature record has no read. Each is a record with nothing to cite, and a read that cites nothing is refused. */
export type RecoveryDrop =
  /** No call of this action in any cell, such as one a version-2 deposit left with no tool record. */
  | 'no-cell-of-action'
  /** Calls of this action in cells, none of them failed: the error line's call did not settle as an error. */
  | 'no-failed-cell-of-action'
  /** Failed calls of this action in cells, none on a day this signature occurred. */
  | 'no-failed-cell-on-day';

export interface RecoveryOutcome {
  reads: ReadBody[];
  /** Every signature record is a read or is counted here, so none leaves without a reason. */
  dropped: { [reason in RecoveryDrop]: number };
}

export const recoveryOf = ({ pool, store }: FamilyInput): RecoveryOutcome => {
  const sessions = new Map([...store.sessions, ...store.subagents].map((session) => [session.session, session]));
  const prompts = new Map(store.prompts.map((prompt) => [`${prompt.session}#${String(prompt.index)}`, prompt]));
  const actionIn = (session: string, tool: string): CanonicalAction => actionOf(ACTION_TABLES[harnessOf(sessions.get(session) ?? {})], tool).action;
  const cellsAt = groupBy(pool.cells, (cell) => `${cell.motifId}/${cell.day}`);
  const cellsOf = groupBy(pool.cells, (cell) => cell.motifId);
  /** The day a cell files this error's call under: its frame's, which is its prompt's, or its session's for a subagent or a call before the first prompt. An error can run past that midnight. */
  const frameDayOf = (error: ErrorObservation): string => {
    const prompt = error.agent === undefined ? prompts.get(`${error.session}#${String(error.prompt)}`) : undefined;
    if (prompt !== undefined) return prompt.frame?.day ?? utcDay(prompt.ts) ?? UNKNOWN;
    const session = sessions.get(error.agent ?? error.session);
    return session?.frame?.day ?? utcDay(session?.tsFirst) ?? UNKNOWN;
  };
  const dropped: RecoveryOutcome['dropped'] = { 'no-cell-of-action': 0, 'no-failed-cell-of-action': 0, 'no-failed-cell-on-day': 0 };
  const reads = [...groupBy(oneRowPerCall(store.errors), (error) => error.sig)].flatMap(([sig, list]) => {
    const inputs = new Set<Cell>();
    const following: { [action: string]: number } = {};
    let failedAction: CanonicalAction = 'other';
    const session = (error: ErrorObservation): string => error.agent ?? error.session;
    for (const error of list) {
      failedAction = actionIn(session(error), error.tool);
      const next = error.next[0] === undefined ? undefined : actionIn(session(error), error.next[0]);
      for (const day of new Set([utcDay(error.ts) ?? UNKNOWN, frameDayOf(error)])) {
        for (const cell of cellsAt.get(`${shapeOf([failedAction])}/${day}`) ?? []) if (cell.failed > 0) inputs.add(cell);
        if (next !== undefined) for (const cell of cellsAt.get(`${shapeOf([failedAction, next])}/${day}`) ?? []) inputs.add(cell);
      }
      for (const tool of error.next) {
        const action = actionIn(session(error), tool);
        following[action] = (following[action] ?? 0) + 1;
      }
    }
    if (inputs.size === 0) {
      const ofAction = cellsOf.get(shapeOf([failedAction])) ?? [];
      const reason: RecoveryDrop = ofAction.length === 0 ? 'no-cell-of-action' : ofAction.some((cell) => cell.failed > 0) ? 'no-failed-cell-on-day' : 'no-failed-cell-of-action';
      dropped[reason] += 1;
      return [];
    }
    const record = signatureRecord(sig, list);
    return [
      body('recovery', [...inputs], {
        slice: { sig: contentHash(sig), action: failedAction },
        value: { sessions: record.sessions, errors: record.count, firstSeen: utcDay(record.firstSeen), lastSeen: utcDay(record.lastSeen), following, editFollowed: record.editFollowed },
        n: record.count,
        interval: null,
      }),
    ];
  });
  return { reads, dropped };
};

export const deriveRecovery: DeriveFamily = (input) => recoveryOf(input).reads;
