// Call shape (t757, the fit family's other method): one tool and its input key names, over the floors a shape needs before a hook may push it. A shape is what a pre-tool hook can
// compute from the call it is about to run, so this read is what a push cites. A failure is not in a cell by shape, so its evidence is the failed one-step cells of the
// tool's action on the days the shape failed. Same confounders as `read-fit.ts`: a failure is not a misfit, and prompt class is not adjusted for.
import { UNKNOWN } from './cells.js';
import { shapeMotif } from './motif.js';
import { CALL_SHAPE_METHOD } from './read.js';
import { actionOfShape, fitReads, toolShapeId } from './recall-reads.js';
import { body, rate, wilson, type DeriveFamily } from './read-support.js';

export const deriveCallShape: DeriveFamily = ({ pool, store }) =>
  fitReads(store).flatMap((read) => {
    const action = actionOfShape(read.tool, read.harnesses);
    const motifId = shapeMotif([{ action, identity: null }]).motifId;
    const within = (day: string): boolean => day === UNKNOWN || (read.firstDay !== null && read.lastDay !== null && day >= read.firstDay && day <= read.lastDay);
    const cells = pool.cells.filter((cell) => cell.motifId === motifId && cell.failed > 0 && within(cell.day));
    // A shape whose failures are in no cell has nothing to cite, so it is not a read: its answers keep their stand-in.
    if (cells.length === 0) return [];
    const calls = read.calls ?? read.count;
    return [
      body(
        'fit',
        cells,
        {
          slice: { shape: toolShapeId(read.tool, read.keys), action },
          value: { failureRate: rate(read.count, calls), failed: read.count, calls },
          n: read.count,
          interval: wilson(read.count, calls),
        },
        CALL_SHAPE_METHOD,
      ),
    ];
  });
