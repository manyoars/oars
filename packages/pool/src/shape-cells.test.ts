// The pool serves a call's shape cells (layer 0): a target class, an argument class, and a count of unsent key names are closed lists, so their cells are `clear` and served at the clear floor;
// the sorted key names are a long tail, so their cell is `thresholded` and served only at the public floor. The bundle's `fit` reads cite them.
import { describe, expect, it } from 'vitest';
import { NO_AXES, shapeClass, type Cell } from '../../cli/src/sessions/cells.js';
import { classMotif, namedId, shapeMotif, type Motif, type WindowStep } from '../../cli/src/sessions/motif.js';
import { cellClassOf } from './cell-class.js';
import { familiesOf, withheldOf } from './complement.js';
import { bundleOf } from './derive.js';
import { DEFAULT_FLOORS, DEFAULT_PUBLIC_FLOOR } from './floors.js';
import type { StoredPool } from './stored.js';

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
    expect(served(DEFAULT_PUBLIC_FLOOR - 1)).toEqual([]);
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
  // The cells of a partition facet (`target`, `keys`, `dropped`, and a keyed facet for one key) split the same calls, so a fully served facet less another's served parts would give a sub-floor cell's exact count.
  const motifOf = (facet: Parameters<typeof shapeClass>[1], value: string) => classMotif(shapeClass('file.read', facet, value));
  const servedValues = (cells: [ReturnType<typeof motifOf>, number][]): string[] => {
    const stored: StoredPool = { cells: cells.map(([motif, clusters]) => cellOf(motif.motifId, clusters)), environment: [], motifs: cells.map(([motif]) => motif), strata: [] };
    const held = bundleOf('claude-code', '2.1.314', stored, DEFAULT_FLOORS);
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
    const held = bundleOf('claude-code', '2.1.314', stored, DEFAULT_FLOORS);
    return held.cells.map(({ motifId }) => held.motifs.find((motif) => motif.motifId === motifId)?.cls ?? '').sort();
  };

  it('are parts of that key facets, so a sub-floor keys cell is not recovered from a key size cell', () => {
    // Every `path` value falls in one size bucket, so that facet has no sub-floor part; its total less the served keys cells that hold `path` would be the sub-floor `path,pattern` cell.
    const thin = motifOf('keys', 'path,pattern');
    const small = motifOf('keys', 'pattern');
    const large = motifOf('keys', 'glob,path,pattern');
    const size = motifOf('size', 'path=9-32');
    const served = servedValues([[thin, F - 1], [small, F], [large, F + 10], [size, 2 * F + 9]]);
    // The smallest served `keys` part (`pattern`) goes with the facet rule; the `path` nesting then withholds `glob,path,pattern`, a second rule taking its turn after the first.
    expect(served).toEqual([size.cls]);
  });
});

describe('every family of cells (`FAMILY_RULES`)', () => {
  // A seeded generator (mulberry32) over calls of one action: each call lands in one cell of every partition facet, in the shape cell, and in one named cell, by day and by week, so the cells are consistent with one another the way a real store is.
  const random = (seed: number): (() => number) => {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  };
  const KEY_SETS = [['path'], ['path', 'pattern'], ['pattern'], ['glob', 'path', 'pattern'], ['limit', 'path']];
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
    const counts = new Map<string, { motif: Motif; day: string; n: number }>();
    const count = (motif: Motif, day: string): void => {
      const key = `${motif.motifId}/${day}`;
      counts.set(key, { motif, day, n: (counts.get(key)?.n ?? 0) + 1 });
    };
    const calls = 12 + Math.floor(next() * 36);
    for (let call = 0; call < calls; call += 1) {
      const day = pick(DAYS);
      const keys = pick(KEY_SETS);
      count(classMotif(shapeClass('file.search', 'target', pick(['source', 'test', 'doc']))), day);
      count(classMotif(shapeClass('file.search', 'dropped', pick(['0', '1']))), day);
      count(classMotif(shapeClass('file.search', 'keys', keys.join(','))), day);
      for (const key of keys) {
        count(classMotif(shapeClass('file.search', 'size', `${key}=${next() < 0.8 ? '9-32' : '1-8'}`)), day);
        count(classMotif(shapeClass('file.search', 'depth', `${key}=${pick(['0', '1', '2'])}`)), day);
      }
      count(SHAPE, day);
      count(pick(NAMES), day);
    }
    const cells: Cell[] = [];
    const weeks = new Map<string, Cell>();
    for (const { motif, day, n } of counts.values()) {
      cells.push({ ...cellOf(motif.motifId, n), grain: 'day', day });
      const week = weeks.get(motif.motifId);
      if (week === undefined) weeks.set(motif.motifId, { ...cellOf(motif.motifId, n), day: FIRST_DAY });
      else weeks.set(motif.motifId, { ...week, clusters: week.clusters + n, sessions: week.sessions + n, ok: week.ok + n });
    }
    return { held: [...cells, ...weeks.values()], motifs: [...new Map([...counts.values()].map(({ motif }) => [motif.motifId, motif])).values()] };
  };

  it('never serves a whole beside exactly one part that is under the floor or withheld', () => {
    let withheldSome = 0;
    const broken: string[] = [];
    for (let seed = 1; seed <= 400; seed += 1) {
      const { held, motifs } = bundleFrom(seed);
      const withheld = withheldOf(held, motifs, F);
      if (withheld.size > 0) withheldSome += 1;
      const served = (cell: Cell): boolean => cell.clusters >= F && !withheld.has(cell);
      for (const { rule, whole, parts } of familiesOf(held, motifs)) {
        const hidden = parts.filter((part) => !served(part));
        // A family with no whole cell has its total in another read, so a served part stands for it.
        if ((whole === null ? parts.some(served) : served(whole)) && hidden.length === 1) broken.push(`${rule} ${hidden.map((part) => (part.clusters < F ? 'sub' : 'withheld')).join()}`);
      }
    }
    expect(withheldSome).toBeGreaterThan(100);
    expect(broken).toEqual([]);
  });

  it('never serves a key facet in full beside exactly one unserved keys cell that holds the key', () => {
    // The nesting read straight from the cells, not from the table: the total of a key's `size` cells is the sum of the `keys` cells that hold it.
    const broken: string[] = [];
    for (let seed = 1; seed <= 400; seed += 1) {
      const { held, motifs } = bundleFrom(seed);
      const withheld = withheldOf(held, motifs, F);
      const served = (cell: Cell): boolean => cell.clusters >= F && !withheld.has(cell);
      const classOf = (cell: Cell): string[] => (motifs.find((motif) => motif.motifId === cell.motifId)?.cls ?? '').replace('shape:file.search/', '').split('/');
      for (const grain of ['day', 'week'] as const) {
        for (const day of grain === 'day' ? DAYS : [FIRST_DAY]) {
          const here = held.filter((cell) => cell.grain === grain && cell.day === day);
          const keysCells = here.filter((cell) => classOf(cell)[0] === 'keys');
          for (const key of ['path', 'pattern', 'glob', 'limit']) {
            const sizes = here.filter((cell) => classOf(cell)[0] === 'size' && classOf(cell)[1]?.startsWith(`${key}=`));
            const holding = keysCells.filter((cell) => classOf(cell)[1]?.split(',').includes(key));
            const hidden = holding.filter((cell) => !served(cell)).length;
            if (sizes.length > 0 && sizes.every(served) && hidden === 1) broken.push(`seed ${String(seed)} ${grain} ${day} ${key}`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
