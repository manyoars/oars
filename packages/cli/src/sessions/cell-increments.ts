// The cell computation a deposit and a local read share (pool vocabulary spec Section 2, "the deposit form", and Section 4, rules 1 to 6). The pool's ingest turns a batch's skeleton into
// increments with `incrementsOf`, and a local read derives its cells with `cellsOf` over the store it holds, projected the way a deposit projects it (`projectedStore`). Both end in the
// one `cellsOf`, so a session gives the same cells at the pool and on the machine. This file reads no file system: the pool's Worker bundles it.

import { ARG_CLASSES, CHANGE_KINDS, type ArgFeature, type ArgValue } from './call-shape.js';
import { bucketFields, cellFold, ENVIRONMENT_BUCKET, EXPOSURE_CODES, exposureOfCell, isEnvironmentCell, type CellSet, type ExposureGraph, type Exposure, type Grain, type HeldStep } from './cells.js';
import type { Motif } from './motif.js';
import { bucketOf, floorOf, OTHER, OPEN_GATE, projectedSteps, wireChange, wireFeatures, wireKeys, wireValues, type SkeletonArgFeature, type SkeletonArgValue, type SessionSkeleton, type ShellReader, type SkeletonFrame, type SkeletonPrompt, type SkeletonTool, type SkeletonTranscript } from './pool-wire.js';
import { NO_RECALLS, type RecallGraph } from './recall-consequence.js';
import { USAGE_FIELDS, harnessOf, type Frame, type Harness, type PromptClass, type PromptObservation, type SessionObservation, type StepEdge, type StepObservation, type ToolObservation, type ToolStatus, type Usage } from './schema.js';
import type { Store } from './store.js';

export interface CellRow {
  key: string;
  harnessBucket: string;
  motifId: string;
  frameBucket: string;
  grain: Grain;
  day: string;
  /** 1 for a shown cell, 0 for any other: the column the cell table held before held and unknown were told apart. */
  exposed: number;
  /** Shown, held, or unknown; its code (`EXPOSURE_CODES`) is the last field of `key`. */
  exposure: Exposure;
  sessions: number;
  ok: number;
  failed: number;
  tokens: number;
  /** How many of the batch's sessions recorded input, the coverage of `tokens`; the served column sums it. */
  tokenSessions: number;
  /** How many of the batch's prompts (or steps) `tokens` covers: the divisor of a per-prompt mean. */
  tokenPrompts: number;
  durationMs: number;
}

export interface StratumRow {
  key: string;
  dimension: string;
  value: string;
  sessions: number;
}

/** What one batch adds to the index: its cells, the motifs they name, and rule 3's strata. */
export interface Increments {
  cells: Map<string, CellRow>;
  motifs: Motif[];
  strata: Map<string, StratumRow>;
}

const floorTokens = (value: number): number => floorOf('tokens', bucketOf('tokens', value));

const floorUsage = ({ input, cacheWrite, cacheRead, output, thinking }: Usage): Usage => ({
  input: floorTokens(input),
  cacheWrite: floorTokens(cacheWrite),
  cacheRead: floorTokens(cacheRead),
  output: floorTokens(output),
  thinking: floorTokens(thinking),
});

const floorPrompt = (prompt: PromptObservation): PromptObservation => ({
  ...prompt,
  errors: floorOf('count', bucketOf('count', prompt.errors)),
  wallSec: prompt.wallSec === null ? null : floorOf('seconds', bucketOf('seconds', prompt.wallSec)),
  usage: floorUsage(prompt.usage),
});

const floorTool = (tool: ToolObservation): ToolObservation => ({
  ...tool,
  durationMs: tool.durationMs === null ? null : floorOf('ms', bucketOf('ms', tool.durationMs)),
  steps: tool.steps?.map((step) => ({
    ...step,
    cost: { tokens: step.cost.tokens === null ? null : floorTokens(step.cost.tokens), durationMs: step.cost.durationMs === null ? null : floorOf('ms', bucketOf('ms', step.cost.durationMs)) },
  })),
});

const flooredStore = (store: Store): Store => ({ ...store, prompts: store.prompts.map(floorPrompt), tools: store.tools.map(floorTool) });

/** A step's shell identity without the two lists it carries: a named motif keys on the program and its subcommand, and each flag and each pull is a cell of its own (rule 1). */
const withoutLists = (step: StepObservation): StepObservation => (step.identity !== null && 'program' in step.identity ? { ...step, identity: { program: step.identity.program, sub: step.identity.sub, flags: [] } } : step);

/** One step per flag and one per pull of each shell step, each holding that one name and nothing else (rule 2: no cell has two set-valued dimensions). */
const marginalSteps = (step: StepObservation): StepObservation[] => {
  if (step.identity === null || !('program' in step.identity)) return [];
  const { program, sub, flags, pulls } = step.identity;
  return [...flags.map((flag) => ({ ...step, identity: { program, sub, flags: [flag] } })), ...(pulls ?? []).map((pull) => ({ ...step, identity: { program, sub, flags: [], pulls: [pull] } }))];
};

/** The tools of a store as one-step calls, one per flag and per pull: read at window length 1, each is one marginal cell. */
const marginalStore = (store: Store): Store => ({ ...store, tools: store.tools.flatMap((tool) => (tool.steps ?? []).flatMap(marginalSteps).map((marginal) => ({ ...tool, steps: [marginal] }))) });

/**
 * Rule 5: exact tokens and durations never reach `index`. A cell counts a bucketed value as the bucket's lowest value, so a derivation reads only what a deposit carries, and a
 * summed window is a sum of those. A value already at a bucket's floor stays there, which is why a skeleton's store and a local store of the same session derive the same cells.
 * Rules 1 and 2: a window names a shell step by its program and subcommand alone, and each flag and each pull of it adds a one-step cell of its own.
 */
export interface CellsFold {
  add: (store: Store) => void;
  finish: () => CellSet;
}

/** `cellsOf` as a fold: each `add` floors one run and tallies it, whole and marginal, and `finish` merges the two. Runs come in the whole store's row order. */
export const cellsFold = (graph: RecallGraph = NO_RECALLS): CellsFold => {
  const whole = cellFold(graph);
  const marginal = cellFold(graph);
  const add = (store: Store): void => {
    const floored = flooredStore(store);
    whole.add({ ...floored, tools: floored.tools.map((tool) => (tool.steps === undefined ? tool : { ...tool, steps: tool.steps.map(withoutLists) })) });
    // Only the one-step named motifs of the marginal pass that hold a shell identity (a recall step the graph places there has none, and `whole` already counts it) are kept at the finish: its prompts, its shape motifs, and its longer windows repeat or splice what `whole` holds.
    marginal.add(marginalStore(floored));
  };
  const finish = (): CellSet => {
    const wholeSet = whole.finish();
    const marginalSet = marginal.finish();
    const named = new Set(marginalSet.motifs.filter(({ level, steps }) => level === 'named' && steps.length === 1 && steps[0]?.identity !== null).map(({ motifId }) => motifId));
    const motifs = new Map([...wholeSet.motifs, ...marginalSet.motifs.filter(({ motifId }) => named.has(motifId))].map((motif) => [motif.motifId, motif]));
    const order = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
    const cells = [...wholeSet.cells, ...marginalSet.cells.filter(({ motifId }) => named.has(motifId))].sort((x, y) => order(x.motifId, y.motifId) || order(x.frameBucket, y.frameBucket) || order(x.grain, y.grain) || order(x.day, y.day) || EXPOSURE_CODES[exposureOfCell(x)] - EXPOSURE_CODES[exposureOfCell(y)]);
    return { cells, motifs: [...motifs.values()].sort((x, y) => order(x.motifId, y.motifId)) };
  };
  return { add, finish };
};

export const cellsOf = (store: Store, graph: RecallGraph = NO_RECALLS): CellSet => {
  const fold = cellsFold(graph);
  fold.add(store);
  return fold.finish();
};

/**
 * A local store with each shell step read as a deposit reads it (`projectedSteps`), so its named motifs are the ones the pool holds, and each call's key names as the wire sends them (`wireKeys`), so its shape cells are too.
 * It uses the open gate, which keeps the name shape and length but applies no redactor or exclusion term: a local read sends nothing.
 */
export const projectedStore = (store: Store, read: ShellReader): Store => {
  const harnesses = new Map([...store.sessions, ...store.subagents].map((session) => [session.session, harnessOf(session)]));
  return {
    ...store,
    tools: store.tools.map((tool) => {
      if (tool.steps === undefined) return tool;
      const steps = projectedSteps(tool, read, harnesses.get(tool.session) ?? 'claude-code');
      const { keys, dropped } = wireKeys(tool.keys, steps[0]?.native, OPEN_GATE);
      const sent = new Set(keys);
      const argFeatures = wireFeatures(tool.argFeatures, sent);
      const argValues = wireValues(tool.argValues, sent, steps[0]?.native);
      const changeKind = wireChange(tool.changeKind);
      // Only what the wire would carry, so the shape cells here are the pool's.
      const projected: ToolObservation = { ...tool, steps, keys };
      delete projected.argFeatures;
      delete projected.argValues;
      delete projected.changeKind;
      return { ...projected, ...(dropped === 0 ? {} : { keysDropped: dropped }), ...(argFeatures.length === 0 ? {} : { argFeatures }), ...(argValues.length === 0 ? {} : { argValues }), ...(changeKind.length === 0 ? {} : { changeKind }) };
    }),
  };
};

const NO_USAGE: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 };

/** A transcript whose harness the reader knows; one that names a harness it does not (`other` on the wire) derives no cells, since a cell is keyed by a harness the bundle can serve. */
type KnownTranscript = SkeletonTranscript & { harness: Harness };

const isKnown = (transcript: SkeletonTranscript): transcript is KnownTranscript => transcript.harness !== OTHER;

/** A frame whose own harness is `other` takes its transcript's: the two are the same harness, and a frame cannot name one the transcript does not. A repo size this reader does not know is a size the frame does not name. */
const frameOf = (frame: SkeletonFrame, harness: Harness): Frame => ({
  ...frame,
  harness: frame.harness === OTHER ? harness : frame.harness,
  stack: { ...frame.stack, size: frame.stack.size === OTHER ? null : frame.stack.size },
});

/** A class this reader does not know counts in `mixed`, the class a prompt that fits no other takes. */
const classOf = (cls: SkeletonPrompt['cls']): PromptClass => (cls === OTHER ? 'mixed' : cls);

/** A feature whose key or size this reader does not know names nothing it can count, and a field it does not know is a field the call did not send. */
const knownFeatures = (features: readonly SkeletonArgFeature[] | undefined): ArgFeature[] =>
  (features ?? []).flatMap(({ key, valueSize, pathDepth, extension, dirKind, patternFeatures }): ArgFeature[] =>
    key === OTHER || valueSize === OTHER
      ? []
      : [
          {
            key,
            valueSize,
            ...(pathDepth === undefined || pathDepth === OTHER ? {} : { pathDepth }),
            ...(extension === undefined || extension === OTHER ? {} : { extension }),
            ...(dirKind === undefined || dirKind === OTHER ? {} : { dirKind }),
            ...(patternFeatures === undefined ? {} : { patternFeatures: patternFeatures.flatMap((feature) => (feature === OTHER ? [] : [feature])) }),
          },
        ],
  );

const knownValues = (values: readonly SkeletonArgValue[] | undefined): ArgValue[] => (values ?? []).filter(({ key, enumValue }) => key !== OTHER && enumValue !== OTHER);

/** A status this reader does not know is a segment the call did not report. */
const statusOf = (status: SkeletonTool['status']): ToolStatus => (status === OTHER ? 'none' : status);

/** A skeleton's transcript as the record `deriveCells` reads. Everything a skeleton leaves out stays empty, so no derivation here can come to depend on it unnoticed. */
const sessionRecord = (id: string, parent: string | null, spawnedIn: string | null, { harness, frame }: KnownTranscript): SessionObservation => ({
  kind: 'session',
  cv: '',
  sid: '',
  session: id,
  project: '',
  parent,
  agentType: null,
  spawnedBy: null,
  spawnedIn,
  rev: 1,
  at: '',
  bytes: 0,
  lines: 0,
  badLines: 0,
  userTurns: 0,
  assistantTurns: 0,
  tsFirst: null,
  tsLast: null,
  versions: [],
  models: {},
  branches: [],
  tools: {},
  files: [],
  fileHashes: [],
  // The store's salted key, so a read that groups by repo works on pooled data from one store (one machine). It joins no cell.
  repo: frame.repoKey ?? null,
  urls: [],
  searches: [],
  bashCmds: 0,
  tldrs: [],
  confidences: [],
  compactSummaries: 0,
  promptFingerprint: null,
  env: { harness: frame.harnessVersion ?? '', oars: '', node: '', os: frame.platform },
  costUsd: null,
  usage: NO_USAGE,
  harness,
  frame: frameOf(frame, harness),
});

const promptRecords = (id: string, { harness, prompts }: KnownTranscript): PromptObservation[] =>
  prompts.map(({ cls, errors, wallSec, usage, usageResponses, explore, frame }, index) => ({
    kind: 'prompt',
    v: '',
    session: id,
    rev: 1,
    index,
    ts: null,
    wallSec: wallSec === null ? null : floorOf('seconds', wallSec),
    head: '',
    cls: classOf(cls),
    tools: [],
    shape: '',
    errors: floorOf('count', errors),
    thinking: 0,
    sideTools: 0,
    turns: 0,
    model: frame.model ?? '',
    efforts: frame.effort === null ? [] : [frame.effort],
    skills: [],
    // A category the wire sent as null was never recorded: it reads as a placeholder zero here and is left out of `usageObserved`.
    usage: {
      input: floorOf('tokens', usage.input ?? 0),
      cacheWrite: floorOf('tokens', usage.cacheWrite ?? 0),
      cacheRead: floorOf('tokens', usage.cacheRead ?? 0),
      output: floorOf('tokens', usage.output ?? 0),
      thinking: floorOf('tokens', usage.thinking ?? 0),
    },
    usageObserved: USAGE_FIELDS.filter((field) => usage[field] !== null),
    ...(usageResponses === undefined ? {} : { usageResponses: floorOf('count', usageResponses) }),
    recovery: [],
    // The lowest value of the bucket, as every other bucketed value counts; a prompt that sent none counts none.
    explore: explore === null ? 0 : floorOf('calls', explore),
    act: 0,
    bigrams: {},
    contextFingerprint: null,
    frame: frameOf(frame, harness),
  }));

/** A step's place as the store names it: its call's position and its segment. A transcript's steps are numbered across its calls in order, which is what an edge's target counts. */
const stepPlaces = ({ tools }: SkeletonTranscript): { n: number; seg: number }[] => tools.flatMap(({ steps }, n) => steps.map((_, seg) => ({ n, seg })));

const toolRecords = (id: string, main: string, transcript: KnownTranscript, spawner: SkeletonTranscript | null): ToolObservation[] => {
  const own = stepPlaces(transcript);
  const spawning = spawner === null ? [] : stepPlaces(spawner);
  return transcript.tools.map(({ side, prompt, status, durationMs, errorCode, keys, keysDropped, targetClass, argClass, argFeatures, argValues, changeKind, steps }, n) => ({
    kind: 'tool',
    cv: '',
    sid: '',
    session: id,
    rev: 1,
    parent: main,
    agentType: null,
    n,
    ts: null,
    tool: steps[0]?.native ?? '',
    status: statusOf(status),
    target: null,
    targetBase: null,
    // The names the wire carried, which are the only ones a skeleton-derived store ever holds, and the count of those it did not, at its bucket's lowest value.
    keys: keys ?? [],
    ...(keysDropped === undefined ? {} : { keysDropped: floorOf('count', keysDropped) }),
    ...(targetClass === undefined ? {} : { targetClass }),
    ...(argClass === undefined ? {} : { argClass: ARG_CLASSES.filter((kind) => argClass.includes(kind)).sort() }),
    ...(argFeatures === undefined ? {} : { argFeatures: knownFeatures(argFeatures) }),
    ...(argValues === undefined ? {} : { argValues: knownValues(argValues) }),
    ...(changeKind === undefined ? {} : { changeKind: CHANGE_KINDS.filter((kind) => changeKind.includes(kind)) }),
    durationMs,
    toolUseId: '',
    harnessVersion: null,
    side,
    prompt,
    ...(errorCode === null ? {} : { errorCode }),
    steps: steps.map(({ action, native, identity, status: reported, parent, tokens, ms, edges }, seg) => ({
      action,
      native,
      identity,
      status: statusOf(reported),
      parent,
      seg,
      // A target is read back as the call position and segment it names, in this transcript or, for a `spawned` edge, in the spawning one. A target the transcript does not hold names nothing and is left out, and so does a kind this reader does not know (`other`).
      edges: (edges ?? []).flatMap(({ kind, target }): StepEdge[] => {
        const place = (kind === 'spawned' ? spawning : own)[target];
        return place === undefined || kind === OTHER ? [] : [{ kind, n: place.n, seg: place.seg }];
      }),
      cost: { tokens: tokens === null ? null : floorOf('tokens', tokens), durationMs: ms === null ? null : floorOf('ms', ms) },
      n,
      frameId: '',
    })),
  }));
};

/** One account's deposits as a store. A session's id is its skeleton's, which the client hashes per account, so it joins nothing across accounts. */
export const storeOf = (skeletons: readonly SessionSkeleton[]): Store => {
  const store: Store = { sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0 };
  for (const { id, transcripts } of skeletons) {
    const nameOf = (index: number): string => `${id}#${String(index)}`;
    const main = nameOf(0);
    transcripts.forEach((transcript, index) => {
      if (!isKnown(transcript)) return;
      const session = nameOf(index);
      const spawner = transcript.spawnedIn === null ? null : (transcripts[transcript.spawnedIn] ?? null);
      (index === 0 ? store.sessions : store.subagents).push(sessionRecord(session, index === 0 ? null : main, transcript.spawnedIn === null ? null : nameOf(transcript.spawnedIn), transcript));
      store.prompts.push(...promptRecords(session, transcript));
      store.tools.push(...toolRecords(session, main, transcript, spawner));
    });
  }
  return store;
};

const callKey = (tool: Pick<ToolObservation, 'session' | 'n'>): string => `${tool.session}#${String(tool.n)}`;
const promptKey = (session: string, index: number | null): string => `${session}#${String(index)}`;

/**
 * The graph a deposit derives its cells under: the recommendations the skeleton carries, placed on the main run's calls that are not sidechain (the line the windows were counted on). A call in a shown window is shown, in a held
 * one held, and one the batch has no row for is unknown: the graph adds no step and never reads a call as unexposed, since no row cannot be told from a client that did not look. An arm this reader does not know places nothing.
 */
export const exposureGraphOf = (store: Store, skeleton: SessionSkeleton): ExposureGraph => {
  const main = `${skeleton.id}#0`;
  const line = store.tools.filter((tool) => tool.session === main && !tool.side).sort((a, b) => a.n - b.n);
  const shown = { calls: new Set<string>(), prompts: new Set<string>() };
  const held = { calls: new Set<string>(), prompts: new Set<string>() };
  for (const { arm, from, to } of skeleton.recommendations ?? []) {
    if (arm === OTHER) continue;
    const into = arm === 'shown' ? shown : held;
    for (const tool of line.slice(from, to)) {
      into.calls.add(callKey(tool));
      into.prompts.add(promptKey(tool.session, tool.prompt));
    }
  }
  return {
    place: (tool, steps): HeldStep[] => steps.map((step) => ({ step, exposed: shown.calls.has(callKey(tool)), held: held.calls.has(callKey(tool)) })),
    exposedPrompt: (session, index) => shown.prompts.has(promptKey(session, index)),
    heldPrompt: (session, index) => held.prompts.has(promptKey(session, index)),
  };
};

/** Whole cells and strata, summed over a batch's own sessions: the same cells a store of that batch alone derives, under the exposure the batch carries. */
export const incrementsOf = (skeleton: SessionSkeleton): Increments => {
  const store = storeOf([skeleton]);
  const derived = cellsOf(store, exposureGraphOf(store, skeleton));
  const cells = new Map<string, CellRow>();
  for (const cell of derived.cells) {
    const exposure = exposureOfCell(cell);
    const exposed = cell.exposed ? 1 : 0;
    const key = `${cell.motifId}/${cell.frameBucket}/${cell.grain}/${cell.day}/${String(EXPOSURE_CODES[exposure])}`;
    // The served column is a running sum, so a cell no session of this batch recorded tokens for adds nothing to it; the sum itself holds only what was observed, and `tokenSessions` and `tokenPrompts` say how much of the cell it covers.
    cells.set(key, { key, harnessBucket: isEnvironmentCell(cell) ? ENVIRONMENT_BUCKET : bucketFields(cell.frameBucket).harnessBucket, motifId: cell.motifId, frameBucket: cell.frameBucket, grain: cell.grain, day: cell.day, exposed, exposure, sessions: cell.sessions, ok: cell.ok, failed: cell.failed, tokens: cell.tokens ?? 0, tokenSessions: cell.tokenSessions ?? 0, tokenPrompts: cell.tokenPrompts ?? 0, durationMs: cell.durationMs });
  }
  // A session counts once per value, so each value is one session of this batch.
  const strata = new Map<string, StratumRow>();
  const frames = skeleton.transcripts.flatMap(({ frame, prompts }) => [frame, ...prompts.map((prompt) => prompt.frame)]);
  const named: [string, string][] = [
    ...frames.flatMap(({ stack }) => stack.languages.map((value): [string, string] => ['language', value])),
    ...frames.flatMap(({ stack }) => stack.frameworks.map((value): [string, string] => ['framework', value])),
    ...frames.flatMap(({ stack }) => (stack.size === null ? [] : [['repoFiles', stack.size] satisfies [string, string]])),
    // The two pairs (rule 3): each is a stratum of its own, never a cell and never keyed by the stack's other values. A language with no share, and a prompt with no count, make none.
    ...frames.flatMap(({ stack }) => stack.languageShares.map(({ language, languageShare }): [string, string] => ['languageShare', `${language}/${languageShare}`])),
    ...skeleton.transcripts.flatMap(({ prompts }) => prompts.flatMap(({ explore, frame }) => (explore === null || frame.stack.size === null ? [] : [['repoFilesExplore', `${frame.stack.size}/${String(explore)}`] satisfies [string, string]]))),
  ];
  for (const [dimension, value] of named) strata.set(`${dimension}/${value}`, { key: `${dimension}/${value}`, dimension, value, sessions: 1 });
  return { cells, motifs: derived.motifs, strata };
};
