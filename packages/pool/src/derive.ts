// Cells and reads over deposits (recall spec Sections 2.5 and 2.6), with the same code a local store runs. Each account's skeletons become that account's store and its cells, and
// the cells merge by key, so `clusters` counts accounts and nothing here can count one account twice. Recovery is left out: its signature is class A text, which a skeleton does not hold.
import { deriveCells, poolOf, type Cell, type CellSet, type Pool } from '../../cli/src/sessions/cells.js';
import type { Motif } from '../../cli/src/sessions/motif.js';
import { type Slice, type SessionSkeleton, type SkeletonTranscript, SLICE_FORMAT } from '../../cli/src/sessions/pool-wire.js';
import { makeRead, orderResolver, type Read } from '../../cli/src/sessions/read.js';
import { deriveAdoption } from '../../cli/src/sessions/read-adoption.js';
import { deriveChange } from '../../cli/src/sessions/read-change.js';
import { deriveCost } from '../../cli/src/sessions/read-cost.js';
import { deriveFit } from '../../cli/src/sessions/read-fit.js';
import { deriveLive } from '../../cli/src/sessions/read-live.js';
import { deriveMethod } from '../../cli/src/sessions/read-method.js';
import { deriveNextStep } from '../../cli/src/sessions/read-next-step.js';
import type { DeriveFamily } from '../../cli/src/sessions/read-support.js';
import type { PromptObservation, SessionObservation, ToolObservation } from '../../cli/src/sessions/schema.js';
import type { Store } from '../../cli/src/sessions/store.js';

/** A served read or cell needs this many accounts (spec Section 8; D4's k rule). */
export const SERVED_FLOOR = 3;

const DERIVERS: readonly DeriveFamily[] = [deriveFit, deriveCost, deriveChange, deriveLive, deriveAdoption, deriveMethod, deriveNextStep];

const NO_USAGE = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 };

/** A skeleton's transcript as the record `deriveCells` reads. Everything a skeleton leaves out stays empty, so no derivation here can come to depend on it unnoticed. */
const sessionRecord = (id: string, parent: string | null, { harness, frame }: SkeletonTranscript): SessionObservation => ({
  kind: 'session',
  cv: '',
  sid: '',
  session: id,
  project: '',
  parent,
  agentType: null,
  spawnedBy: null,
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
    wallSec,
    head: '',
    cls,
    tools: [],
    shape: '',
    errors,
    thinking: 0,
    sideTools: 0,
    turns: 0,
    model: frame.model ?? '',
    efforts: frame.effort === null ? [] : [frame.effort],
    skills: [],
    usage,
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
    steps: steps.map((step) => ({ ...step, n, frameId: '' })),
  }));

/** One account's deposits as a store. A session's id is its skeleton's, which the client hashes per account, so it joins nothing across accounts. */
export const storeOf = (skeletons: readonly SessionSkeleton[]): Store => {
  const store: Store = { sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0 };
  for (const { id, transcripts } of skeletons) {
    const main = `${id}#0`;
    transcripts.forEach((transcript, index) => {
      const session = `${id}#${String(index)}`;
      (index === 0 ? store.sessions : store.subagents).push(sessionRecord(session, index === 0 ? null : main, transcript));
      store.prompts.push(...promptRecords(session, transcript));
      store.tools.push(...toolRecords(session, main, transcript));
    });
  }
  return store;
};

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every account's cells as one set: counts add, and `clusters` is how many accounts hold the key. */
export const mergeCells = (sets: readonly CellSet[]): CellSet => {
  const cells = new Map<string, Cell>();
  const motifs = new Map<string, Motif>();
  for (const set of sets) {
    for (const motif of set.motifs) motifs.set(motif.motifId, motif);
    for (const cell of set.cells) {
      const key = `${cell.motifId}/${cell.frameBucket}/${cell.day}`;
      const held = cells.get(key);
      cells.set(
        key,
        held === undefined
          ? { ...cell, clusters: 1 }
          : { ...held, sessions: held.sessions + cell.sessions, clusters: held.clusters + 1, ok: held.ok + cell.ok, failed: held.failed + cell.failed, tokens: held.tokens + cell.tokens, durationMs: held.durationMs + cell.durationMs },
      );
    }
  }
  return {
    cells: [...cells.values()].sort((a, b) => compare(a.motifId, b.motifId) || compare(a.frameBucket, b.frameBucket) || compare(a.day, b.day)),
    motifs: [...motifs.values()].sort((a, b) => compare(a.motifId, b.motifId)),
  };
};

const NO_STORE: Store = { sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0 };

const readsOf = (pool: Pool): Read[] => {
  const orderOf = orderResolver([]);
  const asOf = { pool: pool.version, day: pool.lastDay };
  return DERIVERS.flatMap((derive) => derive({ pool, store: NO_STORE }).map((read) => makeRead({ ...read, asOf }, orderOf)));
};

/** What one stack's slice holds. Every family reads the whole pool, so a share keeps its true denominator; only what clears the floor leaves. */
export const sliceOf = (stack: string, byAccount: readonly (readonly SessionSkeleton[])[]): Slice => {
  const set = mergeCells(byAccount.map((skeletons) => deriveCells(storeOf(skeletons))));
  // No error rows: a skeleton holds none, and recovery, the one family that reads them, is left out here.
  const pool = poolOf(set, []);
  const cells = set.cells.filter((cell) => cell.clusters >= SERVED_FLOOR);
  const held = new Set(cells.map((cell) => cell.motifId));
  return {
    format: SLICE_FORMAT,
    stack,
    capped: null,
    asOf: { pool: pool.version, day: pool.lastDay },
    cells,
    motifs: set.motifs.filter((motif) => held.has(motif.motifId)),
    reads: readsOf(pool).filter((read) => read.clusters >= SERVED_FLOOR),
  };
};
