// Recovery (t752, rank 1; spec Section 7): each signature record, as a read. A signature's text is class A, so the read holds its hash (the same value on any account,
// computed by the asker's client) and public names only; `recall()` is still how an operator reads the text. Confounders: `editFollowed` is not success, and refusals and
// hook denials are local policy. Its evidence is the cells holding the failed call and the step after it, on the days the signature occurred.
import { ACTION_TABLES, actionOf, type CanonicalAction } from './actions.js';
import { type Cell } from './cells.js';
import { utcDay } from './frame.js';
import { shapeMotif } from './motif.js';
import { contentHash } from './read.js';
import { body, groupBy, type DeriveFamily } from './read-support.js';
import { harnessOf, type ErrorObservation, type Harness } from './schema.js';
import { signatureRecord } from './store.js';

const shapeOf = (actions: readonly CanonicalAction[]): string => shapeMotif(actions.map((action) => ({ action, identity: null }))).motifId;

export const deriveRecovery: DeriveFamily = ({ pool, store }) => {
  const harnesses = new Map<string, Harness>([...store.sessions, ...store.subagents].map((session) => [session.session, harnessOf(session)]));
  const actionIn = (session: string, tool: string): CanonicalAction => actionOf(ACTION_TABLES[harnesses.get(session) ?? 'claude-code'], tool).action;
  const cellsAt = groupBy(pool.cells, (cell) => `${cell.motifId}/${cell.day}`);
  return [...groupBy(store.errors, (error) => error.sig)].flatMap(([sig, list]) => {
    const inputs = new Set<Cell>();
    const following: { [action: string]: number } = {};
    let failedAction: CanonicalAction = 'other';
    const session = (error: ErrorObservation): string => error.agent ?? error.session;
    for (const error of list) {
      failedAction = actionIn(session(error), error.tool);
      const day = utcDay(error.ts);
      const next = error.next[0] === undefined ? undefined : actionIn(session(error), error.next[0]);
      for (const cell of cellsAt.get(`${shapeOf([failedAction])}/${String(day)}`) ?? []) if (cell.failed > 0) inputs.add(cell);
      if (next !== undefined) for (const cell of cellsAt.get(`${shapeOf([failedAction, next])}/${String(day)}`) ?? []) inputs.add(cell);
      for (const tool of error.next) {
        const action = actionIn(session(error), tool);
        following[action] = (following[action] ?? 0) + 1;
      }
    }
    // A signature whose failed call is in no cell, such as one a version-2 deposit left with no tool record, has nothing to cite, so it is not a read.
    if (inputs.size === 0) return [];
    const record = signatureRecord(sig, list);
    return [
      body('recovery', 'signature-record', '1', [...inputs], {
        slice: { sig: contentHash(sig), action: failedAction },
        value: { sessions: record.sessions, errors: record.count, firstSeen: utcDay(record.firstSeen), lastSeen: utcDay(record.lastSeen), following, editFollowed: record.editFollowed },
        n: record.count,
        interval: null,
      }),
    ];
  });
};
