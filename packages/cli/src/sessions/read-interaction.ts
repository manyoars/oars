// Interaction (spec Section 6, order 2): a tool fails more on one tier than another, beyond how those two tiers differ on every other tool. The difference of differences is
// what makes it an interaction: a tier that fails more on everything has a main effect, usually the harder work it is given. The axis is the tier assigned, not a model version
// (ruling mrd5591-08: one version per model on this store), and comparisons hold the version bucket and the effort constant. Confounders it does not remove: task assignment by
// tier, which is the operator's own choice and the largest of them, prompt class, and a failure not being a misfit.
import { UNKNOWN } from './cells.js';
import { candidateOf, differenceOf, estimateOf, screen, TRIALS_FLOOR, type Candidate, type DeriveRelation } from './read-order.js';
import type { Read } from './read.js';
import { groupBy, rate, wilson } from './read-support.js';

const countOf = (read: Read, metric: string): number => {
  const value = read.value[metric];
  return typeof value === 'number' ? value : 0;
};

const toolKey = (read: Read): string => `${read.slice.level ?? UNKNOWN}\n${read.slice.motif ?? UNKNOWN}`;

/** One tier in one version bucket at one effort. */
interface Tier {
  model: string;
  tools: ReadonlyMap<string, Read>;
  /** One-step shape reads: every step in the frame, once each. */
  shapes: readonly Read[];
}

const tierOf = (model: string, reads: readonly Read[]): Tier => ({ model, tools: new Map(reads.map((read) => [toolKey(read), read])), shapes: reads.filter((read) => read.slice.level === 'shape') });

/** A tier's failure rate on every step but this tool's. A named tool's steps are in its action's shape read, so subtracting it works at either level. */
const restOf = (tier: Tier, read: Read) => {
  const failed = tier.shapes.reduce((sum, shape) => sum + countOf(shape, 'failed'), 0) - countOf(read, 'failed');
  const trials = tier.shapes.reduce((sum, shape) => sum + shape.n, 0) - read.n;
  const value = rate(failed, trials);
  const interval = wilson(failed, trials);
  return trials < TRIALS_FLOOR || value === null || interval === null ? undefined : { value, interval, cites: tier.shapes.filter((shape) => shape.readId !== read.readId) };
};

const candidateFor = (a: Tier, b: Tier, key: string, scope: { harness: string; harnessBucket: string; effort: string }): Candidate | undefined => {
  const readA = a.tools.get(key);
  const readB = b.tools.get(key);
  if (readA === undefined || readB === undefined) return undefined;
  const failureA = estimateOf(readA, 'failureRate');
  const failureB = estimateOf(readB, 'failureRate');
  const restA = restOf(a, readA);
  const restB = restOf(b, readB);
  if (failureA === undefined || failureB === undefined || restA === undefined || restB === undefined) return undefined;
  const gap = differenceOf(failureA, failureB);
  const restGap = differenceOf(restA, restB);
  const interaction = differenceOf(gap, restGap);
  const [level = UNKNOWN, motif = UNKNOWN] = key.split('\n');
  return candidateOf('interaction', 'failure-gap-across-tier-assigned', '1', [readA, readB], [gap, interaction], {
    slice: { motif, level, ...scope, tierA: a.model, tierB: b.model },
    value: { failureA: failureA.value, failureB: failureB.value, gap: gap.value, restGap: restGap.value, interaction: interaction.value },
    interval: interaction.interval,
    cites: [...restA.cites, ...restB.cites],
  });
};

/** The comparisons a store's fit reads allow, above the floor, whether or not any of them moved. */
export const interactionCandidates = (reads: readonly Read[]): Candidate[] => {
  const known = reads.filter((read) => read.family === 'fit' && read.slice.model !== UNKNOWN);
  const frames = groupBy(known, (read) => `${read.slice.harness ?? UNKNOWN}\n${read.slice.harnessBucket ?? UNKNOWN}\n${read.slice.effort ?? UNKNOWN}`);
  return [...frames].flatMap(([frame, group]) => {
    const [harness = UNKNOWN, harnessBucket = UNKNOWN, effort = UNKNOWN] = frame.split('\n');
    const tiers = [...groupBy(group, (read) => read.slice.model ?? UNKNOWN)].map(([model, inTier]) => tierOf(model, inTier)).sort((a, b) => (a.model < b.model ? -1 : 1));
    return tiers.flatMap((a, index) =>
      tiers.slice(index + 1).flatMap((b) =>
        [...a.tools.keys()].flatMap((key) => {
          const candidate = candidateFor(a, b, key, { harness, harnessBucket, effort });
          return candidate === undefined ? [] : [candidate];
        }),
      ),
    );
  });
};

export const deriveInteraction: DeriveRelation = (reads) => screen(interactionCandidates(reads));
