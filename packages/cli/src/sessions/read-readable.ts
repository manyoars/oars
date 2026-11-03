// What this store cannot read, stated rather than forced (ruling owner-08). A family that finds nothing has made no claim about why, so a reader of an empty family could take
// "no reads" for "nothing moved". These rows separate the two: a question the store cannot ask from one it asked and got no answer to.
import { interactionCandidates } from './read-interaction.js';
import { leadLagPairs, PAIRS_FLOOR } from './read-lead-lag.js';
import { boundariesOf } from './read-version-boundary.js';
import type { Family, Read } from './read.js';

export interface NotReadable {
  family: Family;
  what: string;
  why: string;
}

export const notReadable = (reads: readonly Read[]): NotReadable[] => {
  const rows: NotReadable[] = [{ family: 'version-boundary', what: 'a model version boundary', why: 'a cell holds a model name and no version of it' }];
  if (boundariesOf(reads).length === 0) {
    const why = 'no harness has two version buckets';
    rows.push({ family: 'version-boundary', what: 'a harness version boundary', why }, { family: 'substitution', what: 'one tool replacing another at a boundary', why });
  }
  if (interactionCandidates(reads).length === 0) rows.push({ family: 'interaction', what: 'a tool across the tiers assigned', why: 'no tool clears the floor on two tiers in one frame' });
  if (!reads.some((read) => read.family === 'lead-lag')) {
    rows.push({ family: 'lead-lag', what: 'a failure move leading a share move', why: `${String(leadLagPairs(reads).length)} pairs, and it needs ${String(PAIRS_FLOOR)} on each side of the cut` });
  }
  return rows;
};

export const whatOf = (rows: readonly NotReadable[], family: Family): string[] => rows.filter((row) => row.family === family).map((row) => row.what);

export const formatNotReadable = (rows: readonly NotReadable[]): string[] => (rows.length === 0 ? [] : ['Not readable on this store:', ...rows.map(({ family, what, why }) => `  ${family}: ${what}: ${why}`)]);
