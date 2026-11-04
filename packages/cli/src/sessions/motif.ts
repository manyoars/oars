// The motif (recall spec Section 2.4): a window of steps, hashed without its frame or its account. One motif ID read across frames is how the record
// compares models, harnesses, versions, and dates, and the hash takes no salt, so the same shape from two accounts joins.

import { ACTION_TABLES, actionOf, type CanonicalAction } from './actions.js';
import { contentHash } from './read.js';
import type { Harness, PullIdentity, StepIdentity, ToolObservation, ToolStatus } from './schema.js';

/**
 * Window lengths (spec Section 8, an open parameter). The spec's 2 to 4, plus 1: a rate of one action (fit, adoption, live) needs a count of that action, and a
 * prompt of one call has no longer window, so it would otherwise leave every such denominator.
 */
export const MOTIF_LENGTHS = [1, 2, 3, 4] as const;

/** `shape` is actions only and `named` is actions and identities. `class` is a prompt's class, which carries no steps: cost is read per class. */
export type MotifLevel = 'shape' | 'named' | 'class';

/** What a motif's hash reads of a step: never a position, a frame, a salted hash, or a status. */
export interface WindowStep {
  action: CanonicalAction;
  identity: StepIdentity;
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

const memo = new Map<string, Motif>();

/** One object per motif: a store repeats a shape hundreds of thousands of times, and each would otherwise hash again. */
const motifOf = (level: MotifLevel, steps: readonly WindowStep[], cls: string | null): Motif => {
  // Only what the hash reads: a caller's window also holds the counts of whichever occurrence came first, which would pin them here and make the file depend on record order.
  const held = steps.map((step): WindowStep => ({ action: step.action, identity: level === 'named' ? step.identity : null }));
  const key = JSON.stringify([level, cls, held.map((step) => [step.action, step.identity])]);
  const found = memo.get(key);
  if (found !== undefined) return found;
  const motif: Motif = { motifId: contentHash({ level, cls, steps: held.map((step) => [step.action, step.identity]) }), level, steps: held, cls };
  memo.set(key, motif);
  return motif;
};

export const shapeId = (steps: readonly WindowStep[]): string => motifOf('shape', steps, null).motifId;
export const namedId = (steps: readonly WindowStep[]): string => motifOf('named', steps, null).motifId;
export const classMotif = (cls: string): Motif => motifOf('class', [], cls);
export const shapeMotif = (steps: readonly WindowStep[]): Motif => motifOf('shape', steps, null);

/** The steps of one call. A record captured before steps existed reads through the same action table capture uses, so old data joins new. */
export const stepsOfCall = (tool: ToolObservation, harness: Harness): CountedStep[] => {
  if (tool.steps === undefined) return [{ action: actionOf(ACTION_TABLES[harness], tool.tool).action, identity: null, status: tool.status, tokens: 0, durationMs: tool.durationMs ?? 0 }];
  return tool.steps.map((step) => ({ action: step.action, identity: step.identity, status: step.status, tokens: step.cost.tokens ?? 0, durationMs: step.cost.durationMs ?? 0 }));
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

const nameOfField = (value: unknown): string => {
  if (!Array.isArray(value)) return String(value);
  return value.map((item: string | PullIdentity) => (typeof item === 'string' ? item : `${item.registry}:${item.name}${item.version === null ? '' : `@${item.version}`}`)).join(',');
};

const nameOfStep = (step: WindowStep): string => {
  if (step.identity === null) return step.action;
  const fields = Object.entries(step.identity)
    .filter(([, value]: [string, unknown]) => value !== null && !(Array.isArray(value) && value.length === 0))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([field, value]: [string, unknown]) => `${field}=${nameOfField(value)}`);
  return `${step.action}[${fields.join(' ')}]`;
};

/** A motif in public vocabulary, for a slice and a row. */
export const motifName = (motif: Motif): string => motif.cls ?? motif.steps.map(nameOfStep).join('>');
