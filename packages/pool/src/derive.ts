// Cells and reads (recall spec Sections 2.5 and 2.6), with the same code a local store runs. A deposit's skeleton becomes a store here for ingest, which adds its cells to the stored
// ones; a bundle is derived from the stored cells, whose `clusters` is the held count of accounts. Recovery is left out: its signature is class A text, which a skeleton does not hold.
import { cellIdOf, poolOf, type Pool } from '../../cli/src/sessions/cells.js';
import { motifName } from '../../cli/src/sessions/motif.js';
import { BUNDLE_FORMAT, type Bundle, type SessionSkeleton, type SkeletonTranscript, VOCAB_VERSION } from '../../cli/src/sessions/pool-wire.js';
import { makeRead, orderResolver, type Read } from '../../cli/src/sessions/read.js';
import { deriveAdoption } from '../../cli/src/sessions/read-adoption.js';
import { deriveChange } from '../../cli/src/sessions/read-change.js';
import { deriveCost } from '../../cli/src/sessions/read-cost.js';
import { deriveFit } from '../../cli/src/sessions/read-fit.js';
import { baselineDaysOf, deriveLive } from '../../cli/src/sessions/read-live.js';
import { deriveMethod } from '../../cli/src/sessions/read-method.js';
import { deriveNextStep } from '../../cli/src/sessions/read-next-step.js';
import { unitCells, type DeriveFamily, type ReadBody } from '../../cli/src/sessions/read-support.js';
import type { PromptObservation, SessionObservation, ToolObservation } from '../../cli/src/sessions/schema.js';
import type { Store } from '../../cli/src/sessions/store.js';
import type { StoredPool } from './stored.js';

/** A served cell needs this many accounts, and a served read this many in at least one of its cells (spec Section 8; D4 may move this proposal, so it stays one constant). */
export const K_CELL = 5;

const DERIVERS: readonly DeriveFamily[] = [deriveFit, deriveCost, deriveChange, deriveLive, deriveAdoption, deriveMethod, deriveNextStep];

const NO_USAGE = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 };

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

const NO_STORE: Store = { sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0 };

/**
 * Each family states the highest of a read's cells, the most one store can prove. A read's `clusters` here is the largest held count among its input cells: the fetch path
 * reads no per-account record, so five accounts on five days are five cells of one cluster each and serve nothing until a later change brings held counts for a key's `n` and `c`.
 */
const readsOf = (pool: Pool): Read[] => {
  const orderOf = orderResolver([]);
  const asOf = { pool: pool.version, day: pool.lastDay };
  const held = new Map(pool.cells.map((cell) => [cellIdOf(cell), cell.clusters]));
  const clustersOf = (inputs: readonly string[]): number => inputs.reduce((most, input) => Math.max(most, held.get(input) ?? 0), 0);
  // Once for every live read of a bundle: the shape-level units are the same for each.
  const shapeUnits = unitCells(pool).filter(({ motif }) => motif.level === 'shape');
  // A live read's baseline is a second set of cells its inputs do not cite, so it takes the same floor on its own: under it, the baseline and the ratio against it are null.
  const baselined = (read: ReadBody): ReadBody => {
    if (read.family !== 'live') return read;
    const { motif, day } = read.slice;
    const days = new Set(baselineDaysOf(String(day)));
    const inBaseline = shapeUnits.filter(({ cell, motif: unit }) => motifName(unit) === motif && days.has(cell.day));
    return clustersOf(inBaseline.map(({ cell }) => cellIdOf(cell))) >= K_CELL ? read : { ...read, value: { ...read.value, baseline: null, ratio: null } };
  };
  return DERIVERS.flatMap((derive) => derive({ pool, store: NO_STORE }).map(baselined).map((read) => makeRead({ ...read, asOf, clusters: clustersOf(read.inputs) }, orderOf)));
};

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** What one harness version's bundle holds: the stored cells of its bucket, the only version a landed cell keys on. A share's denominator is the bundle's; only what clears the floor leaves. */
export const bundleOf = (harnessVersion: string, stored: StoredPool): Bundle => {
  const cells = [...stored.cells].sort((a, b) => compare(a.motifId, b.motifId) || compare(a.frameBucket, b.frameBucket) || compare(a.day, b.day));
  const motifs = [...stored.motifs].sort((a, b) => compare(a.motifId, b.motifId));
  // No error rows: a skeleton holds none, and recovery, the one family that reads them, is left out here.
  const pool = poolOf({ cells, motifs }, []);
  const served = cells.filter((cell) => cell.clusters >= K_CELL);
  const named = new Set(served.map((cell) => cell.motifId));
  return {
    format: BUNDLE_FORMAT,
    harnessVersion,
    vocabVersion: VOCAB_VERSION,
    asOf: { pool: pool.version, day: pool.lastDay },
    cells: served,
    motifs: motifs.filter((motif) => named.has(motif.motifId)),
    reads: readsOf(pool).filter((read) => read.clusters >= K_CELL),
    strata: [...stored.strata].sort((a, b) => compare(a.dimension, b.dimension) || compare(a.value, b.value)),
  };
};
