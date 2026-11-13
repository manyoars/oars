// What `refreshPool` needs of the rows of every turn, folded one run of sessions at a time (t1243, spec 4 Build 2): each recall's consequence, the cells, and the two read families' inputs.
// A run is a set of sessions with their prompts, tools, and own errors; the reversion matching waits for the last run, so `reverted` is filled in `finish`.
import { cellsFold, projectedStore } from './cell-increments.js';
import type { CellSet } from './cells.js';
import { shellReader } from './projection.js';
import { readFold, type ReadFolds } from './read-folds.js';
import { deriveConsequences, NO_RECALLS, recallGraphOf, type RecallGraph } from './recall-consequence.js';
import type { Recall } from './recall-object.js';
import { finishReversions, foldReversions, newReversionIndex, type ReversionIndex } from './reversion.js';
import type { Store } from './store.js';
import { vocabulary } from './vocab-load.js';

/** What the pool step reads in place of the whole store's tools and prompts. */
export interface PoolFolds {
  /** The recalls in `recalls.jsonl` order, each of a held session with its consequence. */
  recalls: Recall[];
  cells: CellSet;
  reads: ReadFolds;
}

export interface PoolFold {
  /** One run of sessions: their main and subagent records, prompts, tools, and own errors. A session of another run is not in it. */
  add: (run: Store) => void;
  finish: () => PoolFolds;
  /** The matching's input as it stands, for a report of its size. */
  index: ReversionIndex;
}

export const poolFold = (recalls: readonly Recall[]): PoolFold => {
  const bySid = new Map<string, { at: number; recall: Recall }[]>();
  for (const [at, recall] of recalls.entries()) {
    if (recall.sid === null) continue;
    bySid.set(recall.sid, [...(bySid.get(recall.sid) ?? []), { at, recall }]);
  }
  const derived = [...recalls];
  const index = newReversionIndex();
  // The cells are tallied with the graph of the run being added.
  let graph: RecallGraph = NO_RECALLS;
  const cells = cellsFold({ place: (tool, steps) => graph.place(tool, steps), exposedPrompt: (session, at) => graph.exposedPrompt(session, at) });
  const reads = readFold();
  const read = shellReader(vocabulary());
  // The recalls whose outcome holds a reversion lookup, which the last run settles.
  const pending: { at: number; filled: Recall; session: string; prompt: number | null }[] = [];
  const add = (run: Store): void => {
    foldReversions(index, run);
    // In `recalls.jsonl` order, as the whole store's call keeps them.
    const mine = run.sessions.flatMap((session) => bySid.get(session.session) ?? []).sort((a, b) => a.at - b.at);
    const asked: { session: string; prompt: number | null }[] = [];
    const placeholder = (session: string, prompt: number | null): null => {
      asked.push({ session, prompt });
      return null;
    };
    const filled = deriveConsequences(run, mine.map(({ recall }) => recall), placeholder);
    const promptKeys = new Set(run.prompts.map((prompt) => `${prompt.session}#${String(prompt.index)}`));
    filled.forEach((recall, position) => {
      const entry = mine[position];
      const lookup = asked[position];
      if (entry === undefined || lookup === undefined) return;
      derived[entry.at] = recall;
      if (promptKeys.has(`${lookup.session}#${String(lookup.prompt)}`)) pending.push({ at: entry.at, filled: recall, ...lookup });
    });
    graph = recallGraphOf(run, filled);
    cells.add(projectedStore(run, read));
    reads.add(run);
  };
  const finish = (): PoolFolds => {
    const reverted = finishReversions(index);
    for (const { at, filled, session, prompt } of pending) {
      if (filled.consequence === undefined) continue;
      derived[at] = { ...filled, consequence: { ...filled.consequence, outcome: { ...filled.consequence.outcome, reverted: reverted(session, prompt) } } };
    }
    return { recalls: derived, cells: cells.finish(), reads: reads.finish() };
  };
  return { add, finish, index };
};

/** The folds of a store held whole: one run. */
export const poolFoldsOf = (recalls: readonly Recall[], store: Store): PoolFolds => {
  const fold = poolFold(recalls);
  fold.add(store);
  return fold.finish();
};
