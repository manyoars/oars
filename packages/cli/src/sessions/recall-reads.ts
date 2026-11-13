// The reads a recall answers from, counted over the store: a signature is a read in family `recovery` (spec Section 7), a tool call's input shape a read in family `fit`, the
// pre-call half of recovery, and a public name a read in family `entity`. `recall-pool.ts` puts each under the ID of the stored read it rests on; a hash here is what stands in
// where the pool holds none, and the only ID an `entity` read has, because no family stores a read per public name.
import { createHash } from 'node:crypto';
import { ACTION_TABLES, actionOf, mcpOf, type CanonicalAction } from './actions.js';
import { utcDay } from './frame.js';
import { LITERAL, PUBLIC_PACKAGES, publicModel, publicVersion } from './public-vocabulary.js';
import { recall, recallRows, type RecallQuery, type RecallResult } from './query.js';
import { contentHash, FAMILIES, type Family } from './read.js';
import { namedByPrefix, readsOfFamily, resolveReads, type CurrentPool } from './recall-pool.js';
import { makeRecall, type Recall, type RecallForm, type RecallQueryObject, type RecallSlice } from './recall-object.js';
import { closedName, evidenceOf, renderAnswer, type RecallAsker } from './recall-render.js';
import { makeRedactor } from './redact.js';
import { harnessOf, PROMPT_CLASSES, type ErrorObservation, type Frame, type Harness, type SessionObservation, type ToolObservation } from './schema.js';
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

/**
 * The floors the pre-tool push holds a shape to (t926). The pre-tool hook fires after the call is decided, so a push is a warning or nothing: a shape that fails less than half
 * its calls is a base rate (the two broad shell shapes, `Bash` and `PowerShell` with a command, fail about a third of theirs whatever the command) and warning on it tells the
 * agent nothing it can act on. A shape that fails at least half its calls is a defect of the call itself (`Monitor` with `query`, `Read` with `path`). Pulls and the pool keep
 * `FIT_FLOORS`: a base rate is still a fact to read on request.
 */
export const PUSH_FLOORS: FitFloors = { ...FIT_FLOORS, minFailedShare: 0.5 };

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

export interface FitFold {
  add: (store: Store) => void;
  finish: () => RecallRead[];
}

/**
 * `fitReads` as a fold: each `add` tallies one run of sessions into the same shapes, and `finish` applies the floors. Runs come in the whole store's row order, so the tie order of `followed` matches.
 * `keep` narrows which calls are tallied, not what can come next: the call after a kept one is what followed it, wherever the slice ends.
 */
export const fitFold = (floors: FitFloors = FIT_FLOORS, keep: (call: ToolObservation) => boolean = () => true): FitFold => {
  const harnesses = new Map<string, Harness>();
  const shapes = new Map<string, ShapeTally>();
  const add = (store: Store): void => {
    const models = modelsByPrompt(store);
    for (const [session, harness] of harnessesOf(store)) harnesses.set(session, harness);
    for (const calls of callsBySession(store).values()) {
      for (const [position, call] of calls.entries()) {
        if (!keep(call)) continue;
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
  };
  const finish = (): RecallRead[] => {
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
    return reads.sort((x, y) => y.count - x.count || x.readId.localeCompare(y.readId));
  };
  return { add, finish };
};

export const fitReads = (store: Store, floors: FitFloors = FIT_FLOORS, keep: (call: ToolObservation) => boolean = () => true): RecallRead[] => {
  const fold = fitFold(floors, keep);
  fold.add(store);
  return fold.finish();
};

/** The action of a tool under the first of its harnesses whose table lists it, else under the first harness (the default one when a read names none). */
export const actionOfShape = (tool: string, harnesses: readonly string[]): CanonicalAction => {
  const tables = Object.entries(ACTION_TABLES).flatMap(([name, table]) => (harnesses.includes(name) ? [table] : []));
  return actionOf(tables.find((table) => Object.hasOwn(table.rows, tool)) ?? tables[0] ?? ACTION_TABLES[harnessOf({})], tool).action;
};

/**
 * What a push must beat: a shape is pushed only when its failure share is at least this many times the share of all calls of its action. The floors above keep
 * a shape that fails often; this keeps one that fails more often than its action does, and guards a store whose base rate is high. On the replay of 2026-11-02 it kept
 * 79 of 79 pushes, at 4.5x and 8.6x their action's share: a real signal, not a defect. Open parameter, like the floors.
 */
export const PUSH_MIN_LIFT = 2;

/**
 * The reads whose shape fails at `lift` times the share of its whole action or more, where the action's share counts every call of every shape of it, those under the floors too.
 * A tool no table lists is the action `other` (or `mcp.call`), so it is held to that action's share like any other and can enter the index and fire. Compared in integers, so a tie is exact.
 */
export const aboveBaseRate = (store: Store, reads: readonly RecallRead[], lift: number = PUSH_MIN_LIFT): RecallRead[] => {
  const harnesses = harnessesOf(store);
  const byAction = new Map<CanonicalAction, { calls: number; failed: number }>();
  for (const calls of callsBySession(store).values()) {
    for (const call of calls) {
      const action = actionOfShape(call.tool, [harnesses.get(call.session) ?? harnessOf({})]);
      const tally = byAction.get(action) ?? { calls: 0, failed: 0 };
      byAction.set(action, tally);
      tally.calls += 1;
      if (call.status === 'error') tally.failed += 1;
    }
  }
  return reads.filter((read) => {
    const base = byAction.get(actionOfShape(read.tool, read.harnesses));
    // A fit read always counts its calls (`calls` is null only for entity reads), and its own calls are in the tally, so `base` is there; the fallbacks keep the types honest.
    return base !== undefined && read.calls !== null && read.count * base.calls >= lift * base.failed * read.calls;
  });
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
  // Calls and a model's requests are two counts, so each is its own read: their sum is neither. Only the model's read lists a model, which is how the answer names its noun.
  const usage = (idParts: readonly string[], listed: string[], countOf: (session: SessionObservation) => number): RecallRead[] => {
    const counted = store.sessions.filter((session) => countOf(session) > 0);
    if (counted.length === 0) return [];
    const sessions = new Set(counted.map((session) => session.session));
    const count = counted.reduce((sum, session) => sum + countOf(session), 0);
    return [
      {
        readId: digest([...idParts, sessions.size, count]),
        family: 'entity',
        tool: name,
        keys: [],
        n: sessions.size,
        count,
        calls: null,
        clusters: 1,
        ...dayRange(counted.flatMap((session) => [utcDay(session.tsFirst), utcDay(session.tsLast)])),
        harnesses: harnessNames(sessions, harnesses),
        harnessVersions: [],
        models: listed,
        followed: [],
      },
    ];
  };
  const calls = usage(['entity', name], [], (session) => Object.entries(session.tools).reduce((sum, [tool, times]) => (namedInTable(name, tool) ? sum + times : sum), 0));
  const requests = usage(['entity', 'model', name], [name], (session) => session.models[name] ?? 0);
  // A pull's name is class A, so only a name the public vocabulary lists is looked for: a private package gets no answer that its asker could read as a count of it.
  const pulling = new Map<string, number>();
  if (PUBLIC_PACKAGES.has(name)) {
    for (const [session, list] of callsBySession(store)) pulling.set(session, list.filter((call) => call.pulls?.some((one) => one.name === name)).length);
  }
  const pulled = usage(['entity', 'package', name], [], (session) => pulling.get(session.session) ?? 0);
  const errors = recoveryReads(store, (error) => namedInTable(name, error.tool) || models.get(`${error.session}#${String(error.prompt)}`) === name);
  return [...calls, ...requests, ...pulled, ...errors];
};

const promptKey = (row: { session: string; prompt: number | null }): string => `${row.session}#${String(row.prompt)}`;

/** The calls and errors a slice holds. A class comes through `clsOf`, because an error row states its own and a call only through its prompt. */
const sliceKeeps = <Row extends { session: string; prompt: number | null; harnessVersion: string | null; tool: string; ts: string | null }>(store: Store, slice: RecallSlice, now: number, clsOf: (row: Row) => string | null | undefined): ((row: Row) => boolean) => {
  const models = modelsByPrompt(store);
  const cutoff = slice.sinceDays === undefined ? undefined : new Date(now - slice.sinceDays * DAY_MS).toISOString();
  return (row) =>
    (slice.harnessVersion === undefined || row.harnessVersion === slice.harnessVersion) &&
    (slice.model === undefined || models.get(promptKey(row)) === slice.model) &&
    (slice.tool === undefined || row.tool === slice.tool) &&
    (slice.cls === undefined || clsOf(row) === slice.cls) &&
    (cutoff === undefined || (row.ts !== null && row.ts >= cutoff));
};

/** `current` answers every family the store's own rows do not: its reads are already cut, so `pullRefusal` turns away a slice they cannot apply. With no pool, there is nothing to answer from. */
const questionReads = (store: Store, family: string | undefined, slice: RecallSlice, now: number, current: CurrentPool | undefined): RecallRead[] => {
  if (family === undefined) return [];
  if (family === 'recovery') return recoveryReads(store, sliceKeeps<ErrorObservation>(store, slice, now, (error) => error.cls));
  if (family !== 'fit') return current === undefined ? [] : readsOfFamily(family, current);
  const classes = new Map(store.prompts.map((prompt) => [`${prompt.session}#${String(prompt.index)}`, prompt.cls]));
  return fitReads(store, FIT_FLOORS, sliceKeeps<ToolObservation>(store, slice, now, (call) => classes.get(promptKey(call))));
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
  const slice = { ...(options.cls === undefined ? {} : { cls: options.cls }), ...(options.sinceDays === undefined ? {} : { sinceDays: options.sinceDays }) };
  if (options.pattern.length > 0) return { form: 'pattern', prefix: options.pattern, slice };
  if (options.entity !== undefined) return { form: 'entity', entity: options.entity, slice };
  if (options.text !== undefined) return { form: 'text', text: options.text, slice };
  if (options.family === undefined) return undefined;
  return { form: 'question', family: options.family, slice };
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
        return questionReads(store, input.family, input.slice ?? {}, now, current);
      case 'text':
        return input.text === undefined ? [] : textReads(store, input.text);
    }
  };
  const answers = reads().slice(0, ANSWER_LIMIT);
  return current === undefined ? answers : resolveReads(answers, current.reads);
};

const ID_SHAPE = /^(read:)?[0-9a-f]{16}$/;
const isIdShape = (value: string): boolean => ID_SHAPE.test(value);
const isPublicName = (value: string): boolean => closedName(value) === value;
const isFamily = (value: string): boolean => FAMILIES.some((family) => family === value);

/** The families a question can answer. `lead-lag` is experimental, so it stays with `oars sessions read`. */
export const RECALL_FAMILIES: readonly Family[] = FAMILIES.filter((family) => family !== 'lead-lag');

/**
 * Why this pull cannot be asked; undefined when it can. Only `recovery` and `fit` count their answers from the store's own rows, so any other closed form or family cannot apply a
 * slice, and answering them anyway would state counts the slice did not narrow. The text names a form or a family that has passed `isFamily`, so it holds nothing an asker typed.
 */
export const pullRefusal = (input: PullInput): string | undefined => {
  if (!isClosed(input) || Object.keys(input.slice ?? {}).length === 0) return undefined;
  if (input.form !== 'question') return `The ${input.form} form counts all time, which a class or a number of days cannot narrow. Ask without them.`;
  const { family } = input;
  if (family === undefined || family === 'recovery' || family === 'fit' || !isFamily(family)) return undefined;
  return `Family ${family} answers from stored reads, which a class or a number of days cannot narrow. Ask without them, or slice its rows with oars sessions read --family ${family} --slice <axis>=<value>.`;
};

/** The forms a pull can name, in the order a refusal lists them. `error` with `path` is one form: the signature lookup. */
export const FORM_NAMES = ['prefix', 'entity', 'family', 'text', 'error or path'] as const;

/**
 * Why a pull naming several forms cannot be asked; undefined when it names at most one. Answering the first form and dropping the rest would state counts for a question the asker did
 * not put, and the rendered answer names no signature to show it. The text lists fixed form names, so it holds nothing an asker typed.
 */
export const formsRefusal = (named: readonly (typeof FORM_NAMES)[number][]): string | undefined =>
  named.length > 1 ? `Name one form per pull: ${FORM_NAMES.join(', ')}. This one named ${named.join(' and ')}.` : undefined;

const isPromptClass = (value: string): boolean => PROMPT_CLASSES.some((cls) => cls === value);
const isPublicModel = (value: string): boolean => publicModel(value) === value;
const isPublicVersion = (value: string): boolean => publicVersion(value) === value;

/**
 * What a recall stores of its query. Every field but `text` is class P, so each holds a value that passes its closed test or `<literal>`, and what it refused joins `text`,
 * class A, where what an asker typed belongs. The answer has already been read from the query as asked.
 */
const recordedQuery = ({ form, prefix, entity, family, slice, text }: ClosedQuery): RecallQueryObject => {
  const typed = text === undefined ? [] : [text];
  const close = (value: string, passes: (value: string) => boolean): string => {
    if (passes(value)) return value;
    typed.push(value);
    return LITERAL;
  };
  const closed: RecallQueryObject = {
    form,
    ...(prefix === undefined ? {} : { prefix: prefix.map((id) => close(id, isIdShape)) }),
    ...(entity === undefined ? {} : { entity: close(entity, isPublicName) }),
    ...(family === undefined ? {} : { family: close(family, isFamily) }),
    ...(slice === undefined
      ? {}
      : {
          slice: {
            ...(slice.harnessVersion === undefined ? {} : { harnessVersion: close(slice.harnessVersion, isPublicVersion) }),
            ...(slice.model === undefined ? {} : { model: close(slice.model, isPublicModel) }),
            ...(slice.tool === undefined ? {} : { tool: close(slice.tool, isPublicName) }),
            ...(slice.cls === undefined ? {} : { cls: close(slice.cls, isPromptClass) }),
            ...(slice.sinceDays === undefined ? {} : { sinceDays: slice.sinceDays }),
          },
        }),
  };
  return typed.length === 0 ? closed : { ...closed, text: typed.join(' ') };
};

/** The closed form a `recall()` input is recorded under. An error and a path are text the asker typed, so both stay in class A, and the narrowing that applied is kept as the slice. */
const closedOf = (query: RecallQuery): RecallQueryObject => {
  const slice = { ...(query.cls === undefined ? {} : { cls: query.cls }), ...(query.sinceDays === undefined ? {} : { sinceDays: query.sinceDays }) };
  const text = [query.error, query.path].filter((typed) => typed !== undefined).join(' ');
  if (text === '') return recordedQuery({ form: 'question', family: 'recovery', slice });
  return recordedQuery({ form: 'text', text, ...(Object.keys(slice).length === 0 ? {} : { slice }) });
};

export interface PullContext {
  /** The session asking; null when the pull came from outside one, which is every pull until the MCP path can name it. */
  sid: string | null;
  now: number;
  /** The asker's frame, when the caller knows it; otherwise `sid` may name a stored session, whose frame stands in. */
  frame: Frame | null;
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

/** The stored frame of the session asking, as of today: its harness and model are what the session ran under, and its day is when it started. */
const frameOfSession = (store: Store, sid: string | null, day: string | null): Frame | null => {
  const frame = sid === null ? undefined : store.sessions.find((session) => session.session === sid)?.frame;
  return frame === undefined ? null : { ...frame, day };
};

/** A pull always answers (spec 2.7): the holdback runs on pushes alone. */
export const pull = (store: Store, input: PullInput, context: PullContext): PullResult => {
  const at = new Date(context.now).toISOString();
  const legacy = isClosed(input) ? undefined : recall(store, input, context.now, undefined, context.redactDomains);
  const { current } = context;
  const day = utcDay(at);
  const frame = context.frame ?? frameOfSession(store, context.sid, day);
  const asker: RecallAsker = frame ?? { harness: null, harnessVersion: null, model: null, day };
  const legacyReads = (query: RecallQuery): RecallRead[] => {
    const found = recoveryReads(store, recallRows(store, query, context.now, context.redactDomains).keep).slice(0, ANSWER_LIMIT);
    return current === undefined ? found : resolveReads(found, current.reads);
  };
  const reads = isClosed(input) ? answerQuery(store, input, context.now, current) : legacyReads(input);
  const { rendered, names } = renderAnswer(reads, asker);
  const recorded = isClosed(input) ? recordedQuery(input) : closedOf(input);
  // What an asker typed is class A: redacted here, as a deposit redacts what it reads.
  const redact = makeRedactor(context.redactDomains);
  const made = makeRecall({
    sid: context.sid,
    at,
    frame,
    mode: 'pull',
    query: recorded.text === undefined ? recorded : { ...recorded, text: redact(recorded.text) },
    poolVersion: poolVersionOf(store),
    arm: 'shown',
    reads: reads.map((read) => read.readId),
    rendered,
    names,
    evidence: reads.map((read) => evidenceOf(read, asker)),
  });
  return { recall: made, reads, ...(legacy === undefined ? {} : { legacy }) };
};
