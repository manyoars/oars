// Complementary withholding under the two floors. A shape cell carries no identity, so it is always `clear` and is served at the clear floor; its named cells can be long-tail and held to the public floor. Serving the shape total beside
// a served clear part, with a long-tail part under the public floor, would let a reader subtract what is served from the total and read the long-tail part: so the total is served only when a served part that clears the public floor (on the
// accounts that have stood) is withheld in its place, and is withheld itself when there is none.
import { describe, expect, it } from 'vitest';
import type { Cell } from '../../cli/src/sessions/cells.js';
import { namedId, shapeMotif, type Motif, type WindowStep } from '../../cli/src/sessions/motif.js';
import { bundleOf } from './derive.js';
import { DEFAULT_FLOORS, floorsOf } from './floors.js';
import type { StoredPool } from './stored.js';

const FRAME = 'claude-code/2.1.31x/claude-sonnet-4-5';
const WEEK = '2026-11-02';
const SHAPE_STEPS: WindowStep[] = [{ action: 'shell.exec', identity: null }];
const SHAPE = shapeMotif(SHAPE_STEPS);
const named = (program: string): Motif => {
  const steps: WindowStep[] = [{ action: 'shell.exec', identity: { program, sub: null, flags: [] } }];
  return { motifId: namedId(steps), level: 'named', steps, cls: null };
};
const CLEAR = named('git');
const TAIL = named('acme-deploy');
const NPM = named('npm');
const LABELS = new Map([[SHAPE.motifId, 'shape'], [CLEAR.motifId, 'clear'], [TAIL.motifId, 'tail'], [NPM.motifId, 'npm']]);

/** A day cell held by `standing` accounts that have stood and `any` accounts in all. */
const cellOf = (motif: Motif, standing: number, any: number, day = WEEK): { cell: Cell; any: number } => ({
  cell: { motifId: motif.motifId, frameBucket: FRAME, grain: 'day', day, sessions: any, clusters: standing, ok: any, failed: 0, tokens: 0, durationMs: 0, exposed: false },
  any,
});

const served = (held: { cell: Cell; any: number }[], floors = DEFAULT_FLOORS): string[] => {
  const stored: StoredPool = { cells: held.map(({ cell }) => cell), every: new Map(held.map(({ cell, any }) => [cell, any])), environment: [], motifs: [SHAPE, CLEAR, TAIL, NPM], strata: [] };
  return bundleOf('claude-code', '2.1.314', stored, floors).cells.map((cell) => LABELS.get(cell.motifId) ?? 'unknown').sort();
};

describe('a shape total beside a long-tail part under the public floor', () => {
  it('is not served when the long-tail part is the only named cell under the shape', () => {
    expect(served([cellOf(SHAPE, 1, 1), cellOf(TAIL, 1, 1)])).toEqual([]);
  });

  it('is not served beside a clear part held only by accounts that have not stood, so the total less what is served is not the long-tail part', () => {
    expect(served([cellOf(SHAPE, 0, 2), cellOf(CLEAR, 0, 1), cellOf(TAIL, 0, 1)])).toEqual(['clear']);
  });

  it('is served, with a clear part that clears the public floor withheld, when one does', () => {
    expect(served([cellOf(SHAPE, 6, 6), cellOf(CLEAR, 5, 5), cellOf(TAIL, 1, 1)])).toEqual(['shape']);
  });

  it('is served with its clear parts when no long-tail part is under the floor', () => {
    expect(served([cellOf(SHAPE, 0, 2), cellOf(CLEAR, 0, 1), cellOf(NPM, 0, 1)])).toEqual(['clear', 'npm', 'shape']);
  });

  it('is served at a clear floor of 5, where nothing sits under the floor of its own class', () => {
    const five = floorsOf({ CLEAR_FLOOR: '5' }, () => undefined);
    expect(served([cellOf(SHAPE, 6, 6), cellOf(CLEAR, 5, 5), cellOf(TAIL, 5, 5)], five)).toEqual(['clear', 'shape', 'tail']);
  });
});
