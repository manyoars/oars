// What crosses the wire between `oars pool` and the pool server (t758, recall spec Sections 2.5, 4, and 5). A skeleton is one session in closed vocabulary: the records a cell is
// computed from, with every class A field left out, so any later derivation can run over old data while nothing private leaves. The client builds a skeleton and checks it before
// sending, and the server parses it again, field by field, because a live URL takes anything from anyone. This file imports nothing from the file system: the Worker bundles it.

import { ACTION_TABLES, CANONICAL_ACTIONS, mcpOf, type CanonicalAction } from './actions.js';
import { FRAMEWORKS, isPublicMcpTool, isRegistryVersion, LANGUAGES, LITERAL, PRIVATE, publicEffort, publicModel, publicVersion, PUBLIC_FLAGS, PUBLIC_HOSTS, PUBLIC_MCP_SERVERS, PUBLIC_PACKAGES, PUBLIC_PROGRAMS, PUBLIC_SKILLS, PUBLIC_SUBCOMMANDS, REPO_SIZES, VOCAB_VERSION } from './public-vocabulary.js';
import type { Cell } from './cells.js';
import type { Motif } from './motif.js';
import type { Read, ReadAsOf } from './read.js';
import type { Frame, Harness, PromptClass, PromptObservation, PullIdentity, SessionObservation, ShellIdentity, StepIdentity, StepObservation, ToolObservation, ToolStatus, Usage } from './schema.js';

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
} as const satisfies { [kind: string]: readonly number[] };

export type BucketKind = keyof typeof EDGES;

/** The bucket a value falls in. */
export const bucketOf = (kind: BucketKind, value: number): number => EDGES[kind].filter((edge) => value >= edge).length;

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

export interface SkeletonPrompt {
  cls: PromptClass;
  /** A `count` bucket. */
  errors: number;
  /** A `seconds` bucket. */
  wallSec: number | null;
  usage: SkeletonUsage;
  frame: Frame;
}

export interface SkeletonTranscript {
  harness: Harness;
  frame: Frame;
  prompts: SkeletonPrompt[];
  tools: SkeletonTool[];
}

export interface SessionSkeleton {
  format: typeof SKELETON_FORMAT;
  /** A hash the client computes per account, so a redeposit replaces and two accounts' sessions cannot be joined. Never the session's own id. */
  id: string;
  /** The main transcript first, then each subagent's. */
  transcripts: SkeletonTranscript[];
  /** The batch's client-built delta entries (Section 2, "Deltas"). Empty until the client builds them; a non-empty list is refused. */
  deltas: never[];
}

/** One main session and the subagents it spawned, as the local store holds them. */
export interface SessionRecords {
  main: SessionObservation;
  transcripts: { session: SessionObservation; prompts: PromptObservation[]; tools: ToolObservation[] }[];
}

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
export const sessionsOf = (store: { sessions: readonly SessionObservation[]; subagents: readonly SessionObservation[]; prompts: readonly PromptObservation[]; tools: readonly ToolObservation[] }): SessionRecords[] => {
  // Grouped once: a fleet's store holds thousands of sessions over hundreds of thousands of rows, and a scan per session would be quadratic.
  const prompts = groupBy(store.prompts, (prompt) => prompt.session);
  const tools = groupBy(store.tools, (tool) => tool.session);
  const subagents = groupBy(store.subagents, (subagent) => subagent.parent);
  const recordsOf = (session: SessionObservation): SessionRecords['transcripts'][number] => ({ session, prompts: prompts.get(session.session) ?? [], tools: tools.get(session.session) ?? [] });
  return store.sessions.map((main) => ({ main, transcripts: [main, ...(subagents.get(main.session) ?? [])].map(recordsOf) }));
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

/** A stored tool's steps with each shell step's identity replaced by the projected, wire-held command; the other steps keep theirs. The one place a deposit and a local read take it from. */
export const projectedSteps = (tool: ToolObservation, read: ShellReader): StepObservation[] => {
  const commands = read(tool);
  return (tool.steps ?? []).map((step, at) => {
    if (step.action !== 'shell.exec') return step;
    const command = wireCommand(commands[at] ?? { program: PRIVATE, subcommand: null, flags: [] });
    const pulls = step.identity !== null && 'program' in step.identity ? step.identity.pulls : undefined;
    return { ...step, identity: pulls === undefined ? command : { ...command, pulls } };
  });
};

/** A transcript's calls in the order they ran, which is the order a skeleton holds them in. */
const byCall = (tools: readonly ToolObservation[]): ToolObservation[] => [...tools].sort((a, b) => a.n - b.n);

const transcriptOf = ({ session, prompts, tools }: SessionRecords['transcripts'][number], spawners: ReadonlyMap<number, number> | null, read: ShellReader): SkeletonTranscript | null => {
  if (session.frame === undefined) return null;
  const framedPrompts: SkeletonPrompt[] = [];
  const promptAt = new Map<number, number>();
  for (const { index, cls, errors, wallSec, usage, frame } of [...prompts].sort((a, b) => a.index - b.index)) {
    if (frame === undefined) return null;
    promptAt.set(index, framedPrompts.length);
    framedPrompts.push({
      cls,
      errors: bucketOf('count', errors),
      wallSec: wallSec === null ? null : bucketOf('seconds', wallSec),
      usage: { input: bucketOf('tokens', usage.input), cacheWrite: bucketOf('tokens', usage.cacheWrite), cacheRead: bucketOf('tokens', usage.cacheRead), output: bucketOf('tokens', usage.output), thinking: bucketOf('tokens', usage.thinking) },
      frame,
    });
  }
  const steppedTools: SkeletonTool[] = [];
  let unrecorded = 0;
  for (const tool of byCall(tools)) {
    if (tool.steps === undefined) return null;
    const { side, prompt, status, durationMs } = tool;
    // A subagent's call names the prompt that spawned it, which its own transcript holds no record of: such a number takes the next position past the prompts, one per distinct number, so
    // the calls that shared a prompt still share one, and no position reads as a prompt.
    if (prompt !== null && !promptAt.has(prompt)) promptAt.set(prompt, framedPrompts.length + unrecorded++);
    const promptPosition = prompt === null ? null : (promptAt.get(prompt) ?? null);
    const steps = projectedSteps(tool, read).map(({ action, native, identity, status: reported, cost, parent }): SkeletonStep => ({
      action,
      native,
      identity,
      status: reported,
      tokens: cost.tokens === null ? null : bucketOf('tokens', cost.tokens),
      ms: cost.durationMs === null ? null : bucketOf('ms', cost.durationMs),
      parent: parent === null || spawners === null ? null : (spawners.get(parent) ?? null),
    }));
    steppedTools.push({ side, prompt: promptPosition, status, durationMs, steps });
  }
  return { harness: session.harness ?? 'claude-code', frame: session.frame, prompts: framedPrompts, tools: steppedTools };
};

/** The skeleton of a session; null when any record of it was captured before steps and frames, which holds no closed reading to send. */
export const skeletonOf = (records: SessionRecords, id: string, read: ShellReader): SessionSkeleton | null => {
  // A subagent's step names the call that spawned it by that call's `n` in the main run, which the skeleton holds as the call's position.
  const spawners = new Map(byCall(records.transcripts[0]?.tools ?? []).map(({ n }, position) => [n, position]));
  const transcripts: SkeletonTranscript[] = [];
  for (const entry of records.transcripts) {
    // Only a call of the main run has a position here: a step of a subagent a subagent spawned names a call of that other transcript, so it sends no link rather than a false one.
    const transcript = transcriptOf(entry, entry.session.spawnedIn === records.main.session ? spawners : null, read);
    if (transcript === null) return null;
    transcripts.push(transcript);
  }
  return { format: SKELETON_FORMAT, id, transcripts, deltas: [] };
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
  if (name !== LITERAL && !allowed.has(name)) throw new Refused(at, 'outside the vocabulary');
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
const HARNESSES = allHarnesses(['claude-code', 'cursor', 'codex', 'copilot', 'gemini', 'grok']);
const PROMPT_CLASSES = ['no-tools', 'orchestration', 'research', 'edit-verify', 'edit-only', 'explore-only', 'shell-only', 'mixed'] as const satisfies readonly PromptClass[];
const STATUSES = ['ok', 'error', 'none'] as const satisfies readonly ToolStatus[];
const PLATFORMS: ReadonlySet<string> = new Set(['aix', 'android', 'cygwin', 'darwin', 'freebsd', 'haiku', 'linux', 'netbsd', 'openbsd', 'sunos', 'win32']);
const SHELLS: ReadonlySet<string> = new Set(Object.values(ACTION_TABLES).flatMap((table) => Object.values(table.shells)));
const REGISTRIES = ['npm', 'pypi', 'crates', 'go', 'rubygems', 'homebrew', 'skill', 'plugin', 'mcp'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[0-9a-f]{16}$/;
/** A real date, not just its shape. `Date.parse` rolls 2026-02-31 over to March instead of failing, so the day must also survive the trip back to text. */
const isCalendarDay = (text: string): boolean => {
  if (!DAY.test(text)) return false;
  const parsed = Date.parse(text);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === text;
};

const parseFrame = (value: unknown, at: string): Frame => {
  const raw = fieldsOf(value, at, ['harness', 'harnessVersion', 'model', 'effort', 'day', 'platform', 'shell', 'stack']);
  const stackAt = under(at, 'stack');
  const stack = fieldsOf(raw.stack, stackAt, ['languages', 'frameworks', 'size']);
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
  const version = orNull(raw.version, under(at, 'version'), (entry, entryAt) => {
    const text = textOf(entry, entryAt);
    if (text !== LITERAL && !isRegistryVersion(text)) throw new Refused(entryAt, 'outside the vocabulary');
    return text;
  });
  return { registry: oneOf(REGISTRIES, raw.registry, under(at, 'registry')), name: inSet(PUBLIC_PACKAGES, raw.name, under(at, 'name')), version };
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
    // A program is a list member or `private`, and a `private` program holds no subcommand: the projection writes nothing else.
    const program = textOf(raw.program, under(at, 'program'));
    if (program !== PRIVATE && !PUBLIC_PROGRAMS.has(program)) throw new Refused(under(at, 'program'), 'outside the vocabulary');
    if (program === PRIVATE) {
      if (raw.flags !== undefined && !(Array.isArray(raw.flags) && raw.flags.length === 0)) throw new Refused(under(at, 'flags'), 'a private program holds no flags');
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

const parseNative = (harness: Harness, value: unknown, at: string): string => {
  const native = textOf(value, at);
  if (native === LITERAL) return native;
  const table = ACTION_TABLES[harness];
  if (Object.hasOwn(table.rows, native)) return native;
  const mcp = mcpOf(table, native);
  if (mcp !== undefined && table.toolDelimited && isPublicMcpTool(mcp.server, mcp.tool)) return native;
  throw new Refused(at, 'outside the vocabulary');
};

const parseStep = (harness: Harness, value: unknown, at: string): SkeletonStep => {
  const raw = fieldsOf(value, at, ['action', 'native', 'identity', 'status', 'tokens', 'ms', 'parent']);
  const action = oneOf(CANONICAL_ACTIONS, raw.action, under(at, 'action'));
  return {
    action,
    native: parseNative(harness, raw.native, under(at, 'native')),
    identity: parseIdentity(harness, action, raw.identity, under(at, 'identity')),
    status: oneOf(STATUSES, raw.status, under(at, 'status')),
    tokens: orNull(raw.tokens, under(at, 'tokens'), (entry, entryAt) => bucketIn('tokens', entry, entryAt)),
    ms: orNull(raw.ms, under(at, 'ms'), (entry, entryAt) => bucketIn('ms', entry, entryAt)),
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
  const raw = fieldsOf(value, at, ['cls', 'errors', 'wallSec', 'usage', 'frame']);
  return {
    cls: oneOf(PROMPT_CLASSES, raw.cls, under(at, 'cls')),
    errors: bucketIn('count', raw.errors, under(at, 'errors')),
    wallSec: orNull(raw.wallSec, under(at, 'wallSec'), (entry, entryAt) => bucketIn('seconds', entry, entryAt)),
    usage: parseUsage(raw.usage, under(at, 'usage')),
    frame: parseFrame(raw.frame, under(at, 'frame')),
  };
};

const parseTranscript = (value: unknown, at: string): SkeletonTranscript => {
  const raw = fieldsOf(value, at, ['harness', 'frame', 'prompts', 'tools']);
  const harness = oneOf(HARNESSES, raw.harness, under(at, 'harness'));
  return {
    harness,
    frame: parseFrame(raw.frame, under(at, 'frame')),
    prompts: listOf(raw.prompts, under(at, 'prompts'), parsePrompt),
    tools: listOf(raw.tools, under(at, 'tools'), (entry, entryAt) => parseTool(harness, entry, entryAt)),
  };
};

/** The skeleton in `value`, rebuilt from the fields read; else the first field that is not closed vocabulary, and why. */
export const parseSkeleton = (value: unknown): { ok: true; skeleton: SessionSkeleton } | Refusal => {
  try {
    // The first form sent exact usage; it is named here, since its fields would otherwise read as a list of strangers.
    if (isFields(value) && value.format === 1) throw new Refused('format', 'the exact-count form (format 1) is no longer read; send format 2');
    const raw = fieldsOf(value, '', ['format', 'id', 'transcripts', 'deltas']);
    if (raw.format !== SKELETON_FORMAT) throw new Refused('format', 'not a format this version reads');
    const id = textOf(raw.id, 'id');
    if (!ID.test(id)) throw new Refused('id', 'not a hash');
    if (!Array.isArray(raw.deltas) || raw.deltas.length > 0) throw new Refused('deltas', 'not empty: a delta entry is not read yet');
    const transcripts = listOf(raw.transcripts, 'transcripts', parseTranscript);
    if (transcripts.length === 0) throw new Refused('transcripts', 'empty');
    // A counting batch is what lifts the fetch cap, so a deposit has to hold something to derive from.
    if (transcripts.every(({ prompts, tools }) => prompts.length === 0 && tools.length === 0)) throw new Refused('transcripts', 'holds no prompt and no tool');
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
    return { ok: true, skeleton: { format: SKELETON_FORMAT, id, transcripts, deltas: [] } };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, field: error.field, reason: error.reason };
    throw error;
  }
};

/** One count of a stack stratum (spec Section 4, rule 3), across every harness version, so it is never joined to one. */
export interface StrataCell {
  dimension: 'language' | 'framework' | 'repoFiles';
  value: string;
  sessions: number;
  clusters: number;
}

/** One harness version's replica, as the server signs it. Nothing in it is keyed by stack. */
export interface Bundle {
  format: typeof BUNDLE_FORMAT;
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
  isFields(value) && value.format === BUNDLE_FORMAT && typeof value.harnessVersion === 'string' && typeof value.vocabVersion === 'string' && isFields(value.asOf) && Array.isArray(value.cells) && Array.isArray(value.motifs) && Array.isArray(value.reads) && Array.isArray(value.strata);

const signatureHolds = async ({ payload, signature }: SignedBundle, key: PinnedKey): Promise<boolean> => {
  try {
    const verifier = await crypto.subtle.importKey('jwk', { kty: key.kty, crv: key.crv, x: key.x }, 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', verifier, Uint8Array.from(atob(signature), (char) => char.charCodeAt(0)), new TextEncoder().encode(payload));
  } catch {
    return false;
  }
};

/** The bundle, only when the pinned key signed these bytes for the version that was asked for: another version's bundle, under a good signature, is still the wrong answer. */
export const verifyBundle = async (signed: unknown, key: PinnedKey, harnessVersion: string): Promise<{ ok: true; bundle: Bundle } | { ok: false; reason: string }> => {
  if (!isSignedBundle(signed)) return { ok: false, reason: 'not a signed bundle' };
  if (!(await signatureHolds(signed, key))) return { ok: false, reason: 'the signature does not match the key pinned at login' };
  const bundle: unknown = JSON.parse(signed.payload);
  if (!isBundle(bundle)) return { ok: false, reason: 'not a signed bundle this version reads' };
  if (bundle.vocabVersion !== VOCAB_VERSION) return { ok: false, reason: `this bundle is for vocabulary version ${bundle.vocabVersion}, not ${VOCAB_VERSION}` };
  if (bundle.harnessVersion !== harnessVersion) return { ok: false, reason: `this bundle is for harness version ${bundle.harnessVersion}, not ${harnessVersion}` };
  return { ok: true, bundle };
};
