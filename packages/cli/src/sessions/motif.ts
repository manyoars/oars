// The motif (t756, recall spec Section 2.4): a window of steps, hashed without its frame or its account. One motif ID read across frames is how the record
// compares models, harnesses, versions, and dates, and the hash takes no salt, so the same shape from two accounts joins.

import { ACTION_TABLES, actionOf, type CanonicalAction } from './actions.js';
import { contentHash } from './read.js';
import type { Harness, StepObservation, ToolObservation, ToolStatus } from './schema.js';

/**
 * Window lengths (spec Section 8, an open parameter). The spec's 2 to 4, plus 1: a rate of one action (fit, adoption, live) needs a count of that action, and a
 * prompt of one call has no longer window, so it would otherwise leave every such denominator.
 */
export const MOTIF_LENGTHS = [1, 2, 3, 4] as const;

/** `shape` is actions only and `named` is actions and identities. `class` is a prompt's class, which carries no steps: cost is read per class. */
export type MotifLevel = 'shape' | 'named' | 'class';

/** A step's public names (spec Section 2.2), whichever fields its action has. */
export interface StepIdentity {
  [field: string]: string | readonly string[] | null;
}

/** What a motif's hash reads of a step: never a position, a frame, a salted hash, or a status. */
export interface WindowStep {
  action: CanonicalAction;
  identity: StepIdentity | null;
}

/** A step as a cell counts it. */
export interface CountedStep extends WindowStep {
  status: ToolStatus;
  tokens: number;
  durationMs: number;
}

export interface Motif {
  motifId: string;
  level: MotifLevel;
  /** The window; empty on a `class` motif. A `shape` motif holds actions only. */
  steps: WindowStep[];
  /** The prompt class of a `class` motif; null on a window. */
  cls: string | null;
}

/** The fields capture writes on a step as it reaches them (spec Section 2.2); a record captured earlier has none of them. */
type CapturedStep = StepObservation & { identity?: StepIdentity | null; status?: ToolStatus; cost?: { tokens: number; durationMs: number | null } };

const memo = new Map<string, Motif>();

/** One object per motif: a store repeats a shape hundreds of thousands of times, and each would otherwise hash again. */
const motifOf = (level: MotifLevel, steps: readonly WindowStep[], cls: string | null): Motif => {
  const held = level === 'named' ? steps : steps.map((step) => ({ action: step.action, identity: null }));
  const key = JSON.stringify([level, cls, held.map((step) => [step.action, step.identity])]);
  const found = memo.get(key);
  if (found !== undefined) return found;
  const motif: Motif = { motifId: contentHash({ level, cls, steps: held.map((step) => [step.action, step.identity]) }), level, steps: [...held], cls };
  memo.set(key, motif);
  return motif;
};

export const shapeId = (steps: readonly WindowStep[]): string => motifOf('shape', steps, null).motifId;
export const namedId = (steps: readonly WindowStep[]): string => motifOf('named', steps, null).motifId;
export const classMotif = (cls: string): Motif => motifOf('class', [], cls);
export const shapeMotif = (steps: readonly WindowStep[]): Motif => motifOf('shape', steps, null);

/** The steps of one call. A record captured before steps existed reads through the same action table capture uses, so old data joins new. */
export const stepsOfCall = (tool: ToolObservation, harness: Harness): CountedStep[] => {
  const captured: readonly CapturedStep[] = tool.steps ?? [{ n: tool.n, seg: 0, frameId: '', ...actionOf(ACTION_TABLES[harness], tool.tool) }];
  return captured.map((step, position) => ({
    action: step.action,
    identity: step.identity ?? null,
    status: step.status ?? tool.status,
    tokens: step.cost?.tokens ?? 0,
    // A call has one duration however many segments it ran; a step that states its own wins.
    durationMs: step.cost?.durationMs ?? (position === 0 ? (tool.durationMs ?? 0) : 0),
  }));
};

export interface MotifWindow {
  motif: Motif;
  /** The position of the window's first step in the line. */
  start: number;
}

/** Every window of a line of work, at both levels, shortest first at each position. */
export const motifsOf = (line: readonly WindowStep[]): MotifWindow[] => {
  const windows: MotifWindow[] = [];
  for (const length of MOTIF_LENGTHS) {
    for (let start = 0; start + length <= line.length; start += 1) {
      const steps = line.slice(start, start + length);
      windows.push({ motif: motifOf('shape', steps, null), start }, { motif: motifOf('named', steps, null), start });
    }
  }
  return windows;
};

const nameOfStep = (step: WindowStep): string => {
  if (step.identity === null) return step.action;
  const fields = Object.entries(step.identity)
    .filter(([, value]) => value !== null)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([field, value]) => `${field}=${String(value)}`);
  return `${step.action}[${fields.join(' ')}]`;
};

/** A motif in public vocabulary, for a slice and a row. */
export const motifName = (motif: Motif): string => motif.cls ?? motif.steps.map(nameOfStep).join('>');
