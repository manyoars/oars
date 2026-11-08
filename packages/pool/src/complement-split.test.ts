// Complementary withholding under the two floors. A shape cell carries no identity, so it is always `clear` and is served at the clear floor; its named cells can be long-tail and held to the public floor. Serving the shape total beside
// a served clear part, with a long-tail part under the public floor, would let a reader subtract what is served from the total and read the long-tail part: so the total is served only when a served part that clears the public floor (on the
// accounts that have stood) is withheld in its place, and is withheld itself when there is none.
import { describe, expect, it } from 'vitest';
import { NO_AXES, shapeClass, type Cell } from '../../cli/src/sessions/cells.js';
import { classMotif, namedId, shapeMotif, type Motif, type WindowStep } from '../../cli/src/sessions/motif.js';
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

describe('a shape total whose clear part is already withheld for its week, at a clear floor of 2', () => {
  const two = floorsOf({ CLEAR_FLOOR: '2' }, () => undefined);
  /** The week cell of a motif, held by `standing` accounts. */
  const weekOf = (motif: Motif, standing: number): { cell: Cell; any: number } => {
    const { cell, any } = cellOf(motif, standing, standing, WEEK);
    return { cell: { ...cell, grain: 'week' }, any };
  };

  it('is withheld, since a part held by fewer accounts than the long-tail part needs does not hide it', () => {
    // git: the week (4) clears 2, its first day (1) does not, so the smallest served day (3, the day of the shape) is withheld for the week; that part is under the public floor of 5.
    const held = [weekOf(CLEAR, 4), cellOf(CLEAR, 1, 1, '2026-11-03'), cellOf(CLEAR, 3, 3, '2026-11-04'), cellOf(SHAPE, 4, 4, '2026-11-04'), cellOf(TAIL, 1, 1, '2026-11-04')];
    expect(served(held, two)).toEqual(['clear']);
  });

  it('stays served when the part withheld for its week has the accounts the long-tail part needs', () => {
    const held = [weekOf(CLEAR, 9), cellOf(CLEAR, 1, 1, '2026-11-03'), cellOf(CLEAR, 5, 5, '2026-11-04'), cellOf(SHAPE, 6, 6, '2026-11-04'), cellOf(TAIL, 1, 1, '2026-11-04')];
    expect(served(held, two)).toEqual(['clear', 'shape']);
  });
});


describe("an action's calls beside a long-tail model's one-step shape cell, which no cell totals", () => {
  // The one-step shape cells of an action, per model, sum to the calls its `target` cells split (the `action-calls` family): a family with no whole cell, whose parts mix classes by model.
  const BUCKET = `claude-code/2.1.31x/${NO_AXES}`;
  const ACTION_SHAPE = shapeMotif([{ action: 'file.search', identity: null }]);
  const SOURCE = classMotif(shapeClass('file.search', 'target', 'source'));
  const LISTED = 'claude-code/2.1.31x/claude-sonnet-4-5';
  const PRIVATE = 'claude-code/2.1.31x/acme-private-finetune-v7';
  const OTHER = 'claude-code/2.1.31x/acme-other-finetune-v9';
  const WEEK_CELL = (motif: Motif, frameBucket: string, standing: number, any: number): { cell: Cell; any: number } => ({
    cell: { motifId: motif.motifId, frameBucket, grain: 'week', day: WEEK, sessions: any, clusters: standing, ok: any, failed: 0, tokens: 0, durationMs: 0, exposed: false },
    any,
  });
  const servedFrom = (held: { cell: Cell; any: number }[]): string[] => {
    const stored: StoredPool = { cells: held.map(({ cell }) => cell), every: new Map(held.map(({ cell, any }) => [cell, any])), environment: [], motifs: [ACTION_SHAPE, SOURCE], strata: [] };
    return bundleOf('claude-code', '2.1.314', stored, DEFAULT_FLOORS).cells.map((cell) => `${cell.motifId === SOURCE.motifId ? 'target' : 'shape'} ${cell.frameBucket.split('/')[2] ?? ''}`).sort();
  };

  it("does not serve the target total when the only part that could hide a sub-floor model's cell is a fresh account's own", () => {
    // A: a fresh account's call on a listed model (clear, counted over every account). B: one standing account's call on a private model (thresholded, under 5). The target cell counts both: 2 less A's 1 would be B alone.
    const held = [WEEK_CELL(ACTION_SHAPE, LISTED, 0, 1), WEEK_CELL(ACTION_SHAPE, PRIVATE, 1, 1), WEEK_CELL(SOURCE, BUCKET, 1, 2)];
    expect(servedFrom(held)).toEqual(['shape claude-sonnet-4-5']);
  });

  it('serves the target total, with the model cell that clears the public floor on standing accounts withheld in its place, when there is one', () => {
    const held = [WEEK_CELL(ACTION_SHAPE, LISTED, 0, 1), WEEK_CELL(ACTION_SHAPE, PRIVATE, 1, 1), WEEK_CELL(ACTION_SHAPE, OTHER, 6, 6), WEEK_CELL(SOURCE, BUCKET, 7, 8)];
    expect(servedFrom(held)).toEqual(['shape claude-sonnet-4-5', 'target -']);
  });
});
