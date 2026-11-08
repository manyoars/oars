// Call shape (the fit family's other method): one tool and its input key names, over the floors a shape needs before a hook may push it. A shape is what a pre-tool hook can
// compute from the call it is about to run, so this read is what a push cites. Its evidence is the shape cells that count the action's calls by those key names (`shape:<action>/keys/<names>`, a week
// cell per version bucket, `shapeClass`), in the weeks the shape failed. Same confounders as `read-fit.ts`: a failure is not a misfit, and prompt class is not adjusted for. A bundle holds no store, so the
// pool serves the same cells as `fit-shape` (`deriveFitShape`), by every facet of shape and not this one tool's.
import { lastDayOfCell, parseShapeClass, UNKNOWN, type Cell } from './cells.js';
import { OPEN_GATE, wireKeys } from './pool-wire.js';
import { CALL_SHAPE_METHOD } from './read.js';
import { actionOfShape, fitReads, toolShapeId } from './recall-reads.js';
import { body, atGrain, rate, wilson, type DeriveFamily } from './read-support.js';

export const deriveCallShape: DeriveFamily = ({ pool, store }) =>
  fitReads(store).flatMap((read) => {
    const action = actionOfShape(read.tool, read.harnesses);
    // The cell names the keys as the wire sends them (`projectedStore`); a record captured before steps was never projected, so its raw names are the other spelling.
    const names = new Set([wireKeys(read.keys, read.tool, OPEN_GATE).keys.join(','), read.keys.join(',')]);
    const within = (cell: Cell): boolean => read.firstDay !== null && read.lastDay !== null && cell.day <= read.lastDay && lastDayOfCell(cell) >= read.firstDay;
    const cells = atGrain(pool, 'week').filter((cell) => {
      const shape = cell.day === UNKNOWN ? null : parseShapeClass(pool.motifs.get(cell.motifId)?.cls ?? '');
      return shape !== null && shape.action === action && shape.facet === 'keys' && names.has(shape.value) && cell.failed > 0 && within(cell);
    });
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
