// A served number sums only cells at or above `K_CELL`. A read's `n` and a share's denominator are counts, and a count that held a sub-floor cell would, set beside a second served
// count, show how large that cell is. Each test holds one served cell and one sub-floor cell and asks what the served number counts.
import { describe, expect, it } from 'vitest';
import type { Cell } from '../../cli/src/sessions/cells.js';
import { shapeMotif } from '../../cli/src/sessions/motif.js';
import type { Read } from '../../cli/src/sessions/read.js';
import type { Harness } from '../../cli/src/sessions/schema.js';
import { bundleOf, K_CELL } from './derive.js';
import type { StoredPool } from './stored.js';

const HARNESS: Harness = 'claude-code';
const VERSION = '2.1.314';
const BUCKET = 'claude-code/2.1.31x';
const DAY = '2026-11-02';

const READ = shapeMotif([{ action: 'file.read', identity: null }]);
const SHELL = shapeMotif([{ action: 'shell.exec', identity: null }]);
const SEARCH = shapeMotif([{ action: 'file.search', identity: null }]);

const cellOf = (motifId: string, clusters: number, ok: number, over: Partial<Cell> = {}): Cell => ({
  motifId,
  frameBucket: `${BUCKET}/opus`,
  grain: 'day',
  day: DAY,
  sessions: clusters,
  clusters,
  ok,
  failed: 0,
  tokens: 0,
  durationMs: 0,
  exposed: false,
  ...over,
});

const bundleOver = (cells: Cell[]): ReturnType<typeof bundleOf> => {
  const stored: StoredPool = { cells, environment: [], motifs: [READ, SHELL, SEARCH], strata: [] };
  return bundleOf(HARNESS, VERSION, stored);
};

const readsOf = (cells: Cell[], family: Read['family']): Read[] => bundleOver(cells).reads.filter((read) => read.family === family);

const slicedTo = (reads: Read[], motifId: string, grain: 'day' | 'week' = 'day'): Read => {
  const name = motifId === READ.motifId ? 'file.read' : motifId === SHELL.motifId ? 'shell.exec' : 'file.search';
  const found = reads.find((read) => read.slice.motif === name && (grain === 'week' || read.slice.day === DAY));
  if (found === undefined) throw new Error(`no read for ${name}`);
  return found;
};

describe('a served read counts only cells at the floor', () => {
  it('tool-day `steps` leaves out a sub-floor tool on the same day', () => {
    const served = slicedTo(readsOf([cellOf(READ.motifId, K_CELL, 10), cellOf(SHELL.motifId, K_CELL - 1, 7)], 'tool-day'), READ.motifId);
    expect(served.value.steps).toBe(10);
    expect(served.value.share).toBe(1);
  });

  it('a live read\'s `of` leaves out a sub-floor tool on the same day', () => {
    const served = slicedTo(readsOf([cellOf(READ.motifId, K_CELL, 10), cellOf(SHELL.motifId, K_CELL - 1, 7)], 'live'), READ.motifId);
    expect(served.value.of).toBe(10);
    expect(served.value.share).toBe(1);
    expect(served.n).toBe(10);
  });

  it('a live read\'s baseline sums only served days', () => {
    const before = '2026-11-01';
    const cells = [cellOf(READ.motifId, K_CELL, 10), cellOf(READ.motifId, K_CELL, 4, { day: before }), cellOf(SHELL.motifId, K_CELL - 1, 6, { day: before })];
    const served = slicedTo(readsOf(cells, 'live'), READ.motifId);
    // The day before holds 4 served steps and 6 sub-floor ones: the baseline is 4 of 4, not 4 of 10.
    expect(served.value.baseline).toBe(1);
  });

  it('fit sums the weeks of one frame at the floor, not a sub-floor week beside them', () => {
    const week = (clusters: number, ok: number, day: string): Cell => cellOf(READ.motifId, clusters, ok, { grain: 'week', day });
    const served = slicedTo(readsOf([week(K_CELL, 10, '2026-10-26'), week(K_CELL - 1, 4, '2026-11-02')], 'fit'), READ.motifId, 'week');
    expect(served.n).toBe(10);
    expect(served.value.ok).toBe(10);
  });

  it('tool-day sums a tool across models at the floor, not a sub-floor model beside them', () => {
    const served = slicedTo(readsOf([cellOf(READ.motifId, K_CELL, 10), cellOf(READ.motifId, K_CELL - 1, 3, { frameBucket: `${BUCKET}/sonnet` })], 'tool-day'), READ.motifId);
    expect(served.n).toBe(10);
    expect(served.value.steps).toBe(10);
  });
});

describe('two served numbers over one day', () => {
  const served = (sub: number, ok: number): { steps: number; reads: number[]; shape: unknown } => {
    const bundle = bundleOver([cellOf(READ.motifId, K_CELL, 10), cellOf(SHELL.motifId, K_CELL, 6), cellOf(SEARCH.motifId, sub, ok)]);
    const days = bundle.reads.filter((read) => read.family === 'tool-day');
    const [first] = days;
    const steps = Number(first?.value.steps);
    // What is served, without the ids and the pool's version, which name the cells held and so move with the sub-floor cell itself.
    return { steps, reads: days.map((read) => read.n), shape: bundle.reads.map((read) => [read.family, read.slice, read.value, read.n, read.inputs.length]) };
  };

  it('shows nothing of a sub-floor cell in `steps` less `n`', () => {
    const small = served(K_CELL - 1, 2);
    const large = served(K_CELL - 2, 9);
    // The served tools are the only ones `steps` counts, so `steps` less one tool's `n` is the other served tool's `n`, whatever the hidden cell holds.
    expect(small.steps).toBe(16);
    expect(small.steps - 10).toBe(6);
    expect(small.reads.slice().sort()).toEqual([10, 6].sort());
    // And no served number moves with the hidden cell: the same bundle, with the cell larger, serves the same reads.
    expect(large.shape).toEqual(small.shape);
  });
});
