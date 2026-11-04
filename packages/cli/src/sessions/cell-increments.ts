// The cell computation a deposit and a local read share (pool vocabulary spec Section 2, "the deposit form", and Section 4, rules 1 to 6). The pool's ingest turns a batch's skeleton into
// increments with `incrementsOf`, and a local read derives its cells with `cellsOf` over the store it holds, projected the way a deposit projects it (`projectedStore`). Both end in the
// one `cellsOf`, so a session gives the same cells at the pool and on the machine. This file reads no file system: the pool's Worker bundles it.

import { bucketFields, deriveCells, type CellSet } from './cells.js';
import type { Motif } from './motif.js';
import { bucketOf, floorOf, projectedSteps, type SessionSkeleton, type ShellReader, type SkeletonTranscript } from './pool-wire.js';
import { NO_RECALLS, type RecallGraph } from './recall-consequence.js';
import type { PromptObservation, SessionObservation, ToolObservation, Usage } from './schema.js';
import type { Store } from './store.js';

export interface CellRow {
  key: string;
  harnessBucket: string;
  motifId: string;
  frameBucket: string;
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
  thinking: floorOf('count', bucketOf('count', thinking)),
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

/**
 * Rule 5: exact tokens and durations never reach `index`. A cell counts a bucketed value as the bucket's lowest value, so a derivation reads only what a deposit carries, and a
 * summed window is a sum of those. A value already at a bucket's floor stays there, which is why a skeleton's store and a local store of the same session derive the same cells.
 */
export const cellsOf = (store: Store, graph: RecallGraph = NO_RECALLS): CellSet => deriveCells({ ...store, prompts: store.prompts.map(floorPrompt), tools: store.tools.map(floorTool) }, graph);

/** A local store with each shell step read as a deposit reads it (`projectedSteps`), so its named motifs are the ones the pool holds. */
export const projectedStore = (store: Store, read: ShellReader): Store => ({ ...store, tools: store.tools.map((tool) => (tool.steps === undefined ? tool : { ...tool, steps: projectedSteps(tool, read) })) });

const NO_USAGE: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 };

/** A skeleton's transcript as the record `deriveCells` reads. Everything a skeleton leaves out stays empty, so no derivation here can come to depend on it unnoticed. */
const sessionRecord = (id: string, parent: string | null, spawnedIn: string | null, { harness, frame }: SkeletonTranscript): SessionObservation => ({
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
  frame,
});

const promptRecords = (id: string, { prompts }: SkeletonTranscript): PromptObservation[] =>
  prompts.map(({ index, cls, errors, wallSec, usage, frame }) => ({
    kind: 'prompt',
    v: '',
    session: id,
    rev: 1,
    index,
    ts: null,
    wallSec: wallSec === null ? null : floorOf('seconds', wallSec),
    head: '',
    cls,
    tools: [],
    shape: '',
    errors: floorOf('count', errors),
    thinking: 0,
    sideTools: 0,
    turns: 0,
    model: frame.model ?? '',
    efforts: frame.effort === null ? [] : [frame.effort],
    skills: [],
    usage: {
      input: floorOf('tokens', usage.input),
      cacheWrite: floorOf('tokens', usage.cacheWrite),
      cacheRead: floorOf('tokens', usage.cacheRead),
      output: floorOf('tokens', usage.output),
      thinking: floorOf('count', usage.thinking),
    },
    recovery: [],
    explore: 0,
    act: 0,
    bigrams: {},
    contextFingerprint: null,
    frame,
  }));

const toolRecords = (id: string, main: string, { tools }: SkeletonTranscript): ToolObservation[] =>
  tools.map(({ n, side, prompt, status, durationMs, steps }) => ({
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
    status,
    target: null,
    targetBase: null,
    keys: [],
    durationMs,
    toolUseId: '',
    harnessVersion: null,
    side,
    prompt,
    steps: steps.map(({ tokens, ms, ...step }) => ({
      ...step,
      cost: { tokens: tokens === null ? null : floorOf('tokens', tokens), durationMs: ms === null ? null : floorOf('ms', ms) },
      n,
      frameId: '',
    })),
  }));

/** One account's deposits as a store. A session's id is its skeleton's, which the client hashes per account, so it joins nothing across accounts. */
export const storeOf = (skeletons: readonly SessionSkeleton[]): Store => {
  const store: Store = { sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0 };
  for (const { id, transcripts } of skeletons) {
    const nameOf = (index: number): string => `${id}#${String(index)}`;
    const main = nameOf(0);
    transcripts.forEach((transcript, index) => {
      const session = nameOf(index);
      (index === 0 ? store.sessions : store.subagents).push(sessionRecord(session, index === 0 ? null : main, transcript.spawnedIn === null ? null : nameOf(transcript.spawnedIn), transcript));
      store.prompts.push(...promptRecords(session, transcript));
      store.tools.push(...toolRecords(session, main, transcript));
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
    const key = `${cell.motifId}/${cell.frameBucket}/${cell.day}/${String(exposed)}`;
    cells.set(key, { key, harnessBucket: bucketFields(cell.frameBucket).harnessBucket, motifId: cell.motifId, frameBucket: cell.frameBucket, day: cell.day, exposed, sessions: cell.sessions, ok: cell.ok, failed: cell.failed, tokens: cell.tokens, durationMs: cell.durationMs });
  }
  // A session counts once per value, so each value is one session of this batch.
  const strata = new Map<string, StratumRow>();
  const frames = skeleton.transcripts.flatMap(({ frame, prompts }) => [frame, ...prompts.map((prompt) => prompt.frame)]);
  const named: [string, string][] = [
    ...frames.flatMap(({ stack }) => stack.languages.map((value): [string, string] => ['language', value])),
    ...frames.flatMap(({ stack }) => stack.frameworks.map((value): [string, string] => ['framework', value])),
    ...frames.flatMap(({ stack }) => (stack.size === null ? [] : [['repoFiles', stack.size] satisfies [string, string]])),
  ];
  for (const [dimension, value] of named) strata.set(`${dimension}/${value}`, { key: `${dimension}/${value}`, dimension, value, sessions: 1 });
  return { cells, motifs: derived.motifs, strata };
};
