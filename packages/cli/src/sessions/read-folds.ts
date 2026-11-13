// What the two families that read the rows of every turn keep of them (t1243): the fit shapes `deriveCallShape` cites, and the days of the prompts a recovery read's errors name. A refresh folds
// them one run of sessions at a time, so neither family holds the tools or prompts of the whole history; a store held whole folds the same way as one run.
import { UNKNOWN } from './cells.js';
import { utcDay } from './frame.js';
import { actionFold, aboveActionRate, fitFold, PUSH_FLOORS, type RecallRead } from './recall-reads.js';
import type { PromptObservation } from './schema.js';
import type { Store } from './store.js';

export interface ReadFolds {
  /** `fitReads` over the whole store. */
  fit: RecallRead[];
  /** The hook index's fit reads: `fitReads` at the push floors, kept above the base rate of their action. */
  push: RecallRead[];
  /** The frame day of each prompt an error of a main session names, by `session#index`. */
  promptDays: ReadonlyMap<string, string>;
}

/** The day a prompt's frame was written under: its frame's, else the day of its stamp. */
export const promptDayOf = (prompt: PromptObservation): string => prompt.frame?.day ?? utcDay(prompt.ts) ?? UNKNOWN;

export interface ReadFold {
  /** One run of sessions; its errors name prompts of its own sessions only. */
  add: (run: Store) => void;
  finish: () => ReadFolds;
}

export const readFold = (): ReadFold => {
  const fit = fitFold();
  const pushFit = fitFold(PUSH_FLOORS);
  const actions = actionFold();
  const promptDays = new Map<string, string>();
  return {
    add: (run) => {
      fit.add(run);
      pushFit.add(run);
      actions.add(run);
      const prompts = new Map(run.prompts.map((prompt) => [`${prompt.session}#${String(prompt.index)}`, prompt]));
      for (const error of run.errors) {
        // A subagent's error is filed under its own session's frame, never a prompt's.
        if (error.agent !== undefined) continue;
        const key = `${error.session}#${String(error.prompt)}`;
        const prompt = prompts.get(key);
        if (prompt !== undefined) promptDays.set(key, promptDayOf(prompt));
      }
    },
    finish: () => ({ fit: fit.finish(), push: aboveActionRate(actions.finish(), pushFit.finish()), promptDays }),
  };
};

/** The folds of a store held whole: one run. */
export const readFoldsOf = (store: Store): ReadFolds => {
  const fold = readFold();
  fold.add(store);
  return fold.finish();
};
