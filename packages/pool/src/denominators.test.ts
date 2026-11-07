// A served number sums only cells at or above `DEFAULT_PUBLIC_FLOOR`. A read's `n` and a share's denominator are counts, and a count that held a sub-floor cell would, set beside a second served
// count, show how large that cell is. Each test holds one served cell and one sub-floor cell and asks what the served number counts.
import { describe, expect, it } from 'vitest';
import type { Cell } from '../../cli/src/sessions/cells.js';
import { namedId, shapeMotif, type Motif, type WindowStep } from '../../cli/src/sessions/motif.js';
import type { Read } from '../../cli/src/sessions/read.js';
import type { Harness } from '../../cli/src/sessions/schema.js';
import { bundleOf } from './derive.js';
import { DEFAULT_FLOORS, DEFAULT_PUBLIC_FLOOR } from './floors.js';
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
  return bundleOf(HARNESS, VERSION, stored, DEFAULT_FLOORS);
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
    const served = slicedTo(readsOf([cellOf(READ.motifId, DEFAULT_PUBLIC_FLOOR, 10), cellOf(SHELL.motifId, DEFAULT_PUBLIC_FLOOR - 1, 7)], 'tool-day'), READ.motifId);
    expect(served.value.steps).toBe(10);
    expect(served.value.share).toBe(1);
  });

  it('a live read\'s `of` leaves out a sub-floor tool on the same day', () => {
    const served = slicedTo(readsOf([cellOf(READ.motifId, DEFAULT_PUBLIC_FLOOR, 10), cellOf(SHELL.motifId, DEFAULT_PUBLIC_FLOOR - 1, 7)], 'live'), READ.motifId);
    expect(served.value.of).toBe(10);
    expect(served.value.share).toBe(1);
    expect(served.n).toBe(10);
  });

  it('a live read\'s baseline sums only served days', () => {
    const before = '2026-11-01';
    const cells = [cellOf(READ.motifId, DEFAULT_PUBLIC_FLOOR, 10), cellOf(READ.motifId, DEFAULT_PUBLIC_FLOOR, 4, { day: before }), cellOf(SHELL.motifId, DEFAULT_PUBLIC_FLOOR - 1, 6, { day: before })];
    const served = slicedTo(readsOf(cells, 'live'), READ.motifId);
    // The day before holds 4 served steps and 6 sub-floor ones: the baseline is 4 of 4, not 4 of 10.
    expect(served.value.baseline).toBe(1);
  });

  it('fit sums the weeks of one frame at the floor, not a sub-floor week beside them', () => {
    const week = (clusters: number, ok: number, day: string): Cell => cellOf(READ.motifId, clusters, ok, { grain: 'week', day });
    const served = slicedTo(readsOf([week(DEFAULT_PUBLIC_FLOOR, 10, '2026-10-26'), week(DEFAULT_PUBLIC_FLOOR - 1, 4, '2026-11-02')], 'fit'), READ.motifId, 'week');
    expect(served.n).toBe(10);
    expect(served.value.ok).toBe(10);
  });

  it('tool-day sums a tool across models at the floor, not a sub-floor model beside them', () => {
    const served = slicedTo(readsOf([cellOf(READ.motifId, DEFAULT_PUBLIC_FLOOR, 10), cellOf(READ.motifId, DEFAULT_PUBLIC_FLOOR - 1, 3, { frameBucket: `${BUCKET}/sonnet` })], 'tool-day'), READ.motifId);
    expect(served.n).toBe(10);
    expect(served.value.steps).toBe(10);
  });
});

describe('two served numbers over one day', () => {
  const served = (sub: number, ok: number): { steps: number; reads: number[]; shape: unknown } => {
    const bundle = bundleOver([cellOf(READ.motifId, DEFAULT_PUBLIC_FLOOR, 10), cellOf(SHELL.motifId, DEFAULT_PUBLIC_FLOOR, 6), cellOf(SEARCH.motifId, sub, ok)]);
    const days = bundle.reads.filter((read) => read.family === 'tool-day');
    const [first] = days;
    const steps = Number(first?.value.steps);
    // What is served, without the ids and the pool's version, which name the cells held and so move with the sub-floor cell itself.
    return { steps, reads: days.map((read) => read.n), shape: bundle.reads.map((read) => [read.family, read.slice, read.value, read.n, read.inputs.length]) };
  };

  it('shows nothing of a sub-floor cell in `steps` less `n`', () => {
    const small = served(DEFAULT_PUBLIC_FLOOR - 1, 2);
    const large = served(DEFAULT_PUBLIC_FLOOR - 2, 9);
    // The served tools are the only ones `steps` counts, so `steps` less one tool's `n` is the other served tool's `n`, whatever the hidden cell holds.
    expect(small.steps).toBe(16);
    expect(small.steps - 10).toBe(6);
    expect(small.reads.slice().sort()).toEqual([10, 6].sort());
    // And no served number moves with the hidden cell: the same bundle, with the cell larger, serves the same reads.
    expect(large.shape).toEqual(small.shape);
  });
});

describe('a live baseline that is sub-floor is null, not zero', () => {
  it('reads `baseline: null` for a tool with no baseline cell at the floor, though another tool is served that day', () => {
    const before = '2026-11-01';
    // READ is served on DAY and sub-floor the day before; SHELL is served the day before, so the baseline has steps, none of them READ's that are served.
    const cells = [cellOf(READ.motifId, DEFAULT_PUBLIC_FLOOR, 10), cellOf(READ.motifId, DEFAULT_PUBLIC_FLOOR - 1, 4, { day: before }), cellOf(SHELL.motifId, DEFAULT_PUBLIC_FLOOR, 6, { day: before })];
    const served = slicedTo(readsOf(cells, 'live'), READ.motifId);
    expect(served.value.baseline).toBeNull();
    expect(served.value.ratio).toBeNull();
    expect(served.value.share).toBe(1);
  });
});

// A week cell and the day cells of its days count the same steps, and both leave. A served week less all of its served days would then be the sub-floor days' steps, so a week with a sub-floor day
// also withholds its smallest served day (fewest accounts, ties to the earliest day): the difference is then a sum over at least two days, one of them at or above the floor, which no reader can split.
describe('a week and its days: complementary withholding', () => {
  const week = (clusters: number, ok: number): Cell => cellOf(READ.motifId, clusters, ok, { grain: 'week', day: '2026-11-02' });
  const dayOf = (clusters: number, ok: number, day: string): Cell => cellOf(READ.motifId, clusters, ok, { day });
  const servedDays = (bundle: ReturnType<typeof bundleOf>): string[] => bundle.cells.filter((cell) => cell.grain === 'day').map((cell) => cell.day);
  const dayReads = (bundle: ReturnType<typeof bundleOf>, family: Read['family']): string[] => bundle.reads.filter((read) => read.family === family).map((read) => String(read.slice.day));

  it('serves the week and not the one served day beside a sub-floor day', () => {
    const bundle = bundleOver([week(6, 20), dayOf(5, 18, '2026-11-02'), dayOf(1, 2, '2026-11-03')]);
    const fit = bundle.reads.find((read) => read.family === 'fit');
    expect(fit?.n).toBe(20);
    expect(servedDays(bundle)).toEqual([]);
    expect(bundle.cells.map((cell) => cell.grain)).toEqual(['week']);
    expect(bundle.reads.filter((read) => read.family === 'tool-day' || read.family === 'live')).toEqual([]);
  });

  it('withholds the smallest served day of three, so the week less the served days covers two days', () => {
    const bundle = bundleOver([week(8, 26), dayOf(7, 10, '2026-11-02'), dayOf(6, 8, '2026-11-03'), dayOf(5, 6, '2026-11-04'), dayOf(1, 2, '2026-11-05')]);
    expect(servedDays(bundle)).toEqual(['2026-11-02', '2026-11-03']);
    expect(dayReads(bundle, 'tool-day').sort()).toEqual(['2026-11-02', '2026-11-03']);
    const fit = bundle.reads.find((read) => read.family === 'fit');
    const rest = (fit?.n ?? 0) - bundle.reads.filter((read) => read.family === 'tool-day').reduce((sum, read) => sum + read.n, 0);
    // 26 less 10 and 8 is 8: the held day at 5 accounts (6 steps) and the sub-floor day (2 steps), which no one number separates.
    expect(rest).toBe(8);
    expect(rest).toBeGreaterThan(2);
  });

  it('breaks a tie between served days toward the earlier day', () => {
    const bundle = bundleOver([week(7, 20), dayOf(5, 8, '2026-11-02'), dayOf(5, 9, '2026-11-03'), dayOf(1, 3, '2026-11-04')]);
    expect(servedDays(bundle)).toEqual(['2026-11-03']);
  });

  it('keeps every day of a week with no sub-floor day', () => {
    const bundle = bundleOver([week(7, 17), dayOf(5, 8, '2026-11-02'), dayOf(6, 9, '2026-11-03')]);
    expect(servedDays(bundle)).toEqual(['2026-11-02', '2026-11-03']);
  });

  it('serves only the week when every day is sub-floor, as there is no served day to withhold', () => {
    const bundle = bundleOver([week(6, 20), dayOf(3, 10, '2026-11-02'), dayOf(2, 10, '2026-11-03')]);
    expect(bundle.cells.map((cell) => cell.grain)).toEqual(['week']);
  });

  it('keeps the days of a week that is itself sub-floor', () => {
    const bundle = bundleOver([week(4, 12), dayOf(5, 8, '2026-11-02'), dayOf(1, 4, '2026-11-03')]);
    expect(bundle.cells.map((cell) => cell.grain)).toEqual(['day']);
  });

  it('is the same for another frame: a sub-floor day in one model does not withhold another model\'s day', () => {
    const sonnet = (clusters: number, ok: number, day: string, grain: Cell['grain']): Cell => cellOf(READ.motifId, clusters, ok, { day, grain, frameBucket: `${BUCKET}/sonnet` });
    const bundle = bundleOver([week(6, 20), dayOf(5, 18, '2026-11-02'), dayOf(1, 2, '2026-11-03'), sonnet(6, 9, '2026-11-02', 'week'), sonnet(5, 9, '2026-11-02', 'day')]);
    expect(bundle.cells.filter((cell) => cell.grain === 'day').map((cell) => cell.frameBucket)).toEqual([`${BUCKET}/sonnet`]);
  });

  it('moves asOf.pool when the first sub-floor day withholds a served day', () => {
    const served = [week(6, 20), dayOf(5, 18, '2026-11-02')];
    expect(bundleOver([...served, dayOf(1, 2, '2026-11-03')]).asOf.pool).not.toBe(bundleOver(served).asOf.pool);
  });

  it('does not move with the size of a sub-floor cell', () => {
    const served = [week(6, 20), dayOf(5, 18, '2026-11-02')];
    expect(bundleOver([...served, dayOf(1, 2, '2026-11-03')]).asOf.pool).toBe(bundleOver([...served, dayOf(3, 5, '2026-11-03')]).asOf.pool);
  });
});

describe('a shape and its named cells: complementary withholding', () => {
  const named = (tool: string): Motif => {
    const steps: WindowStep[] = [{ action: 'mcp.call', identity: { server: 'a', tool } }];
    return { motifId: namedId(steps), level: 'named', steps, cls: null };
  };
  const shape = shapeMotif([{ action: 'mcp.call', identity: null }]);
  const [one, two, three] = [named('one'), named('two'), named('three')];
  const over = (cells: Cell[]): ReturnType<typeof bundleOf> => bundleOf(HARNESS, VERSION, { cells, environment: [], motifs: [shape, one, two, three], strata: [] }, DEFAULT_FLOORS);
  const ids = (bundle: ReturnType<typeof bundleOf>): string[] => bundle.cells.map((cell) => cell.motifId);

  it('also withholds the smallest served name beside a sub-floor name, and keeps the shape and the other names', () => {
    const bundle = over([cellOf(shape.motifId, 12, 30), cellOf(one.motifId, 7, 12), cellOf(two.motifId, 5, 10), cellOf(three.motifId, 1, 8)]);
    expect(ids(bundle).sort()).toEqual([shape.motifId, one.motifId].sort());
  });

  it('drops the environment counterpart of a withheld name and its fit read', () => {
    const week = (motifId: string, clusters: number, ok: number): Cell => cellOf(motifId, clusters, ok, { grain: 'week' });
    const environment = [week(one.motifId, 7, 12), week(two.motifId, 5, 10)].map((cell) => ({ ...cell, frameBucket: 'env:linux:bash' }));
    const bundle = bundleOf(HARNESS, VERSION, { cells: [week(shape.motifId, 12, 30), week(one.motifId, 7, 12), week(two.motifId, 5, 10), week(three.motifId, 1, 8)], environment, motifs: [shape, one, two, three], strata: [] }, DEFAULT_FLOORS);
    expect(bundle.cells).not.toContainEqual(environment[1]);
    expect(bundle.cells).toContainEqual(environment[0]);
    expect(bundle.reads.filter((read) => read.family === 'fit' && read.slice.platform === 'linux').map((read) => read.n)).toEqual([12]);
  });

  it('withholds no name for a shape day that is itself withheld', () => {
    // Monday's shape is the smallest served day of a week with a sub-floor day, so it goes; its names are then no pair to difference against it, and both served names stay.
    const day = (motifId: string, clusters: number, ok: number, when: string): Cell => cellOf(motifId, clusters, ok, { day: when });
    const week = cellOf(shape.motifId, 12, 33, { grain: 'week', day: '2026-11-02' });
    const bundle = over([week, day(shape.motifId, 12, 31, '2026-11-02'), day(one.motifId, 7, 20, '2026-11-02'), day(two.motifId, 5, 10, '2026-11-02'), day(three.motifId, 1, 1, '2026-11-02'), day(shape.motifId, 1, 2, '2026-11-03')]);
    expect(bundle.cells.map((cell) => `${cell.grain}:${cell.motifId}`).sort()).toEqual([`week:${shape.motifId}`, `day:${one.motifId}`, `day:${two.motifId}`].sort());
  });

  it('keeps every name of a shape with no sub-floor name', () => {
    const bundle = over([cellOf(shape.motifId, 12, 30), cellOf(one.motifId, 7, 12), cellOf(two.motifId, 5, 10)]);
    expect(ids(bundle).sort()).toEqual([shape.motifId, one.motifId, two.motifId].sort());
  });
});

describe('the last day a bundle states', () => {
  it('leaves a later sub-floor cell out of `asOf.day` and out of `weeksSinceLast`', () => {
    const week = (clusters: number, day: string): Cell => cellOf(READ.motifId, clusters, 3, { grain: 'week', day });
    const bundle = bundleOver([week(DEFAULT_PUBLIC_FLOOR, '2026-10-12'), week(1, '2026-11-02')]);
    expect(bundle.asOf.day).toBe('2026-10-12');
    expect(slicedTo(bundle.reads.filter((read) => read.family === 'adoption'), READ.motifId, 'week').value.weeksSinceLast).toBe(0);
  });
});

describe('overlapping named cells', () => {
  const program = (name: string, flags: string[] = [], pulls: NonNullable<Extract<NonNullable<WindowStep['identity']>, { program: string }>['pulls']> = []): Motif => {
    const steps: WindowStep[] = [{ action: 'shell.exec', identity: { program: name, sub: null, flags, pulls } }];
    return { motifId: namedId(steps), level: 'named', steps, cls: null };
  };

  it.each(['flag', 'pull'])('withholds git rather than its overlapping %s cell', (kind) => {
    const git = program('git');
    const rare = program('rare');
    const overlap = kind === 'flag' ? program('git', ['--x']) : program('git', [], [{ registry: 'npm', name: 'x', version: null }]);
    const bundle = bundleOf(HARNESS, VERSION, { cells: [cellOf(SHELL.motifId, 20, 100), cellOf(git.motifId, 15, 90), cellOf(rare.motifId, 1, 10), cellOf(overlap.motifId, 5, 40)], environment: [], motifs: [SHELL, git, rare, overlap], strata: [] }, DEFAULT_FLOORS);
    expect(bundle.cells.some((cell) => cell.motifId === git.motifId)).toBe(false);
    expect(bundle.cells.some((cell) => cell.motifId === overlap.motifId)).toBe(true);
    expect(bundle.cells.some((cell) => cell.motifId === SHELL.motifId)).toBe(true);
    expect([git, rare].filter((motif) => !bundle.cells.some((cell) => cell.motifId === motif.motifId))).toHaveLength(2);
  });
});
