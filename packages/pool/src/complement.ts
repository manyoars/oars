// Complementary withholding. A whole and its parts count the same steps: a week cell and the day cells of its days, and a shape cell and the named cells that share its actions. Serving the whole beside
// all of its served parts would show the parts that are not served by subtraction, a sub-floor day or name among them. So where a served whole has a sub-floor part, one more part is withheld, the
// smallest served one: the whole less the served parts is then a sum over at least two parts, one of them at or above the floor, which no reader can split. The whole and the other parts stay, so a thin
// pool still serves what it can. Families also combine (the served totals of several can add and subtract to an unserved cell), so a rank check then withholds until the served cells determine no unserved one
// (`withheldOf`). The environment cells (`ENVIRONMENT_CELLS`, `stored.ts`) keep their own rule, every part served or the total is not, and their counterparts are also dropped when a bucket cell is withheld (`bundleOf`).
import { isEnvironmentCell, NO_AXES, parseShapeClass, weekStartOf, type Cell, type ShapeFacet } from '../../cli/src/sessions/cells.js';
import type { Motif } from '../../cli/src/sessions/motif.js';
import { clears, clustersOf } from './floors.js';

interface Family {
  /** The name of the `FAMILY_RULES` rule that made it. */
  rule: string;
  whole: Cell | null;
  /** Where the family has no whole cell, the count its parts sum to that no cell holds (an action's calls, or the calls that send a key), shared by the families that sum to it: an unknown of the rank check (`determinedOf`). */
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

/**
 * The facets whose cells split the same calls of an action: each call counts in exactly one cell of `target`, `keys`, or `dropped`, and in one cell per key of `size`, `depth`, `extension`, `dir`, and `enum` (a value is
 * `<key>=<member>`). The others (`arg`, `pattern`, `change`) hold a call in several cells, so their cells are not parts of one count.
 */
const FACET_PARTITIONS: ReadonlyMap<ShapeFacet, boolean> = new Map([['target', false], ['keys', false], ['dropped', false], ['size', true], ['depth', true], ['extension', true], ['dir', true], ['enum', true]]);

/** The facets that carry a key in their values. */
const KEYED_FACETS: readonly ShapeFacet[] = [...FACET_PARTITIONS].filter(([, keyed]) => keyed).map(([facet]) => facet);

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The fewest accounts first, then the earliest day, then the motif, so the choice is the same for the same cells. */
const smallest = (a: Cell, b: Cell): number => clustersOf(a) - clustersOf(b) || compare(a.day, b.day) || compare(a.motifId, b.motifId);

/**
 * Every way a cell counts inside another count, one rule each; `familiesOf` reads this table for both the local rules and the rank check. The invariant test (`shape-cells.test.ts`) states the relations from the
 * cells on its own, so a nesting this table leaves out shows there as a determined cell. A rule names the
 * families a cell belongs to and whether it is the whole of one (a cell holding the family's total) or a part of it; a family with no whole cell has a total the reader still has from another read.
 */
const FAMILY_RULES: readonly { name: string; placements: (cell: Cell, motif: Motif | undefined) => Placement[] }[] = [
  // The class cells of one facet partition (`FACET_PARTITIONS`) split the same calls of an action; the total is not a cell of the family.
  {
    name: 'facet',
    placements: (cell, motif) => {
      const parsed = motif === undefined || motif.cls === null ? null : parseShapeClass(motif.cls);
      const keyed = parsed === null ? undefined : FACET_PARTITIONS.get(parsed.facet);
      if (parsed === null || keyed === undefined) return [];
      const key = keyed ? parsed.value.slice(0, parsed.value.indexOf('=')) : '';
      return [{ family: facetFamilyKey(parsed.action, parsed.facet, key, cell), role: 'part', total: callsTotal(parsed.action, key, cell) }];
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
  // An action's one-step shape cells, one per model (`harness/version/model`), sum to the calls its shape cells split on the version bucket (`harness/version/-`): the total the `fit` read gives.
  {
    name: 'action-calls',
    placements: (cell, motif) => {
      const [step, ...more] = motif?.level === 'shape' && !isEnvironmentCell(cell) ? motif.steps : [];
      if (step === undefined || more.length > 0) return [];
      const [harness, version] = cell.frameBucket.split('/');
      const versionCell = { ...cell, frameBucket: [harness, version, NO_AXES].join('/') };
      return [{ family: JSON.stringify(['action-calls', step.action, versionCell.frameBucket, cell.grain, cell.day, cell.exposed]), role: 'part', total: callsTotal(step.action, '', versionCell) }];
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
  for (const [family, keys] of echoed) family.echoes = [...keys].flatMap((key) => byKey.get(key) ?? []);
  return byRule.flatMap(({ families }) => [...families.values()]);
};

/**
 * The local rules, one family at a time. A family (`FAMILY_RULES`) needs one more part withheld, its smallest served one, in two cases: it holds a sub-floor part and none of its parts is withheld yet, or exactly
 * one of its parts is unserved, sub-floor or withheld by another family. A withheld part is at or above the floor but still hides a count another family protects, so a family that leaves it as the one unserved
 * part would give it back by subtraction, and the sub-floor cell it shields with it. The whole of a family stays when it has one. A cell can be a part of one family and the whole of another, so the rule repeats
 * until it adds nothing. Where a lone unserved part has no served part beside it, the whole is withheld instead: it is that part's count.
 */
const withholdLocally = (families: readonly Family[], withheld: Set<Cell>, floor: number): void => {
  for (let changed = true; changed; ) {
    changed = false;
    for (const { whole, parts, echoes } of families) {
      if (whole !== null && (!clears(whole, floor) || withheld.has(whole))) continue;
      const unserved = parts.filter((part) => !clears(part, floor) || withheld.has(part));
      const thin = parts.some((part) => !clears(part, floor)) && !parts.some((part) => withheld.has(part));
      if (!thin && unserved.length !== 1) continue;
      const [next] = parts.filter((part) => clears(part, floor) && !withheld.has(part)).sort(smallest);
      if (next !== undefined) {
        withheld.add(next);
        changed = true;
        continue;
      }
      if (unserved.length !== 1) continue;
      // With no served part left to join it, a lone unserved part equals its whole, so the whole goes too; and it equals the total that the families echoing it count, so each of those gives up its smallest served part.
      for (const gone of [whole, ...echoes.map((echo) => echo.parts.filter((part) => clears(part, floor) && !withheld.has(part)).sort(smallest)[0])]) {
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

/**
 * The served cells to leave out of a bundle, given every held cell (so a sub-floor part is seen) and the floor. First the local rules (`withholdLocally`); then the rank check, because served totals combine
 * across families (a sub-floor `keys` cell is one key's `size` total plus another's less the action's calls, though no one family holds it alone). Every family states one linear equation, and while the served cells
 * determine any unserved cell (`determinedOf`), the smallest served cell of its equation that shares a family with it is withheld (any served cell of its equation where none does), and both stages repeat.
 */
export const withheldOf = (held: readonly Cell[], motifs: readonly Motif[], floor: number): Set<Cell> => {
  // The one-step shape cells tie an action's calls only where its shape cells split them, so an action with no shape cells keeps its shape cells out of this rule.
  const every = familiesOf(held, motifs);
  const split = new Set(every.flatMap(({ rule, total }) => (rule === 'facet' && total !== null && isActionCalls(total) ? [total] : [])));
  const families = every.filter(({ rule, total }) => rule !== 'action-calls' || (total !== null && split.has(total)));
  // An action's calls the `fit` read gives: through its one-step shape cells where they are held, and as known where they are not.
  const tied = new Set(families.flatMap(({ rule, total }) => (rule === 'action-calls' && total !== null ? [total] : [])));
  const systems = systemsOf(families);
  const familiesHolding = new Map<Cell, Set<Cell>>();
  for (const { whole, parts } of families) {
    const members = whole === null ? parts : [whole, ...parts];
    for (const cell of members) {
      const near = familiesHolding.get(cell) ?? new Set<Cell>();
      familiesHolding.set(cell, near);
      for (const member of members) near.add(member);
    }
  }
  const withheld = new Set<Cell>();
  const known = (term: Term): boolean => (typeof term === 'string' ? isActionCalls(term) && !tied.has(term) : clears(term, floor) && !withheld.has(term));
  const systemOf = new Map<Term, Row[]>(systems.flatMap((system) => system.flatMap((row) => [...row.keys()].map((term): [Term, Row[]] => [term, system]))));
  // The cell each system withholds next, kept until a cell of that system is withheld; the systems share no cell, so each round withholds one per system.
  const choices = new Map<Row[], Cell | undefined>();
  const choiceOf = (system: Row[]): Cell | undefined =>
    [...determinedOf(system, known)]
      .map(([cell, row]) => {
        const support = [...row.keys()].filter((term): term is Cell => typeof term !== 'string' && term !== cell && known(term));
        const near = support.filter((term) => familiesHolding.get(cell)?.has(term) === true);
        return (near.length > 0 ? near : support).sort(smallest)[0];
      })
      .find((cell) => cell !== undefined);
  for (let seen = 0; ; ) {
    withholdLocally(families, withheld, floor);
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
    if (next.length === 0) return withheld;
    for (const cell of next) withheld.add(cell);
  }
};
