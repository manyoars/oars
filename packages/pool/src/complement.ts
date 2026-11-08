// Complementary withholding. A whole and its parts count the same steps: a week cell and the day cells of its days, and a shape cell and the named cells that share its actions. Serving the whole beside
// all of its served parts would show the parts that are not served by subtraction, a sub-floor day or name among them. So where a served whole has a sub-floor part, one more part is withheld, the
// smallest served one: the whole less the served parts is then a sum over at least two parts, one of them at or above the floor, which no reader can split. The whole and the other parts stay, so a thin
// pool still serves what it can. Families also combine (the served totals of several can add and subtract to an unserved cell), so a rank check then withholds until the served cells determine no unserved one
// (`withheldOf`). Where a sub-floor part is held to a higher floor than its whole (a long-tail name under a clear shape), the part withheld must be at or above that higher floor on the accounts that have stood, since a clear part is served at the lower clear floor; with none, the whole is withheld. The same holds for a total no cell holds (an action's calls,
// which its one-step shape cells sum to over models, a long-tail model beside a listed one): with no such part, the smallest served part of each other family that counts that total is withheld, and a family with neither a whole nor a total is left alone.
// The environment cells (`environmentOf`, `stored.ts`) keep their own rule, every part served or the total is not (each part against its own class's floor), and their counterparts are also dropped when a bucket cell is withheld (`bundleOf`).
import { argFeaturesOf } from '../../cli/src/sessions/call-shape.js';
import { isEnvironmentCell, NO_AXES, parseShapeClass, weekStartOf, type Cell, type ShapeFacet } from '../../cli/src/sessions/cells.js';
import { targetOf } from '../../cli/src/sessions/extract.js';
import type { Motif } from '../../cli/src/sessions/motif.js';
import { OPEN_LIST_KEYS } from '../../cli/src/sessions/public-vocabulary.js';
import { clears, clustersOf } from './floors.js';

/** What `withheldOf` needs to know of a cell: the floor it is served at, and its count of the accounts that have stood (`clusters` as stored), which a cell served on a count of every account (`countsEvery`) does not carry. */
export interface Floorplan {
  floorOf: (cell: Cell) => number;
  standingOf: (cell: Cell) => number;
}

interface Family {
  /** The name of the `FAMILY_RULES` rule that made it. */
  rule: string;
  whole: Cell | null;
  /** Where the family has no whole cell, the count its parts sum to that no cell holds (an action's calls, the calls that send a key, or a count of its own), shared by the families that sum to it: an unknown of the rank check (`determinedOf`). */
  total: string | null;
  parts: Cell[];
  /** The families that count the same total (`Placement.echoes`), once all are built. */
  echoes: Family[];
}

/** One cell's place in one family: the whole of it or a part of it. */
interface Placement {
  family: string;
  role: 'whole' | 'part';
  /** The family's `total`. */
  total?: string;
  /** Families that count the same total as this one (the per-key facets of a key's `keys` cells): where this family's lone part has no served part beside it, they are the other ways to read it. */
  echoes?: string[];
}

/** The key of the family of one partition facet: the facet's cells for an action, key (for a keyed facet), frame, grain, day, and exposure. */
const facetFamilyKey = (action: string, facet: ShapeFacet, key: string, cell: Cell): string => JSON.stringify(['facet', action, facet, key, cell.frameBucket, cell.grain, cell.day, cell.exposed]);

/**
 * The calls of an action (`key` empty), or of an action that send a key, in one frame, grain, day, and exposure: the total of a partition facet and of a key's nesting family. An action's calls are tagged apart
 * (`ACTION_CALLS`) because a reader has them from the `fit` read: the `action-calls` rule ties them to the action's one-step shape cells, and where no such cell is held the rank check counts them as known.
 */
const callsTotal = (action: string, key: string, cell: Pick<Cell, 'frameBucket' | 'grain' | 'day' | 'exposed'>): string =>
  JSON.stringify([key === '' ? ACTION_CALLS : 'key-calls', action, key, cell.frameBucket, cell.grain, cell.day, cell.exposed]);

const ACTION_CALLS = 'action-calls';

/** Whether a total (`callsTotal`) is an action's calls. */
const isActionCalls = (total: string): boolean => total.startsWith(`["${ACTION_CALLS}"`);

/** The calls of an action that have a path target, in one frame, grain, day, and exposure: the total the `target-keys` rule's two families share. */
const pathCalls = (action: string, cell: Pick<Cell, 'frameBucket' | 'grain' | 'day' | 'exposed'>): string => JSON.stringify(['path-calls', action, cell.frameBucket, cell.grain, cell.day, cell.exposed]);

/** Whether a call that sends this key has a path target, asked of the emitter (`targetOf`) so the list of path keys is not restated. */
const sendsPath = (key: string): boolean => targetOf('', { [key]: 'x' }, undefined, '', (value) => value).target !== null;

/** The tag of `ownCalls`, so no key name can make the same total and it is never an action's calls. */
const OWN_CALLS = 'own-calls';

/** The calls a facet's cells split where those are not all of the action's or the key's: no other cell holds this count, so the facet's equation leaves its cells free of every other family's. */
const ownCalls = (action: string, facet: ShapeFacet, key: string, cell: Pick<Cell, 'frameBucket' | 'grain' | 'day' | 'exposed'>): string =>
  JSON.stringify([OWN_CALLS, action, facet, key, cell.frameBucket, cell.grain, cell.day, cell.exposed]);

/** Whether a facet counts only some of the calls its total would name: `dropped` only the calls with an unsent key, and the `enum` of a list that is not exhaustive only its on-list values. A boolean is always closed, under any key. */
const countsOnlySome = (facet: ShapeFacet, value: string): boolean => {
  if (facet === 'dropped') return true;
  const member = value.slice(value.indexOf('=') + 1);
  return facet === 'enum' && OPEN_LIST_KEYS.has(value.slice(0, value.indexOf('='))) && member !== 'true' && member !== 'false';
};

/**
 * The facets whose cells do not overlap: a call counts in at most one cell of each. `target` splits the action's calls (a call with no path reads `none`). `keys` splits the calls that sent a key, and is taken as the
 * action's calls, which it equals for a tool with a required key and which elsewhere can only withhold more. `dropped` splits only the calls with an unsent key (`ownCalls`). Per key (a value is `<key>=<member>`): `size`, `depth`,
 * `extension`, and `dir` split the calls that send the key with a value of their kind, taken as all of them, and `enum` splits them for a boolean or an exhaustive list and only its on-list values for an open one (`ownCalls`).
 * The others (`arg`, `pattern`, `change`) hold a call in several cells or none, so their cells are not parts of one count; the one exception is `arg/none`, which the `facet` rule below places in the `keys` family. A superset of the true equations determines more, never less, so taking a sum for a larger one only withholds more.
 */
const FACET_PARTITIONS: ReadonlyMap<ShapeFacet, boolean> = new Map([['target', false], ['keys', false], ['dropped', false], ['size', true], ['depth', true], ['extension', true], ['dir', true], ['enum', true]]);

/** The facets that carry a key in their values. */
const KEYED_FACETS: readonly ShapeFacet[] = [...FACET_PARTITIONS].filter(([, keyed]) => keyed).map(([facet]) => facet);

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The fewest accounts first, then the earliest day, then the motif, so the choice is the same for the same cells. */
const smallest = (a: Cell, b: Cell): number => clustersOf(a) - clustersOf(b) || compare(a.day, b.day) || compare(a.motifId, b.motifId);

/**
 * Every way a cell counts inside another count, one rule each; `familiesOf` reads this table for both the local rules and the rank check. The oracle (`withholding-oracle.test.ts`) derives the relations from the
 * emitter, so a relation this table leaves out shows there as a leak. A rule names the
 * families a cell belongs to and whether it is the whole of one (a cell holding the family's total) or a part of it; a family with no whole cell has a total the reader still has from another read.
 */
const FAMILY_RULES: readonly { name: string; placements: (cell: Cell, motif: Motif | undefined) => Placement[] }[] = [
  // The class cells of one facet partition (`FACET_PARTITIONS`) split one count, named there for each facet; the total is not a cell of the family.
  {
    name: 'facet',
    placements: (cell, motif) => {
      const parsed = motif === undefined || motif.cls === null ? null : parseShapeClass(motif.cls);
      if (parsed === null) return [];
      // `arg/none` is the calls that send no value, so beside the `keys` cells (the calls that send a key) it splits the action's calls: it is a part of the `keys` family. A call whose keys are all null is in both, and a call
      // with only an unsent key in neither; the sum is then not exact, in the direction that only withholds more (the oracle, `withholding-oracle.test.ts`, is what checks it).
      const facet: ShapeFacet = parsed.facet === 'arg' && parsed.value === 'none' ? 'keys' : parsed.facet;
      const keyed = FACET_PARTITIONS.get(facet);
      if (keyed === undefined) return [];
      const key = keyed ? parsed.value.slice(0, parsed.value.indexOf('=')) : '';
      return [{ family: facetFamilyKey(parsed.action, facet, key, cell), role: 'part', total: countsOnlySome(facet, parsed.value) ? ownCalls(parsed.action, facet, key, cell) : callsTotal(parsed.action, key, cell) }];
    },
  },
  // A path with no folder below the root has depth `0` and folder kind `root` (`call-shape.ts:130,174`), so a key's `depth` `0` cell and its `dir` `root` cell count the same calls: one equation, which the two facets' own
  // families cannot state because each holds only its own facet's cells.
  {
    name: 'depth-dir',
    placements: (cell, motif) => {
      const parsed = motif === undefined || motif.cls === null ? null : parseShapeClass(motif.cls);
      if (parsed === null || (parsed.facet !== 'depth' && parsed.facet !== 'dir')) return [];
      const at = parsed.value.indexOf('=');
      if (parsed.value.slice(at + 1) !== (parsed.facet === 'depth' ? '0' : 'root')) return [];
      return [{ family: JSON.stringify(['depth-dir', parsed.action, parsed.value.slice(0, at), cell.frameBucket, cell.grain, cell.day, cell.exposed]), role: parsed.facet === 'depth' ? 'whole' : 'part' }];
    },
  },
  // A key's `size` cell is the whole of its `enum` cells whose member's length falls in that size, for a boolean-free exhaustive list: every call that sends the key sends a listed value, so the calls in a size are the calls of
  // the members of that length. `files_with_matches` alone is 18 characters, so `size output_mode=9-32` and `enum output_mode=files_with_matches` count the same calls. An open list is not such a whole: an off-list value
  // has a size and no `enum` cell (`countsOnlySome`).
  {
    name: 'enum-size',
    placements: (cell, motif) => {
      const parsed = motif === undefined || motif.cls === null ? null : parseShapeClass(motif.cls);
      if (parsed === null || (parsed.facet !== 'size' && parsed.facet !== 'enum')) return [];
      const at = parsed.value.indexOf('=');
      const key = parsed.value.slice(0, at);
      const member = parsed.value.slice(at + 1);
      if (parsed.facet === 'enum' && (countsOnlySome('enum', parsed.value) || member === 'true' || member === 'false')) return [];
      // The size the emitter itself gives the member, so the buckets are not restated here.
      const size = parsed.facet === 'size' ? member : argFeaturesOf('', { [key]: member }, undefined)[0]?.valueSize;
      return [{ family: JSON.stringify(['enum-size', parsed.action, key, size, cell.frameBucket, cell.grain, cell.day, cell.exposed]), role: parsed.facet === 'size' ? 'whole' : 'part' }];
    },
  },
  // The calls that send a key k are split by the `keys` cells whose list holds k, and by each per-key facet of k: the `keys` cells that hold k are parts of those facets' total.
  {
    name: 'key-nesting',
    placements: (cell, motif) => {
      const parsed = motif === undefined || motif.cls === null ? null : parseShapeClass(motif.cls);
      if (parsed === null || parsed.facet !== 'keys') return [];
      return parsed.value.split(',').map((key) => ({
        family: JSON.stringify(['key-nesting', parsed.action, key, cell.frameBucket, cell.grain, cell.day, cell.exposed]),
        role: 'part' as const,
        total: callsTotal(parsed.action, key, cell),
        echoes: KEYED_FACETS.map((facet) => facetFamilyKey(parsed.action, facet, key, cell)),
      }));
    },
  },
  // A call has a path target (a `target` class other than `none`) exactly when it sends a path key, so the `target` cells other than `none` and the `keys` cells that hold a path key count the same calls: one equation,
  // which neither facet's own family states (the `target` family adds `none` and sums to the action's calls; a `keys` cell is a part of its keys' nesting families). Which keys are path keys is the emitter's own
  // answer (`sendsPath`). A call that sends a path key with an empty or non-string value is in a `keys` cell and has no path target, so the sum can only withhold more.
  {
    name: 'target-keys',
    placements: (cell, motif) => {
      const parsed = motif === undefined || motif.cls === null ? null : parseShapeClass(motif.cls);
      if (parsed === null) return [];
      const withPath = parsed.facet === 'target' ? parsed.value !== 'none' : parsed.facet === 'keys' && parsed.value.split(',').some(sendsPath);
      if (!withPath) return [];
      return [{ family: JSON.stringify(['target-keys', parsed.action, parsed.facet, cell.frameBucket, cell.grain, cell.day, cell.exposed]), role: 'part', total: pathCalls(parsed.action, cell) }];
    },
  },
  // An action's one-step shape cells, per model (`harness/version/model`) and exposure, sum to the calls its facet cells split on the version bucket (`harness/version/-`, unexposed): the total the `fit` read gives.
  // A one-step shape cell counts every step and a facet cell one per call by its first step, so the two are equal only where each call has one step; elsewhere the tie can only withhold more.
  {
    name: 'action-calls',
    placements: (cell, motif) => {
      const [step, ...more] = motif?.level === 'shape' && !isEnvironmentCell(cell) ? motif.steps : [];
      if (step === undefined || more.length > 0) return [];
      const [harness, version] = cell.frameBucket.split('/');
      const versionCell = { ...cell, frameBucket: [harness, version, NO_AXES].join('/'), exposed: false };
      return [{ family: JSON.stringify(['action-calls', step.action, versionCell.frameBucket, cell.grain, cell.day]), role: 'part', total: callsTotal(step.action, '', versionCell) }];
    },
  },
  // A week cell is the whole of the day cells of its motif, frame, exposure, and week.
  { name: 'week', placements: (cell) => [{ family: JSON.stringify(['week', cell.motifId, cell.frameBucket, cell.exposed, cell.grain === 'week' ? cell.day : weekStartOf(cell.day)]), role: cell.grain === 'week' ? 'whole' : 'part' }] },
  // A shape cell is the whole of the named cells of its actions in the same frame, grain, day, and exposure. A program with flags or pulls has its own rule and is left out.
  {
    name: 'shape-name',
    placements: (cell, motif) => {
      if (motif === undefined || motif.level === 'class') return [];
      if (motif.steps.some(({ identity }) => identity !== null && 'program' in identity && (identity.flags.length > 0 || (identity.pulls?.length ?? 0) > 0))) return [];
      return [{ family: JSON.stringify(['shape-name', motif.steps.map((step) => step.action), cell.frameBucket, cell.grain, cell.day, cell.exposed]), role: motif.level === 'shape' ? 'whole' : 'part' }];
    },
  },
];

/** Every family of the held cells, built from `FAMILY_RULES`. */
const familiesOf = (held: readonly Cell[], motifs: readonly Motif[]): Family[] => {
  const levels = new Map(motifs.map((motif) => [motif.motifId, motif]));
  // One map per rule, so the families come out in the table's order: the facet and nesting rules, then the week and the shape rules, which a withheld part can feed in turn.
  const byRule = FAMILY_RULES.map((rule) => ({ rule, families: new Map<string, Family>() }));
  const byKey = new Map<string, Family>();
  const echoed = new Map<Family, Set<string>>();
  for (const cell of held) {
    for (const { rule, families } of byRule) {
      for (const { family, role, total, echoes } of rule.placements(cell, levels.get(cell.motifId))) {
        const made = families.get(family) ?? { rule: rule.name, whole: null, total: total ?? null, parts: [], echoes: [] };
        families.set(family, made);
        byKey.set(family, made);
        if (role === 'whole') made.whole = cell;
        else made.parts.push(cell);
        if (echoes !== undefined) echoed.set(made, new Set([...(echoed.get(made) ?? []), ...echoes]));
      }
    }
  }
  // Only a family that counts the same total echoes: a key's open-list `enum` counts fewer calls than its `keys` cells do.
  for (const [family, keys] of echoed) family.echoes = [...keys].flatMap((key) => byKey.get(key) ?? []).filter(({ total }) => total === family.total);
  return byRule.flatMap(({ families }) => [...families.values()]);
};

/**
 * The local rules, one family at a time. A cell is served when it clears its own floor (`Floorplan.floorOf`): a `clear` cell's is lower than a `thresholded` one's (`cellFloor`). A family (`FAMILY_RULES`) needs one more part
 * withheld, its smallest served one, in two cases: it holds a sub-floor part and none of its parts is withheld yet, or exactly one of its parts is unserved, sub-floor or withheld by another family. A withheld part is at or
 * above the floor but still hides a count another family protects, so a family that leaves it as the one unserved part would give it back by subtraction, and the sub-floor cell it shields with it. The whole of a family
 * stays when it has one. A cell can be a part of one family and the whole of another, so the rule repeats until it adds nothing. Where a lone unserved part has no served part beside it, the whole is withheld instead:
 * it is that part's count. A family with neither a whole nor a total states no count to subtract from, so it is left alone.
 *
 * A sub-floor part held to a higher floor than the lowest of its family (a long-tail name under a clear shape, which carries no identity; a long-tail model beside a listed one in an action's one-step shape cells) is not
 * hidden by withholding a part that is served only on that lower floor: a part that hides it, withheld already or withheld now, must itself be at or above that bar on the accounts that have stood (`Floorplan.standingOf`),
 * or the count less the served parts could be that part alone. With none, a family with a whole withholds the whole; a family with a total no cell holds (the calls its parts sum to) withholds the smallest served part of
 * each family that counts the same total, since a reader reads that total from those cells (`byTotal`).
 */
const withholdLocally = (families: readonly Family[], byTotal: ReadonlyMap<string, readonly Family[]>, withheld: Set<Cell>, { floorOf, standingOf }: Floorplan): void => {
  const served = (cell: Cell): boolean => clears(cell, floorOf(cell));
  for (let changed = true; changed; ) {
    changed = false;
    for (const family of families) {
      const { whole, total, parts, echoes } = family;
      if (whole === null && total === null) continue;
      if (whole !== null && (!served(whole) || withheld.has(whole))) continue;
      const bar = Math.max(0, ...parts.filter((part) => !served(part)).map(floorOf));
      const guarded = bar > (whole === null ? parts.reduce((lowest, part) => Math.min(lowest, floorOf(part)), Infinity) : floorOf(whole));
      // In a guarded family a part withheld on a lower floor does not hide the sub-floor part.
      const hides = (part: Cell): boolean => !guarded || standingOf(part) >= bar;
      const unserved = parts.filter((part) => !served(part) || withheld.has(part));
      const thin = parts.some((part) => !served(part)) && !parts.some((part) => withheld.has(part) && hides(part));
      if (!thin && unserved.length !== 1) continue;
      const [next] = parts.filter((part) => served(part) && !withheld.has(part) && hides(part)).sort(smallest);
      if (next !== undefined) {
        withheld.add(next);
        changed = true;
        continue;
      }
      if (guarded) {
        // The total is read from the other families that count it, each of which gives up its smallest served part unless one of its parts is withheld already.
        const gone = whole !== null ? [whole] : (byTotal.get(total ?? '') ?? []).flatMap((other) => (other === family || other.parts.some((part) => withheld.has(part)) ? [] : other.parts.filter((part) => served(part)).sort(smallest).slice(0, 1)));
        for (const cell of gone) {
          withheld.add(cell);
          changed = true;
        }
        continue;
      }
      if (unserved.length !== 1) continue;
      // With no served part left to join it, a lone unserved part equals its whole, so the whole goes too; and it equals the total that the families echoing it count, so each of those gives up its smallest served part.
      for (const gone of [whole, ...echoes.map((echo) => echo.parts.filter((part) => served(part) && !withheld.has(part)).sort(smallest)[0])]) {
        if (gone === null || gone === undefined || withheld.has(gone)) continue;
        withheld.add(gone);
        changed = true;
      }
    }
  }
};

/** A term of an equation: a held cell, or a total no cell holds (`Family.total`). */
type Term = Cell | string;

/** An equation over terms, as each term's integer coefficient; the equation states that the sum is zero. */
type Row = Map<Term, bigint>;

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));

/** `row` with `column` eliminated by `pivot` (which holds `column`): `row` times the pivot's coefficient less `pivot` times the row's, in lowest terms, so the arithmetic stays exact in integers. */
const eliminate = (row: Row, pivot: Row, column: Term): Row => {
  const scale = pivot.get(column) ?? 1n;
  const factor = row.get(column) ?? 0n;
  const result: Row = new Map();
  for (const term of new Set([...row.keys(), ...pivot.keys()])) {
    const coefficient = (row.get(term) ?? 0n) * scale - (pivot.get(term) ?? 0n) * factor;
    if (coefficient !== 0n) result.set(term, coefficient);
  }
  const divisor = [...result.values()].reduce(gcd, 0n);
  return new Map([...result].map(([term, coefficient]) => [term, coefficient / divisor]));
};

/**
 * The unserved cells that the served cells determine, each with the reduced equation that gives it. Gauss-Jordan elimination over the unknowns only (the unserved cells and the totals), so a served cell is never
 * a pivot: an unserved cell is determined when its column is a pivot whose row holds no other unknown, and that row is the cell as a combination of served cells.
 */
const determinedOf = (equations: readonly Row[], known: (term: Term) => boolean): Map<Cell, Row> => {
  const pivots = new Map<Term, Row>();
  for (const equation of equations) {
    let row = equation;
    // A pivot row holds no other pivot's column, so reducing by one never brings back a column already reduced.
    for (const column of [...row.keys()]) {
      const pivot = pivots.get(column);
      if (pivot !== undefined) row = eliminate(row, pivot, column);
    }
    const column = [...row.keys()].find((term) => !known(term));
    if (column === undefined) continue;
    for (const [other, pivot] of pivots) if (pivot.has(column)) pivots.set(other, eliminate(pivot, row, column));
    pivots.set(column, row);
  }
  return new Map([...pivots].flatMap(([column, row]): [Cell, Row][] => (typeof column !== 'string' && [...row.keys()].every((term) => term === column || known(term)) ? [[column, row]] : [])));
};

/** One equation per family: its whole, or its total where it has none, less its parts. A whole with no part held (a shape cell, which has no day cells) states nothing. Grouped into the sets that share no term. */
const systemsOf = (families: readonly Family[]): Row[][] => {
  const equations = families.flatMap(({ whole, total, parts }): Row[] => {
    const head = whole ?? total;
    if (head === null || parts.length === 0) return [];
    const row: Row = new Map([[head, 1n]]);
    for (const part of parts) row.set(part, (row.get(part) ?? 0n) - 1n);
    return [row];
  });
  // Union-find over the terms, so each elimination runs over one connected set of cells.
  const parent = new Map<Term, Term>();
  const root = (term: Term): Term => {
    const up = parent.get(term) ?? term;
    if (up === term) return term;
    const top = root(up);
    parent.set(term, top);
    return top;
  };
  for (const row of equations) {
    const [first, ...rest] = [...row.keys()].map(root);
    for (const term of rest) if (first !== undefined && term !== first) parent.set(term, first);
  }
  const systems = new Map<Term, Row[]>();
  for (const row of equations) {
    const [head] = row.keys();
    if (head === undefined) continue;
    const key = root(head);
    const system = systems.get(key) ?? [];
    systems.set(key, system);
    system.push(row);
  }
  return [...systems.values()];
};

/** The terms (cells and totals) of one system past which the rank check does not run (`withheldOf`). */
export const MAX_SYSTEM_TERMS = 5000;

/**
 * The served cells to leave out of a bundle, given every held cell (so a sub-floor part is seen) and the floor each cell is held to (`Floorplan`). First the local rules (`withholdLocally`); then the rank check, because served totals combine
 * across families (a sub-floor `keys` cell is one key's `size` total plus another's less the action's calls, though no one family holds it alone). Every family states one linear equation, and while the served cells
 * determine any unserved cell (`determinedOf`), the smallest served cell of its equation that shares a family with it is withheld (any served cell of its equation where none does), and both stages repeat.
 * A system of more than `maxTerms` terms is not eliminated, because the work grows faster than its size: measured, a long-tail action of 4,000 `keys` cells took 1.8 s and one of 13,000 took 10 s, against a Worker's CPU
 * limit. Nothing can be shown determined or not in such a system, so every served cell of it is withheld, which is safe and costs that action's facet, one-step shape, and named cells, day and week, for that week and version bucket.
 */
export const withheldOf = (held: readonly Cell[], motifs: readonly Motif[], plan: Floorplan, maxTerms = MAX_SYSTEM_TERMS): Set<Cell> => {
  const { floorOf } = plan;
  // The one-step shape cells tie an action's calls only where its shape cells split them, so an action with no shape cells keeps its shape cells out of this rule.
  const every = familiesOf(held, motifs);
  const split = new Set(every.flatMap(({ rule, total }) => (rule === 'facet' && total !== null && isActionCalls(total) ? [total] : [])));
  const families = every.filter(({ rule, total }) => rule !== 'action-calls' || (total !== null && split.has(total)));
  // An action's calls the `fit` read gives: through its one-step shape cells where they are held, and as known where they are not.
  const tied = new Set(families.flatMap(({ rule, total }) => (rule === 'action-calls' && total !== null ? [total] : [])));
  // The families that count each total no cell holds, so a family whose total a sub-floor part hides can reach the others that give it away (`withholdLocally`).
  const byTotal = new Map<string, Family[]>();
  for (const family of families) if (family.total !== null) byTotal.set(family.total, [...(byTotal.get(family.total) ?? []), family]);
  const allSystems = systemsOf(families);
  const termsOf = (system: readonly Row[]): Set<Term> => new Set(system.flatMap((row) => [...row.keys()]));
  const systems = allSystems.filter((system) => termsOf(system).size <= maxTerms);
  // The member set of each family, and the families each cell is in, so "shares a family" is a lookup and no cell holds a set of its neighbors (a family of thousands of `keys` cells would square).
  const membersOf = new Map<Family, Set<Cell>>();
  const familiesOfCell = new Map<Cell, Family[]>();
  for (const family of families) {
    const members = new Set(family.whole === null ? family.parts : [family.whole, ...family.parts]);
    membersOf.set(family, members);
    for (const cell of members) familiesOfCell.set(cell, [...(familiesOfCell.get(cell) ?? []), family]);
  }
  const sharesFamily = (cell: Cell, other: Cell): boolean => (familiesOfCell.get(cell) ?? []).some((family) => membersOf.get(family)?.has(other) === true);
  const withheld = new Set<Cell>();
  // A cell is served when it clears its own floor, so a `clear` cell below the public floor is known to the rank check as served.
  const known = (term: Term): boolean => (typeof term === 'string' ? isActionCalls(term) && !tied.has(term) : clears(term, floorOf(term)) && !withheld.has(term));
  const systemOf = new Map<Term, Row[]>(systems.flatMap((system) => system.flatMap((row) => [...row.keys()].map((term): [Term, Row[]] => [term, system]))));
  // The cell each system withholds next, kept until a cell of that system is withheld; the systems share no cell, so each round withholds one per system.
  const choices = new Map<Row[], Cell | undefined>();
  const choiceOf = (system: Row[]): Cell | undefined =>
    [...determinedOf(system, known)]
      .map(([cell, row]) => {
        const support = [...row.keys()].filter((term): term is Cell => typeof term !== 'string' && term !== cell && known(term));
        const near = support.filter((term) => sharesFamily(cell, term));
        return (near.length > 0 ? near : support).sort(smallest)[0];
      })
      .find((cell) => cell !== undefined);
  for (let seen = 0; ; ) {
    withholdLocally(families, byTotal, withheld, plan);
    for (const cell of [...withheld].slice(seen)) {
      const system = systemOf.get(cell);
      if (system !== undefined) choices.delete(system);
    }
    seen = withheld.size;
    const next = systems.flatMap((system) => {
      const choice = choices.has(system) ? choices.get(system) : choiceOf(system);
      choices.set(system, choice);
      return choice === undefined ? [] : [choice];
    });
    if (next.length === 0) break;
    for (const cell of next) withheld.add(cell);
  }
  // The systems left out of the rank check keep none of their served cells.
  for (const system of allSystems) {
    if (systems.includes(system)) continue;
    for (const term of termsOf(system)) if (typeof term !== 'string' && clears(term, floorOf(term))) withheld.add(term);
  }
  return withheld;
};
