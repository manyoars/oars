// The class of a cell: `clear` when every value its key names is on a public list, `thresholded` when any one is not. A cell keys on a motif (the names of its steps) and a frame bucket (`harness/versionBucket/model`), so
// the class of a cell is the strictest class among them. A host is hashed at ingest, so a cell naming one is held to the thresholded floor as well. The class table is `field-classes.ts`; this file only reads it for a cell.
import { isEnvironmentCell, NO_AXES, UNKNOWN, type Cell } from '../../cli/src/sessions/cells.js';
import type { Motif } from '../../cli/src/sessions/motif.js';
import type { StepIdentity } from '../../cli/src/sessions/schema.js';
import { classFor, isListed } from './field-classes.js';

export type CellClass = 'clear' | 'thresholded';

/** A version bucket is `major.minor.tens` (`2.1.31x`), a number's own bucket and so public; anything else is the version string as the client sent it. */
const BUCKET = /^\d+\.\d+\.\d+x$/;

const clearOf = (field: string, value: string, context?: string): boolean => classFor(field, isListed(field, value, context)) === 'clear';

const frameClear = (frameBucket: string): boolean => {
  if (isEnvironmentCell({ frameBucket })) return true;
  const [, bucket = UNKNOWN, ...model] = frameBucket.split('/');
  const name = model.join('/');
  return (bucket === UNKNOWN || bucket === NO_AXES || BUCKET.test(bucket) || clearOf('harnessVersion', bucket)) && (name === UNKNOWN || name === NO_AXES || clearOf('model', name));
};

const identityClear = (identity: StepIdentity): boolean => {
  if (identity === null) return true;
  if ('program' in identity) {
    return clearOf('program', identity.program) && (identity.sub === null || clearOf('sub', identity.sub, identity.program)) && identity.flags.every((flag) => clearOf('flags', flag)) && (identity.pulls ?? []).every((pull) => clearOf('name', pull.name));
  }
  if ('server' in identity) return clearOf('mcp', identity.server) && clearOf('tool', identity.tool, identity.server);
  if ('skill' in identity) return clearOf('skill', identity.skill);
  return identity.host === null || clearOf('host', identity.host);
};

/** A cell whose motif is not held is `thresholded`: a class the pool cannot read is the strict one. */
export const cellClassOf = (cell: Cell, motif: Motif | undefined): CellClass => (motif !== undefined && frameClear(cell.frameBucket) && motif.steps.every((step) => identityClear(step.identity)) ? 'clear' : 'thresholded');
