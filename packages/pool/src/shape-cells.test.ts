// The pool serves a call's shape cells (layer 0): a target class, an argument class, and a count of unsent key names are closed lists, so their cells are `clear` and served at the clear floor;
// the sorted key names are a long tail, so their cell is `thresholded` and served only at the public floor. The bundle's `fit` reads cite them.
import { describe, expect, it } from 'vitest';
import { NO_AXES, parseShapeClass, shapeClass, weekStartOf, type Cell } from '../../cli/src/sessions/cells.js';
import { classMotif, namedId, shapeMotif, type Motif, type WindowStep } from '../../cli/src/sessions/motif.js';
import { cellClassOf } from './cell-class.js';
import { withheldOf, type Floorplan } from './complement.js';
import { bundleOf } from './derive.js';
import { clustersOf, DEFAULT_FLOORS, DEFAULT_PUBLIC_FLOOR, type Floors } from './floors.js';
import type { StoredPool } from './stored.js';

/** One floor for every cell, counted on the cell's clusters: the single-floor plan these cases state. */
/** The clear floor set to the public one, so a clear cell is served at the public floor as a thresholded one is: the cases below test the complement and the rank check at one floor. */
const ONE_FLOOR: Floors = { ...DEFAULT_FLOORS, clear: DEFAULT_PUBLIC_FLOOR };
const at = (floor: number): Floorplan => ({ floorOf: () => floor, standingOf: clustersOf });

/**
 * The unserved cells that the served ones determine, worked out apart from `complement.ts`. Each relation the cells hold is one equation, with the totals no cell holds as unknowns: each of `target` and `keys`
 * sums to the calls of its action; `dropped`, and the `enum` of an open list, sum to a count of their own that no other cell holds; each key's `size` and `depth` cells, its other `enum` cells, and the `keys` cells whose list holds the key, sum to the calls that send the key; a week cell is the sum of its day cells; a shape cell is
 * the sum of its named cells; and an action's one-step shape cells, over models and exposure, are its calls, which the `fit` read gives. With every served cell fixed, a cell is determined when no solution can move it: after reducing the equations over the unknowns to row echelon form, its column is a pivot whose
 * row holds no other unknown.
 */
const determinedCells = (held: readonly Cell[], motifs: readonly Motif[], served: (cell: Cell) => boolean): Cell[] => {
  const motifOf = new Map(motifs.map((motif) => [motif.motifId, motif]));
  const relations = new Map<string, { head: Cell | string | null; parts: Cell[] }>();
  const relate = (relation: string, cell: Cell, head?: string): void => {
    const known = relations.get(relation) ?? { head: head ?? null, parts: [] };
    relations.set(relation, known);
    known.parts.push(cell);
  };
  for (const cell of held) {
    const motif = motifOf.get(cell.motifId);
    const place = `${cell.frameBucket} ${cell.grain} ${cell.day} ${String(cell.exposed)}`;
    const week = `week ${cell.motifId} ${cell.frameBucket} ${String(cell.exposed)} ${weekStartOf(cell.day)}`;
    if (cell.grain === 'week') relations.set(week, { head: cell, parts: relations.get(week)?.parts ?? [] });
    else relate(week, cell);
    const shape = `shape ${motif?.steps.map((step) => step.action).join(' ') ?? ''} ${place}`;
    if (motif?.level === 'shape') relations.set(shape, { head: cell, parts: relations.get(shape)?.parts ?? [] });
    if (motif?.level === 'named') relate(shape, cell);
    // The `fit` read gives an action's calls: its one-step shape cells summed over models and exposure, on the version bucket the facet cells hold, so those calls are known where every such cell is served.
    if (motif?.level === 'shape' && motif.steps.length === 1) {
      const actions = motif.steps.map((step) => step.action).join(' ');
      const onVersion = `${[...cell.frameBucket.split('/').slice(0, 2), NO_AXES].join('/')} ${cell.grain} ${cell.day} false`;
      relate(`fit ${actions} ${onVersion}`, cell, `calls ${actions} ${onVersion}`);
    }
    const parsed = motif?.cls === null || motif?.cls === undefined ? null : parseShapeClass(motif.cls);
    if (parsed === null) continue;
    const { action, facet, value } = parsed;
    if (facet === 'target' || facet === 'keys') relate(`${action} ${facet} ${place}`, cell, `calls ${action} ${place}`);
    // Only a call with an unsent key has a `dropped` cell, so those cells sum to a count nothing else holds.
    if (facet === 'dropped') relate(`${action} ${facet} ${place}`, cell, `own ${action} ${facet} ${place}`);
    if (facet === 'enum') {
      const key = value.slice(0, value.indexOf('='));
      const member = value.slice(value.indexOf('=') + 1);
      const open = (key === 'subagent_type' || key === 'model') && member !== 'true' && member !== 'false';
      relate(`${action} ${facet} ${key} ${place}`, cell, open ? `own ${action} ${facet} ${key} ${place}` : `calls ${action} ${key} ${place}`);
    }
    if (facet === 'keys') for (const key of value.split(',')) relate(`${action} holds ${key} ${place}`, cell, `calls ${action} ${key} ${place}`);
    if (facet === 'size' || facet === 'depth') {
      const key = value.slice(0, value.indexOf('='));
      relate(`${action} ${facet} ${key} ${place}`, cell, `calls ${action} ${key} ${place}`);
    }
  }
  // Only the unknowns get columns: a served cell moves to the right-hand side, which the question does not depend on.
  const columns: (Cell | string)[] = [];
  const columnOf = new Map<Cell | string, number>();
  const unknown = (term: Cell | string): boolean => typeof term === 'string' || !served(term);
  const rows: [number, number][][] = [];
  for (const { head, parts } of relations.values()) {
    if (head === null || parts.length === 0) continue;
    const row = new Map<number, number>();
    const terms: [Cell | string, number][] = [[head, 1], ...parts.map((part): [Cell, number] => [part, -1])];
    for (const [term, coefficient] of terms) {
      if (!unknown(term)) continue;
      if (!columnOf.has(term)) {
        columnOf.set(term, columns.length);
        columns.push(term);
      }
      const column = columnOf.get(term) ?? -1;
      row.set(column, (row.get(column) ?? 0) + coefficient);
    }
    rows.push([...row]);
  }
  const matrix = rows.map((sparse) => {
    const dense = Array.from({ length: columns.length }, () => 0);
    for (const [column, coefficient] of sparse) dense[column] = coefficient;
    return dense;
  });
  const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));
  const pivotRowOf = new Map<number, number[]>();
  let top = 0;
  for (let column = 0; column < columns.length; column += 1) {
    const found = matrix.findIndex((row, index) => index >= top && row[column] !== 0);
    if (found < 0) continue;
    const [pivot] = matrix.splice(found, 1);
    if (pivot === undefined) throw new Error('no pivot row');
    matrix.splice(top, 0, pivot);
    top += 1;
    for (const row of matrix) {
      const factor = row[column] ?? 0;
      if (row === pivot || factor === 0) continue;
      const scale = pivot[column] ?? 0;
      for (let index = 0; index < row.length; index += 1) row[index] = (row[index] ?? 0) * scale - (pivot[index] ?? 0) * factor;
      const divisor = row.reduce(gcd, 0) || 1;
      for (let index = 0; index < row.length; index += 1) {
        row[index] = (row[index] ?? 0) / divisor;
        if (!Number.isSafeInteger(row[index])) throw new Error('a coefficient outgrew exact arithmetic');
      }
    }
    pivotRowOf.set(column, pivot);
  }
  return [...pivotRowOf].flatMap(([column, row]) => {
    const term = columns[column];
    return typeof term === 'object' && row.every((coefficient, index) => index === column || coefficient === 0) ? [term] : [];
  });
};

const bucket = `claude-code/2.1.31x/${NO_AXES}`;
const target = classMotif(shapeClass('file.read', 'target', 'source'));
const arg = classMotif(shapeClass('file.read', 'arg', 'path'));
const dropped = classMotif(shapeClass('file.read', 'dropped', '1'));
const keys = classMotif(shapeClass('file.read', 'keys', 'file_path,limit'));
const cellOf = (motifId: string, clusters: number): Cell => ({ motifId, frameBucket: bucket, grain: 'week', day: '2026-10-26', sessions: clusters, clusters, ok: clusters, failed: 1, tokens: null, durationMs: 0, exposed: false });

describe('the class of a shape cell', () => {
  it('is clear for a target class, an argument class, and a dropped count', () => {
    for (const motif of [target, arg, dropped]) expect(cellClassOf(cellOf(motif.motifId, 1), motif)).toBe('clear');
  });

  it('is thresholded for the key names', () => {
    expect(cellClassOf(cellOf(keys.motifId, 1), keys)).toBe('thresholded');
  });
});

describe('a bundle of shape cells', () => {
  const stored = (clusters: number): StoredPool => ({ cells: [target, arg, dropped, keys].map(({ motifId }) => cellOf(motifId, clusters)), environment: [], motifs: [target, arg, dropped, keys], strata: [] });
  const served = (clusters: number, floors = DEFAULT_FLOORS): (string | null)[] => {
    const held = bundleOf('claude-code', '2.1.314', stored(clusters), floors);
    return held.cells.map(({ motifId }) => held.motifs.find((motif) => motif.motifId === motifId)?.cls ?? null).sort();
  };

  it('serves the clear cells at the clear floor and the key names only at the public floor', () => {
    expect(served(DEFAULT_PUBLIC_FLOOR - 1, { ...DEFAULT_FLOORS, clear: 1 })).toEqual([target.cls, arg.cls, dropped.cls].sort());
    expect(served(DEFAULT_PUBLIC_FLOOR)).toEqual([target.cls, arg.cls, dropped.cls, keys.cls].sort());
    expect(served(DEFAULT_PUBLIC_FLOOR - 1, ONE_FLOOR)).toEqual([]);
  });

  it('carries a fit read per served shape cell, each citing its cell', () => {
    const held = bundleOf('claude-code', '2.1.314', stored(DEFAULT_PUBLIC_FLOOR), DEFAULT_FLOORS);
    const shapes = held.reads.filter(({ family, slice }) => family === 'fit' && slice.facet !== undefined);
    expect(shapes.map(({ slice }) => `${slice.facet ?? ''}/${slice.value ?? ''}`).sort()).toEqual(['arg/path', 'dropped/1', 'keys/file_path,limit', 'target/source']);
    expect(shapes.every(({ inputs, value }) => inputs.length === 1 && value.failed === 1)).toBe(true);
  });
});

describe('the class of a layer 1 shape cell', () => {
  const classOfShape = (facet: Parameters<typeof shapeClass>[1], value: string): string => {
    const motif = classMotif(shapeClass('file.read', facet, value));
    return cellClassOf(cellOf(motif.motifId, 1), motif);
  };

  it('is clear for a value feature or closed value of a key on a public tool list, and for a change kind', () => {
    expect(classOfShape('size', 'file_path=9-32')).toBe('clear');
    expect(classOfShape('depth', 'file_path=2')).toBe('clear');
    expect(classOfShape('pattern', 'pattern=anchor')).toBe('clear');
    expect(classOfShape('enum', 'output_mode=count')).toBe('clear');
    expect(classOfShape('change', 'key-added')).toBe('clear');
  });

  it('is thresholded for a key that only another tool sent', () => {
    expect(classOfShape('size', 'acme_workspace_id=1-8')).toBe('thresholded');
    expect(classOfShape('enum', 'acme_dry_run=true')).toBe('thresholded');
  });
});

describe('the cells of one facet of a shape', () => {
  // The cells of a partition facet (`target`, `keys`, `dropped`, and a keyed facet for one key) do not overlap, so where a facet's parts sum to a count another read holds, a fully served facet less its served parts would give a sub-floor cell's exact count.
  const motifOf = (facet: Parameters<typeof shapeClass>[1], value: string) => classMotif(shapeClass('file.read', facet, value));
  const servedValues = (cells: [ReturnType<typeof motifOf>, number][]): string[] => {
    const stored: StoredPool = { cells: cells.map(([motif, clusters]) => cellOf(motif.motifId, clusters)), environment: [], motifs: cells.map(([motif]) => motif), strata: [] };
    const held = bundleOf('claude-code', '2.1.314', stored, ONE_FLOOR);
    return held.cells.map(({ motifId }) => held.motifs.find((motif) => motif.motifId === motifId)?.cls ?? '').sort();
  };
  const F = DEFAULT_PUBLIC_FLOOR;

  it('withholds the smallest served part where a part is under the floor', () => {
    const sub = motifOf('target', 'test');
    const small = motifOf('target', 'doc');
    const large = motifOf('target', 'source');
    expect(servedValues([[sub, F - 1], [small, F], [large, F + 3]])).toEqual([large.cls]);
  });

  it('keeps every part where none is under the floor, and parts of another facet or key', () => {
    const a = motifOf('target', 'doc');
    const b = motifOf('target', 'source');
    expect(servedValues([[a, F], [b, F + 3]])).toEqual([a.cls, b.cls].sort());
    const sub = motifOf('size', 'file_path=1-8');
    const small = motifOf('size', 'file_path=9-32');
    const large = motifOf('size', 'file_path=33-128');
    const otherKey = motifOf('size', 'limit=1-8');
    const otherFacet = motifOf('depth', 'file_path=2');
    expect(servedValues([[sub, F - 1], [small, F], [large, F + 3], [otherKey, F], [otherFacet, F]])).toEqual([large.cls, otherKey.cls, otherFacet.cls].sort());
  });

  it('withholds the only served part, so the facet shows nothing of the thin part', () => {
    expect(servedValues([[motifOf('dropped', '1'), F - 1], [motifOf('dropped', '2'), F]])).toEqual([]);
  });
});

describe('the keys cells that hold a key', () => {
  const motifOf = (facet: Parameters<typeof shapeClass>[1], value: string) => classMotif(shapeClass('file.search', facet, value));
  const F = DEFAULT_PUBLIC_FLOOR;
  const servedValues = (cells: [ReturnType<typeof motifOf>, number][]): string[] => {
    const stored: StoredPool = { cells: cells.map(([motif, clusters]) => ({ ...cellOf(motif.motifId, clusters) })), environment: [], motifs: cells.map(([motif]) => motif), strata: [] };
    const held = bundleOf('claude-code', '2.1.314', stored, ONE_FLOOR);
    return held.cells.map(({ motifId }) => held.motifs.find((motif) => motif.motifId === motifId)?.cls ?? '').sort();
  };

  it("are parts of that key's facets, so a sub-floor keys cell is not recovered from the key's size cell", () => {
    // Every `path` value falls in one size bucket, so that facet has no sub-floor part; its total less the served keys cells that hold `path` would be the sub-floor `path,pattern` cell.
    const thin = motifOf('keys', 'path,pattern');
    const small = motifOf('keys', 'pattern');
    const large = motifOf('keys', 'glob,path,pattern');
    const size = motifOf('size', 'path=9-32');
    const served = servedValues([[thin, F - 1], [small, F], [large, F + 10], [size, 2 * F + 9]]);
    // The smallest served `keys` part (`pattern`) goes with the facet rule; the `path` nesting then withholds `glob,path,pattern`, a second rule taking its turn after the first. The action's calls, which the
    // `fit` read gives, less the `path` size cell are then the withheld `pattern` cell, so the size cell goes too.
    expect(served).toEqual([]);
  });

  it('are not recovered from any combination of served totals', () => {
    // No one family holds a single unserved part here, yet `path,pattern` is the `path` size total plus the `pattern` size total less the action's calls (the `target` cells), inclusion and exclusion over the key lists.
    const cells: [ReturnType<typeof motifOf>, number][] = [
      [motifOf('keys', 'path'), F + 5],
      [motifOf('keys', 'path,pattern'), F - 1],
      [motifOf('keys', 'pattern'), F + 5],
      [motifOf('size', 'path=9-32'), 2 * F + 4],
      [motifOf('size', 'pattern=9-32'), 2 * F + 4],
      [motifOf('target', 'source'), 3 * F + 9],
    ];
    const stored: StoredPool = { cells: cells.map(([motif, clusters]) => cellOf(motif.motifId, clusters)), environment: [], motifs: cells.map(([motif]) => motif), strata: [] };
    const kept = new Set(bundleOf('claude-code', '2.1.314', stored, ONE_FLOOR).cells.map(({ motifId }) => motifId));
    expect(kept.size).toBeGreaterThan(0);
    expect(determinedCells(stored.cells, stored.motifs, (cell) => kept.has(cell.motifId))).toEqual([]);
  });

  // The same fixture with an `enum` cell as the key's only per-key facet. A boolean, and a list that names all its values, is a value of every call that sends the key, so its cells sum to the key's calls under any key name,
  // an open list's `model` included; if the facet counted only some calls it would stand apart from the `keys` cells and the bundle would serve what they recover.
  it.each([
    ['an exhaustive list', 'output_mode', 'count'],
    ['a boolean', 'replace_all', 'true'],
    ['a boolean under the key of an open list', 'model', 'true'],
  ])('are not recovered from the enum cell of %s, which sums to the calls that send the key', (_, key, member) => {
    const cells: [ReturnType<typeof motifOf>, number][] = [
      [motifOf('keys', key), F + 5],
      [motifOf('keys', [key, 'pattern'].sort().join(',')), F - 1],
      [motifOf('keys', 'pattern'), F + 5],
      [motifOf('enum', `${key}=${member}`), 2 * F + 4],
      [motifOf('size', 'pattern=9-32'), 2 * F + 4],
      [motifOf('target', 'source'), 3 * F + 9],
    ];
    const stored: StoredPool = { cells: cells.map(([motif, clusters]) => cellOf(motif.motifId, clusters)), environment: [], motifs: cells.map(([motif]) => motif), strata: [] };
    const kept = new Set(bundleOf('claude-code', '2.1.314', stored, ONE_FLOOR).cells.map(({ motifId }) => motifId));
    expect(kept.size).toBeGreaterThan(0);
    expect(determinedCells(stored.cells, stored.motifs, (cell) => kept.has(cell.motifId))).toEqual([]);
  });

  it('are all withheld in a system past the term cap, which the rank check does not run on', () => {
    // The cells of the combination fixture above. Under the default cap the rank check keeps some of them served; under a cap below the system's terms it is skipped and every served cell goes, which is safe whatever the system holds.
    const thin = motifOf('keys', 'path,pattern');
    const parts: [ReturnType<typeof motifOf>, number][] = [
      [motifOf('keys', 'path'), F + 5],
      [thin, F - 1],
      [motifOf('keys', 'pattern'), F + 5],
      [motifOf('size', 'path=9-32'), 2 * F + 4],
      [motifOf('size', 'pattern=9-32'), 2 * F + 4],
      [motifOf('target', 'source'), 3 * F + 9],
    ];
    const cells = parts.map(([motif, clusters]) => cellOf(motif.motifId, clusters));
    const motifs = parts.map(([motif]) => motif);
    expect(withheldOf(cells, motifs, at(F)).size).toBeLessThan(5);
    expect(withheldOf(cells, motifs, at(F), 4).size).toBe(5);
    expect([...withheldOf(cells, motifs, at(F), 4)].some((cell) => cell.motifId === thin.motifId)).toBe(false);
  });

  it("are not recovered from the action's calls, which the fit read gives", () => {
    // No `target` cell here, so no served cell holds the action's calls, but the `fit` read does (the action's one-step shape cell summed over models and exposure): with the `keys` cells withheld,
    // `path` is still those calls less the `pattern` size total.
    const served = servedValues([
      [motifOf('keys', 'path'), F - 1],
      [motifOf('keys', 'pattern'), F + 5],
      [motifOf('keys', 'path,pattern'), F + 5],
      [motifOf('size', 'path=9-32'), 2 * F + 4],
      [motifOf('size', 'pattern=9-32'), 2 * F + 10],
    ]);
    expect(served).toEqual([]);
  });
});

describe("an action's one-step shape cells", () => {
  const F = DEFAULT_PUBLIC_FLOOR;
  const shape = shapeMotif([{ action: 'file.search', identity: null }]);
  const source = classMotif(shapeClass('file.search', 'target', 'source'));
  const test = classMotif(shapeClass('file.search', 'target', 'test'));
  const onModel = (model: string, clusters: number): Cell => ({ ...cellOf(shape.motifId, clusters), frameBucket: `claude-code/2.1.31x/${model}` });

  it("sum over models to the action's calls, so a sub-floor model is not the served target cells less the other models", () => {
    const thin = onModel('model-b', F - 1);
    const wide = onModel('model-a', 2 * F + 1);
    const withheld = withheldOf([wide, thin, cellOf(source.motifId, 2 * F), cellOf(test.motifId, F)], [shape, source, test], at(F));
    expect([...withheld]).toEqual([wide]);
  });

  it('sum over exposure too, so a sub-floor exposed cell is not the served target cells less the unexposed one', () => {
    const thin = { ...onModel('model-a', F - 1), exposed: true };
    const wide = onModel('model-a', 2 * F + 1);
    expect([...withheldOf([wide, thin, cellOf(source.motifId, 2 * F), cellOf(test.motifId, F)], [shape, source, test], at(F))]).toEqual([wide]);
  });

  it('are not tied to a dropped cell, which only the calls with an unsent key reach', () => {
    const one = classMotif(shapeClass('file.search', 'dropped', '1'));
    const cells = [onModel('model-a', 30), cellOf(source.motifId, 20), cellOf(test.motifId, 10)];
    expect([...withheldOf([...cells, cellOf(one.motifId, 2)], [shape, source, test, one], at(F))]).toEqual([]);
    expect([...withheldOf([...cells, cellOf(one.motifId, 7)], [shape, source, test, one], at(F))]).toEqual([]);
  });

  const sentKey = (key: string): Motif => classMotif(shapeClass('agent.spawn', 'keys', key));
  const valueOf = (key: string, member: string): Motif => classMotif(shapeClass('agent.spawn', 'enum', `${key}=${member}`));

  it("keeps an open list's on-list values off the key's calls, which a custom agent's call is in too", () => {
    const motifs = [sentKey('subagent_type'), valueOf('subagent_type', 'Explore')];
    expect([...withheldOf([cellOf(motifs[0]?.motifId ?? '', 30), cellOf(motifs[1]?.motifId ?? '', 2)], motifs, at(F))]).toEqual([]);
  });
});

describe('every family of cells (`FAMILY_RULES`)', () => {
  // A seeded generator (mulberry32) over calls of one action: each call lands in the facet cells production gives it, in the shape cell, and in one named cell, by day and by week, so the cells are consistent with one another the way a real store is.
  const random = (seed: number): (() => number) => {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  };
  const KEY_SETS = [['path'], ['path', 'pattern'], ['pattern'], ['glob', 'path', 'pattern'], ['limit', 'path'], ['path', 'subagent_type'], ['output_mode', 'pattern']];
  const MODELS = ['model-a', 'model-b'];
  const FIRST_DAY = '2026-11-02';
  const DAYS = [FIRST_DAY, '2026-11-03', '2026-11-04'];
  const named = (tool: string): Motif => {
    const steps: WindowStep[] = [{ action: 'file.search', identity: { server: 'a', tool } }];
    return { motifId: namedId(steps), level: 'named', steps, cls: null };
  };
  const NAMES = ['one', 'two', 'three'].map(named);
  const SHAPE = shapeMotif([{ action: 'file.search', identity: null }]);
  const F = DEFAULT_PUBLIC_FLOOR;

  const bundleFrom = (seed: number): { held: Cell[]; motifs: Motif[] } => {
    const next = random(seed);
    const pick = <T>(list: readonly T[]): T => {
      const [chosen] = list.slice(Math.floor(next() * list.length));
      if (chosen === undefined) throw new Error('an empty list');
      return chosen;
    };
    const counts = new Map<string, { motif: Motif; day: string; frameBucket: string; exposed: boolean; n: number }>();
    const count = (motif: Motif, day: string, frameBucket = bucket, exposed = false): void => {
      const key = `${motif.motifId}/${frameBucket}/${String(exposed)}/${day}`;
      counts.set(key, { motif, day, frameBucket, exposed, n: (counts.get(key)?.n ?? 0) + 1 });
    };
    const calls = 12 + Math.floor(next() * 36);
    // Some actions have no `target` cells, so only the `fit` read pins their calls.
    const pinned = next() >= 0.3;
    for (let call = 0; call < calls; call += 1) {
      const day = pick(DAYS);
      const keys = pick(KEY_SETS);
      if (pinned) {
        count(classMotif(shapeClass('file.search', 'target', pick(['source', 'test', 'doc']))), day);
      }
      // Only some calls have an unsent key, and a `dropped` cell's value starts at 1.
      if (next() < 0.4) count(classMotif(shapeClass('file.search', 'dropped', pick(['1', '2']))), day);
      count(classMotif(shapeClass('file.search', 'keys', keys.join(','))), day);
      for (const key of keys) {
        count(classMotif(shapeClass('file.search', 'size', `${key}=${next() < 0.8 ? '9-32' : '1-8'}`)), day);
        count(classMotif(shapeClass('file.search', 'depth', `${key}=${pick(['0', '1', '2'])}`)), day);
      }
      // An exhaustive list: every call that sends the key has one `enum` cell, for the value it sent.
      if (keys.includes('output_mode')) count(classMotif(shapeClass('file.search', 'enum', `output_mode=${pick(['content', 'count'])}`)), day);
      // A custom agent's name is off the list, so only some of the calls that send the key have a cell.
      if (keys.includes('subagent_type') && next() < 0.6) count(classMotif(shapeClass('file.search', 'enum', `subagent_type=${pick(['Explore', 'Plan'])}`)), day);
      // The one-step shape and named cells are per model and per exposure; the facet cells above are on the version bucket, unexposed.
      const onModel = `claude-code/2.1.31x/${pick(MODELS)}`;
      const exposed = next() < 0.2;
      count(SHAPE, day, onModel, exposed);
      count(pick(NAMES), day, onModel, exposed);
    }
    const cells: Cell[] = [];
    const weeks = new Map<string, Cell>();
    for (const { motif, day, frameBucket, exposed, n } of counts.values()) {
      cells.push({ ...cellOf(motif.motifId, n), frameBucket, exposed, grain: 'day', day });
      const at = `${motif.motifId}/${frameBucket}/${String(exposed)}`;
      const week = weeks.get(at);
      if (week === undefined) weeks.set(at, { ...cellOf(motif.motifId, n), frameBucket, exposed, day: FIRST_DAY });
      else weeks.set(at, { ...week, clusters: week.clusters + n, sessions: week.sessions + n, ok: week.ok + n });
    }
    return { held: [...cells, ...weeks.values()], motifs: [...new Map([...counts.values()].map(({ motif }) => [motif.motifId, motif])).values()] };
  };

  it('leaves no unserved cell that a combination of served cells determines', () => {
    let withheldSome = 0;
    const broken: string[] = [];
    for (let seed = 1; seed <= 400; seed += 1) {
      const { held, motifs } = bundleFrom(seed);
      const withheld = withheldOf(held, motifs, at(F));
      if (withheld.size > 0) withheldSome += 1;
      const determined = determinedCells(held, motifs, (cell) => cell.clusters >= F && !withheld.has(cell));
      if (determined.length > 0) broken.push(`seed ${String(seed)}: ${String(determined.length)} determined`);
    }
    expect(withheldSome).toBeGreaterThan(100);
    expect(broken).toEqual([]);
  });

  it('withholds the same cells elsewhere with or without the dropped and open-list cells, which no other cell sums with', () => {
    const own = (motif: Motif | undefined): boolean => motif?.cls?.includes('/dropped/') === true || motif?.cls?.includes('/enum/subagent_type=') === true;
    const moved: string[] = [];
    for (let seed = 1; seed <= 400; seed += 1) {
      const { held, motifs } = bundleFrom(seed);
      const motifOf = new Map(motifs.map((motif) => [motif.motifId, motif]));
      const outside = held.filter((cell) => !own(motifOf.get(cell.motifId)));
      const withheld = [...withheldOf(held, motifs, at(F))].filter((cell) => !own(motifOf.get(cell.motifId)));
      const without = withheldOf(outside, motifs, at(F));
      if (withheld.length !== without.size || withheld.some((cell) => !without.has(cell))) moved.push(`seed ${String(seed)}`);
    }
    expect(moved).toEqual([]);
  });

  it('never serves a key facet in full beside exactly one unserved keys cell that holds the key', () => {
    // The nesting read straight from the cells: the total of a key's `size` cells, of its `depth` cells, and of its `enum` cells is the sum of the `keys` cells that hold it.
    const broken: string[] = [];
    for (let seed = 1; seed <= 400; seed += 1) {
      const { held, motifs } = bundleFrom(seed);
      const withheld = withheldOf(held, motifs, at(F));
      const served = (cell: Cell): boolean => cell.clusters >= F && !withheld.has(cell);
      const classOf = (cell: Cell): string[] => (motifs.find((motif) => motif.motifId === cell.motifId)?.cls ?? '').replace('shape:file.search/', '').split('/');
      for (const grain of ['day', 'week'] as const) {
        for (const day of grain === 'day' ? DAYS : [FIRST_DAY]) {
          const here = held.filter((cell) => cell.grain === grain && cell.day === day);
          const keysCells = here.filter((cell) => classOf(cell)[0] === 'keys');
          for (const key of ['path', 'pattern', 'glob', 'limit', 'output_mode']) {
            const holding = keysCells.filter((cell) => classOf(cell)[1]?.split(',').includes(key));
            const hidden = holding.filter((cell) => !served(cell)).length;
            for (const facet of ['size', 'depth', 'enum']) {
              const facetCells = here.filter((cell) => classOf(cell)[0] === facet && classOf(cell)[1]?.startsWith(`${key}=`));
              if (facetCells.length > 0 && facetCells.every(served) && hidden === 1) broken.push(`seed ${String(seed)} ${grain} ${day} ${facet} ${key}`);
            }
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
