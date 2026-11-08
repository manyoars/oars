// Which count a floor uses. A floor of 1 has no k to protect, so a `clear` cell is counted over every account that holds it, standing or not (`derive.ts`). A family on a floor above the public floor lifts the clear floor by the same gap
// (`cellFloor`: `tool-day=8` gives a clear floor of 4), and above 1 the cell counts only the accounts that have stood, as a thresholded cell does.
import { describe, expect, it } from 'vitest';
import type { Cell } from '../../cli/src/sessions/cells.js';
import { namedId, shapeMotif, type Motif, type WindowStep } from '../../cli/src/sessions/motif.js';
import { cellIdOf } from '../../cli/src/sessions/cells.js';
import { bundleOf } from './derive.js';
import { floorsOf } from './floors.js';
import type { StoredPool } from './stored.js';

const SHAPE = shapeMotif([{ action: 'shell.exec', identity: null }]);
const GIT_STEPS: WindowStep[] = [{ action: 'shell.exec', identity: { program: 'git', sub: 'status', flags: [] } }];
const GIT: Motif = { motifId: namedId(GIT_STEPS), level: 'named', steps: GIT_STEPS, cls: null };

const dayCell = (motif: Motif, standing: number, any: number): Cell => ({ motifId: motif.motifId, frameBucket: 'claude-code/2.1.31x/claude-sonnet-4-5', grain: 'day', day: '2026-11-02', sessions: any, clusters: standing, ok: any, failed: 0, tokens: 0, durationMs: 0, exposed: false });

const toolDayReads = (standing: number, any: number, families: string): number => {
  const cells = [dayCell(SHAPE, standing, any), dayCell(GIT, standing, any)];
  const stored: StoredPool = { cells, every: new Map(cells.map((cell) => [cell, any])), environment: [], motifs: [SHAPE, GIT], strata: [] };
  const bundle = bundleOf('claude-code', '2.1.314', stored, floorsOf({ PUBLIC_FLOOR_FAMILIES: families }, () => undefined));
  return bundle.reads.filter((read) => read.family === 'tool-day').length;
};

describe('a clear cell on a family floor above the public floor', () => {
  it('is not served to the family on four fresh accounts, whose clear floor is 4', () => {
    expect(toolDayReads(0, 4, 'tool-day=8')).toBe(0);
  });

  it('is served to the family on four accounts that have stood', () => {
    expect(toolDayReads(4, 4, 'tool-day=8')).toBeGreaterThan(0);
  });
});

// A read cites a cell by an id that hashes its `clusters`, and the bundle ships one row of a cell: the public pool's copy when it serves the cell, else the family's. Every family's reads are derived over that row, so no input is missing from `cells`.
const bundleWith = (standing: number, any: number, env: Record<string, string>) => {
  const cells = [dayCell(SHAPE, standing, any), dayCell(GIT, standing, any)];
  const stored: StoredPool = { cells, every: new Map(cells.map((cell) => [cell, any])), environment: [], motifs: [SHAPE, GIT], strata: [] };
  return bundleOf('claude-code', '2.1.314', stored, floorsOf(env, () => undefined));
};

const missingInputs = (bundle: ReturnType<typeof bundleWith>, family: string): { reads: number; missing: number } => {
  const held = new Set(bundle.cells.map(cellIdOf));
  const reads = bundle.reads.filter((read) => read.family === family);
  return { reads: reads.length, missing: reads.flatMap((read) => read.inputs).filter((input) => !held.has(input)).length };
};

describe('every read cites a cell the bundle holds when the two pools count a cell differently', () => {
  it('on a family floor above the public floor, four standing of six accounts', () => {
    const bundle = bundleWith(4, 6, { PUBLIC_FLOOR_FAMILIES: 'tool-day=8' });
    const { reads, missing } = missingInputs(bundle, 'tool-day');
    expect(reads).toBeGreaterThan(0);
    expect(missing).toBe(0);
    expect(bundle.reads.flatMap((read) => read.inputs).every((input) => new Set(bundle.cells.map(cellIdOf)).has(input))).toBe(true);
  });

  it('on a family floor below the public floor, five standing of seven accounts at CLEAR_FLOOR=3', () => {
    const bundle = bundleWith(5, 7, { CLEAR_FLOOR: '3', PUBLIC_FLOOR_FAMILIES: 'live=3' });
    const { reads, missing } = missingInputs(bundle, 'live');
    expect(reads).toBeGreaterThan(0);
    expect(missing).toBe(0);
    expect(bundle.reads.flatMap((read) => read.inputs).every((input) => new Set(bundle.cells.map(cellIdOf)).has(input))).toBe(true);
  });
});
