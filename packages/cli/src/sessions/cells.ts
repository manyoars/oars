// The cell (recall spec Section 2.5): counts for one motif in one frame bucket in one UTC week (or, for a live cell, one UTC day), order 0. Cells are computed from the capture records, which
// stay the primary record, so a cell file can be dropped and rebuilt and any later derivation can run over old data. Nothing here reads raw.

import { closedFrame, utcDay } from './frame.js';
import { classMotif, motifsOf, stepsOfCall, type Motif } from './motif.js';
import { bucketOf } from './pool-wire.js';
import { CALL_SHAPE_METHOD, cellRef, contentHash, METHODS } from './read.js';
import { NO_RECALLS, type RecallGraph } from './recall-consequence.js';
import { EXTRACTOR_VERSION, harnessOf, type ErrorObservation, type Frame, type Harness, type PromptObservation, type SessionObservation, type ToolObservation } from './schema.js';
import type { Store } from './store.js';

/** Rule 6: an `index` cell is weekly, except a live cell, which stays at the UTC day. */
export type Grain = 'day' | 'week';

export interface Cell {
  motifId: string;
  /** `harness/versionBucket/model`, public names (`frameBucketOf`). Effort is not in it (rule 3). */
  frameBucket: string;
  /** What `day` names: a UTC day, or a UTC week. A read takes the grain it answers from and never the other. */
  grain: Grain;
  /** The UTC day of the step's frame for a day cell, the Monday of its UTC week for a week cell, or `unknown`. */
  day: string;
  /** Distinct main sessions: a subagent's steps count under the session that spawned it. */
  sessions: number;
  /** Distinct accounts. One store is one operator, so 1 here (spec Section 6: one operator stays labeled). */
  clusters: number;
  /** Windows whose last step came back clean; a `class` cell: prompts with no error. */
  ok: number;
  /** Windows whose last step failed; a `class` cell: prompts with an error. A step with no result is in neither. */
  failed: number;
  /** Summed over each window's steps; a `class` cell: the prompts' whole usage. */
  tokens: number;
  durationMs: number;
  /** Whether these counts sit inside a shown recall's consequence window, wholly or in part. It is part of the cell's key, so a motif's exposed and unexposed counts stay apart. */
  exposed: boolean;
}

export const UNKNOWN = 'unknown';

/** The class name an effort cell carries: a class motif with no prompt class in it, so a read of prompt classes skips it by this prefix. */
export const EFFORT_CLASS = 'effort:';

/**
 * Rule 3: effort is not in a cell's key. The one cell that holds it pairs it with the bucket of the prompt's thinking tokens, which is the fact an effort level explains, and it
 * carries `week` and `exposure` but no frame axis: rule 3 bars joining `effort` to `model` or `harnessVersion`, and the pair would be four dimensions over `q_dims`.
 */
export const effortClass = (effort: string, thinking: number): string => `${EFFORT_CLASS}${effort}/thinking:${String(bucketOf('tokens', thinking))}`;

/** The frame bucket of a cell that joins no axis. */
export const NO_AXES = '-';

const ONE_OPERATOR = 1;

/**
 * A harness version's bucket: its patch by tens. 70.5 percent of one operator's later prompts ran a version not yet seen, so an
 * exact-version cell goes stale in days; a reader compares buckets by distance instead. A version with no patch stands for itself.
 */
export const harnessBucket = (version: string | null): string => {
  if (version === null) return UNKNOWN;
  const found = /^(\d+\.\d+)\.(\d+)/.exec(version);
  return found === null ? version : `${found[1] ?? ''}.${String(Math.floor(Number(found[2]) / 10))}x`;
};

/** Only what most comparisons cross: platform, shell, and stack are on the frame and in the records, so a later extractor can add them without new capture. */
export const frameBucketOf = (frame: Frame): string => [frame.harness, harnessBucket(frame.harnessVersion), frame.model ?? UNKNOWN].join('/');

export const bucketFields = (bucket: string): { harness: string; harnessBucket: string; model: string } => {
  const [harness = UNKNOWN, version = UNKNOWN, model = UNKNOWN] = bucket.split('/');
  return { harness, harnessBucket: version, model };
};

const DAY_MS = 86_400_000;

/** The Monday of the UTC week a UTC day falls in, as a day: the week's name in a cell. An unknown day is an unknown week. */
export const weekStartOf = (day: string): string => {
  if (day === UNKNOWN) return UNKNOWN;
  const millis = Date.parse(day);
  return new Date(millis - ((new Date(millis).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
};

/** The last UTC day a cell can hold: its day, or the Sunday that closes its week. A check that evidence predates a day reads this, since a week's cell may hold any of its seven days. */
export const lastDayOfCell = (cell: Cell): string => (cell.grain === 'week' && cell.day !== UNKNOWN ? new Date(Date.parse(cell.day) + 6 * DAY_MS).toISOString().slice(0, 10) : cell.day);

const cellIds = new WeakMap<Cell, string>();

/** `cell:<contentHash>`: a cell that counts differently is a different cell, so a read's inputs pin what it read. */
export const cellIdOf = (cell: Cell): string => {
  const known = cellIds.get(cell);
  if (known !== undefined) return known;
  const id = cellRef(contentHash(cell));
  cellIds.set(cell, id);
  return id;
};

export interface CellSet {
  cells: Cell[];
  motifs: Motif[];
}

interface Tally {
  motifId: string;
  frameBucket: string;
  grain: Grain;
  day: string;
  sessions: Set<string>;
  ok: number;
  failed: number;
  tokens: number;
  durationMs: number;
  exposed: boolean;
}

const newTally = (motifId: string, frameBucket: string, grain: Grain, day: string, exposed: boolean): Tally => ({ motifId, frameBucket, grain, day, sessions: new Set(), ok: 0, failed: 0, tokens: 0, durationMs: 0, exposed });

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A frame for a record captured before frames existed, from the fields it does hold, held to the same public vocabulary. */
const oldFrame = (parts: { harness: Harness; version: string | null; model: string | null; effort: string | null; ts: string | null; platform: string }): Frame =>
  closedFrame({
    harness: parts.harness,
    harnessVersion: parts.version,
    model: parts.model === '' ? null : parts.model,
    effort: parts.effort,
    day: utcDay(parts.ts),
    platform: parts.platform,
    shell: null,
    stack: { languages: [], frameworks: [], size: null },
  });

const mostUsedModel = (models: { [model: string]: number }): string | null => [...Object.entries(models)].sort(([a, one], [b, two]) => two - one || compare(a, b))[0]?.[0] ?? null;

const framedPrompt = (prompt: PromptObservation, harness: Harness, version: string | null, ts: string | null, platform: string): Frame =>
  prompt.frame ?? oldFrame({ harness, version, model: prompt.model, effort: prompt.efforts[0] ?? null, ts: prompt.ts ?? ts, platform });

/** One line of work (spec Section 2.3): a window never crosses a prompt, a sidechain, or a transcript. */
const linesOf = (tools: readonly ToolObservation[]): ToolObservation[][] => {
  const lines = new Map<string, ToolObservation[]>();
  for (const tool of tools) {
    const key = `${tool.session}\n${String(tool.side)}\n${String(tool.prompt)}`;
    const line = lines.get(key);
    if (line === undefined) lines.set(key, [tool]);
    else line.push(tool);
  }
  return [...lines.values()].map((line) => line.sort((a, b) => a.n - b.n));
};

export const deriveCells = (store: Store, graph: RecallGraph = NO_RECALLS): CellSet => {
  const tallies = new Map<string, Tally>();
  const motifs = new Map<string, Motif>();
  const tallyAt = (motif: Motif, frameBucket: string, grain: Grain, day: string, exposed: boolean): Tally => {
    const key = `${motif.motifId}/${frameBucket}/${grain}/${day}/${String(exposed)}`;
    const found = tallies.get(key);
    if (found !== undefined) return found;
    const fresh = newTally(motif.motifId, frameBucket, grain, day, exposed);
    tallies.set(key, fresh);
    return fresh;
  };
  /** The tallies one occurrence counts into: its week cell, and for a shape motif with a known day its live cell too (rule 6). A named or class motif has no day cell. */
  const talliesOf = (motif: Motif, frame: Frame, exposed: boolean, frameBucket = frameBucketOf(frame)): Tally[] => {
    motifs.set(motif.motifId, motif);
    const day = frame.day ?? UNKNOWN;
    const weekly = tallyAt(motif, frameBucket, 'week', weekStartOf(day), exposed);
    return motif.level === 'shape' && day !== UNKNOWN ? [weekly, tallyAt(motif, frameBucket, 'day', day, exposed)] : [weekly];
  };

  const sessions = new Map<string, SessionObservation>([...store.sessions, ...store.subagents].map((session) => [session.session, session]));
  const prompts = new Map(store.prompts.map((prompt) => [`${prompt.session}#${String(prompt.index)}`, prompt]));

  for (const line of linesOf(store.tools)) {
    const [first] = line;
    const session = first === undefined ? undefined : sessions.get(first.session);
    if (first === undefined || session === undefined) continue;
    const harness = harnessOf(session);
    const version = first.harnessVersion ?? session.env.harness;
    const prompt = prompts.get(`${first.session}#${String(first.prompt)}`);
    const frame =
      prompt === undefined
        ? (session.frame ?? oldFrame({ harness, version, model: mostUsedModel(session.models), effort: null, ts: first.ts ?? session.tsFirst, platform: session.env.os }))
        : framedPrompt(prompt, harness, version, first.ts, session.env.os);
    const placed = line.flatMap((tool) => graph.place(tool, stepsOfCall(tool, harness)));
    const steps = placed.map(({ step }) => step);
    for (const { motif, start } of motifsOf(steps)) {
      const window = steps.slice(start, start + motif.steps.length);
      const status = window.at(-1)?.status;
      for (const tally of talliesOf(motif, frame, placed.slice(start, start + motif.steps.length).some(({ exposed }) => exposed))) {
        tally.sessions.add(first.parent);
        if (status === 'ok') tally.ok += 1;
        if (status === 'error') tally.failed += 1;
        for (const step of window) {
          tally.tokens += step.tokens;
          tally.durationMs += step.durationMs;
        }
      }
    }
  }

  for (const prompt of store.prompts) {
    const session = sessions.get(prompt.session);
    const frame = framedPrompt(prompt, harnessOf(session ?? {}), session?.env.harness ?? null, null, session?.env.os ?? UNKNOWN);
    const exposed = graph.exposedPrompt(prompt.session, prompt.index);
    const effort = frame.effort === null ? [] : talliesOf(classMotif(effortClass(frame.effort, prompt.usage.thinking)), frame, exposed, NO_AXES);
    for (const tally of [...talliesOf(classMotif(prompt.cls), frame, exposed), ...effort]) {
      tally.sessions.add(prompt.session);
      if (prompt.errors > 0) tally.failed += 1;
      else tally.ok += 1;
      const { input, cacheWrite, cacheRead, output } = prompt.usage;
      tally.tokens += input + cacheWrite + cacheRead + output;
      tally.durationMs += (prompt.wallSec ?? 0) * 1000;
    }
  }

  const cells = [...tallies.values()]
    .sort((a, b) => compare(a.motifId, b.motifId) || compare(a.frameBucket, b.frameBucket) || compare(a.grain, b.grain) || compare(a.day, b.day) || Number(a.exposed) - Number(b.exposed))
    .map((tally): Cell => ({ motifId: tally.motifId, frameBucket: tally.frameBucket, grain: tally.grain, day: tally.day, sessions: tally.sessions.size, clusters: ONE_OPERATOR, ok: tally.ok, failed: tally.failed, tokens: tally.tokens, durationMs: tally.durationMs, exposed: tally.exposed }));
  return { cells, motifs: [...motifs.values()].sort((a, b) => compare(a.motifId, b.motifId)) };
};

export const serializeCells = (cells: readonly Cell[]): string => cells.map((cell) => `${JSON.stringify(cell)}\n`).join('');

/** What every read of one derive pass reads, and the snapshot it answers from. */
export interface Pool {
  cells: readonly Cell[];
  motifs: ReadonlyMap<string, Motif>;
  /** The hash of the extractor version, the family methods, every cell, and the error rows recovery reads: new data or a new rule is a new pool, and every read of it a new read. */
  version: string;
  lastDay: string | null;
}

/** The fields of an error row a recovery read depends on, as text: only those, so a change elsewhere is not a new pool, and sorted, so record order is not one either. */
const errorRowsRead = (errors: readonly ErrorObservation[]): string[] =>
  errors.map(({ session, agent, toolUseId, prompt, tool, sig, ts, next, editFollowed }) => JSON.stringify([session, agent ?? null, toolUseId ?? null, prompt, tool, sig, ts, next, editFollowed])).sort();

export const poolOf = (set: CellSet, errors: readonly ErrorObservation[]): Pool => ({
  cells: set.cells,
  motifs: new Map(set.motifs.map((motif) => [motif.motifId, motif])),
  version: contentHash([EXTRACTOR_VERSION, METHODS, CALL_SHAPE_METHOD, set.cells.map(cellIdOf), errorRowsRead(errors)]),
  lastDay: set.cells.reduce<string | null>((last, cell) => (cell.day !== UNKNOWN && (last === null || cell.day > last) ? cell.day : last), null),
});
