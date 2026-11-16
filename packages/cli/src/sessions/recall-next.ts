// The next-node read (t926): what the agent is shown at the moments before it decides. Two reads, both from cells and never from text: the recovery edge (what followed this
// failure, for this action and error class) and the split positions (the places in a repo's earlier work where the next step is not settled). A read is built from the kept
// bundle for the session's setup first and the local pool's reads second, and every shown or held one is a `Recall` row, so the holdback arms are real.
import { CANONICAL_ACTIONS } from './actions.js';
import { harnessBucket } from './cells.js';
import { sameTargetOf, type SameTargetRead } from './same-target-lookup.js';
import type { Read } from './read.js';
import { appendRecall, armOf, makeRecall, parseRecalls, recallsPath, type Recall } from './recall-object.js';
import { frameOfTail, tailOf } from './recall-push.js';
import { sessionBundle } from './pool-replica.js';
import { readIdOf, type RecallRead } from './recall-reads.js';
import { closedName, count, evidenceOf } from './recall-render.js';
import type { Frame, Harness } from './schema.js';
import { LITERAL } from './public-vocabulary.js';

/**
 * The count a recovery edge needs before it is served from the local pool. The pool's own served floor is `K_CELL` (5 accounts, `packages/pool/src/derive.ts`); a bundle's read has
 * cleared it already, so only a local edge is held to this, counted in followed steps because one operator's store is one account.
 */
export const RECOVERY_FLOOR = 5;
/** The steps a position needs behind it before it can be called split: t782's qualifying cell is a cell topped up to 20 sessions. */
export const POSITION_MIN_N = 20;
/** The band of t782 plan 1.7: the leading option's share, 20 to 80 percent inclusive. A settled position (above) and a diffuse one (below) are not listed. */
export const POSITION_BAND = { low: 0.2, high: 0.8 } as const;
/**
 * The bytes a table may add to a turn's context. Eight lines of about 70 bytes: a session start or a prompt carries it every time it is sent, and a table the agent has to
 * read past is one it stops reading. Bundle positions come first, then local ones, each by observations; the cap cuts from the end, so a local position goes before a bundle one.
 */
export const TABLE_CAP_BYTES = 600;
const TOP_NEXT = 3;
const MAX_FOLLOWED = 3;

export interface RecoveryEdge {
  next: string;
  followed: number;
  /** The failures of this action and code over every week, the one denominator of every edge's share. */
  of: number;
  clusters: number;
  /** The heaviest week's read, the one the row cites. */
  readId: string;
  day: string | null;
}

export interface RecoveryEdges {
  [actionAndCode: string]: RecoveryEdge[];
}

export interface Position {
  prefix: string;
  n: number;
  /** The three most common next steps with their counts. */
  next: Array<[string, number]>;
  clusters: number;
  readId: string;
  day: string | null;
}

/** The reads one source (the kept bundle, or the local pool) gives the two hooks. */
export interface NextReads {
  poolVersion: string;
  recovery: RecoveryEdges;
  positions: Position[];
  /** The bundle's reads, for the same-target lookup; absent where a caller built the reads by hand. */
  reads?: readonly Read[];
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isAction = (name: string): boolean => CANONICAL_ACTIONS.some((action) => action === name);

const byWeight = (a: { followed: number; next: string }, b: { followed: number; next: string }): number => b.followed - a.followed || a.next.localeCompare(b.next);

/**
 * The recovery edges of a set of reads, by `action/errorCode`, each next step summed over its weeks. A next step that is not a canonical action (or `none`) is left out, so the
 * names a hook shows are the closed ones whatever a store holds.
 */
export const recoveryEdgesOf = (reads: readonly Read[], keep: (followed: number) => boolean = () => true): RecoveryEdges => {
  interface Weighted {
    edge: RecoveryEdge;
    heaviest: number;
  }
  const grouped = new Map<string, Map<string, Weighted>>();
  // The failures of one action and error class, once: every week's reads of its next steps share a week's failures, so a next step seen in fewer weeks must not get a smaller denominator.
  // A week's failures are the sum of what followed them, so the total over every next step is that sum over all its weeks.
  const failures = new Map<string, number>();
  for (const read of reads) {
    if (read.family !== 'recovery') continue;
    const { action, errorCode, next } = read.slice;
    const { followed, of } = read.value;
    if (action === undefined || errorCode === undefined || next === undefined || !isCount(followed) || !isCount(of) || followed === 0) continue;
    const key = `${action}/${errorCode}`;
    failures.set(key, (failures.get(key) ?? 0) + followed);
    if (!(next === 'none' || isAction(next))) continue;
    const edges = grouped.get(key) ?? new Map<string, Weighted>();
    grouped.set(key, edges);
    const have = edges.get(next);
    if (have === undefined) {
      edges.set(next, { edge: { next, followed, of, clusters: read.clusters, readId: read.readId, day: read.asOf.day }, heaviest: followed });
      continue;
    }
    have.edge.followed += followed;
    have.edge.clusters = Math.max(have.edge.clusters, read.clusters);
    if (followed > have.heaviest) {
      have.heaviest = followed;
      have.edge.readId = read.readId;
    }
    if (read.asOf.day !== null && (have.edge.day === null || read.asOf.day > have.edge.day)) have.edge.day = read.asOf.day;
  }
  const edges: RecoveryEdges = {};
  for (const [key, byNext] of grouped) {
    const sorted = [...byNext.values()].map((weighted) => ({ ...weighted.edge, of: failures.get(key) ?? weighted.edge.of })).sort(byWeight);
    if (sorted[0] !== undefined && keep(sorted[0].followed)) edges[key] = sorted.slice(0, MAX_FOLLOWED);
  }
  return edges;
};

/** True when a position's prefix names only canonical actions (no identity, no class): the table prints names and numbers and nothing a store wrote. */
const closedPrefix = (prefix: string): boolean => prefix.split('>').every(isAction);

/** The positions of a set of reads where the next step is split by t782's rule: enough observations, and the leading step's share inside the band. */
export const positionsOf = (reads: readonly Read[]): Position[] => {
  const positions: Position[] = [];
  for (const read of reads) {
    if (read.family !== 'next-step') continue;
    const { prefix } = read.slice;
    const { next, topShare } = read.value;
    if (prefix === undefined || !closedPrefix(prefix) || !isCount(topShare) || topShare < POSITION_BAND.low || topShare > POSITION_BAND.high || read.n < POSITION_MIN_N) continue;
    if (typeof next !== 'object' || next === null) continue;
    const ranked = Object.entries(next)
      .filter(([action, times]) => isAction(action) && isCount(times))
      .sort(([a, one], [b, two]) => two - one || a.localeCompare(b))
      .slice(0, TOP_NEXT);
    if (ranked.length < 2) continue;
    positions.push({ prefix, n: read.n, next: ranked, clusters: read.clusters, readId: read.readId, day: read.asOf.day });
  }
  return positions.sort((a, b) => b.n - a.n || a.prefix.localeCompare(b.prefix));
};

export type RecoveryDecision =
  | { kind: 'serve'; source: 'bundle' | 'local'; edges: RecoveryEdge[]; poolVersion: string }
  /** The top next step is the failed action again: nothing to add to what the agent does anyway. */
  | { kind: 'retry' }
  /** A local edge under the floor. */
  | { kind: 'floor' }
  /** A cell covers this action and error class and its top next step is that nothing followed: the failure is covered, so no older line answers it either. */
  | { kind: 'ended' }
  /** No cell for this action and error class. */
  | { kind: 'none' };

/**
 * What a failure is answered with: the bundle's edges for this action and error class if it holds any (they cleared the pool's floor), else the local pool's. Silent when the top
 * next step is a same-step retry (direction 13c), when a local edge is under `RECOVERY_FLOOR`, or when the top is that nothing followed (`ended`).
 */
export const recoveryDecision = (bundle: NextReads | undefined, local: { recovery: RecoveryEdges; poolVersion: string } | undefined, action: string, code: string): RecoveryDecision => {
  const key = `${action}/${code}`;
  const fromBundle = bundle?.recovery[key];
  const source = fromBundle === undefined || bundle === undefined ? undefined : ({ edges: fromBundle, source: 'bundle', poolVersion: bundle.poolVersion } as const);
  const fromLocal = local?.recovery[key];
  const chosen = source ?? (fromLocal === undefined || local === undefined ? undefined : ({ edges: fromLocal, source: 'local', poolVersion: local.poolVersion } as const));
  const top = chosen?.edges[0];
  if (chosen === undefined || top === undefined) return { kind: 'none' };
  // A tie with another next step is not a retry-only cell, so it is served; the strict lead is what direction 13c silences.
  const second = chosen.edges[1];
  if (top.next === action && (second === undefined || top.followed > second.followed)) return { kind: 'retry' };
  if (top.next === 'none') return { kind: 'ended' };
  if (chosen.source === 'local' && top.followed < RECOVERY_FLOOR) return { kind: 'floor' };
  return { kind: 'serve', ...chosen };
};

const percent = (part: number, whole: number): string => `${String(Math.round((part / whole) * 100))}%`;

/** The recovery read as text: names (closed) and numbers. */
export const renderRecovery = (action: string, code: string, edges: readonly RecoveryEdge[]): { rendered: string; names: string[] } => {
  const shown = edges.filter((edge) => closedName(edge.next) !== LITERAL);
  const total = shown[0]?.of ?? 0;
  const lines = shown.map((edge) => `${edge.next} x${String(edge.followed)}${total > 0 ? ` (${percent(edge.followed, total)})` : ''}`);
  const rendered = [`oars recall, counts from earlier sessions: after a failed ${action} (${code})${total > 0 ? ` in ${count(total, 'failure')}` : ''}, the next step was`, `  ${lines.join(', ')}`, `  read ${shown[0]?.readId ?? ''} (recovery)`].join('\n');
  return { rendered, names: shown.map((edge) => edge.next) };
};

/**
 * The same-target read as one line: the step it carries and its counts, nothing more. A step equal to the failed action is the same action on another kind of target, never a retry (a repeat on the same
 * target class is a `retry` cell, which this read never serves). A step the vocabulary does not close names nothing, so it renders nothing.
 */
export const renderSameTarget = (failed: string, code: string, target: string, read: SameTargetRead): { rendered: string; names: string[] } => {
  if (closedName(read.step) === LITERAL) return { rendered: '', names: [] };
  const step = read.step === failed ? 'the same action on another kind of target' : read.step;
  const rendered = `oars recall, counts from earlier sessions: after a failed ${failed} (${code}) on a ${target} target, ${step} came back ok ${String(read.recovered)} of ${count(read.followed, 'time')} it followed\n  read ${read.readId} (recovery)`;
  return { rendered, names: [read.step] };
};

/** The positions table, with every position that fits under the cap and nothing when none does. */
export const renderPositions = (positions: readonly Position[]): { rendered: string; listed: Position[]; names: string[] } => {
  const header = 'oars recall, next steps that earlier sessions split on (counts, not advice):';
  const listed: Position[] = [];
  let used = Buffer.byteLength(header);
  const lines: string[] = [];
  for (const position of positions) {
    const line = `- after ${position.prefix}: ${position.next.map(([action, times]) => `${action} ${percent(times, position.n)}`).join(', ')} (n ${String(position.n)})`;
    const size = Buffer.byteLength(line) + 1;
    if (used + size > TABLE_CAP_BYTES) break;
    used += size;
    listed.push(position);
    lines.push(line);
  }
  return { rendered: listed.length === 0 ? '' : [header, ...lines].join('\n'), listed, names: [...new Set(listed.flatMap((position) => position.next.map(([action]) => action)))] };
};

/**
 * The key a hook index files the local pool's reads under for a session: its harness and the bucket of the version it runs (`recall-frames.ts`). A session whose version is not
 * stated is read across every version of its harness, which is the filter that can be applied honestly.
 */
export const frameKeyOf = (asker: Asker): string => `${asker.harness}/${asker.harnessVersion === null ? '*' : harnessBucket(asker.harnessVersion)}`;

/** The bundle's and the local pool's positions as one list, a prefix once: the bundle's positions by observations, then the local ones it lacks by observations. */
export const mergePositions = (bundle: readonly Position[], local: readonly Position[]): Position[] => {
  const byObservations = (a: Position, b: Position): number => b.n - a.n || a.prefix.localeCompare(b.prefix);
  const seen = new Set(bundle.map((position) => position.prefix));
  return [...[...bundle].sort(byObservations), ...local.filter((position) => !seen.has(position.prefix)).sort(byObservations)];
};

export interface Asker {
  harness: Harness;
  harnessVersion: string | null;
}

/** A read as the evidence record wants it: counts and closed names only. */
const evidenceRead = (read: { readId: string; family: RecallRead['family']; tool: string; n: number; count: number; calls: number | null; clusters: number; day: string | null; followed: Array<[string, number]> }, setup: Asker): RecallRead => ({
  readId: read.readId,
  family: read.family,
  tool: read.tool,
  keys: [],
  n: read.n,
  count: read.count,
  calls: read.calls,
  clusters: read.clusters,
  firstDay: null,
  lastDay: read.day,
  harnesses: [setup.harness],
  harnessVersions: setup.harnessVersion === null ? [] : [setup.harnessVersion],
  models: [],
  followed: read.followed,
});

export interface NextInput {
  storeDir: string;
  sid: string;
  /** The tail of the transcript the hook was given, which states the version and model; empty when it gave none. */
  tail: string;
  platform: string;
  at: string;
}

/** The asker's frame, from the tail of its transcript. */
export const frameFor = (input: Pick<NextInput, 'tail' | 'platform' | 'at'>): Frame => frameOfTail(input.tail, input.platform, input.at);

/** The reads of the kept bundle for the asker's harness and version; undefined with no version stated, no bundle, or a bundle that does not verify (never an error). */
export const bundleNext = async (storeDir: string, asker: Asker): Promise<NextReads | undefined> => {
  const bundle = asker.harnessVersion === null ? undefined : await sessionBundle(storeDir, { harness: asker.harness, harnessVersion: asker.harnessVersion });
  return bundle === undefined ? undefined : { poolVersion: bundle.asOf.pool, recovery: recoveryEdgesOf(bundle.reads), positions: positionsOf(bundle.reads), reads: bundle.reads };
};

/**
 * A served or held read: the row is written before anything is injected, and the arm is the session's for this query against this pool. The row is the recall's exposure record
 * (ids and counts, and the rendered text a held read would have shown); an arm that kept it back is returned so the hook injects nothing.
 */
export const recordRead = async (
  input: NextInput,
  frame: Frame,
  query: Recall['query'],
  armPrefix: readonly string[],
  poolVersion: string,
  rendered: string,
  names: readonly string[],
  reads: readonly RecallRead[],
): Promise<Recall> => {
  const recall = makeRecall({
    sid: input.sid,
    at: input.at,
    frame,
    mode: 'push',
    query,
    poolVersion,
    arm: armOf(input.sid, armPrefix, poolVersion),
    reads: reads.map((read) => read.readId),
    rendered,
    names,
    evidence: reads.map((read) => evidenceOf(read, frame)),
  });
  await appendRecall(input.storeDir, recall);
  return recall;
};

const NO_NAMES: string[] = [];

/** The same-target read's evidence, as one read of the row it is served in. */
const sameTargetEvidence = (failed: string, read: SameTargetRead, setup: Asker): RecallRead =>
  evidenceRead({ readId: read.readId, family: 'recovery', tool: failed, n: read.recovered, count: read.recovered, calls: read.of, clusters: read.clusters, day: read.day, followed: [[read.step, read.recovered]] }, setup);

/** What a failure's same-target read adds to a row: its text, its names, and its evidence. */
export interface SameTargetServed {
  failed: string;
  target: string;
  read: SameTargetRead;
}

/** The same-target read a bundle's reads hold for a failure, when it can be said in closed names; undefined otherwise, which every surface answers with its output unchanged. */
export const sameTargetServed = (reads: readonly Read[] | undefined, code: string, failed: string, target: string): SameTargetServed | undefined => {
  const read = reads === undefined ? undefined : sameTargetOf(reads, code, failed, target);
  return read === undefined || renderSameTarget(failed, code, target, read).rendered === '' ? undefined : { failed, target, read };
};

/**
 * The recovery read for one failure, as a recall row. A same-target read for the same failure is added beside the edge line, after it, in the same row; with none the row is the edge line alone.
 * `decision` is the edge's decision, or only the pool version when the same-target read stands alone.
 */
export const recoveryRecall = (input: NextInput, setup: Asker, action: string, code: string, decision: { edges: readonly RecoveryEdge[]; poolVersion: string }, same?: SameTargetServed): Promise<Recall> => {
  const frame = frameFor(input);
  const edge = decision.edges.length === 0 ? { rendered: '', names: NO_NAMES } : renderRecovery(action, code, decision.edges);
  const beside = same === undefined ? { rendered: '', names: NO_NAMES } : renderSameTarget(same.failed, code, same.target, same.read);
  const rendered = [edge.rendered, beside.rendered].filter((part) => part !== '').join('\n');
  const top = decision.edges[0];
  const reads: RecallRead[] = [];
  if (top !== undefined) reads.push(evidenceRead({ readId: top.readId, family: 'recovery', tool: action, n: top.followed, count: top.followed, calls: top.of, clusters: top.clusters, day: top.day, followed: decision.edges.map((each): [string, number] => [each.next, each.followed]) }, setup));
  if (same !== undefined && beside.rendered !== '') reads.push(sameTargetEvidence(same.failed, same.read, setup));
  return recordRead(input, frame, { form: 'question', family: 'recovery', prefix: [`${action}/${code}`] }, [`${action}/${code}`], decision.poolVersion, rendered, [...edge.names, ...beside.names], reads);
};

/** The old signature line's recall: the local signature index, held to the same retry rule and floor. */
export const signatureRecall = (input: NextInput, setup: Asker, tool: string, sig: string, found: { sessions: number; followed: Array<[string, number]> }, poolVersion: string): Promise<Recall> => {
  const frame = frameFor(input);
  const followed = found.followed.map(([next]) => next).join(', ');
  const rendered = `oars recall: seen in ${String(found.sessions)} sessions; what followed: ${followed === '' ? 'nothing recorded' : followed}`;
  const read = evidenceRead({ readId: readIdOf(sig), family: 'recovery', tool, n: found.sessions, count: found.sessions, calls: null, clusters: 1, day: null, followed: found.followed }, setup);
  return recordRead(input, frame, { form: 'question', family: 'recovery', prefix: [readIdOf(sig)] }, [readIdOf(sig)], poolVersion, rendered, found.followed.map(([next]) => next), [read]);
};

/**
 * The signature line is a same-step retry when the tool that failed is the one that most often followed, strictly: a tie with another tool is not a retry-only cell. It keeps its
 * own floor, the index's two sessions: it states how many sessions saw the error, so a thin count is printed as thin, which a cell's share is not.
 */
export const isSignatureRetry = (tool: string, found: { followed: Array<[string, number]> }): boolean => {
  const [first, second] = found.followed;
  return first?.[0] === tool && (second === undefined || first[1] > second[1]);
};

/** The positions table for a session, as a recall row; undefined when no position qualifies or the table is the one `previous` already sent. */
export const positionsRecall = (input: NextInput, setup: Asker, positions: readonly Position[], poolVersion: string, previous?: string): Promise<Recall | undefined> => {
  const { rendered, listed, names } = renderPositions(positions);
  if (listed.length === 0 || rendered === previous) return Promise.resolve(undefined);
  const frame = frameFor(input);
  const reads = listed.map((position) =>
    evidenceRead({ readId: position.readId, family: 'next-step', tool: position.next[0]?.[0] ?? '', n: position.n, count: position.next[0]?.[1] ?? 0, calls: position.n, clusters: position.clusters, day: position.day, followed: position.next }, setup),
  );
  return recordRead(input, frame, { form: 'question', family: 'next-step', prefix: ['positions'] }, ['positions'], poolVersion, rendered, names, reads);
};

/** The text the session was last sent a table with, from `recalls.jsonl`; undefined when it was never sent one. */
export const lastTable = async (storeDir: string, sid: string): Promise<string | undefined> => {
  const mine = parseRecalls(await tailOf(recallsPath(storeDir))).filter((recall) => recall.mode === 'push' && recall.sid === sid && recall.query.family === 'next-step');
  return mine.at(-1)?.answer.rendered;
};
