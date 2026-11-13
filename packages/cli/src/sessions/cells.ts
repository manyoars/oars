// The cell (recall spec Section 2.5): counts for one motif in one frame bucket in one UTC week (or, for a live cell, one UTC day), order 0. Cells are computed from the capture records, which
// stay the primary record, so a cell file can be dropped and rebuilt and any later derivation can run over old data. Nothing here reads raw.

import { closedFrame, utcDay } from './frame.js';
import { classMotif, motifName, motifsOf, stepsOfCall, type CountedStep, type Motif } from './motif.js';
import { bucketOf } from './pool-wire.js';
import { CALL_SHAPE_METHOD, cellRef, contentHash, METHODS, RECOVERY_EDGE_METHOD } from './read.js';
import { recoveryCallsOf } from './recovery-calls.js';
import { NO_RECALLS, type PlacedStep, type RecallGraph } from './recall-consequence.js';
import { ERROR_CODES, EXTRACTOR_VERSION, harnessOf, observesUsage, type ErrorObservation, type Frame, type Harness, type PromptObservation, type SessionObservation, type ToolObservation } from './schema.js';
import type { Store } from './store.js';

/** Rule 6: an `index` cell is weekly, except a live cell, which stays at the UTC day. */
export type Grain = 'day' | 'week';

export interface Cell {
  motifId: string;
  /** `harness/versionBucket/model`, public names (`frameBucketOf`), or `env:<platform>:<shell>` for a (name, `platform`, `shell`) cell, which names no harness, version, or model (`ENVIRONMENT_BUCKET`). Effort is not in it (rule 3). */
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
  /**
   * Summed over each window's steps; a `class` cell: the whole usage of the prompts that recorded input, counting only the categories each recorded (a placeholder zero beside
   * `usageObserved` is not a measurement). Null when no session recorded any: absent, never a measured 0.
   */
  tokens: number | null;
  /** How many of `sessions` recorded the cost `tokens` sums (a class cell: input; a step cell: a step cost), which is the coverage the `tokens` figure has (a session that recorded input but not every category still counts as covered, so the figure can be partial by category); less than `sessions` makes it a partial sum. Absent on a cell read back from a stored sum written before the pool held coverage. */
  tokenSessions?: number;
  /** How many of the cell's prompts the `tokens` figure covers (a step cell counts steps): the divisor of a per-prompt mean, since `tokens` holds only prompts that recorded input. Absent like `tokenSessions`. */
  tokenPrompts?: number;
  durationMs: number;
  /** Whether these counts sit inside a shown recall's consequence window, wholly or in part. It is part of the cell's key, so a motif's exposed and unexposed counts stay apart. */
  exposed: boolean;
  /**
   * What a deposit's evidence says of the counts: `shown` (inside a shown window), `held` (inside a held one), or `unknown` (no recommendation covers them, which a pool cannot tell from a client that never looked).
   * Present only on a cell derived with an `ExposureGraph`; a local cell leaves it out and reads `exposed` alone. Its code is the last field of a stored key (`EXPOSURE_CODES`).
   */
  exposure?: Exposure;
}

/** The three readings of a recommendation's exposure. There is no `unexposed`: absent evidence is `unknown`. */
export type Exposure = 'shown' | 'held' | 'unknown';

/** The last field of a stored cell key. `unknown` is 0 so every key written before held existed keeps its meaning. */
export const EXPOSURE_CODES: Readonly<Record<Exposure, number>> = { unknown: 0, shown: 1, held: 2 };

/** A step placed by a graph that also knows the recommendations a session was held back from. */
export interface HeldStep extends PlacedStep {
  held: boolean;
}

/** A recall graph that states exposure in three readings. `deriveCells` reads `heldPrompt` and `held` beside the shown reading, and a cell it derives carries `exposure`. */
export interface ExposureGraph extends RecallGraph {
  place: (tool: ToolObservation, steps: readonly CountedStep[]) => HeldStep[];
  heldPrompt: (session: string, index: number) => boolean;
}

const statesExposure = (graph: RecallGraph): graph is ExposureGraph => 'heldPrompt' in graph;

/** A cell's reading: its own `exposure`, or for a local cell the two readings it can tell apart. */
export const exposureOfCell = (cell: Pick<Cell, 'exposed' | 'exposure'>): Exposure => cell.exposure ?? (cell.exposed ? 'shown' : 'unknown');

/** Shown wins over held, and held over unknown: a call in both windows counts as shown. */
const exposureOf = (shown: boolean, held: boolean): Exposure => (shown ? 'shown' : held ? 'held' : 'unknown');

export const UNKNOWN = 'unknown';

/** The class name an effort cell carries: a class motif with no prompt class in it, so a read of prompt classes skips it by this prefix. */
export const EFFORT_CLASS = 'effort:';

/**
 * Rule 3: effort is not in a cell's key. The one cell that holds it pairs it with the bucket of the prompt's thinking tokens, which is the fact an effort level explains, and it
 * carries `week` and `exposure` but no frame axis: rule 3 bars joining `effort` to `model` or `harnessVersion`, and the pair would be four dimensions over `q_dims`.
 */
export const effortClass = (effort: string, thinking: number): string => `${EFFORT_CLASS}${effort}/thinking:${String(bucketOf('tokens', thinking))}`;

/**
 * The two day-cell families of a failed call by its `errorCode` (t868): `error:<code>/<name>` keeps the model and no version beside the code, and `error-version:<code>/<name>` keeps the harness version bucket and no model
 * (`versionBucketOf`). Each joins three dimensions: name, code, and either model or version. A class motif with no prompt class in it, so a read of prompt classes skips both by prefix (`isPromptClass`).
 */
export const ERROR_CLASS = 'error:';
export const ERROR_VERSION_CLASS = 'error-version:';

/**
 * The week cell of what followed a failed call (t868): `recovery:<code>/<failed action>><next action>`, where the next action is that of the call right after it in the same prompt, or `none` when nothing
 * followed. It keeps the harness version bucket and no model, so it joins three dimensions: the failed-to-next edge, code, and version. A class motif with no prompt class in it, like the others.
 */
export const RECOVERY_CLASS = 'recovery:';
export const NO_NEXT = 'none';
export const recoveryClass = (code: string, failed: string, next: string): string => `${RECOVERY_CLASS}${code}/${failed}>${next}`;

/** The three parts of a recovery class name, or null for a name that is not one. An action name holds no `>` or `/`, and a code holds no `/`. */
export const parseRecoveryClass = (cls: string): { code: string; failed: string; next: string } | null => {
  const found = /^recovery:([^/]+)\/([^>/]+)>([^>/]+)$/.exec(cls);
  return found === null ? null : { code: found[1] ?? '', failed: found[2] ?? '', next: found[3] ?? '' };
};

/**
 * The week cell of a call's shape: `shape:<action>/<facet>/<value>`, one facet of what the call held and never a value. It keeps the harness version bucket and no model, so it joins three dimensions: the call's action, the
 * facet's value, and version. `target` is the class of the path target, `arg` one member of the argument classes (a set is one cell per member, rule 2), `dropped` the `count` bucket of key names not sent, and `keys` the
 * sorted key names joined by commas, the call-shape method's key (a long tail, so the pool holds it to the thresholded floor). Layer 1 adds one cell per sent key's value feature (`size`, `depth`, `extension`, `dir`, and each
 * `pattern` feature, its value `<key>=<member>`), per closed value (`enum`, `<key>=<value>`), and per change kind (`change`). A class motif with no prompt class in it, like the others.
 */
export const SHAPE_CLASS = 'shape:';
export const SHAPE_FACETS = ['target', 'arg', 'dropped', 'keys', 'size', 'depth', 'extension', 'dir', 'pattern', 'enum', 'change'] as const;
export type ShapeFacet = (typeof SHAPE_FACETS)[number];
export const shapeClass = (action: string, facet: ShapeFacet, value: string): string => `${SHAPE_CLASS}${action}/${facet}/${value}`;

/** The three parts of a shape class name, or null for a name that is not one. An action name and a facet hold no `/`; the value is the rest. */
export const parseShapeClass = (cls: string): { action: string; facet: ShapeFacet; value: string } | null => {
  const found = /^shape:([^/]+)\/([^/]+)\/(.+)$/.exec(cls);
  const facet = SHAPE_FACETS.find((name) => name === found?.[2]);
  return found === null || facet === undefined ? null : { action: found[1] ?? '', facet, value: found[3] ?? '' };
};

/** The facets one call counts in: each that the record holds. A record captured before a facet existed has none of it, so it adds no cell of that facet. */
export const shapeFacetsOf = (tool: ToolObservation): [ShapeFacet, string][] => [
  ...(tool.targetClass === undefined ? [] : [['target', tool.targetClass] satisfies [ShapeFacet, string]]),
  ...(tool.argClass ?? []).map((kind): [ShapeFacet, string] => ['arg', kind]),
  ...(tool.keysDropped === undefined ? [] : [['dropped', String(bucketOf('count', tool.keysDropped))] satisfies [ShapeFacet, string]]),
  ...(tool.keys.length === 0 ? [] : [['keys', [...tool.keys].sort().join(',')] satisfies [ShapeFacet, string]]),
  ...(tool.argFeatures ?? []).flatMap(({ key, valueSize, pathDepth, extension, dirKind, patternFeatures }): [ShapeFacet, string][] => [
    ['size', `${key}=${valueSize}`],
    ...(pathDepth === undefined ? [] : [['depth', `${key}=${pathDepth}`] satisfies [ShapeFacet, string]]),
    ...(extension === undefined ? [] : [['extension', `${key}=${extension}`] satisfies [ShapeFacet, string]]),
    ...(dirKind === undefined ? [] : [['dir', `${key}=${dirKind}`] satisfies [ShapeFacet, string]]),
    ...(patternFeatures ?? []).map((feature): [ShapeFacet, string] => ['pattern', `${key}=${feature}`]),
  ]),
  ...(tool.argValues ?? []).map(({ key, enumValue }): [ShapeFacet, string] => ['enum', `${key}=${enumValue}`]),
  ...(tool.changeKind ?? []).map((kind): [ShapeFacet, string] => ['change', kind]),
];

/** Whether a class motif names a prompt class, as opposed to one of the side cells (effort, a failed call's code or what followed it, or a call's shape). */
export const isPromptClass = (cls: string | null): boolean => cls !== null && ![EFFORT_CLASS, ERROR_CLASS, ERROR_VERSION_CLASS, RECOVERY_CLASS, SHAPE_CLASS].some((prefix) => cls.startsWith(prefix));

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

/** The frame bucket of a cell that keeps the version and drops the model: `harness/versionBucket/-`. */
export const versionBucketOf = (frame: Frame): string => [frame.harness, harnessBucket(frame.harnessVersion), NO_AXES].join('/');

export const bucketFields = (bucket: string): { harness: string; harnessBucket: string; model: string } => {
  const [harness = UNKNOWN, version = UNKNOWN, model = UNKNOWN] = bucket.split('/');
  return { harness, harnessBucket: version, model };
};

/** The frame bucket of a (name, `platform`, `shell`) cell: fit's third pool form. Rule 3 lets the two join each other and a name within `q_dims`, but not a version or a model beside them, so the cell is version-free and model-free. */
export const ENVIRONMENT_BUCKET = 'env:';

export const environmentBucketOf = (frame: Frame): string => `${ENVIRONMENT_BUCKET}${frame.platform}:${frame.shell ?? UNKNOWN}`;

export const isEnvironmentCell = (cell: Pick<Cell, 'frameBucket'>): boolean => cell.frameBucket.startsWith(ENVIRONMENT_BUCKET);

export const environmentFieldsOf = (bucket: string): { platform: string; shell: string } => {
  const held = bucket.slice(ENVIRONMENT_BUCKET.length);
  const at = held.indexOf(':');
  return { platform: held.slice(0, at), shell: held.slice(at + 1) };
};

/** A one-step named call with no flag and no pull: the name that is one dimension. A call with no identity (a file read, an edit) is its action alone, so it counts. A flag or a pull is a second dimension of its own, so its cell would be four with the pair. */
const isPlainCall = (motif: Motif): boolean => {
  const [only] = motif.steps;
  if (motif.level !== 'named' || motif.steps.length !== 1 || only === undefined) return false;
  return only.identity === null || !('program' in only.identity) || (only.identity.flags.length === 0 && (only.identity.pulls?.length ?? 0) === 0);
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
  /** The sessions whose tokens `tokens` holds: a step's count only when it recorded a cost, a prompt's only when it recorded input. */
  recorded: Set<string>;
  /** The prompts (or steps) behind `tokens`, counted where `recorded` gains a session. */
  recordedUnits: number;
  durationMs: number;
  exposure: Exposure;
}

/** The usage categories a prompt's tokens add up: thinking is part of the output already billed, so it is not summed. */
const TOKEN_FIELDS = ['input', 'cacheWrite', 'cacheRead', 'output'] as const;

const newTally = (motifId: string, frameBucket: string, grain: Grain, day: string, exposure: Exposure): Tally => ({ motifId, frameBucket, grain, day, sessions: new Set(), ok: 0, failed: 0, tokens: 0, recorded: new Set(), recordedUnits: 0, durationMs: 0, exposure });

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

/** `deriveCells` as a fold: each `add` tallies one run of sessions into the same tallies, and `finish` sorts them. The runs must come in the order the whole store holds its rows, so sums of floats match. */
export interface CellFold {
  add: (store: Store) => void;
  finish: () => CellSet;
}

export const cellFold = (graph: RecallGraph = NO_RECALLS): CellFold => {
  const tallies = new Map<string, Tally>();
  const motifs = new Map<string, Motif>();
  const tallyAt = (motif: Motif, frameBucket: string, grain: Grain, day: string, exposure: Exposure): Tally => {
    const key = `${motif.motifId}/${frameBucket}/${grain}/${day}/${exposure}`;
    const found = tallies.get(key);
    if (found !== undefined) return found;
    const fresh = newTally(motif.motifId, frameBucket, grain, day, exposure);
    tallies.set(key, fresh);
    return fresh;
  };
  /** The tallies one occurrence counts into: its week cell, and for a one-step shape motif with a known day its live cell too (rule 6). A window of two or more steps, a named motif, and a class motif have no day cell. */
  const talliesOf = (motif: Motif, frame: Frame, exposure: Exposure, frameBucket = frameBucketOf(frame)): Tally[] => {
    motifs.set(motif.motifId, motif);
    const day = frame.day ?? UNKNOWN;
    const weekly = tallyAt(motif, frameBucket, 'week', weekStartOf(day), exposure);
    const tallies = motif.level === 'shape' && motif.steps.length === 1 && day !== UNKNOWN ? [weekly, tallyAt(motif, frameBucket, 'day', day, exposure)] : [weekly];
    // Fit's (name, platform, shell) cell: a week cell beside the versioned one, counting the same call.
    return isPlainCall(motif) ? [...tallies, tallyAt(motif, environmentBucketOf(frame), 'week', weekStartOf(day), exposure)] : tallies;
  };

  const add = (store: Store): void => {
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
        const covered = placed.slice(start, start + motif.steps.length);
        for (const tally of talliesOf(motif, frame, exposureOf(covered.some(({ exposed }) => exposed), covered.some((step) => 'held' in step && step.held)))) {
          tally.sessions.add(first.parent);
          if (status === 'ok') tally.ok += 1;
          if (status === 'error') tally.failed += 1;
          for (const step of window) {
            // A step with no recorded cost has no tokens to count, so it joins neither the sum nor the coverage (its duration is still counted).
            if (step.tokens !== null) {
              tally.tokens += step.tokens;
              tally.recorded.add(first.parent);
              tally.recordedUnits += 1;
            }
            tally.durationMs += step.durationMs;
          }
        }
      }
      // What followed each failed call that has a code (t868): a week cell per (code, failed action, next action).
      // A call is read by its first step's action, as a skeleton's is; a record captured before steps has the action its native name maps to.
      const calls = line.map((call) => ({ side: call.side, prompt: call.prompt, status: call.status, steps: stepsOfCall(call, harness) }));
      for (const [at, tool] of line.entries()) {
        const followed = recoveryCallsOf(calls, at);
        if (followed === null || tool.errorCode === undefined) continue;
        const code = ERROR_CODES.has(tool.errorCode) ? tool.errorCode : 'other';
        const motif = classMotif(recoveryClass(code, calls[at]?.steps[0]?.action ?? 'other', followed.next[0] ?? NO_NEXT));
        motifs.set(motif.motifId, motif);
        const tally = tallyAt(motif, versionBucketOf(frame), 'week', weekStartOf(frame.day ?? UNKNOWN), 'unknown');
        tally.sessions.add(first.parent);
        tally.failed += 1;
      }
      // Each call's shape, by its first step's action: a week cell per facet it holds, counted by the call's own status.
      for (const [at, tool] of line.entries()) {
        const action = calls[at]?.steps[0]?.action ?? 'other';
        for (const [facet, value] of shapeFacetsOf(tool)) {
          const motif = classMotif(shapeClass(action, facet, value));
          motifs.set(motif.motifId, motif);
          const tally = tallyAt(motif, versionBucketOf(frame), 'week', weekStartOf(frame.day ?? UNKNOWN), 'unknown');
          tally.sessions.add(first.parent);
          if (tool.status === 'ok') tally.ok += 1;
          if (tool.status === 'error') tally.failed += 1;
        }
      }
      // The failed calls by their `errorCode` (t868). Rule 6: a day cell exists for a known day only.
      const failedDay = frame.day ?? UNKNOWN;
      for (const tool of failedDay === UNKNOWN ? [] : line) {
        if (tool.status !== 'error' || tool.errorCode === undefined) continue;
        const code = ERROR_CODES.has(tool.errorCode) ? tool.errorCode : 'other';
        for (const counted of stepsOfCall(tool, harness)) {
          if (counted.status !== 'error') continue;
          // The call's name at both levels: its action alone, and a named call (a flag or a pull would be a second dimension, so those steps are named by program and subcommand alone upstream).
          for (const { motif: named } of motifsOf([counted])) {
            if (named.level === 'named' && counted.identity === null) continue;
            const name = motifName(named);
            for (const [prefix, bucket] of [[ERROR_CLASS, `${frame.harness}/${NO_AXES}/${frame.model ?? UNKNOWN}`], [ERROR_VERSION_CLASS, versionBucketOf(frame)]] as const) {
              const motif = classMotif(`${prefix}${code}/${name}`);
              motifs.set(motif.motifId, motif);
              const tally = tallyAt(motif, bucket, 'day', failedDay, 'unknown');
              tally.sessions.add(first.parent);
              tally.failed += 1;
              if (counted.tokens !== null) {
                tally.tokens += counted.tokens;
                tally.recorded.add(first.parent);
                tally.recordedUnits += 1;
              }
              tally.durationMs += counted.durationMs;
            }
          }
        }
      }
    }

    for (const prompt of store.prompts) {
      const session = sessions.get(prompt.session);
      const frame = framedPrompt(prompt, harnessOf(session ?? {}), session?.env.harness ?? null, null, session?.env.os ?? UNKNOWN);
      const exposure = exposureOf(graph.exposedPrompt(prompt.session, prompt.index), statesExposure(graph) && graph.heldPrompt(prompt.session, prompt.index));
      const effort = frame.effort === null ? [] : talliesOf(classMotif(effortClass(frame.effort, prompt.usage.thinking)), frame, exposure, NO_AXES);
      for (const tally of [...talliesOf(classMotif(prompt.cls), frame, exposure), ...effort]) {
        tally.sessions.add(prompt.session);
        if (prompt.errors > 0) tally.failed += 1;
        else tally.ok += 1;
        // A prompt that recorded no input has no whole usage to count, and a category it never recorded is a placeholder zero, so neither enters the sum.
        if (observesUsage(prompt, 'input')) {
          tally.recorded.add(prompt.session);
          tally.recordedUnits += 1;
          for (const field of TOKEN_FIELDS) if (observesUsage(prompt, field)) tally.tokens += prompt.usage[field];
        }
        tally.durationMs += (prompt.wallSec ?? 0) * 1000;
      }
    }
  };

  const finish = (): CellSet => {
    const stated = statesExposure(graph);
    const cells = [...tallies.values()]
      .sort((a, b) => compare(a.motifId, b.motifId) || compare(a.frameBucket, b.frameBucket) || compare(a.grain, b.grain) || compare(a.day, b.day) || EXPOSURE_CODES[a.exposure] - EXPOSURE_CODES[b.exposure])
      .map((tally): Cell => ({ motifId: tally.motifId, frameBucket: tally.frameBucket, grain: tally.grain, day: tally.day, sessions: tally.sessions.size, clusters: ONE_OPERATOR, ok: tally.ok, failed: tally.failed, tokens: tally.recorded.size === 0 ? null : tally.tokens, tokenSessions: tally.recorded.size, tokenPrompts: tally.recordedUnits, durationMs: tally.durationMs, exposed: tally.exposure === 'shown', ...(stated ? { exposure: tally.exposure } : {}) }));
    return { cells, motifs: [...motifs.values()].sort((a, b) => compare(a.motifId, b.motifId)) };
  };
  return { add, finish };
};

export const deriveCells = (store: Store, graph: RecallGraph = NO_RECALLS): CellSet => {
  const fold = cellFold(graph);
  fold.add(store);
  return fold.finish();
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
  version: contentHash([EXTRACTOR_VERSION, METHODS, CALL_SHAPE_METHOD, RECOVERY_EDGE_METHOD, set.cells.map(cellIdOf), errorRowsRead(errors)]),
  lastDay: set.cells.reduce<string | null>((last, cell) => (cell.day !== UNKNOWN && (last === null || cell.day > last) ? cell.day : last), null),
});
