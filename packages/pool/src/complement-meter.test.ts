// The withholding work is metered (`withheldOf`): each elimination is charged the terms of its row and its pivot before it runs, one meter serves a whole bundle, and a system that cannot pay is withheld whole. Every case here
// counts work and reads no clock; the budgets are taken from the work a fixture itself costs, so no number is pinned.
import { describe, expect, it } from 'vitest';
import { NO_AXES, shapeClass, type Cell } from '../../cli/src/sessions/cells.js';
import { classMotif, type Motif } from '../../cli/src/sessions/motif.js';
import { cellClassOf } from './cell-class.js';
import { MAX_BUNDLE_UNITS, MAX_SYSTEM_TERMS, meterOf, withheldOf, type Floorplan } from './complement.js';
import { bundleOf } from './derive.js';
import { cellFloor, clears, clustersOf, DEFAULT_PUBLIC_FLOOR, type Floors } from './floors.js';

const F = DEFAULT_PUBLIC_FLOOR;
const at = (floor: number): Floorplan => ({ floorOf: () => floor, standingOf: clustersOf });
const cellOf = (motifId: string, clusters: number): Cell => ({ motifId, frameBucket: `claude-code/2.1.31x/${NO_AXES}`, grain: 'week', day: '2026-10-26', sessions: clusters, clusters, ok: clusters, failed: 1, tokens: null, durationMs: 0, exposed: false });

interface Fixture {
  cells: Cell[];
  motifs: Motif[];
}

/** The combination fixture of `shape-cells.test.ts` (a `keys` cell under the floor beside the `size` and `target` cells that would give it back): one system of several equations. `thin` is the sub-floor cell's count. */
const fixtureOf = (parts: readonly [Motif, number][]): Fixture => ({ cells: parts.map(([motif, clusters]) => cellOf(motif.motifId, clusters)), motifs: parts.map(([motif]) => motif) });

const comboOf = (action: string, thin = F - 1, extra = 0): Fixture => {
  const motifOf = (facet: Parameters<typeof shapeClass>[1], value: string): Motif => classMotif(shapeClass(action, facet, value));
  const parts: [Motif, number][] = [
    [motifOf('keys', 'path'), F + 5],
    [motifOf('keys', 'path,pattern'), thin],
    [motifOf('keys', 'pattern'), F + 5],
    [motifOf('size', 'path=9-32'), 2 * F + 4],
    [motifOf('size', 'pattern=9-32'), 2 * F + 4],
    [motifOf('target', 'none'), 3 * F + 9],
  ];
  // More keys, each with a `keys` cell and a `size` cell, make a larger system of the same kind.
  for (let key = 0; key < extra; key++) parts.push([motifOf('keys', `extra${String(key)}`), F + 5], [motifOf('size', `extra${String(key)}=9-32`), 2 * F + 4]);
  return fixtureOf(parts);
};

const join = (...fixtures: Fixture[]): Fixture => ({ cells: fixtures.flatMap(({ cells }) => cells), motifs: fixtures.flatMap(({ motifs }) => motifs) });
const reversed = ({ cells, motifs }: Fixture): Fixture => ({ cells: [...cells].reverse(), motifs: [...motifs].reverse() });

/** What `withheldOf` leaves out of a fixture with `units` to spend, and what it spent. */
const run = ({ cells, motifs }: Fixture, units = MAX_BUNDLE_UNITS): { withheld: Set<Cell>; spent: number; left: number } => {
  const meter = meterOf(units);
  const withheld = withheldOf(cells, motifs, at(F), MAX_SYSTEM_TERMS, meter);
  return { withheld, spent: units - meter.left, left: meter.left };
};

const servedOf = ({ cells }: Fixture): Cell[] => cells.filter((cell) => clears(cell, F));
const idsOf = (cells: Iterable<Cell>): string[] => [...cells].map((cell) => cell.motifId).sort();

describe('the meter', () => {
  it('charges what the eliminations touch, and a system that cannot pay for the next one is withheld whole', () => {
    const combo = comboOf('file.read');
    const full = run(combo);
    expect(full.spent).toBeGreaterThan(0);
    expect(full.withheld.size).toBeLessThan(servedOf(combo).length);
    // The exact budget is enough, and leaves nothing.
    const exact = run(combo, full.spent);
    expect(idsOf(exact.withheld)).toEqual(idsOf(full.withheld));
    expect(exact.left).toBe(0);
    // One unit short stops the system before its last elimination: every served cell goes, nothing is half applied, and the elimination that could not be paid for was not charged.
    const short = run(combo, full.spent - 1);
    expect(idsOf(short.withheld)).toEqual(idsOf(servedOf(combo)));
    expect(short.left).toBeGreaterThan(0);
    expect(short.spent).toBeLessThan(full.spent - 1);
  });

  it('charges the terms of the row and of the pivot, not the terms of their union', () => {
    // Everything here is served, so the rank check withholds nothing and runs once. The `path` key's nesting equation (its total less the two `keys` cells that hold it, 3 terms) and the `size` equation (the same total less the
    // `size` cell, 2 terms) meet in the one elimination the system makes, which reads 3 + 2 = 5 terms; the union of the two rows is 4. The other two equations (the action's calls, and the `pattern` key's total) pivot on nothing and cost 0.
    const motifOf = (facet: Parameters<typeof shapeClass>[1], value: string): Motif => classMotif(shapeClass('file.read', facet, value));
    const pair = fixtureOf([[motifOf('keys', 'path'), F + 5], [motifOf('keys', 'path,pattern'), F + 5], [motifOf('size', 'path=9-32'), 2 * F + 4]]);
    expect(run(pair)).toEqual({ withheld: new Set(), spent: 5, left: MAX_BUNDLE_UNITS - 5 });
  });

  it('charges an elimination again each time the system is eliminated again', () => {
    const combo = comboOf('file.read');
    // Traced by hand (rows of 3 and 2 terms, then 3 and 4, and so on; each charge is the terms of the row and of its pivot), one pass of the rank check over this system makes eight eliminations of 5, 7, 7, 5, 6, 7, 6, and 8 units: 51.
    // The check then withholds a cell and runs the system again, so a system with something to withhold costs more than one pass.
    const FIRST_PASS = 51;
    // A budget of one pass pays for it exactly (the second pass is refused at its first elimination, which takes nothing); one short stops before the eighth elimination, which takes nothing either.
    expect(run(combo, FIRST_PASS).spent).toBe(FIRST_PASS);
    expect(run(combo, FIRST_PASS - 1).spent).toBe(FIRST_PASS - 8);
    // Left whole, the check withholds two cells from it, so it runs three passes (51, 51, and 42 units by a throwaway counter, 144 in all), and each is charged: a meter that charged only a system's first pass would stop at 51.
    const once = run(combo).spent;
    expect(once).toBeGreaterThanOrEqual(2 * FIRST_PASS);
    // The same cells through one meter twice (a second week or floor with the same cells) cost twice.
    const meter = meterOf();
    withheldOf(combo.cells, combo.motifs, at(F), MAX_SYSTEM_TERMS, meter);
    withheldOf(combo.cells, combo.motifs, at(F), MAX_SYSTEM_TERMS, meter);
    expect(MAX_BUNDLE_UNITS - meter.left).toBe(2 * once);
  });

  it('is shared by the systems of a bundle: two systems each under the cap whose sum is over the budget', () => {
    const [read, search] = [comboOf('file.read'), comboOf('file.search')];
    const both = run(join(read, search));
    const one = run(read).spent;
    expect(both.spent).toBe(2 * one);
    // With one system's worth the first system finishes and the other is left out of the rank check, whichever order the cells arrive in.
    const budget = run(join(read, search), one);
    expect(idsOf(run(join(reversed(search), reversed(read)), one).withheld)).toEqual(idsOf(budget.withheld));
    const capped = [read, search].filter((system) => servedOf(system).every((cell) => budget.withheld.has(cell)));
    expect(capped).toHaveLength(1);
    expect(budget.withheld.size).toBeGreaterThan(both.withheld.size);
    expect(run(join(read, search), both.spent).withheld.size).toBe(both.withheld.size);
  });

  it('runs the smaller system first, so it finishes before a larger one can spend the meter', () => {
    const [small, large] = [comboOf('file.read'), comboOf('file.search', F - 1, 3)];
    const budget = run(small).spent;
    for (const held of [join(large, small), join(small, large)]) {
      const { withheld } = run(held, budget);
      expect(idsOf([...withheld].filter((cell) => small.cells.includes(cell)))).toEqual(idsOf(run(small).withheld));
      expect(servedOf(large).every((cell) => withheld.has(cell))).toBe(true);
    }
  });

  it('caps a dense system under the term cap, whose work is more than its terms squared', () => {
    // 60 keys, 300 `keys` cells that each leave out three of them (all under the floor), and a served `size` cell per key: every key's row holds most of the `keys` cells.
    const keys = Array.from({ length: 60 }, (_, index) => `k${String(index).padStart(2, '0')}`);
    const lists: string[][] = [];
    for (let a = 0; a < keys.length && lists.length < 300; a++) for (let b = a; b < keys.length && lists.length < 300; b++) for (let c = b; c < keys.length && lists.length < 300; c++) lists.push(keys.filter((_, index) => index !== a && index !== b && index !== c));
    const keyed = lists.map((list) => classMotif(shapeClass('file.search', 'keys', list.join(','))));
    // The first key is left out of every list, so it has no `keys` cell to give back and is not in the system.
    const sized = keys.filter((key) => lists.some((list) => list.includes(key))).map((key) => classMotif(shapeClass('file.search', 'size', `${key}=9-32`)));
    const dense: Fixture = { cells: [...keyed.map((motif) => cellOf(motif.motifId, F - 1)), ...sized.map((motif) => cellOf(motif.motifId, 4000))], motifs: [...keyed, ...sized] };
    // The terms are the cells, the calls each key sends, and the action's calls.
    const terms = dense.cells.length + sized.length + 1;
    expect(terms).toBeLessThan(MAX_SYSTEM_TERMS);
    const full = run(dense);
    expect(full.withheld.size).toBe(0);
    expect(full.spent).toBeGreaterThan(terms ** 2);
    // A budget of terms squared would have been enough had that been the work; the meter refuses, and every served cell goes.
    expect(idsOf(run(dense, terms ** 2).withheld)).toEqual(idsOf(servedOf(dense)));
  });

  it('is one meter across the floors of a bundle: a family on a lower floor spends what the public floor left', () => {
    // The bundle sorts its cells, and the work depends on the order, so the work of each floor is measured over the same order.
    const sorted = ({ cells, motifs }: Fixture): Fixture => ({ cells: [...cells].sort((a, b) => (a.motifId < b.motifId ? -1 : 1)), motifs: [...motifs].sort((a, b) => (a.motifId < b.motifId ? -1 : 1)) });
    const { cells, motifs } = sorted(comboOf('file.read'));
    const floors: Floors = { public: F, disclosure: 2, clear: F, families: { fit: 3 } };
    const spentAt = (floor: number): number => {
      const meter = meterOf();
      const motifOf = new Map(motifs.map((motif) => [motif.motifId, motif]));
      withheldOf(cells, motifs, { floorOf: (cell) => cellFloor(floors, floor, cellClassOf(cell, motifOf.get(cell.motifId))), standingOf: clustersOf }, MAX_SYSTEM_TERMS, meter);
      return MAX_BUNDLE_UNITS - meter.left;
    };
    const [publicSpent, familySpent] = [spentAt(F), spentAt(3)];
    expect(familySpent).toBeGreaterThan(0);
    expect(familySpent).toBeLessThanOrEqual(publicSpent);
    const stored = { cells, environment: [], motifs, strata: [] };
    const shown = (units: number): boolean => bundleOf('claude-code', '2.1.314', stored, floors, units).cells.some((cell) => cell.clusters === F - 1);
    // The `fit` family on 3 shows the cell the public floor does not serve, when the meter has what both floors need and not when the public floor has used what only it needs.
    expect(shown(publicSpent + familySpent)).toBe(true);
    expect(shown(publicSpent)).toBe(false);
  });
});
