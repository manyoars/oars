// Lead-lag (spec Section 6, order 3), the labeled experiment: does a tool's failure rate moving come before its share moving? Chosen over a model release moving tool choice
// because each model has one version here with no release date (ruling owner-08), and two version boundaries are too few to cut in time, while consecutive days over many tools
// can be cut. A search over pairs of tools was rejected: it manufactures the false patterns Section 6 warns about, and this is one question asked once.
//
// A pair shares no day between its sides. A failure move ending on day d is paired with the share move from d+1 to d+2, not d to d+1: a burst of failing calls on d lifts both the
// day's failure rate and its share, so a pair that read d twice would show a negative slope with no lead in it, and that slope would hold on later days and pass the check.
//
// Fit on earlier days and scored on later ones, with a pair dated by the day its outcome is known. It exists or not by its floor and states its score either way, labeled in
// every output. No path serves it to an agent: Section 6 requires this check before one, and this read is the check's first run, not a licensed read.
//
// What the check does not remove: shares sum to one, so tools on one day are not independent; steps cluster in sessions, so intervals run narrow; a failure move measured with
// error flattens the slope; and one operator's changes of habit move many tools at once.
import { UNKNOWN } from './cells.js';
import { estimateOf, relate, type DeriveRelation, type Estimate } from './read-order.js';
import { nextDay } from './read-day-move.js';
import type { Read } from './read.js';
import { rate, round, wilson } from './read-support.js';

/** The fewest pairs on each side of the cut. */
export const PAIRS_FLOOR = 30;

const FIT_SHARE = 0.7;
const Z_95 = 1.96;
const SIGMA_FLOOR = 0.0001;
const CHANCE = 0.5;

export interface LeadLagPair {
  /** The failure move. */
  x: Estimate;
  /** The share move that shares no day with it. */
  y: Estimate;
  /** The day the outcome is known: the last day of the share move. */
  day: string;
  reads: readonly [Read, Read];
}

const keyOf = (motif: string | undefined, metric: string, from: string | undefined): string => `${motif ?? UNKNOWN}\n${metric}\n${from ?? UNKNOWN}`;

export const leadLagPairs = (reads: readonly Read[]): LeadLagPair[] => {
  const moves = reads.filter((read) => read.family === 'day-move');
  const byStart = new Map(moves.map((read) => [keyOf(read.slice.motif, read.slice.metric ?? UNKNOWN, read.slice.from), read]));
  return moves.flatMap((lead) => {
    if (lead.slice.metric !== 'failureRate') return [];
    const lag = byStart.get(keyOf(lead.slice.motif, 'share', nextDay(lead.slice.to ?? UNKNOWN)));
    const x = estimateOf(lead, 'move');
    const y = lag === undefined ? undefined : estimateOf(lag, 'move');
    if (lag === undefined || x === undefined || y === undefined) return [];
    return [{ x, y, day: lag.slice.to ?? UNKNOWN, reads: [lead, lag] }];
  });
};

/** A share move's weight: a thin day's move says less. The floor keeps one pair with no measured spread from outweighing the rest. */
const weightOf = ({ y }: LeadLagPair): number => {
  const sigma = Math.max((y.interval.high - y.interval.low) / (2 * Z_95), SIGMA_FLOOR);
  return 1 / (sigma * sigma);
};

const weightedSum = (pairs: readonly LeadLagPair[], term: (pair: LeadLagPair) => number): number => pairs.reduce((sum, pair) => sum + weightOf(pair) * term(pair), 0);

/** The later days' weighted error against predicting no move at all: above zero means the slope from earlier days beat that. With nothing to explain there is no skill. */
const skillOf = (pairs: readonly LeadLagPair[], slope: number): number => {
  const zero = weightedSum(pairs, ({ y }) => y.value * y.value);
  if (zero === 0) return 0;
  return 1 - weightedSum(pairs, ({ x, y }) => (y.value - slope * x.value) ** 2) / zero;
};

/** How often a later day's share moved the way the slope said, among pairs where both moved. */
const signsOf = (pairs: readonly LeadLagPair[], slope: number): { agreement: number | null; low: number } => {
  const moved = pairs.filter(({ x, y }) => x.value !== 0 && y.value !== 0);
  const agreed = moved.filter(({ x, y }) => Math.sign(slope * x.value) === Math.sign(y.value)).length;
  return { agreement: rate(agreed, moved.length), low: wilson(agreed, moved.length)?.low ?? 0 };
};

export const deriveLeadLag: DeriveRelation = (reads) => {
  const pairs = leadLagPairs(reads);
  const days = [...new Set(pairs.map(({ day }) => day))].sort();
  const cut = Math.floor(days.length * FIT_SHARE);
  const fitThrough = days[cut - 1];
  const scoredFrom = days[cut];
  if (fitThrough === undefined || scoredFrom === undefined) return [];
  const fit = pairs.filter(({ day }) => day <= fitThrough);
  const scored = pairs.filter(({ day }) => day >= scoredFrom);
  const leverage = weightedSum(fit, ({ x }) => x.value * x.value);
  if (fit.length < PAIRS_FLOOR || scored.length < PAIRS_FLOOR || leverage === 0) return [];
  const slope = weightedSum(fit, ({ x, y }) => x.value * y.value) / leverage;
  const margin = Z_95 * Math.sqrt(1 / leverage);
  const skill = skillOf(scored, slope);
  const signs = signsOf(scored, slope);
  const passed = Math.abs(slope) > margin && skill > 0 && signs.low > CHANCE;
  const read = relate('lead-lag', pairs.flatMap((pair) => pair.reads), {
    slice: { lead: 'failureRate', lag: 'share', level: 'shape' },
    value: { label: 'experimental', check: passed ? 'passed' : 'failed', slope: round(slope), skill: round(skill), signAgreement: signs.agreement, fitPairs: fit.length, scorePairs: scored.length, fitThrough, scoredFrom },
    interval: { low: round(slope - margin), high: round(slope + margin), level: 0.95 },
    n: pairs.length,
  });
  return read === undefined ? [] : [read];
};
