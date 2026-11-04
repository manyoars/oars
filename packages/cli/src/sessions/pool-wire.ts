// What crosses the wire between `oars pool` and the pool server (recall spec Sections 2.5, 4, and 5). A skeleton is one session in closed vocabulary: the records a cell is
// computed from, with every class A field left out, so any later derivation can run over old data while nothing private leaves. The client builds a skeleton and checks it before
// sending, and the server parses it again, field by field, because a live URL takes anything from anyone. This file imports nothing from the file system: the Worker bundles it.

import { ACTION_TABLES, CANONICAL_ACTIONS, mcpOf, type CanonicalAction } from './actions.js';
import { CUSTOM_AGENT, FRAMEWORKS, isPublicMcpTool, isRegistryVersion, LANGUAGES, LITERAL, PRIVATE, publicEffort, publicModel, publicVersion, PUBLIC_FLAGS, PUBLIC_HOSTS, PUBLIC_MCP_SERVERS, PUBLIC_PACKAGES, PUBLIC_PROGRAMS, PUBLIC_SKILLS, projectedAgentType, PUBLIC_SUBCOMMANDS, REPO_SIZES, VOCAB_VERSION } from './public-vocabulary.js';
import type { Cell } from './cells.js';
import type { Motif } from './motif.js';
import type { Read, ReadAsOf } from './read.js';
import { projectLanguage, projectLanguageShare } from './strata.js';
import { LANGUAGE_SHARES, type Frame, type FrameStack, type Harness, type LanguageShare, type PromptClass, type PromptObservation, type PullIdentity, type SessionObservation, type ShellIdentity, type StepIdentity, type StepObservation, type Strata, type ToolObservation, type ToolStatus, type Usage } from './schema.js';

export const SKELETON_FORMAT = 2;
export const BUNDLE_FORMAT = 1;
/** One constant: the pool serves only the vocabulary version the client holds. */
export { VOCAB_VERSION };

/**
 * Section 7's edges. A bucket is the count of edges a value reaches, so bucket 0 is under the first edge and the last is the first edge's doubling past the cap. `tokens`: under 1k, then
 * doubling to 1.024M and over. `ms`: under 100 ms, then doubling to 6,553.6 s and over. `seconds`: under 1 s, then doubling to 65,536 s and over. `count`: 0, 1, 2, 3-4, 5-8, 9-16, 17-32, over 32.
 */
const EDGES = {
  tokens: Array.from({ length: 11 }, (_, power) => 1000 * 2 ** power),
  ms: Array.from({ length: 17 }, (_, power) => 100 * 2 ** power),
  seconds: Array.from({ length: 17 }, (_, power) => 2 ** power),
  count: [1, 2, 3, 5, 9, 17, 33],
  // A call count of a session: the `count` edges, then each edge doubling its width up to over 4,096 (spec Section 7), because a long session passes 32 routinely.
  calls: [1, 2, 3, 5, 9, 17, 33, 65, 129, 257, 513, 1025, 2049, 4097],
} as const satisfies { [kind: string]: readonly number[] };

export type BucketKind = keyof typeof EDGES;

/** The bucket a value falls in. */
export const bucketOf = (kind: BucketKind, value: number): number => EDGES[kind].filter((edge) => value >= edge).length;

/** A stored `explore` count as it pools: its `calls` bucket, or null for a value no count holds (a record captured before the strata has none). The exact count never leaves. */
export const projectExplore = (stored: number | undefined): number | null => (stored !== undefined && Number.isSafeInteger(stored) && stored >= 0 ? bucketOf('calls', stored) : null);

/** The lowest value of a bucket, which is what a derivation counts a bucketed value as: it never reads above what the sender held. */
export const floorOf = (kind: BucketKind, bucket: number): number => EDGES[kind][bucket - 1] ?? 0;

/**
 * A step without what a server can compute or no derivation reads: `n` is its call's position, `seg` its place in the call (the array position), `frameId` hashes a frame the skeleton holds, and `edges` are read by no cell. Its cost is
 * two buckets, never the exact counts. `parent` is the position of the spawning call in the main run's `tools` (Section 1.2's `parent` ordinal).
 */
export type SkeletonStep = Omit<StepObservation, 'n' | 'seg' | 'frameId' | 'cost' | 'edges'> & {
  /** A `tokens` bucket of the step's tokens. */
  tokens: number | null;
  /** An `ms` bucket of the step's time. */
  ms: number | null;
  /** A `tokens` bucket of the tokens the run spent after this step (spec Section 1.2): the bucket of the exact sum, never a sum of buckets. */
  remainingTokens: number;
  /** The projected type of the subagent whose run holds the step, a built-in or `custom`; null on a main-run step. */
  agentType: string | null;
};

/** A call's order is its position in `tools`, and its `prompt` is a position in the same transcript's `prompts`: ordinals inside the batch, never the session's own numbers. */
export interface SkeletonTool {
  side: boolean;
  prompt: number | null;
  status: ToolStatus;
  /** Exact, per tool: the one exact time on the wire, which W reads on `ledger` (Section 1.2, `durationMs`). A cell never reads it. */
  durationMs: number | null;
  steps: SkeletonStep[];
}

/** A prompt's usage as `tokens` buckets: `thinking` is a token count (the thinking tokens of the output), so it takes the same edges as the rest. */
export type SkeletonUsage = { [field in keyof Usage]: number };

/** A language of the stack with its share of the touched files (spec Section 7): one of four buckets, never a count. */
export interface LanguageShareEntry {
  language: string;
  languageShare: LanguageShare;
}

/** The frame a skeleton holds: the stored frame, with the stack's shares beside its languages. A language whose share is not known is in `languages` and has no entry here. */
export type SkeletonFrame = Omit<Frame, 'stack'> & { stack: FrameStack & { languageShares: LanguageShareEntry[] } };

export interface SkeletonPrompt {
  cls: PromptClass;
  /** A `count` bucket. */
  errors: number;
  /** A `seconds` bucket. */
  wallSec: number | null;
  usage: SkeletonUsage;
  /** A `calls` bucket of the prompt's steps that only look (`file.read`, `file.search`, `web.search`, `web.fetch`); null when the record holds no count. */
  explore: number | null;
  frame: SkeletonFrame;
}

export interface SkeletonTranscript {
  /** The transcript's Merkle root and the count of its lines it covers (Section 2, "Subagents"): one pair for each transcript, the main's first. */
  merkleRoot: string;
  leaves: number;
  harness: Harness;
  frame: SkeletonFrame;
  prompts: SkeletonPrompt[];
  tools: SkeletonTool[];
}

/** What a delta entry may change (spec Section 4, rule 4): `permissionMode` and `effort` by name only, a `plugin` as added or removed, and a `package` as removed. */
export type DeltaField = 'plugin' | 'package' | 'permissionMode' | 'effort';
export type DeltaKind = 'added' | 'removed' | 'changed';
/** The one metric an entry's change is in: `callsPerSession` (tool calls in a session, or calls naming the package) in `count` buckets, `thinking` (thinking tokens in a prompt) in `tokens` buckets. */
export type DeltaMetric = 'callsPerSession' | 'thinking';

/**
 * One change between a client's own before and after windows. It holds no `sid`, root, window date, or exact value: `name` is the public package or the word `private` (a plugin has no pinned registry, so
 * always `private`), null when the field is named alone; `registry` is the package's registry and is null for a `private` name; `change` is the signed bucket of the metric's move, never the metric.
 */
export interface DeltaEntry {
  deltaKind: DeltaKind;
  field: DeltaField;
  name: string | null;
  registry: string | null;
  metric: DeltaMetric;
  change: number;
}

export interface SessionSkeleton {
  format: typeof SKELETON_FORMAT;
  /** A hash the client computes per account, so a redeposit replaces and two accounts' sessions cannot be joined. Never the session's own id. */
  id: string;
  /** The main transcript first, then each subagent's. */
  transcripts: SkeletonTranscript[];
  /** One for the batch: a hash of the main transcript's non-null call durations in call order, only with `MIN_TIMED_CALLS` of them; a subagent's calls never join it. */
  timingPrint: string | null;
  /** The batch's client-built delta entries (Section 2, "Deltas"): changes between the client's own before and after windows, each carried once, by the batch of the session that filled the after window. */
  deltas: DeltaEntry[];
}

/** One main session and the subagents it spawned, as the local store holds them. */
export interface SessionRecords {
  main: SessionObservation;
  /** The main transcript first, then each subagent's, ordered by session so one store builds one batch. */
  transcripts: { session: SessionObservation; prompts: PromptObservation[]; tools: ToolObservation[]; root: TranscriptRoot | null }[];
}

/** What a skeleton file holds of a transcript that may leave the machine: its root and the count of lines under it. */
export interface TranscriptRoot {
  merkleRoot: string;
  leaves: number;
}

/** W's minimum for a timing print (deposit-weighting spec, layer 5): fewer timed calls than this say too little to tell sessions apart. */
export const MIN_TIMED_CALLS = 50;

/** A session has ended once no transcript of it has gained a line for this long (`session_idle_hours`, spec Section 7). */
export const SESSION_IDLE_HOURS = 6;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Whether a session's batch may be built at `now`: no transcript of it, main or subagent, has gained a line for `SESSION_IDLE_HOURS`. A transcript gains a line when capture sees it change, which
 * stamps a new `rev` in epoch milliseconds, but a transcript can grow after the last capture, so `written` (the newest write to any raw file of the session, 0 when none is known) counts too: the
 * session was last active at the later of the two. A subagent that died without an end marker holds its session back at most that long.
 */
export const hasEnded = (records: SessionRecords, now: number, written: number): boolean => now - Math.max(written, ...records.transcripts.map(({ session }) => session.rev)) >= SESSION_IDLE_HOURS * HOUR_MS;

const groupBy = <T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> => {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
};

/** Every main session of a store, with its records. */
export const sessionsOf = (
  store: { sessions: readonly SessionObservation[]; subagents: readonly SessionObservation[]; prompts: readonly PromptObservation[]; tools: readonly ToolObservation[] },
  roots: ReadonlyMap<string, TranscriptRoot>,
): SessionRecords[] => {
  // Grouped once: a fleet's store holds thousands of sessions over hundreds of thousands of rows, and a scan per session would be quadratic.
  const prompts = groupBy(store.prompts, (prompt) => prompt.session);
  const tools = groupBy(store.tools, (tool) => tool.session);
  const subagents = groupBy(store.subagents, (subagent) => subagent.parent);
  const recordsOf = (session: SessionObservation): SessionRecords['transcripts'][number] => ({ session, prompts: prompts.get(session.session) ?? [], tools: tools.get(session.session) ?? [], root: roots.get(session.session) ?? null });
  // A subagent whose main transcript the store does not hold is in no group: it cannot be folded, and counting it alone would raise `n`.
  return store.sessions.map((main) => ({ main, transcripts: [main, ...[...(subagents.get(main.session) ?? [])].sort((a, b) => (a.session < b.session ? -1 : 1))].map(recordsOf) }));
};

/** One command of a shell call as the projection reads it (`projectStoredShell`): a program, its subcommand, and its flags, each a list member or `private`. */
export interface ShellCommand {
  program: string;
  subcommand: string | null;
  flags: readonly string[];
}

/** Reads a stored shell call's commands in order. The client passes the projection; this file holds no vocabulary snapshot, so the Worker can bundle it. */
export type ShellReader = (tool: ToolObservation) => readonly ShellCommand[];


const SHORT_FLAG = /^-[A-Za-z]$/;

/** The flags the wire has a row for: the curated list and a single letter. */
const isWireFlag = (flag: string): boolean => PUBLIC_FLAGS.has(flag) || SHORT_FLAG.test(flag);

const PRIVATE_COMMAND = { program: PRIVATE, sub: null, flags: [] } satisfies ShellIdentity;

/**
 * A projected command as the server's parser reads it. The client's snapshot lists more programs than the curated list the server holds, and a name the server has no row for
 * does not go on the wire (Section 1.2): such a program is `private`, and a subcommand or flag outside the curated lists is dropped, as the projection drops an unlisted one.
 */
const wireCommand = ({ program, subcommand, flags }: ShellCommand): ShellIdentity => {
  if (!PUBLIC_PROGRAMS.has(program)) return PRIVATE_COMMAND;
  return { program, sub: subcommand !== null && PUBLIC_SUBCOMMANDS.get(program)?.has(subcommand) === true ? subcommand : null, flags: flags.filter(isWireFlag) };
};

/** The wire's one spelling of "not admitted": a name the server's list does not hold goes as `private`, whatever the local store spells it. */
const listed = (allowed: ReadonlySet<string>, name: string): string => (allowed.has(name) ? name : PRIVATE);

/** A pull in the wire's spelling: its package name is a list member or `private`. A version beside a masked name could identify it, so it goes as `<literal>` (null stays null), the rule capture applies. */
const wirePull = (pull: PullIdentity): PullIdentity => {
  const name = listed(PUBLIC_PACKAGES, pull.name);
  return { ...pull, name, version: name === PRIVATE && pull.version !== null ? LITERAL : pull.version };
};

/** A non-shell step's identity in the wire's spelling; a shell step's comes from `wireCommand`. */
const wireIdentity = (identity: StepIdentity, harness: Harness): StepIdentity => {
  if (identity === null || 'program' in identity) return identity;
  if ('server' in identity) {
    const server = listed(PUBLIC_MCP_SERVERS, identity.server);
    // A tool beside a masked server has no list to be checked against, so it goes as the literal. Beside a listed one it goes as itself only where the server's list still holds it
    // and the harness's spelling delimits the server (the parser's rule); a tool an older list held, or one stored before that rule, goes as the literal rather than refusing the session.
    const named = server !== PRIVATE && ACTION_TABLES[harness].toolDelimited && isPublicMcpTool(server, identity.tool);
    return { server, tool: named ? identity.tool : LITERAL };
  }
  if ('skill' in identity) return { skill: listed(PUBLIC_SKILLS, identity.skill) };
  return { host: identity.host === null ? null : listed(PUBLIC_HOSTS, identity.host) };
};

/**
 * A stored tool's steps as the wire holds them: each shell step's identity is replaced by the projected command, and every name the server has no row for (a native name, MCP server,
 * skill, host, or pull name) reads `private`. A `private` program holds no pull, so a stored step whose public program has since left the list carries none. The one place a deposit and a local read take it from.
 */
export const projectedSteps = (tool: ToolObservation, read: ShellReader, harness: Harness): StepObservation[] => {
  const commands = read(tool);
  return (tool.steps ?? []).map((step, at) => {
    const native = admittedNative(harness, step.native) ? step.native : PRIVATE;
    if (step.action !== 'shell.exec') return { ...step, native, identity: wireIdentity(step.identity, harness) };
    const command = wireCommand(commands[at] ?? { program: PRIVATE, subcommand: null, flags: [] });
    const pulls = step.identity !== null && 'program' in step.identity ? step.identity.pulls : undefined;
    return { ...step, native, identity: pulls === undefined || command.program === PRIVATE ? command : { ...command, pulls: pulls.map(wirePull) } };
  });
};

/** A transcript's calls in the order they ran, which is the order a skeleton holds them in. */
const byCall = (tools: readonly ToolObservation[]): ToolObservation[] => [...tools].sort((a, b) => a.n - b.n);

/** The step of a call that carries the runs it spawned: its first spawn step, else its first step. A call with no step carries none. */
const carrier = (steps: readonly { action: string }[]): number => Math.max(0, steps.findIndex(({ action }) => action === 'agent.spawn'));

/** What a run does about the subagent runs its calls spawned: the exact tokens each call's runs spent, by the call's position in the main run. Empty for a subagent's run. */
type Spawned = ReadonlyMap<number, number>;

/**
 * A stored frame with its stack's language shares: each stored share is read through its projection, so a share outside the list is dropped and its language stays in `languages`. A stored
 * language outside the pinned list is `other`, and `other` holds the first share a record gives it. A record captured before the strata holds none.
 */
const wireFrame = (frame: Frame, strata: Strata | undefined): SkeletonFrame => {
  const shares = new Map<string, LanguageShare>();
  for (const { language, share } of strata?.languages ?? []) {
    const held = projectLanguageShare(share);
    const name = projectLanguage(language);
    if (held !== null && !shares.has(name)) shares.set(name, held);
  }
  return { ...frame, stack: { ...frame.stack, languageShares: [...shares].map(([language, languageShare]) => ({ language, languageShare })) } };
};

const transcriptOf = (
  { session, prompts, tools, root }: SessionRecords['transcripts'][number],
  spawners: ReadonlyMap<number, number> | null,
  spawned: Spawned,
  agentType: string | null,
  read: ShellReader,
): SkeletonTranscript | null => {
  if (session.frame === undefined || root === null) return null;
  const harness = session.harness ?? 'claude-code';
  const framedPrompts: SkeletonPrompt[] = [];
  const promptAt = new Map<number, number>();
  for (const { index, cls, errors, wallSec, usage, frame, strata } of [...prompts].sort((a, b) => a.index - b.index)) {
    if (frame === undefined) return null;
    promptAt.set(index, framedPrompts.length);
    framedPrompts.push({
      cls,
      errors: bucketOf('count', errors),
      wallSec: wallSec === null ? null : bucketOf('seconds', wallSec),
      usage: { input: bucketOf('tokens', usage.input), cacheWrite: bucketOf('tokens', usage.cacheWrite), cacheRead: bucketOf('tokens', usage.cacheRead), output: bucketOf('tokens', usage.output), thinking: bucketOf('tokens', usage.thinking) },
      explore: projectExplore(strata?.explore),
      frame: wireFrame(frame, strata),
    });
  }
  const steppedTools: SkeletonTool[] = [];
  // The exact tokens of every step, by call and step, which the `remainingTokens` buckets below are computed from: a bucket of a sum is not a sum of buckets.
  const exact: number[][] = [];
  let unrecorded = 0;
  for (const tool of byCall(tools)) {
    if (tool.steps === undefined) return null;
    const { side, prompt, status, durationMs } = tool;
    // A subagent's call names the prompt that spawned it, which its own transcript holds no record of: such a number takes the next position past the prompts, one per distinct number, so
    // the calls that shared a prompt still share one, and no position reads as a prompt.
    if (prompt !== null && !promptAt.has(prompt)) promptAt.set(prompt, framedPrompts.length + unrecorded++);
    const promptPosition = prompt === null ? null : (promptAt.get(prompt) ?? null);
    const projected = projectedSteps(tool, read, harness);
    exact.push(projected.map(({ cost }) => cost.tokens ?? 0));
    const steps = projected.map(({ action, native, identity, status: reported, cost, parent }): SkeletonStep => ({
      action,
      native,
      identity,
      status: reported,
      tokens: cost.tokens === null ? null : bucketOf('tokens', cost.tokens),
      ms: cost.durationMs === null ? null : bucketOf('ms', cost.durationMs),
      remainingTokens: 0,
      agentType,
      parent: parent === null || spawners === null ? null : (spawners.get(parent) ?? null),
    }));
    steppedTools.push({ side, prompt: promptPosition, status, durationMs, steps });
  }
  // A step's remaining tokens are those of the steps after it in its own run; a main-run step also counts the subagent runs its later steps spawned (a run belongs to the spawning call's carrier step).
  let later = 0;
  for (let call = steppedTools.length - 1; call >= 0; call -= 1) {
    const steps = steppedTools[call]?.steps ?? [];
    const held = carrier(steps);
    for (let at = steps.length - 1; at >= 0; at -= 1) {
      const step = steps[at];
      if (step === undefined) continue;
      step.remainingTokens = bucketOf('tokens', later);
      later += (exact[call]?.[at] ?? 0) + (at === held ? (spawned.get(call) ?? 0) : 0);
    }
  }
  return { merkleRoot: root.merkleRoot, leaves: root.leaves, harness, frame: wireFrame(session.frame, session.strata), prompts: framedPrompts, tools: steppedTools };
};

/** The hash a batch's timing print is made with, over the durations in call order: the client's `contentHash` (D1's `hP`). */
export type Print = (durations: readonly number[]) => string;

/**
 * The skeleton of a session; null when any record of it was captured before steps and frames, or a transcript of it has no root, which holds no closed reading to send. The batch holds the main
 * transcript's run first, then each subagent's as its own run; its `id` is the main session's, and its one `timingPrint` is over the main transcript's calls alone.
 */
export const skeletonOf = (records: SessionRecords, id: string, read: ShellReader, print: Print, deltas: readonly DeltaEntry[] = []): SessionSkeleton | null => {
  const mainTools = byCall(records.transcripts[0]?.tools ?? []);
  // A subagent's step names the call that spawned it by that call's `n` in the main run, which the skeleton holds as the call's position.
  const spawners = new Map(mainTools.map(({ n }, position) => [n, position]));
  const spawnedBy = (entry: SessionRecords['transcripts'][number]): boolean => entry.session.spawnedIn === records.main.session;
  // The exact tokens of the runs each main-run call spawned. A run a subagent spawned names a call of that other transcript, so it joins no main-run step.
  const spawned = new Map<number, number>();
  for (const entry of records.transcripts.slice(1)) {
    if (!spawnedBy(entry)) continue;
    for (const tool of entry.tools) {
      for (const { cost, parent } of tool.steps ?? []) {
        const position = parent === null ? undefined : spawners.get(parent);
        if (position !== undefined) spawned.set(position, (spawned.get(position) ?? 0) + (cost.tokens ?? 0));
      }
    }
  }
  const transcripts: SkeletonTranscript[] = [];
  for (const [index, entry] of records.transcripts.entries()) {
    // Only a call of the main run has a position here: a step of a subagent a subagent spawned names a call of that other transcript, so it sends no link rather than a false one.
    const transcript = transcriptOf(entry, index > 0 && spawnedBy(entry) ? spawners : null, index === 0 ? spawned : new Map(), index === 0 ? null : projectedAgentType(entry.session.agentType ?? CUSTOM_AGENT), read);
    if (transcript === null) return null;
    transcripts.push(transcript);
  }
  const durations = mainTools.flatMap(({ durationMs }) => (durationMs === null ? [] : [durationMs]));
  return { format: SKELETON_FORMAT, id, transcripts, timingPrint: durations.length < MIN_TIMED_CALLS ? null : print(durations), deltas: [...deltas] };
};

/** A harness version a bundle can be asked for: public, so the request carries nothing private. The admitted list replaces this shape rule when it ships. */
export const isBundleVersion = (version: string): boolean => version !== LITERAL && publicVersion(version) === version;

/** Whether `name` is a harness the schema names. */
export const isHarness = (name: string): name is Harness => HARNESSES.some((harness) => harness === name);

export interface Refusal {
  ok: false;
  field: string;
  reason: string;
}

class Refused extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`${field}: ${reason}`);
  }
}

interface Fields {
  [key: string]: unknown;
}

const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);

const under = (at: string, key: string): string => (at === '' ? key : `${at}.${key}`);

/** The object at `at`, holding every field of `known` and, of the rest, only `optional`. Nothing unnamed passes, which is what keeps a class A field out. */
const fieldsOf = (value: unknown, at: string, known: readonly string[], optional: readonly string[] = []): Fields => {
  if (!isFields(value)) throw new Refused(at === '' ? 'skeleton' : at, 'not an object');
  for (const key of Object.keys(value)) if (!known.includes(key) && !optional.includes(key)) throw new Refused(under(at, key), 'not a field of a skeleton');
  for (const key of known) if (!Object.hasOwn(value, key)) throw new Refused(under(at, key), 'missing');
  return value;
};

const listOf = <T>(value: unknown, at: string, item: (entry: unknown, entryAt: string) => T): T[] => {
  if (!Array.isArray(value)) throw new Refused(at, 'not a list');
  const entries: readonly unknown[] = value;
  return entries.map((entry, index) => item(entry, `${at}[${String(index)}]`));
};

const textOf = (value: unknown, at: string): string => {
  if (typeof value !== 'string') throw new Refused(at, 'not text');
  return value;
};

/** Whole and safe: a depositor's value is added into cells every account is served, and one huge number would turn a sum into Infinity, which JSON writes as null. */
const countOf = (value: unknown, at: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Refused(at, 'not a count');
  return value;
};

const orNull = <T>(value: unknown, at: string, item: (entry: unknown, entryAt: string) => T): T | null => (value === null ? null : item(value, at));

const booleanOf = (value: unknown, at: string): boolean => {
  if (typeof value !== 'boolean') throw new Refused(at, 'not a boolean');
  return value;
};

/** A value from a closed list; the list narrows the type, so no caller needs a cast. */
const oneOf = <T extends string>(list: readonly T[], value: unknown, at: string): T => {
  const found = list.find((entry) => entry === value);
  if (found === undefined) throw new Refused(at, 'outside the vocabulary');
  return found;
};

const inSet = (allowed: ReadonlySet<string>, value: unknown, at: string): string => {
  const name = textOf(value, at);
  if (name !== PRIVATE && !allowed.has(name)) throw new Refused(at, 'outside the vocabulary');
  return name;
};

const exactlyIn = (allowed: ReadonlySet<string>) => (value: unknown, at: string): string => {
  if (typeof value !== 'string' || !allowed.has(value)) throw new Refused(at, 'outside the vocabulary');
  return value;
};

/** `publicModel` and its like hand back what is public and the literal for what is not, so only a value they return unchanged is in the vocabulary. */
const heldTo = (isHeld: (value: string | null) => string | null, value: unknown, at: string): string | null => {
  if (value === null) return null;
  const name = textOf(value, at);
  if (isHeld(name) !== name) throw new Refused(at, 'outside the vocabulary');
  return name;
};

// `satisfies` checks every entry is a `Harness` but not that every `Harness` is listed; this refuses a list that leaves one out at compile time.
const allHarnesses = <const T extends readonly Harness[]>(list: [Exclude<Harness, T[number]>] extends [never] ? T : never): T => list;
export const HARNESSES = allHarnesses(['claude-code', 'cursor', 'codex', 'copilot', 'gemini', 'grok', 'vscode-copilot']);
const PROMPT_CLASSES = ['no-tools', 'orchestration', 'research', 'edit-verify', 'edit-only', 'explore-only', 'shell-only', 'mixed'] as const satisfies readonly PromptClass[];
const STATUSES = ['ok', 'error', 'none'] as const satisfies readonly ToolStatus[];
const PLATFORMS: ReadonlySet<string> = new Set(['aix', 'android', 'cygwin', 'darwin', 'freebsd', 'haiku', 'linux', 'netbsd', 'openbsd', 'sunos', 'win32']);
const SHELLS: ReadonlySet<string> = new Set(Object.values(ACTION_TABLES).flatMap((table) => Object.values(table.shells)));
/** The registries a package comes from; a pull may also come from a skill, plugin, or MCP registry. */
export const PACKAGE_REGISTRIES = ['npm', 'pypi', 'crates', 'go', 'rubygems', 'homebrew'] as const;
const REGISTRIES = [...PACKAGE_REGISTRIES, 'skill', 'plugin', 'mcp'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[0-9a-f]{16}$/;
/** A real date, not just its shape. `Date.parse` rolls 2026-02-31 over to March instead of failing, so the day must also survive the trip back to text. */
const isCalendarDay = (text: string): boolean => {
  if (!DAY.test(text)) return false;
  const parsed = Date.parse(text);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === text;
};

const parseLanguageShare = (value: unknown, at: string): LanguageShareEntry => {
  const raw = fieldsOf(value, at, ['language', 'languageShare']);
  return { language: exactlyIn(LANGUAGES)(raw.language, under(at, 'language')), languageShare: oneOf(LANGUAGE_SHARES, raw.languageShare, under(at, 'languageShare')) };
};

const parseFrame = (value: unknown, at: string): SkeletonFrame => {
  const raw = fieldsOf(value, at, ['harness', 'harnessVersion', 'model', 'effort', 'day', 'platform', 'shell', 'stack']);
  const stackAt = under(at, 'stack');
  const stack = fieldsOf(raw.stack, stackAt, ['languages', 'frameworks', 'size', 'languageShares']);
  const day = orNull(raw.day, under(at, 'day'), (entry, entryAt) => {
    const text = textOf(entry, entryAt);
    if (!isCalendarDay(text)) throw new Refused(entryAt, 'not a UTC day');
    return text;
  });
  return {
    harness: oneOf(HARNESSES, raw.harness, under(at, 'harness')),
    harnessVersion: heldTo(publicVersion, raw.harnessVersion, under(at, 'harnessVersion')),
    model: heldTo(publicModel, raw.model, under(at, 'model')),
    effort: heldTo(publicEffort, raw.effort, under(at, 'effort')),
    day,
    platform: exactlyIn(PLATFORMS)(raw.platform, under(at, 'platform')),
    shell: orNull(raw.shell, under(at, 'shell'), exactlyIn(SHELLS)),
    stack: {
      languages: listOf(stack.languages, under(stackAt, 'languages'), exactlyIn(LANGUAGES)),
      frameworks: listOf(stack.frameworks, under(stackAt, 'frameworks'), exactlyIn(FRAMEWORKS)),
      size: orNull(stack.size, under(stackAt, 'size'), (entry, entryAt) => oneOf(REPO_SIZES, entry, entryAt)),
      languageShares: listOf(stack.languageShares, under(stackAt, 'languageShares'), parseLanguageShare),
    },
  };
};

const bucketIn = (kind: BucketKind, value: unknown, at: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > EDGES[kind].length) throw new Refused(at, 'not a bucket');
  return value;
};

const parseUsage = (value: unknown, at: string): SkeletonUsage => {
  const raw = fieldsOf(value, at, ['input', 'cacheWrite', 'cacheRead', 'output', 'thinking']);
  return {
    input: bucketIn('tokens', raw.input, under(at, 'input')),
    cacheWrite: bucketIn('tokens', raw.cacheWrite, under(at, 'cacheWrite')),
    cacheRead: bucketIn('tokens', raw.cacheRead, under(at, 'cacheRead')),
    output: bucketIn('tokens', raw.output, under(at, 'output')),
    thinking: bucketIn('tokens', raw.thinking, under(at, 'thinking')),
  };
};

const parsePull = (value: unknown, at: string): PullIdentity => {
  const raw = fieldsOf(value, at, ['registry', 'name', 'version']);
  const name = inSet(PUBLIC_PACKAGES, raw.name, under(at, 'name'));
  const version = orNull(raw.version, under(at, 'version'), (entry, entryAt) => {
    const text = textOf(entry, entryAt);
    if (text !== LITERAL && !isRegistryVersion(text)) throw new Refused(entryAt, 'outside the vocabulary');
    // A version beside a masked name could identify it: capture masks the two together.
    if (name === PRIVATE && text !== LITERAL) throw new Refused(entryAt, 'a private name holds no version');
    return text;
  });
  return { registry: oneOf(REGISTRIES, raw.registry, under(at, 'registry')), name, version };
};

const parseFlag = (value: unknown, at: string): string => {
  const flag = textOf(value, at);
  if (!isWireFlag(flag)) throw new Refused(at, 'outside the vocabulary');
  return flag;
};

const parseIdentity = (harness: Harness, action: CanonicalAction, value: unknown, at: string): StepIdentity => {
  if (value === null) return null;
  if (action === 'shell.exec') {
    const raw = fieldsOf(value, at, ['program', 'sub', 'flags'], ['pulls']);
    // A program is a list member or `private`, and a `private` program holds no subcommand, flag, or pull.
    const program = textOf(raw.program, under(at, 'program'));
    if (program !== PRIVATE && !PUBLIC_PROGRAMS.has(program)) throw new Refused(under(at, 'program'), 'outside the vocabulary');
    if (program === PRIVATE) {
      if (!(Array.isArray(raw.flags) && raw.flags.length === 0)) throw new Refused(under(at, 'flags'), 'a private program holds no flags');
      if (raw.pulls !== undefined) throw new Refused(under(at, 'pulls'), 'a private program holds no pulls');
    }
    const subs = PUBLIC_SUBCOMMANDS.get(program) ?? new Set<string>();
    const sub = orNull(raw.sub, under(at, 'sub'), exactlyIn(subs));
    const flags = listOf(raw.flags, under(at, 'flags'), parseFlag);
    return raw.pulls === undefined ? { program, sub, flags } : { program, sub, flags, pulls: listOf(raw.pulls, under(at, 'pulls'), parsePull) };
  }
  if (action === 'mcp.call') {
    const raw = fieldsOf(value, at, ['server', 'tool']);
    const server = inSet(PUBLIC_MCP_SERVERS, raw.server, under(at, 'server'));
    const tool = textOf(raw.tool, under(at, 'tool'));
    // The same rule capture applies (`callIdentity`), so a name it would have masked is refused here rather than stored.
    if (tool !== LITERAL && !(ACTION_TABLES[harness].toolDelimited && isPublicMcpTool(server, tool))) throw new Refused(under(at, 'tool'), 'outside the vocabulary');
    return { server, tool };
  }
  if (action === 'skill.run') return { skill: inSet(PUBLIC_SKILLS, fieldsOf(value, at, ['skill']).skill, under(at, 'skill')) };
  if (action === 'web.fetch' || action === 'web.search') {
    const { host } = fieldsOf(value, at, ['host']);
    return { host: orNull(host, under(at, 'host'), (entry, entryAt) => inSet(PUBLIC_HOSTS, entry, entryAt)) };
  }
  throw new Refused(at, 'this action has no identity');
};

/** Whether the harness's table names this native, so it can cross as itself; anything else (including the literal) crosses as `private`. */
const admittedNative = (harness: Harness, native: string): boolean => {
  if (native === PRIVATE) return true;
  const table = ACTION_TABLES[harness];
  if (Object.hasOwn(table.rows, native)) return true;
  const mcp = mcpOf(table, native);
  return mcp !== undefined && table.toolDelimited && isPublicMcpTool(mcp.server, mcp.tool);
};

const parseNative = (harness: Harness, value: unknown, at: string): string => {
  const native = textOf(value, at);
  if (!admittedNative(harness, native)) throw new Refused(at, 'outside the vocabulary');
  return native;
};

/** A subagent type as the projection leaves it: a built-in of a harness, or `custom`; a custom agent's own name is private and never admitted. */
const parseAgentType = (value: unknown, at: string): string => {
  const name = textOf(value, at);
  if (projectedAgentType(name) !== name) throw new Refused(at, 'outside the vocabulary');
  return name;
};

const parseStep = (harness: Harness, value: unknown, at: string): SkeletonStep => {
  const raw = fieldsOf(value, at, ['action', 'native', 'identity', 'status', 'tokens', 'ms', 'remainingTokens', 'agentType', 'parent']);
  const action = oneOf(CANONICAL_ACTIONS, raw.action, under(at, 'action'));
  return {
    action,
    native: parseNative(harness, raw.native, under(at, 'native')),
    identity: parseIdentity(harness, action, raw.identity, under(at, 'identity')),
    status: oneOf(STATUSES, raw.status, under(at, 'status')),
    tokens: orNull(raw.tokens, under(at, 'tokens'), (entry, entryAt) => bucketIn('tokens', entry, entryAt)),
    ms: orNull(raw.ms, under(at, 'ms'), (entry, entryAt) => bucketIn('ms', entry, entryAt)),
    remainingTokens: bucketIn('tokens', raw.remainingTokens, under(at, 'remainingTokens')),
    agentType: orNull(raw.agentType, under(at, 'agentType'), parseAgentType),
    parent: orNull(raw.parent, under(at, 'parent'), countOf),
  };
};

const parseTool = (harness: Harness, value: unknown, at: string): SkeletonTool => {
  const raw = fieldsOf(value, at, ['side', 'prompt', 'status', 'durationMs', 'steps']);
  return {
    side: booleanOf(raw.side, under(at, 'side')),
    prompt: orNull(raw.prompt, under(at, 'prompt'), countOf),
    status: oneOf(STATUSES, raw.status, under(at, 'status')),
    durationMs: orNull(raw.durationMs, under(at, 'durationMs'), countOf),
    steps: listOf(raw.steps, under(at, 'steps'), (entry, entryAt) => parseStep(harness, entry, entryAt)),
  };
};

const parsePrompt = (value: unknown, at: string): SkeletonPrompt => {
  const raw = fieldsOf(value, at, ['cls', 'errors', 'wallSec', 'usage', 'explore', 'frame']);
  return {
    cls: oneOf(PROMPT_CLASSES, raw.cls, under(at, 'cls')),
    errors: bucketIn('count', raw.errors, under(at, 'errors')),
    wallSec: orNull(raw.wallSec, under(at, 'wallSec'), (entry, entryAt) => bucketIn('seconds', entry, entryAt)),
    usage: parseUsage(raw.usage, under(at, 'usage')),
    explore: orNull(raw.explore, under(at, 'explore'), (entry, entryAt) => bucketIn('calls', entry, entryAt)),
    frame: parseFrame(raw.frame, under(at, 'frame')),
  };
};

const ROOT = /^[0-9a-f]{64}$/;
const PRINT = /^[0-9a-f]{16}$/;

const parseRoot = (value: unknown, at: string): string => {
  const root = textOf(value, at);
  if (!ROOT.test(root)) throw new Refused(at, 'not a SHA-256');
  return root;
};

const parseTranscript = (value: unknown, at: string): SkeletonTranscript => {
  const raw = fieldsOf(value, at, ['merkleRoot', 'leaves', 'harness', 'frame', 'prompts', 'tools']);
  const harness = oneOf(HARNESSES, raw.harness, under(at, 'harness'));
  return {
    merkleRoot: parseRoot(raw.merkleRoot, under(at, 'merkleRoot')),
    leaves: countOf(raw.leaves, under(at, 'leaves')),
    harness,
    frame: parseFrame(raw.frame, under(at, 'frame')),
    prompts: listOf(raw.prompts, under(at, 'prompts'), parsePrompt),
    tools: listOf(raw.tools, under(at, 'tools'), (entry, entryAt) => parseTool(harness, entry, entryAt)),
  };
};

const DELTA_FIELDS = ['plugin', 'package', 'permissionMode', 'effort'] as const satisfies readonly DeltaField[];
/** The kinds each field can take: a plugin comes or goes, a package only goes (an addition is adoption, which `pool` reads from the calls), and a mode or an effort changes. */
const KINDS_OF = { plugin: ['added', 'removed'], package: ['removed'], permissionMode: ['changed'], effort: ['changed'] } as const satisfies { readonly [field in DeltaField]: readonly DeltaKind[] };
/** The one metric each field's change is measured in, and the bucket edges that metric is held to. */
const METRIC_OF = { plugin: 'callsPerSession', package: 'callsPerSession', permissionMode: 'callsPerSession', effort: 'thinking' } as const satisfies { readonly [field in DeltaField]: DeltaMetric };
const METRIC_EDGES = { callsPerSession: 'count', thinking: 'tokens' } as const satisfies { readonly [metric in DeltaMetric]: BucketKind };
const NO_NAME: ReadonlySet<string> = new Set();

const nullOnly = (value: unknown, at: string): null => {
  if (value !== null) throw new Refused(at, 'outside the vocabulary');
  return null;
};

/**
 * The entry of a delta, held to its field's own row. A plugin has no registry to pass, so only the word `private` stands for one; a package is a public name with its registry, or `private` with none; a mode
 * and an effort are named by their field and carry no name. The change is a signed bucket of the field's metric.
 */
const parseDelta = (value: unknown, at: string): DeltaEntry => {
  const raw = fieldsOf(value, at, ['deltaKind', 'field', 'name', 'registry', 'metric', 'change']);
  const field = oneOf(DELTA_FIELDS, raw.field, under(at, 'field'));
  const deltaKind = oneOf(KINDS_OF[field], raw.deltaKind, under(at, 'deltaKind'));
  const metric = oneOf([METRIC_OF[field]], raw.metric, under(at, 'metric'));
  const name = field === 'plugin' || field === 'package' ? inSet(field === 'package' ? PUBLIC_PACKAGES : NO_NAME, raw.name, under(at, 'name')) : nullOnly(raw.name, under(at, 'name'));
  const registry = field === 'package' && name !== PRIVATE ? oneOf(PACKAGE_REGISTRIES, raw.registry, under(at, 'registry')) : nullOnly(raw.registry, under(at, 'registry'));
  const change = raw.change;
  if (typeof change !== 'number' || !Number.isInteger(change) || Math.abs(change) > EDGES[METRIC_EDGES[metric]].length) throw new Refused(under(at, 'change'), 'not a signed bucket');
  return { deltaKind, field, name, registry, metric, change };
};

/** The skeleton in `value`, rebuilt from the fields read; else the first field that is not closed vocabulary, and why. */
export const parseSkeleton = (value: unknown): { ok: true; skeleton: SessionSkeleton } | Refusal => {
  try {
    // The first form sent exact usage; it is named here, since its fields would otherwise read as a list of strangers.
    if (isFields(value) && value.format === 1) throw new Refused('format', 'the exact-count form (format 1) is no longer read; send format 2');
    const raw = fieldsOf(value, '', ['format', 'id', 'transcripts', 'timingPrint', 'deltas']);
    if (raw.format !== SKELETON_FORMAT) throw new Refused('format', 'not a format this version reads');
    const id = textOf(raw.id, 'id');
    if (!ID.test(id)) throw new Refused('id', 'not a hash');
    const deltas = listOf(raw.deltas, 'deltas', parseDelta);
    const transcripts = listOf(raw.transcripts, 'transcripts', parseTranscript);
    if (transcripts.length === 0) throw new Refused('transcripts', 'empty');
    // A counting batch is what lifts the fetch cap, so a deposit has to hold something to derive from.
    if (transcripts.every(({ prompts, tools }) => prompts.length === 0 && tools.length === 0)) throw new Refused('transcripts', 'holds no prompt and no tool');
    // The main run's calls make the one print, so it exists exactly when the main run holds enough timed calls; a subagent's calls never decide it.
    const timed = (transcripts[0]?.tools ?? []).filter(({ durationMs }) => durationMs !== null).length;
    const timingPrint = orNull(raw.timingPrint, 'timingPrint', (entry, entryAt) => {
      const text = textOf(entry, entryAt);
      if (!PRINT.test(text)) throw new Refused(entryAt, 'not a hash');
      return text;
    });
    if ((timingPrint === null) !== (timed < MIN_TIMED_CALLS)) throw new Refused('timingPrint', timingPrint === null ? 'missing: the main run holds enough timed calls' : 'not allowed: the main run holds too few timed calls');
    // A step carries the type of the subagent whose run holds it, so the main run's steps carry none and every subagent step carries one.
    transcripts.forEach(({ tools }, index) => {
      tools.forEach(({ steps }, call) => {
        steps.forEach(({ agentType }, position) => {
          if ((agentType === null) !== (index === 0)) throw new Refused(`transcripts[${String(index)}].tools[${String(call)}].steps[${String(position)}].agentType`, index === 0 ? 'a main-run step has no subagent type' : 'a subagent step needs its type');
        });
      });
    });
    // Positions are the only ordinals on the wire, so each must name something the batch holds.
    const mainCalls = transcripts[0]?.tools.length ?? 0;
    transcripts.forEach(({ prompts, tools }, index) => {
      tools.forEach(({ prompt, steps }, call) => {
        const callAt = `transcripts[${String(index)}].tools[${String(call)}]`;
        // Past the prompts it names a prompt with no record, numbered in order of appearance: no more of those than calls.
        if (prompt !== null && prompt >= prompts.length + tools.length) throw new Refused(`${callAt}.prompt`, 'no such prompt position');
        steps.forEach(({ parent }, position) => {
          if (parent !== null && parent >= mainCalls) throw new Refused(`${callAt}.steps[${String(position)}].parent`, 'no such call in the main run');
        });
      });
    });
    return { ok: true, skeleton: { format: SKELETON_FORMAT, id, transcripts, timingPrint, deltas } };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, field: error.field, reason: error.reason };
    throw error;
  }
};

/**
 * One count of a stack stratum (spec Section 4, rule 3), across every harness version, so it is never joined to one. The two pairs hold two values each, joined by a slash:
 * `languageShare` is `<language>/<share bucket>` and `repoFilesExplore` is `<repoFiles bucket>/<explore calls bucket>`.
 */
export interface StrataCell {
  dimension: 'language' | 'framework' | 'repoFiles' | 'languageShare' | 'repoFilesExplore';
  value: string;
  sessions: number;
  clusters: number;
}

/** One harness version's replica, as the server signs it. It names its harness, which the signature covers, so a bundle for one harness cannot stand in for another's. Nothing in it is keyed by stack. */
export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  harness: Harness;
  harnessVersion: string;
  vocabVersion: string;
  asOf: ReadAsOf;
  cells: Cell[];
  motifs: Motif[];
  reads: Read[];
  strata: StrataCell[];
}

/** The signature covers these exact bytes, so nothing has to be canonicalized on either side. */
export interface SignedBundle {
  payload: string;
  /** Ed25519 over the payload's UTF-8 bytes, in base64. */
  signature: string;
}

/** The public half of the pool's key, as a client pins it at login. */
export interface PinnedKey {
  kty: string;
  crv: string;
  x: string;
}

const isSignedBundle = (value: unknown): value is SignedBundle => isFields(value) && typeof value.payload === 'string' && typeof value.signature === 'string';

const isBundle = (value: unknown): value is Bundle =>
  isFields(value) && value.format === BUNDLE_FORMAT && typeof value.harness === 'string' && isHarness(value.harness) && typeof value.harnessVersion === 'string' && typeof value.vocabVersion === 'string' && isFields(value.asOf) && Array.isArray(value.cells) && Array.isArray(value.motifs) && Array.isArray(value.reads) && Array.isArray(value.strata);

const signatureHolds = async ({ payload, signature }: SignedBundle, key: PinnedKey): Promise<boolean> => {
  try {
    const verifier = await crypto.subtle.importKey('jwk', { kty: key.kty, crv: key.crv, x: key.x }, 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', verifier, Uint8Array.from(atob(signature), (char) => char.charCodeAt(0)), new TextEncoder().encode(payload));
  } catch {
    return false;
  }
};

/** The bundle, only when the pinned key signed these bytes for the harness and version that were asked for: another harness's or version's bundle, under a good signature, is still the wrong answer. */
export const verifyBundle = async (signed: unknown, key: PinnedKey, harness: Harness, harnessVersion: string): Promise<{ ok: true; bundle: Bundle } | { ok: false; reason: string }> => {
  if (!isSignedBundle(signed)) return { ok: false, reason: 'not a signed bundle' };
  if (!(await signatureHolds(signed, key))) return { ok: false, reason: 'the signature does not match the key pinned at login' };
  const bundle: unknown = JSON.parse(signed.payload);
  if (!isBundle(bundle)) return { ok: false, reason: 'not a signed bundle this version reads' };
  if (bundle.vocabVersion !== VOCAB_VERSION) return { ok: false, reason: `this bundle is for vocabulary version ${bundle.vocabVersion}, not ${VOCAB_VERSION}` };
  if (bundle.harness !== harness) return { ok: false, reason: `this bundle is for harness ${bundle.harness}, not ${harness}` };
  if (bundle.harnessVersion !== harnessVersion) return { ok: false, reason: `this bundle is for harness version ${bundle.harnessVersion}, not ${harnessVersion}` };
  return { ok: true, bundle };
};
