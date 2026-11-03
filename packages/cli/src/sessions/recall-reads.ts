// The reads a recall answers from, counted over the store: a signature is a read in family `recovery` (spec Section 7), a tool call's input shape a read in family `fit`, the
// pre-call half of recovery, and a public name a read in family `entity`. `recall-pool.ts` puts each under the ID of the stored read it rests on; a hash here is what stands in
// where the pool holds none, and the only ID an `entity` read has, because no family stores a read per public name.
import { createHash } from 'node:crypto';
import { ACTION_TABLES, actionOf, mcpOf } from './actions.js';
import { utcDay } from './frame.js';
import { recall, type RecallQuery, type RecallResult } from './query.js';
import { contentHash, type Family } from './read.js';
import { namedByPrefix, resolveReads, type CurrentPool } from './recall-pool.js';
import { makeRecall, type Recall, type RecallForm, type RecallQueryObject, type RecallSlice } from './recall-object.js';
import { evidenceOf, renderAnswer } from './recall-render.js';
import { harnessOf, type ErrorObservation, type Frame, type Harness, type ToolObservation } from './schema.js';
import type { Store } from './store.js';

export type ReadFamily = Family | 'entity';

export interface RecallRead {
  readId: string;
  family: ReadFamily;
  /** The native tool name, as recorded. A renderer holds it to the public vocabulary, because a name can carry text. */
  tool: string;
  /** The call's input key names; empty for a read not about a call shape. */
  keys: string[];
  /** Sessions. */
  n: number;
  /** Errors, for recovery and fit; calls, for entity. */
  count: number;
  /** All calls of the shape, the denominator of `count`; null when the read has none. */
  calls: number | null;
  /** One operator's store is one cluster (spec Section 6). */
  clusters: number;
  firstDay: string | null;
  lastDay: string | null;
  harnesses: string[];
  harnessVersions: string[];
  models: string[];
  /** Native tool names that came next, most common first. */
  followed: Array<[string, number]>;
}

const FOLLOWED = 3;
const DAY_MS = 86_400_000;

const digest = (parts: readonly unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

/** A signature's stand-in: the hash a stored recovery read holds as `slice.sig`. */
export const readIdOf = (sig: string): string => contentHash(sig);

/** The ID of a call's shape: its tool and input key names, nothing the caller typed as a value. */
export const toolShapeId = (tool: string, keys: readonly string[]): string => digest(['fit', tool, [...keys].sort()]);

const top = (following: ReadonlyMap<string, number>): Array<[string, number]> => [...following].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, FOLLOWED);

const modelsByPrompt = (store: Store): Map<string, string> => new Map(store.prompts.map((prompt) => [`${prompt.session}#${String(prompt.index)}`, prompt.model]));

const bump = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

const dayRange = (days: Iterable<string | null>): { firstDay: string | null; lastDay: string | null } => {
  const known = [...days].filter((day): day is string => day !== null).sort();
  return { firstDay: known[0] ?? null, lastDay: known[known.length - 1] ?? null };
};

const harnessesOf = (store: Store): Map<string, Harness> => new Map([...store.sessions, ...store.subagents].map((session) => [session.session, harnessOf(session)]));

/** Which harnesses a set of sessions ran under; a session with no record reads as the default, the way `harnessOf` reads one with no field. */
const harnessNames = (sessions: Iterable<string>, harnesses: ReadonlyMap<string, Harness>): string[] => [...new Set([...sessions].map((session) => harnesses.get(session) ?? harnessOf({})))].sort();

export const recoveryReads = (store: Store, keep: (error: ErrorObservation) => boolean = () => true): RecallRead[] => {
  const models = modelsByPrompt(store);
  const harnesses = harnessesOf(store);
  const bySig = new Map<string, ErrorObservation[]>();
  for (const error of store.errors) {
    if (keep(error)) bySig.set(error.sig, [...(bySig.get(error.sig) ?? []), error]);
  }
  const reads = [...bySig].map(([sig, list]): RecallRead => {
    const following = new Map<string, number>();
    for (const tool of list.flatMap((error) => error.next)) bump(following, tool);
    const sessions = new Set(list.map((error) => error.session));
    return {
      readId: readIdOf(sig),
      family: 'recovery',
      tool: list[0]?.tool ?? '',
      keys: [],
      n: sessions.size,
      count: list.length,
      calls: null,
      clusters: 1,
      ...dayRange(list.map((error) => utcDay(error.ts))),
      harnesses: harnessNames(sessions, harnesses),
      harnessVersions: [...new Set(list.flatMap((error) => (error.harnessVersion === null ? [] : [error.harnessVersion])))].sort(),
      models: [...new Set(list.flatMap((error) => models.get(`${error.session}#${String(error.prompt)}`) ?? []))].sort(),
      followed: top(following),
    };
  });
  return reads.sort((a, b) => b.n - a.n || b.count - a.count || a.readId.localeCompare(b.readId));
};

/**
 * One row per call on the main line: a sidechain's repeats are not a new call, and a resumed transcript's replay is a second row for one tool-use id, so the
 * row with a status wins. `loadStore` folds these already (`foldToolRows`), so over a loaded store only the sidechain filter does anything; the rest guards a store built by hand.
 */
const oneRowPerCall = (tools: readonly ToolObservation[]): ToolObservation[] => {
  const kept = new Map<string, ToolObservation>();
  const anonymous: ToolObservation[] = [];
  for (const tool of tools) {
    if (tool.side) continue;
    if (tool.toolUseId === null) {
      anonymous.push(tool);
      continue;
    }
    const key = `${tool.session} ${tool.toolUseId}`;
    const held = kept.get(key);
    if (held === undefined || (held.status === 'none' && tool.status !== 'none')) kept.set(key, tool);
  }
  return [...kept.values(), ...anonymous];
};

/** The main-line calls of each session, one row per call, in call order. */
export const callsBySession = (store: Store): Map<string, ToolObservation[]> => {
  const bySession = new Map<string, ToolObservation[]>();
  for (const tool of oneRowPerCall(store.tools)) {
    const list = bySession.get(tool.session);
    if (list === undefined) bySession.set(tool.session, [tool]);
    else list.push(tool);
  }
  for (const list of bySession.values()) list.sort((a, b) => a.n - b.n);
  return bySession;
};

export interface FitFloors {
  minFailedSessions: number;
  minFailedShare: number;
  minCalls: number;
}

/**
 * The floors a call shape needs before it is pushed. On the operator's store (6,264 sessions, 361,914 calls) they keep 14 shapes, among them the wrong-input
 * calls that always fail (`Monitor` with `query`, `Read` with `path`), and leave Bash, whose failures do not depend on its shape. Open parameters.
 */
export const FIT_FLOORS: FitFloors = { minFailedSessions: 3, minFailedShare: 0.1, minCalls: 20 };

interface ShapeTally {
  tool: string;
  keys: string[];
  calls: number;
  failed: number;
  sessions: Set<string>;
  following: Map<string, number>;
  days: Array<string | null>;
  versions: Set<string>;
  models: Set<string>;
}

export const fitReads = (store: Store, floors: FitFloors = FIT_FLOORS): RecallRead[] => {
  const models = modelsByPrompt(store);
  const harnesses = harnessesOf(store);
  const shapes = new Map<string, ShapeTally>();
  for (const calls of callsBySession(store).values()) {
    for (const [position, call] of calls.entries()) {
      const id = toolShapeId(call.tool, call.keys);
      const shape: ShapeTally = shapes.get(id) ?? { tool: call.tool, keys: [...call.keys].sort(), calls: 0, failed: 0, sessions: new Set(), following: new Map(), days: [], versions: new Set(), models: new Set() };
      shapes.set(id, shape);
      shape.calls += 1;
      if (call.status !== 'error') continue;
      shape.failed += 1;
      shape.sessions.add(call.session);
      shape.days.push(utcDay(call.ts));
      if (call.harnessVersion !== null) shape.versions.add(call.harnessVersion);
      const model = models.get(`${call.session}#${String(call.prompt)}`);
      if (model !== undefined) shape.models.add(model);
      const next = calls[position + 1];
      if (next !== undefined) bump(shape.following, next.tool);
    }
  }
  const reads: RecallRead[] = [];
  for (const [readId, shape] of shapes) {
    if (shape.sessions.size < floors.minFailedSessions || shape.calls < floors.minCalls || shape.failed / shape.calls < floors.minFailedShare) continue;
    reads.push({
      readId,
      family: 'fit',
      tool: shape.tool,
      keys: shape.keys,
      n: shape.sessions.size,
      count: shape.failed,
      calls: shape.calls,
      clusters: 1,
      ...dayRange(shape.days),
      harnesses: harnessNames(shape.sessions, harnesses),
      harnessVersions: [...shape.versions].sort(),
      models: [...shape.models].sort(),
      followed: top(shape.following),
    });
  }
  return reads.sort((a, b) => b.count - a.count || a.readId.localeCompare(b.readId));
};

/** The snapshot a store answers from: its latest deposit. A deposit time compares with a recall's `at`, which is what "older than the recall" needs. */
export const poolVersionOf = (store: Store): string => store.sessions.reduce((latest, session) => (session.at > latest ? session.at : latest), '');

const namedInTable = (name: string, tool: string): boolean => {
  if (tool === name) return true;
  for (const table of Object.values(ACTION_TABLES)) {
    if (actionOf(table, tool).action === name || mcpOf(table, tool)?.server === name) return true;
  }
  return false;
};

const entityReads = (store: Store, name: string): RecallRead[] => {
  const models = modelsByPrompt(store);
  const harnesses = harnessesOf(store);
  const sessions = new Set<string>();
  let count = 0;
  const seenModels = new Set<string>();
  for (const session of store.sessions) {
    let here = 0;
    for (const [tool, calls] of Object.entries(session.tools)) if (namedInTable(name, tool)) here += calls;
    const asModel = session.models[name];
    if (asModel !== undefined) {
      here += asModel;
      seenModels.add(name);
    }
    if (here > 0) sessions.add(session.session);
    count += here;
  }
  const errors = recoveryReads(store, (error) => namedInTable(name, error.tool) || models.get(`${error.session}#${String(error.prompt)}`) === name);
  if (sessions.size === 0) return errors;
  const day = dayRange(store.sessions.filter((session) => sessions.has(session.session)).flatMap((session) => [utcDay(session.tsFirst), utcDay(session.tsLast)]));
  const usage: RecallRead = {
    readId: digest(['entity', name, sessions.size, count]),
    family: 'entity',
    tool: name,
    keys: [],
    n: sessions.size,
    count,
    calls: null,
    clusters: 1,
    ...day,
    harnesses: harnessNames(sessions, harnesses),
    harnessVersions: [],
    models: [...seenModels],
    followed: [],
  };
  return [usage, ...errors];
};

const sliceKeeps = (store: Store, slice: RecallSlice, now: number): ((error: ErrorObservation) => boolean) => {
  const models = modelsByPrompt(store);
  const cutoff = slice.sinceDays === undefined ? undefined : new Date(now - slice.sinceDays * DAY_MS).toISOString();
  return (error) =>
    (slice.harnessVersion === undefined || error.harnessVersion === slice.harnessVersion) &&
    (slice.model === undefined || models.get(`${error.session}#${String(error.prompt)}`) === slice.model) &&
    (slice.tool === undefined || error.tool === slice.tool) &&
    (slice.cls === undefined || error.cls === slice.cls) &&
    (cutoff === undefined || (error.ts !== null && error.ts >= cutoff));
};

const questionReads = (store: Store, family: string | undefined, slice: RecallSlice, now: number): RecallRead[] => {
  if (family === 'recovery') return recoveryReads(store, sliceKeeps(store, slice, now));
  if (family !== 'fit') return [];
  return fitReads(store).filter((read) => (slice.tool === undefined || read.tool === slice.tool) && (slice.harnessVersion === undefined || read.harnessVersions.includes(slice.harnessVersion)) && (slice.model === undefined || read.models.includes(slice.model)));
};

const patternReads = (store: Store, prefix: readonly string[], current: CurrentPool | undefined): RecallRead[] => {
  const named = current === undefined ? { standIns: [], reads: [] } : namedByPrefix(prefix, current);
  const ids = new Set([...prefix, ...named.standIns]);
  return [...[...recoveryReads(store), ...fitReads(store)].filter((read) => ids.has(read.readId)), ...named.reads];
};

const textReads = (store: Store, text: string): RecallRead[] => {
  const needle = text.trim().toLowerCase();
  if (needle === '') return [];
  return recoveryReads(store, (error) => error.sig.toLowerCase().includes(needle) || error.example.toLowerCase().includes(needle));
};

export interface ClosedQuery {
  form: RecallForm;
  prefix?: readonly string[];
  entity?: string;
  family?: string;
  slice?: RecallSlice;
  text?: string;
}

export type PullInput = ClosedQuery | RecallQuery;

const isClosed = (input: PullInput): input is ClosedQuery => 'form' in input;

/** The closed form a command line asks for; undefined when it names none, and only `recall()`'s inputs are left. */
export const closedQueryOf = (options: { pattern: readonly string[]; entity?: string | undefined; family?: string | undefined; text?: string | undefined; cls?: string | undefined; sinceDays?: number | undefined }): ClosedQuery | undefined => {
  if (options.pattern.length > 0) return { form: 'pattern', prefix: options.pattern };
  if (options.entity !== undefined) return { form: 'entity', entity: options.entity };
  if (options.text !== undefined) return { form: 'text', text: options.text };
  if (options.family === undefined) return undefined;
  return { form: 'question', family: options.family, slice: { ...(options.cls === undefined ? {} : { cls: options.cls }), ...(options.sinceDays === undefined ? {} : { sinceDays: options.sinceDays }) } };
};

const ANSWER_LIMIT = 5;

/** The reads a query's form asks for, best first, over the local store: an empty list is a miss, which a recall keeps. */
export const answerQuery = (store: Store, input: ClosedQuery, now: number, current?: CurrentPool): RecallRead[] => {
  const reads = (): RecallRead[] => {
    switch (input.form) {
      case 'pattern':
        return patternReads(store, input.prefix ?? [], current);
      case 'entity':
        return input.entity === undefined ? [] : entityReads(store, input.entity);
      case 'question':
        return questionReads(store, input.family, input.slice ?? {}, now);
      case 'text':
        return input.text === undefined ? [] : textReads(store, input.text);
    }
  };
  const answers = reads().slice(0, ANSWER_LIMIT);
  return current === undefined ? answers : resolveReads(answers, current.reads);
};

/** The closed form a `recall()` input is recorded under. An error or a path is text the asker typed, so it stays in class A; a class is a closed name. */
const closedOf = (query: RecallQuery): RecallQueryObject => {
  const text = query.error ?? query.path;
  if (text !== undefined) return { form: 'text', text };
  return { form: 'question', family: 'recovery', slice: { ...(query.cls === undefined ? {} : { cls: query.cls }), ...(query.sinceDays === undefined ? {} : { sinceDays: query.sinceDays }) } };
};

const objectOf = ({ form, prefix, entity, family, slice, text }: ClosedQuery): RecallQueryObject => ({
  form,
  ...(prefix === undefined ? {} : { prefix: [...prefix] }),
  ...(entity === undefined ? {} : { entity }),
  ...(family === undefined ? {} : { family }),
  ...(slice === undefined ? {} : { slice }),
  ...(text === undefined ? {} : { text }),
});

export interface PullContext {
  /** The session asking; null when the pull came from outside one, which is every pull until the MCP path can name it. */
  sid: string | null;
  now: number;
  frame: Frame | null;
  harness: Harness;
  redactDomains?: readonly string[];
  /** The pool an answer's stored read comes from; without one, an answer keeps its stand-in hash. */
  current?: CurrentPool | undefined;
}

export interface PullResult {
  recall: Recall;
  reads: RecallRead[];
  /** What `recall()` found, when the pull came through its `error`, `path`, or `cls` inputs. */
  legacy?: RecallResult;
}

/** A pull always answers (spec 2.7): the holdback runs on pushes alone. */
export const pull = (store: Store, input: PullInput, context: PullContext): PullResult => {
  const at = new Date(context.now).toISOString();
  const legacy = isClosed(input) ? undefined : recall(store, input, context.now, undefined, context.redactDomains);
  const sigs = new Set(legacy?.matches.map((match) => match.sig));
  const { current } = context;
  const legacyReads = (): RecallRead[] => {
    const found = recoveryReads(store, (error) => sigs.has(error.sig)).slice(0, ANSWER_LIMIT);
    return current === undefined ? found : resolveReads(found, current.reads);
  };
  const reads = isClosed(input) ? answerQuery(store, input, context.now, current) : legacyReads();
  const { rendered, names } = renderAnswer(reads, context.frame, context.harness);
  const made = makeRecall({
    sid: context.sid,
    at,
    frame: context.frame,
    mode: 'pull',
    query: isClosed(input) ? objectOf(input) : closedOf(input),
    poolVersion: poolVersionOf(store),
    arm: 'shown',
    reads: reads.map((read) => read.readId),
    rendered,
    names,
    evidence: reads.map((read) => evidenceOf(read, context.frame)),
  });
  return { recall: made, reads, ...(legacy === undefined ? {} : { legacy }) };
};
