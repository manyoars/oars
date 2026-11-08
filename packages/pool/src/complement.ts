// Complementary withholding. A whole and its parts count the same steps: a week cell and the day cells of its days, and a shape cell and the named cells that share its actions. Serving the whole beside
// all of its served parts would show the parts that are not served by subtraction, a sub-floor day or name among them. So where a served whole has a sub-floor part, one more part is withheld, the
// smallest served one: the whole less the served parts is then a sum over at least two parts, one of them at or above the floor, which no reader can split. The whole and the other parts stay, so a thin
// pool still serves what it can. The environment cells (`ENVIRONMENT_CELLS`, `stored.ts`) keep their own rule, every part served or the total is not, and their counterparts are also dropped when a bucket cell is withheld (`bundleOf`).
import { parseShapeClass, weekStartOf, type Cell, type ShapeFacet } from '../../cli/src/sessions/cells.js';
import type { Motif } from '../../cli/src/sessions/motif.js';
import { clears, clustersOf } from './floors.js';

export interface Family {
  /** The name of the `FAMILY_RULES` rule that made it. */
  rule: string;
  whole: Cell | null;
  parts: Cell[];
  /** The families that count the same total (`Placement.echoes`), once all are built. */
  echoes: Family[];
}

/** One cell's place in one family: the whole of it or a part of it. */
interface Placement {
  family: string;
  role: 'whole' | 'part';
  /** Families that count the same total as this one (the per-key facets of a key's `keys` cells): where this family's lone part has no served part beside it, they are the other ways to read it. */
  echoes?: string[];
}

/** The key of the family of one partition facet: the facet's cells for an action, key (for a keyed facet), frame, grain, day, and exposure. */
const facetFamilyKey = (action: string, facet: ShapeFacet, key: string, cell: Cell): string => JSON.stringify(['facet', action, facet, key, cell.frameBucket, cell.grain, cell.day, cell.exposed]);

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
 * Every way a cell counts inside another count, one rule each; `familiesOf` and the invariant test (`shape-cells.test.ts`) both read this table, so a new nesting cannot be left out of either. A rule names the
 * families a cell belongs to and whether it is the whole of one (a cell holding the family's total) or a part of it; a family with no whole cell has a total the reader still has from another read.
 */
export const FAMILY_RULES: readonly { name: string; placements: (cell: Cell, motif: Motif | undefined) => Placement[] }[] = [
  // The class cells of one facet partition (`FACET_PARTITIONS`) split the same calls of an action; the total is not a cell of the family.
  {
    name: 'facet',
    placements: (cell, motif) => {
      const parsed = motif === undefined || motif.cls === null ? null : parseShapeClass(motif.cls);
      const keyed = parsed === null ? undefined : FACET_PARTITIONS.get(parsed.facet);
      if (parsed === null || keyed === undefined) return [];
      return [{ family: facetFamilyKey(parsed.action, parsed.facet, keyed ? parsed.value.slice(0, parsed.value.indexOf('=')) : '', cell), role: 'part' }];
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
        echoes: KEYED_FACETS.map((facet) => facetFamilyKey(parsed.action, facet, key, cell)),
      }));
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
export const familiesOf = (held: readonly Cell[], motifs: readonly Motif[]): Family[] => {
  const levels = new Map(motifs.map((motif) => [motif.motifId, motif]));
  // One map per rule, so the families come out in the table's order: the facet and nesting rules, then the week and the shape rules, which a withheld part can feed in turn.
  const byRule = FAMILY_RULES.map((rule) => ({ rule, families: new Map<string, Family>() }));
  const byKey = new Map<string, Family>();
  const echoed = new Map<Family, Set<string>>();
  for (const cell of held) {
    for (const { rule, families } of byRule) {
      for (const { family, role, echoes } of rule.placements(cell, levels.get(cell.motifId))) {
        const made = families.get(family) ?? { rule: rule.name, whole: null, parts: [], echoes: [] };
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
 * The served cells to leave out of a bundle, given every held cell (so a sub-floor part is seen) and the floor. A family (`FAMILY_RULES`) needs one more part withheld, its smallest served one, in two cases: it holds a
 * sub-floor part and none of its parts is withheld yet, or exactly one of its parts is unserved, sub-floor or withheld by another family. A withheld part is at or above the floor but still hides a count another family
 * protects, so a family that leaves it as the one unserved part would give it back by subtraction, and the sub-floor cell it shields with it. The whole of a family stays when it has one. A cell can be a part of one
 * family and the whole of another, so the rule repeats until it adds nothing. Where a lone unserved part has no served part beside it, the whole is withheld instead: it is that part's count.
 */
export const withheldOf = (held: readonly Cell[], motifs: readonly Motif[], floor: number): Set<Cell> => {
  const families = familiesOf(held, motifs);
  const withheld = new Set<Cell>();
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
  return withheld;
};
