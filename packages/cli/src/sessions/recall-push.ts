// The push: a pre-tool hook's recall (spec Section 2.7). The harness tells the hook only the call it is about to run, so the query is the call's shape, and a shape
// with a read over the floors and `PUSH_MIN_LIFT` is the one thing that can arm a push. A held push stores what it would have shown and injects nothing, which is the unexposed baseline.
import { closedFrame, closedStack, utcDay } from './frame.js';
import type { HookIndex } from './hook-index.js';
import { appendRecall, armOf, makeRecall, parseRecalls, recallsPath, type Recall } from './recall-object.js';
import { toolShapeId } from './recall-reads.js';
import { evidenceOf, renderAnswer } from './recall-render.js';
import { harnessOf, type Frame } from './schema.js';
import { statedOf, tailOf } from './transcript-tail.js';

export { tailOf };

/**
 * The asker's frame, as far as a transcript's tail states it. The stack and the shell need the whole transcript, which a hook has no time to read, so they stay
 * unknown here; `delta` says unknown for them, and derive reads the session's real frame.
 */
export const frameOfTail = (tail: string, platform: string, at: string): Frame => {
  const { harnessVersion, model, effort } = statedOf(tail);
  return closedFrame({ harness: harnessOf({}), harnessVersion, model, effort, day: utcDay(at), platform, shell: null, stack: closedStack({ languages: [], frameworks: [], size: null }) });
};

export interface PushInput {
  storeDir: string;
  sid: string;
  tool: string;
  /** The call's input key names, never their values. */
  keys: readonly string[];
  transcript: string | undefined;
  platform: string;
  at: string;
  index: HookIndex;
}

/**
 * The recall a call about to run gets, written before anything is injected: an exposure with no record is the one failure the arms cannot survive. Undefined when no read
 * covers the shape, which keeps no row (no one asked, so it is not a want, and it would be a row per call), and when this session has already been told about this shape.
 */
export const pushRecall = async (input: PushInput): Promise<Recall | undefined> => {
  const shape = toolShapeId(input.tool, input.keys);
  const read = input.index.fit?.[shape];
  if (read === undefined) return undefined;
  const earlier = parseRecalls(await tailOf(recallsPath(input.storeDir)));
  if (earlier.some((recall) => recall.mode === 'push' && recall.sid === input.sid && recall.query.prefix?.[0] === shape)) return undefined;
  const frame = frameOfTail(input.transcript === undefined ? '' : await tailOf(input.transcript), input.platform, input.at);
  const { rendered, names } = renderAnswer([read], frame);
  const recall = makeRecall({
    sid: input.sid,
    at: input.at,
    frame,
    mode: 'push',
    query: { form: 'pattern', prefix: [shape] },
    poolVersion: input.index.at,
    arm: armOf(input.sid, [shape], input.index.at),
    reads: [read.readId],
    rendered,
    names,
    evidence: [evidenceOf(read, frame)],
  });
  await appendRecall(input.storeDir, recall);
  return recall;
};
