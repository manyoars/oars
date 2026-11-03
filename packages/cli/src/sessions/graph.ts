// The edges of the steps of one transcript (t755, recall spec Section 2.3). Every edge is held on the step it points to, naming the step it came
// from, so one transcript's capture writes all of its own edges and no earlier record is rewritten, including a subagent's first step, whose
// edge comes from a call in another transcript.

import type { StepObservation, ToolStatus } from './schema.js';

/** One call's steps, with what the graph reads and does not keep. */
export interface LinkedCall {
  steps: StepObservation[];
  /** One per step. Masked identities can match by accident, so a retry compares these; they are never stored. */
  rawKeys: readonly string[];
  /** The line of work: the prompt, and whether the call ran on a sidechain. */
  line: string;
  status: ToolStatus;
}

interface Line {
  last: StepObservation | undefined;
  lastFailed: boolean;
  /** The last failed step of each raw key with no clean run since. */
  failed: Map<string, StepObservation>;
}

/** Writes `next`, `after-error`, and `retried` on every step, and `spawned` on the transcript's first when `spawnedAt` knows the call that started it. */
export const linkSteps = (calls: readonly LinkedCall[], spawnedAt: number | null): void => {
  const lines = new Map<string, Line>();
  for (const { steps, rawKeys, line, status } of calls) {
    const held = lines.get(line) ?? { last: undefined, lastFailed: false, failed: new Map<string, StepObservation>() };
    lines.set(line, held);
    for (const [seg, step] of steps.entries()) {
      const before = seg === 0 ? held.last : steps[seg - 1];
      if (before !== undefined) step.edges.push({ kind: 'next', n: before.n, seg: before.seg });
      if (seg === 0 && before !== undefined && held.lastFailed) step.edges.push({ kind: 'after-error', n: before.n, seg: before.seg });
      const failure = held.failed.get(rawKeys[seg] ?? '');
      if (failure !== undefined) step.edges.push({ kind: 'retried', n: failure.n, seg: failure.seg });
    }
    // After the whole call: a command repeated inside one call is not a retry of itself.
    for (const [seg, step] of steps.entries()) {
      const key = rawKeys[seg] ?? '';
      if (step.status === 'error') held.failed.set(key, step);
      else if (step.status === 'ok') held.failed.delete(key);
    }
    held.last = steps.at(-1);
    held.lastFailed = status === 'error';
  }
  const first = calls[0]?.steps[0];
  if (first !== undefined && spawnedAt !== null) first.edges.unshift({ kind: 'spawned', n: spawnedAt, seg: 0 });
};
