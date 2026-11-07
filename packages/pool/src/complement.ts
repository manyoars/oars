// Complementary withholding. A whole and its parts count the same steps: a week cell and the day cells of its days, and a shape cell and the named cells that share its actions. Serving the whole beside
// all of its served parts would show the parts that are not served by subtraction, a sub-floor day or name among them. So where a served whole has a sub-floor part, one more part is withheld, the
// smallest served one: the whole less the served parts is then a sum over at least two parts, one of them at or above the floor, which no reader can split. The whole and the other parts stay, so a thin
// pool still serves what it can. The environment cells (`ENVIRONMENT_CELLS`, `stored.ts`) keep their own rule, every part served or the total is not, and their counterparts are also dropped when a bucket cell is withheld (`bundleOf`).
import { weekStartOf, type Cell } from '../../cli/src/sessions/cells.js';
import type { Motif } from '../../cli/src/sessions/motif.js';
import { clears, clustersOf } from './floors.js';

interface Family {
  whole: Cell | null;
  parts: Cell[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The fewest accounts first, then the earliest day, then the motif, so the choice is the same for the same cells. */
const smallest = (a: Cell, b: Cell): number => clustersOf(a) - clustersOf(b) || compare(a.day, b.day) || compare(a.motifId, b.motifId);

const familyOf = (families: Map<string, Family>, key: string): Family => {
  const known = families.get(key);
  if (known !== undefined) return known;
  const made: Family = { whole: null, parts: [] };
  families.set(key, made);
  return made;
};

/**
 * The served cells to leave out of a bundle, given every held cell (so a sub-floor part is seen) and the floor. A week cell is the whole of the day cells of its motif, frame, exposure, and week; a shape
 * cell is the whole of the named cells of its actions in the same frame, grain, day, and exposure. A cell can be a part of one family and the whole of another, so the rule repeats until it adds nothing.
 */
export const withheldOf = (held: readonly Cell[], motifs: readonly Motif[], floor: number): Set<Cell> => {
  const levels = new Map(motifs.map((motif) => [motif.motifId, motif]));
  const weeks = new Map<string, Family>();
  const shapes = new Map<string, Family>();
  for (const cell of held) {
    const week = familyOf(weeks, JSON.stringify([cell.motifId, cell.frameBucket, cell.exposed, cell.grain === 'week' ? cell.day : weekStartOf(cell.day)]));
    if (cell.grain === 'week') week.whole = cell;
    else week.parts.push(cell);
    const motif = levels.get(cell.motifId);
    if (motif === undefined || motif.level === 'class') continue;
    if (motif.steps.some(({ identity }) => identity !== null && 'program' in identity && (identity.flags.length > 0 || (identity.pulls?.length ?? 0) > 0))) continue;
    const shape = familyOf(shapes, JSON.stringify([motif.steps.map((step) => step.action), cell.frameBucket, cell.grain, cell.day, cell.exposed]));
    if (motif.level === 'shape') shape.whole = cell;
    else shape.parts.push(cell);
  }
  const withheld = new Set<Cell>();
  const families = [...weeks.values(), ...shapes.values()];
  for (let changed = true; changed; ) {
    changed = false;
    for (const { whole, parts } of families) {
      if (whole === null || !clears(whole, floor) || withheld.has(whole)) continue;
      if (!parts.some((part) => !clears(part, floor)) || parts.some((part) => withheld.has(part))) continue;
      const [next] = parts.filter((part) => clears(part, floor)).sort(smallest);
      if (next === undefined) continue;
      withheld.add(next);
      changed = true;
    }
  }
  return withheld;
};
