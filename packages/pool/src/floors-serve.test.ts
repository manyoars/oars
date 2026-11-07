// A floor is applied when a bundle is served, to cells that keep their held counts. One stored set is served at floors 3, 5, and 10: lowering a floor serves what was held, raising it withdraws what was served, and nothing is
// redeposited or derived by hand between them. t866's complementary withholding is re-run at each of those floors, and with one family on its own floor, so it holds at any value and not only at 5.
import { describe, expect, it } from 'vitest';
import type { Cell } from '../../cli/src/sessions/cells.js';
import { namedId, shapeMotif, type Motif, type WindowStep } from '../../cli/src/sessions/motif.js';
import type { Read } from '../../cli/src/sessions/read.js';
import type { Harness } from '../../cli/src/sessions/schema.js';
import { etagOf } from './bundle.js';
import { bundleOf, SERVED } from './derive.js';
import { DEFAULT_FLOORS, wireFloors, type Floors } from './floors.js';

const HARNESS: Harness = 'claude-code';
const VERSION = '2.1.314';
const BUCKET = 'claude-code/2.1.31x';
const DAY = '2026-11-02';

const READ = shapeMotif([{ action: 'file.read', identity: null }]);
const SHELL = shapeMotif([{ action: 'shell.exec', identity: null }]);
const SEARCH = shapeMotif([{ action: 'file.search', identity: null }]);

const cellOf = (motifId: string, clusters: number, ok: number, over: Partial<Cell> = {}): Cell => ({ motifId, frameBucket: `${BUCKET}/opus`, grain: 'day', day: DAY, sessions: clusters, clusters, ok, failed: 0, tokens: 0, durationMs: 0, exposed: false, ...over });

const at = (publicFloor: number, families: Floors['families'] = {}): Floors => ({ public: publicFloor, disclosure: 2, families });
const bundleOver = (cells: Cell[], floors: Floors, motifs: Motif[] = [READ, SHELL, SEARCH]): ReturnType<typeof bundleOf> => bundleOf(HARNESS, VERSION, { cells, environment: [], motifs, strata: [] }, floors);
const motifsOf = (bundle: ReturnType<typeof bundleOf>, family: Read['family']): string[] => bundle.reads.filter((read) => read.family === family).map((read) => String(read.slice.motif)).sort();

describe('one store at floors 3, 5, and 10', () => {
  // Three tools on one day, held by 10, 5, and 3 accounts. The same array is served three times: nothing is written between the bundles.
  const held = [cellOf(READ.motifId, 10, 30), cellOf(SHELL.motifId, 5, 20), cellOf(SEARCH.motifId, 3, 8)];
  const frozen = JSON.stringify(held);

  it('serves what each floor lets through, and a read of each states the floor it cleared', () => {
    const three = bundleOver(held, at(3));
    const five = bundleOver(held, at(5));
    const ten = bundleOver(held, at(10));
    const counts = (bundle: ReturnType<typeof bundleOver>): number[] => bundle.cells.map((cell) => cell.clusters).sort((a, b) => b - a);
    expect(counts(three)).toEqual([10, 5, 3]);
    expect(counts(five)).toEqual([10, 5]);
    expect(counts(ten)).toEqual([10]);
    expect(motifsOf(three, 'tool-day')).toEqual(['file.read', 'file.search', 'shell.exec']);
    expect(motifsOf(five, 'tool-day')).toEqual(['file.read', 'shell.exec']);
    expect(motifsOf(ten, 'tool-day')).toEqual(['file.read']);
    for (const [bundle, floor] of [[three, 3], [five, 5], [ten, 10]] as const) {
      expect(bundle.reads.length).toBeGreaterThan(0);
      expect(bundle.reads.every((read) => read.floor === floor), `floor ${String(floor)}`).toBe(true);
    }
  });

  it('lowering serves the cell that was held, and raising it again withdraws it', () => {
    const search = (bundle: ReturnType<typeof bundleOver>): boolean => bundle.cells.some((cell) => cell.motifId === SEARCH.motifId);
    expect([5, 3, 5, 10].map((floor) => search(bundleOver(held, at(floor))))).toEqual([false, true, false, false]);
    expect(JSON.stringify(held)).toBe(frozen);
  });

  it('counts only the cells it serves: a tool-day total at 10 holds the one tool, and at 3 all three', () => {
    const steps = (floor: number): number => Number(bundleOver(held, at(floor)).reads.find((read) => read.family === 'tool-day' && read.slice.motif === 'file.read')?.value.steps);
    expect([steps(3), steps(5), steps(10)]).toEqual([58, 50, 30]);
  });

  it('keeps the bundle at its floor from moving by the held counts below it', () => {
    // Two stores that differ only in a cell under the floor serve the same bytes, at every floor.
    for (const floor of [3, 5, 10]) {
      const small = [cellOf(READ.motifId, floor, 10), cellOf(SHELL.motifId, floor - 1, 2)];
      const large = [cellOf(READ.motifId, floor, 10), cellOf(SHELL.motifId, floor - 2 || 1, 90)];
      expect(JSON.stringify(bundleOver(small, at(floor))), `floor ${String(floor)}`).toBe(JSON.stringify(bundleOver(large, at(floor))));
    }
  });
});

describe('what the bundle and the ETag carry', () => {
  it('states both floors, and the families that have their own', () => {
    expect(bundleOver([], at(3)).floors).toEqual({ public: 3, disclosure: 2 });
    expect(bundleOver([], at(5, { live: 3 })).floors).toEqual({ public: 5, disclosure: 2, families: { live: 3 } });
    expect(bundleOver([], DEFAULT_FLOORS).floors).toEqual({ public: 5, disclosure: 2 });
  });

  it('gives two bundles alike but for a floor two ETags, and the same floors the same ETag', () => {
    const served = SERVED.map(({ name }) => name);
    const etag = (floors: Floors): string => etagOf(HARNESS, VERSION, 7, served, floors);
    expect(etag(at(3))).not.toBe(etag(at(5)));
    expect(etag({ ...at(5), disclosure: 3 })).not.toBe(etag(at(5)));
    expect(etag(at(5, { live: 3 }))).not.toBe(etag(at(5)));
    expect(etag(at(5, { live: 3 }))).not.toBe(etag(at(5, { live: 4 })));
    expect(etag(at(5, { live: 3, cost: 6 }))).toBe(etag(at(5, { cost: 6, live: 3 })));
    // A family named at the public floor is the public floor, so it is not a different bundle.
    expect(etag(at(5, { live: 5 }))).toBe(etag(at(5)));
    expect(wireFloors(at(5, { live: 5 }))).toEqual(wireFloors(at(5)));
  });

  it('adds only optional fields, so an older reader\'s check still accepts the bundle', () => {
    // The check below is the one a client before the floors ran (`isBundle` at t812): it names the fields it needs and ignores the rest. The new bundle carries every one of them, and `floors` and a read\'s `floor` are the only additions.
    const isOlderBundle = (value: Record<string, unknown>): boolean =>
      value.format === 1 && typeof value.harness === 'string' && typeof value.harnessVersion === 'string' && typeof value.vocabVersion === 'string' && typeof value.asOf === 'object' && Array.isArray(value.cells) && Array.isArray(value.motifs) && Array.isArray(value.reads) && Array.isArray(value.strata);
    const bundle = bundleOver([cellOf(READ.motifId, 6, 12)], at(5, { live: 3 }));
    expect(isOlderBundle({ ...bundle })).toBe(true);
    const { floors, ...rest } = bundle;
    expect(floors).toBeDefined();
    expect(Object.keys(rest).sort()).toEqual(['asOf', 'cells', 'format', 'harness', 'harnessVersion', 'motifs', 'reads', 'strata', 'vocabVersion']);
    const read = bundle.reads.find((entry) => entry.family !== 'live');
    const { floor, ...readRest } = read ?? { floor: 0 };
    expect(floor).toBe(5);
    expect(Object.keys(readRest).sort()).toEqual(['asOf', 'basis', 'clusters', 'family', 'inputs', 'interval', 'method', 'methodVersion', 'n', 'order', 'readId', 'slice', 'value']);
  });

  it('puts the floor in a read\'s ID, so the same numbers served at 3 and at 5 are two reads', () => {
    const held = [cellOf(READ.motifId, 6, 12)];
    const [low] = bundleOver(held, at(3)).reads;
    const [high] = bundleOver(held, at(5)).reads;
    expect(low?.value).toEqual(high?.value);
    expect(low?.readId).not.toBe(high?.readId);
  });
});

// t866's complementary withholding, at a floor `F`: every count is relative to it, so the same shapes of store are read at 3, 5, and 10.
describe.each([3, 5, 10])('complementary withholding at floor %i', (floor) => {
  const week = (motifId: string, clusters: number, ok: number): Cell => cellOf(motifId, clusters, ok, { grain: 'week' });
  const dayOf = (clusters: number, ok: number, day: string): Cell => cellOf(READ.motifId, clusters, ok, { day });
  const servedDays = (bundle: ReturnType<typeof bundleOf>): string[] => bundle.cells.filter((cell) => cell.grain === 'day').map((cell) => cell.day);

  it('serves the week and not the one served day beside a sub-floor day', () => {
    const bundle = bundleOver([week(READ.motifId, floor + 1, 20), dayOf(floor, 18, '2026-11-02'), dayOf(1, 2, '2026-11-03')], at(floor));
    expect(bundle.reads.find((read) => read.family === 'fit')?.n).toBe(20);
    expect(servedDays(bundle)).toEqual([]);
    expect(bundle.reads.filter((read) => read.family === 'tool-day' || read.family === 'live')).toEqual([]);
  });

  it('withholds the smallest served day of three, so the week less the served days covers two days', () => {
    const bundle = bundleOver([week(READ.motifId, floor + 3, 26), dayOf(floor + 2, 10, '2026-11-02'), dayOf(floor + 1, 8, '2026-11-03'), dayOf(floor, 6, '2026-11-04'), dayOf(1, 2, '2026-11-05')], at(floor));
    expect(servedDays(bundle)).toEqual(['2026-11-02', '2026-11-03']);
    const fit = bundle.reads.find((read) => read.family === 'fit');
    const rest = (fit?.n ?? 0) - bundle.reads.filter((read) => read.family === 'tool-day').reduce((sum, read) => sum + read.n, 0);
    expect(rest).toBe(8);
  });

  it('keeps every day of a week with no sub-floor day', () => {
    const bundle = bundleOver([week(READ.motifId, floor + 2, 17), dayOf(floor, 8, '2026-11-02'), dayOf(floor + 1, 9, '2026-11-03')], at(floor));
    expect(servedDays(bundle)).toEqual(['2026-11-02', '2026-11-03']);
  });

  it('withholds the smallest served name beside a sub-floor name, and keeps the shape and the other names', () => {
    const named = (tool: string): Motif => {
      const steps: WindowStep[] = [{ action: 'mcp.call', identity: { server: 'a', tool } }];
      return { motifId: namedId(steps), level: 'named', steps, cls: null };
    };
    const shape = shapeMotif([{ action: 'mcp.call', identity: null }]);
    const [one, two, three] = [named('one'), named('two'), named('three')];
    const bundle = bundleOver([cellOf(shape.motifId, floor + 7, 30), cellOf(one.motifId, floor + 2, 12), cellOf(two.motifId, floor, 10), cellOf(three.motifId, 1, 8)], at(floor), [shape, one, two, three]);
    expect(bundle.cells.map((cell) => cell.motifId).sort()).toEqual([shape.motifId, one.motifId].sort());
  });
});

describe('one family on its own floor', () => {
  const week = (clusters: number, ok: number): Cell => cellOf(READ.motifId, clusters, ok, { grain: 'week' });
  const dayOf = (clusters: number, ok: number, day: string): Cell => cellOf(READ.motifId, clusters, ok, { day });

  it('applies to that family and to no other: fit at 3 reads cells that tool-day at 5 does not', () => {
    const week = (motifId: string, clusters: number, ok: number): Cell => cellOf(motifId, clusters, ok, { grain: 'week' });
    const held = [week(READ.motifId, 6, 12), week(SHELL.motifId, 3, 9), cellOf(READ.motifId, 6, 12), cellOf(SHELL.motifId, 3, 9)];
    const bundle = bundleOver(held, at(5, { fit: 3 }));
    expect(motifsOf(bundle, 'tool-day')).toEqual(['file.read']);
    expect(motifsOf(bundle, 'live')).toEqual(['file.read']);
    expect(bundle.reads.filter((read) => read.family === 'tool-day' || read.family === 'live').every((read) => read.floor === 5)).toBe(true);
    const own = bundle.reads.filter((read) => read.family === 'fit');
    expect(own.every((read) => read.floor === 3)).toBe(true);
    expect(own.map((read) => String(read.slice.motif)).sort()).toEqual(['file.read', 'shell.exec']);
    // The cost family is on the public floor, so it does not read the week held by 3 accounts.
    expect(bundle.reads.filter((read) => read.family === 'cost').every((read) => read.floor === 5)).toBe(true);
  });

  it('shows only the cells a family on a lower floor cites, and not the others it could have read', () => {
    // `tool-day` is the one family on 3. It reads the shell tool's day cell, which the public floor of 5 does not serve; the search tool's day cell is read by every family on the public floor and so is not shown.
    const held = [cellOf(READ.motifId, 6, 12), cellOf(SHELL.motifId, 3, 9), cellOf(SEARCH.motifId, 2, 4)];
    const bundle = bundleOver(held, at(5, { 'tool-day': 3 }));
    expect(bundle.cells.map((cell) => cell.clusters)).toEqual([6, 3]);
    expect(bundle.motifs.map((motif) => motif.motifId).sort()).toEqual([READ.motifId, SHELL.motifId].sort());
    expect(motifsOf(bundle, 'tool-day')).toEqual(['file.read', 'shell.exec']);
    // Every other family, on the public floor, reads the one cell at 6 and cites nothing the bundle does not hold.
    expect(bundle.reads.filter((read) => read.family !== 'tool-day').every((read) => read.floor === 5)).toBe(true);
    const held5 = new Set(bundle.cells.map((cell) => cell.motifId));
    expect(held5.has(SEARCH.motifId)).toBe(false);
  });

  it('withdraws a family raised above the public floor while the rest stay', () => {
    const held = [cellOf(READ.motifId, 6, 12)];
    const bundle = bundleOver(held, at(5, { 'tool-day': 8 }));
    expect(bundle.reads.some((read) => read.family === 'tool-day')).toBe(false);
    expect(bundle.reads.some((read) => read.family === 'live')).toBe(true);
    expect(bundle.floors).toEqual({ public: 5, disclosure: 2, families: { 'tool-day': 8 } });
  });

  // A week with a day under every floor: the days are held by 9, 7, 5, 3, and 1 accounts. At 3 the sub-floor day withholds the smallest served one (the 3), at 5 the 5, and at 10 no day is served.
  const DAYS = [dayOf(9, 20, '2026-11-02'), dayOf(7, 12, '2026-11-03'), dayOf(5, 10, '2026-11-04'), dayOf(3, 6, '2026-11-05'), dayOf(1, 2, '2026-11-06')];
  const EXPECTED = new Map<number, string[]>([
    [3, ['2026-11-02', '2026-11-03', '2026-11-04']],
    [5, ['2026-11-02', '2026-11-03']],
    [10, []],
  ]);
  const daysOf = (bundle: ReturnType<typeof bundleOver>, family: Read['family']): string[] => bundle.reads.filter((read) => read.family === family).map((read) => String(read.slice.day)).sort();

  it.each([
    { floors: at(5, { 'tool-day': 3 }), own: 3, rest: 5 },
    { floors: at(5, { 'tool-day': 10 }), own: 10, rest: 5 },
    { floors: at(10, { 'tool-day': 5 }), own: 5, rest: 10 },
    { floors: at(3, { 'tool-day': 5 }), own: 5, rest: 3 },
  ])('holds for the family and for the rest: tool-day on $own beside a public floor of $rest', ({ floors, own, rest }) => {
    const bundle = bundleOver([week(46, 50), ...DAYS], floors);
    // Each family is complemented at its own floor, so its served days are those that floor leaves, whatever the other family's floor.
    expect(daysOf(bundle, 'tool-day')).toEqual(EXPECTED.get(own));
    expect(daysOf(bundle, 'live')).toEqual(EXPECTED.get(rest));
  });

  it('does not let a family on a lower floor undo the withholding of the family beside it', () => {
    // tool-day at 3 reads days at 9, 7, and 5; live at 5 reads 9 and 7. Their `steps` and `of` are 42 and 32, from different pools: the 5-account day is in one and not the other, and the 3-account day is in neither.
    const bundle = bundleOver([week(46, 50), ...DAYS], at(5, { 'tool-day': 3 }));
    const sum = (family: Read['family']): number => bundle.reads.filter((read) => read.family === family).reduce((total, read) => total + read.n, 0);
    expect([sum('tool-day'), sum('live')]).toEqual([42, 32]);
  });
});
