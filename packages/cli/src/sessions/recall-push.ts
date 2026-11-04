// The push: a pre-tool hook's recall (spec Section 2.7). The harness tells the hook only the call it is about to run, so the query is the call's shape, and a shape
// with a read over the floors and `PUSH_MIN_LIFT` is the one thing that can arm a push. A held push stores what it would have shown and injects nothing, which is the unexposed baseline.
import { open, type FileHandle } from 'node:fs/promises';
import { closedFrame, closedStack, utcDay } from './frame.js';
import type { HookIndex } from './hook-index.js';
import { appendRecall, armOf, makeRecall, parseRecalls, recallsPath, type Recall } from './recall-object.js';
import { toolShapeId } from './recall-reads.js';
import { evidenceOf, renderAnswer } from './recall-render.js';
import { harnessOf, type Frame } from './schema.js';

/** How far back a hook looks in a growing file: enough for the session's latest lines, and a bound on what a hook on every call can cost. */
const TAIL_BYTES = 64 * 1024;

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const openIfThere = async (file: string): Promise<FileHandle | undefined> => {
  try {
    return await open(file, 'r');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

/** A file's last bytes; a first line this cuts in two fails to parse and is skipped by whoever reads it. */
export const tailOf = async (file: string): Promise<string> => {
  const handle = await openIfThere(file);
  if (handle === undefined) return '';
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
};

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const parsedLines = (tail: string): Array<{ [key: string]: unknown }> =>
  tail.split('\n').flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return isRecord(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });

/**
 * The asker's frame, as far as a transcript's tail states it. The stack and the shell need the whole transcript, which a hook has no time to read, so they stay
 * unknown here; `delta` says unknown for them, and derive reads the session's real frame.
 */
export const frameOfTail = (tail: string, platform: string, at: string): Frame => {
  let harnessVersion: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  // Oldest first, so the newest line that states a field wins.
  for (const line of parsedLines(tail)) {
    harnessVersion = text(line.version) ?? harnessVersion;
    effort = text(line.effort) ?? effort;
    if (isRecord(line.message)) model = text(line.message.model) ?? model;
  }
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
