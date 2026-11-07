// The cell computation a deposit and a local read share (pool vocabulary spec Section 2, "the deposit form", and Section 4, rules 1 to 6). The pool's ingest turns a batch's skeleton into
// increments with `incrementsOf`, and a local read derives its cells with `cellsOf` over the store it holds, projected the way a deposit projects it (`projectedStore`). Both end in the
// one `cellsOf`, so a session gives the same cells at the pool and on the machine. This file reads no file system: the pool's Worker bundles it.

import { bucketFields, deriveCells, ENVIRONMENT_BUCKET, isEnvironmentCell, type CellSet, type Grain } from './cells.js';
import type { Motif } from './motif.js';
import { bucketOf, floorOf, OTHER, projectedSteps, type SessionSkeleton, type ShellReader, type SkeletonFrame, type SkeletonPrompt, type SkeletonTool, type SkeletonTranscript } from './pool-wire.js';
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
  exposed: number;
  sessions: number;
  ok: number;
  failed: number;
  tokens: number;
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
export const cellsOf = (store: Store, graph: RecallGraph = NO_RECALLS): CellSet => {
  const floored = flooredStore(store);
  const whole = deriveCells({ ...floored, tools: floored.tools.map((tool) => (tool.steps === undefined ? tool : { ...tool, steps: tool.steps.map(withoutLists) })) }, graph);
  // Only the one-step named motifs of the marginal pass that hold a shell identity (a recall step the graph places there has none, and `whole` already counts it): its prompts, its shape motifs, and its longer windows repeat or splice what `whole` holds.
  const marginal = deriveCells(marginalStore(floored), graph);
  const named = new Set(marginal.motifs.filter(({ level, steps }) => level === 'named' && steps.length === 1 && steps[0]?.identity !== null).map(({ motifId }) => motifId));
  const motifs = new Map([...whole.motifs, ...marginal.motifs.filter(({ motifId }) => named.has(motifId))].map((motif) => [motif.motifId, motif]));
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const cells = [...whole.cells, ...marginal.cells.filter(({ motifId }) => named.has(motifId))].sort((a, b) => order(a.motifId, b.motifId) || order(a.frameBucket, b.frameBucket) || order(a.grain, b.grain) || order(a.day, b.day) || Number(a.exposed) - Number(b.exposed));
  return { cells, motifs: [...motifs.values()].sort((a, b) => order(a.motifId, b.motifId)) };
};

/** A local store with each shell step read as a deposit reads it (`projectedSteps`), so its named motifs are the ones the pool holds. */
export const projectedStore = (store: Store, read: ShellReader): Store => {
  const harnesses = new Map([...store.sessions, ...store.subagents].map((session) => [session.session, harnessOf(session)]));
  return { ...store, tools: store.tools.map((tool) => (tool.steps === undefined ? tool : { ...tool, steps: projectedSteps(tool, read, harnesses.get(tool.session) ?? 'claude-code') })) };
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
  repo: null,
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
  return transcript.tools.map(({ side, prompt, status, durationMs, errorCode, steps }, n) => ({
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
    keys: [],
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

/** Whole cells and strata, summed over a batch's own sessions: the same cells a store of that batch alone derives. */
export const incrementsOf = (skeleton: SessionSkeleton): Increments => {
  const derived = cellsOf(storeOf([skeleton]));
  const cells = new Map<string, CellRow>();
  for (const cell of derived.cells) {
    const exposed = cell.exposed ? 1 : 0;
    const key = `${cell.motifId}/${cell.frameBucket}/${cell.grain}/${cell.day}/${String(exposed)}`;
    cells.set(key, { key, harnessBucket: isEnvironmentCell(cell) ? ENVIRONMENT_BUCKET : bucketFields(cell.frameBucket).harnessBucket, motifId: cell.motifId, frameBucket: cell.frameBucket, grain: cell.grain, day: cell.day, exposed, sessions: cell.sessions, ok: cell.ok, failed: cell.failed, tokens: cell.tokens, durationMs: cell.durationMs });
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
