// Day move (spec Section 6, order 2): a tool's failure rate from one calendar day to the next, for a tool above the floor of calls on both, and its share, for a tool on either
// of two days above the floor of steps. Unlike the other order 2 families this is not screened: it is the input lead-lag stands on, and keeping only the large moves, or only the
// tools still called after a fall, would select that read on its outcome. So a row here is not a finding.
import { UNKNOWN } from './cells.js';
import { differenceOf, estimateOf, relate, type DeriveRelation, type Estimate } from './read-order.js';
import type { Read } from './read.js';
import { groupBy, wilson, type ReadBody } from './read-support.js';

const DAY_MS = 86_400_000;
const ISO_DAY_LENGTH = 10;

/** One tool's side of a day: its read, if it was called, and a read of the day that states the day's steps either way. */
interface DaySide {
  tool: Read | undefined;
  witness: Read;
}

export const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, ISO_DAY_LENGTH);

const stepsOf = (read: Read): number => {
  const { steps } = read.value;
  return typeof steps === 'number' ? steps : 0;
};

/** A tool's share on a day, measured against that day's steps. With no read of the tool there, it is zero of them, and that is a measurement, not a gap. The read's interval is on its failure rate, so a share's comes from its counts. */
const shareOn = (tool: Read | undefined, witness: Read): Estimate | undefined => {
  const interval = wilson(tool?.n ?? 0, stepsOf(witness));
  const value = tool === undefined ? 0 : tool.value.share;
  return typeof value !== 'number' || interval === null ? undefined : { value, interval };
};

const sliceOf = (tool: Read, metric: string, from: string, to: string) => ({ motif: tool.slice.motif ?? UNKNOWN, level: tool.slice.level ?? UNKNOWN, metric, from, to });

const moveOver = (before: Estimate, after: Estimate) => {
  const move = differenceOf(after, before);
  return { value: { before: before.value, after: after.value, move: move.value }, interval: move.interval };
};

/** Held to the tool's calls on both days: a failure rate is a rate of those calls. */
const failureMove = (earlier: Read, later: Read, from: string, to: string): ReadBody[] => {
  const before = estimateOf(earlier, 'failureRate');
  const after = estimateOf(later, 'failureRate');
  if (before === undefined || after === undefined) return [];
  const read = relate('day-move', 'move-to-next-day', '2', [earlier, later], { slice: sliceOf(earlier, 'failureRate', from, to), ...moveOver(before, after) });
  return read === undefined ? [] : [read];
};

/** Held to each day's steps and not the tool's calls: a floor on the calls would drop a tool for falling, which is the outcome a read over these moves asks about. */
const shareMove = (tool: Read, sides: readonly [DaySide, DaySide], from: string, to: string): ReadBody[] => {
  const [earlier, later] = sides;
  const before = shareOn(earlier.tool, earlier.witness);
  const after = shareOn(later.tool, later.witness);
  if (before === undefined || after === undefined) return [];
  const read = relate('day-move', 'move-to-next-day', '2', [earlier.tool ?? earlier.witness, later.tool ?? later.witness], {
    slice: sliceOf(tool, 'share', from, to),
    ...moveOver(before, after),
    trials: stepsOf,
  });
  return read === undefined ? [] : [read];
};

export const deriveDayMove: DeriveRelation = (reads) => {
  const toolDays = reads.filter((read) => read.family === 'tool-day');
  const witnesses = new Map([...groupBy(toolDays, (read) => read.slice.day ?? UNKNOWN)].flatMap(([day, [witness]]) => (witness === undefined ? [] : [[day, witness] as const])));
  return [...groupBy(toolDays, (read) => read.slice.motif)].flatMap(([, group]) => {
    const byDay = new Map(group.map((read) => [read.slice.day, read]));
    return [...witnesses].flatMap(([from, earlierWitness]) => {
      const to = nextDay(from);
      const laterWitness = witnesses.get(to);
      const earlier = byDay.get(from);
      const later = byDay.get(to);
      const tool = earlier ?? later;
      if (laterWitness === undefined || tool === undefined) return [];
      const failure = earlier === undefined || later === undefined ? [] : failureMove(earlier, later, from, to);
      return [...failure, ...shareMove(tool, [{ tool: earlier, witness: earlierWitness }, { tool: later, witness: laterWitness }], from, to)];
    });
  });
};
