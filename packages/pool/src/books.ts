// The set of four from the pool design notes, set of four, as totals the bundle carries. Served cells are the week cells at or above the floor that the bundle serves; every other week cell the pool holds
// (sub-floor, or served but withheld by `complement.ts`) is backlog, so the served number never overstates what a reader can see. The backlog is one number: a list of it would name a sub-floor value.
import type { Cell } from '../../cli/src/sessions/cells.js';
import type { Books, Sourced } from '../../cli/src/sessions/pool-wire.js';

const NONE_YET = (reason: string): Sourced => ({ state: 'no source yet', reason });

/** The places a later brief fills. Each holds `no source yet` and its reason until a source exists; none is a number. */
export const DEMAND_SOURCE = { comparisonReadOwners: NONE_YET('no comparison read exists to fetch yet'), followOnReads: NONE_YET('no source feeds this yet') };
export const GOAL_SOURCE = { readYield: NONE_YET('no source feeds this yet'), costPerServedCell: NONE_YET('no cost feed exists yet'), yieldPerServedCell: NONE_YET('no source feeds this yet') };

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface BooksInput {
  /** Every cell the pool held for this bundle, before the floor. */
  held: readonly Cell[];
  /** The ones the bundle serves. */
  served: ReadonlySet<Cell>;
  /** Accounts with a deposit in the last four weeks; undefined when the pool's deposits were not read. */
  panel: number | undefined;
  /** The UTC day the panel was counted. */
  panelDay: string | undefined;
  lineage: Pick<Books, 'floor' | 'format' | 'vocabVersion' | 'asOf'>;
}

const tally = <K extends string>(counts: Map<K, number>, key: K): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

export const booksOf = ({ held, served, panel, panelDay, lineage }: BooksInput): Books => {
  const byWeek = new Map<string, number>();
  const byTuple = new Map<string, number>();
  let total = 0;
  let backlog = 0;
  for (const cell of held) {
    if (cell.grain !== 'week' || cell.sessions <= 0) continue;
    if (!served.has(cell)) {
      backlog += 1;
      continue;
    }
    total += 1;
    tally(byWeek, cell.day);
    tally(byTuple, `${cell.motifId}|${cell.frameBucket}`);
  }
  return {
    ...lineage,
    served: {
      total,
      byWeek: [...byWeek].sort(([a], [b]) => compare(a, b)).map(([week, cells]) => ({ week, cells })),
      byTuple: [...byTuple].sort(([a], [b]) => compare(a, b)).map(([tuple, weeks]) => ({ tuple, weeks })),
    },
    backlog,
    panelDay: panelDay ?? null,
    panel: panel === undefined ? NONE_YET("the pool's deposit records were not read") : { state: 'value', value: panel },
    demand: DEMAND_SOURCE,
    goal: GOAL_SOURCE,
  };
};
