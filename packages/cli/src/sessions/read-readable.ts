// What this store cannot read, stated rather than forced (ruling owner-08). A family that finds nothing has made no claim about why, so a reader of an empty family could take
// "no reads" for "nothing moved". These rows separate the two: a question the store cannot ask from one it asked and got no answer to.
import { interactionCandidates } from './read-interaction.js';
import { leadLagPairs, PAIRS_FLOOR } from './read-lead-lag.js';
import type { Candidate } from './read-order.js';
import { substitutionCandidates } from './read-substitution.js';
import { boundariesOf, versionBoundaryCandidates } from './read-version-boundary.js';
import type { Family, Read } from './read.js';

export interface NotReadable {
  family: Family;
  what: string;
  why: string;
}

export const notReadable = (reads: readonly Read[]): NotReadable[] => {
  const rows: NotReadable[] = [{ family: 'version-boundary', what: 'a model version boundary', why: 'a cell holds a model name and no version of it' }];
  const noBoundary = boundariesOf(reads).length === 0;
  const whyNot = (candidates: readonly Candidate[]): string | undefined => (noBoundary ? 'no harness has two version buckets' : candidates.length === 0 ? 'no comparison clears the floor' : undefined);
  const boundaryWhy = whyNot(versionBoundaryCandidates(reads));
  if (boundaryWhy !== undefined) rows.push({ family: 'version-boundary', what: 'a harness version boundary', why: boundaryWhy });
  const substitutionWhy = whyNot(substitutionCandidates(reads));
  if (substitutionWhy !== undefined) rows.push({ family: 'substitution', what: 'one tool replacing another at a boundary', why: substitutionWhy });
  if (interactionCandidates(reads).length === 0) rows.push({ family: 'interaction', what: 'a tool across the tiers assigned', why: 'no tool clears the floor on two tiers in one frame' });
  if (!reads.some((read) => read.family === 'lead-lag')) {
    rows.push({ family: 'lead-lag', what: 'a failure move leading a share move', why: `${String(leadLagPairs(reads).length)} pairs, and it needs ${String(PAIRS_FLOOR)} on each side of the cut` });
  }
  return rows;
};

export const formatNotReadable = (rows: readonly NotReadable[]): string[] => (rows.length === 0 ? [] : ['Not readable on this store:', ...rows.map(({ family, what, why }) => `  ${family}: ${what}: ${why}`)]);
