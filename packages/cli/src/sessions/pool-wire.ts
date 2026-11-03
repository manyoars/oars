// What crosses the wire between `oars pool` and the pool server (t758, recall spec Sections 2.5, 4, and 5). A skeleton is one session in closed vocabulary: the records a cell is
// computed from, with every class A field left out, so any later derivation can run over old data while nothing private leaves. The client builds a skeleton and checks it before
// sending, and the server parses it again, field by field, because a live URL takes anything from anyone. This file imports nothing from the file system: the Worker bundles it.

import { ACTION_TABLES, CANONICAL_ACTIONS, mcpOf, type CanonicalAction } from './actions.js';
import { FRAMEWORKS, isMcpToolName, isRegistryVersion, LANGUAGES, LITERAL, publicEffort, publicModel, publicVersion, PUBLIC_FLAGS, PUBLIC_HOSTS, PUBLIC_MCP_SERVERS, PUBLIC_PACKAGES, PUBLIC_PROGRAMS, PUBLIC_SKILLS, PUBLIC_SUBCOMMANDS, REPO_SIZES } from './public-vocabulary.js';
import type { Cell } from './cells.js';
import type { Motif } from './motif.js';
import type { Read, ReadAsOf } from './read.js';
import type { Frame, Harness, PromptClass, PromptObservation, PullIdentity, SessionObservation, StepEdge, StepIdentity, StepObservation, ToolObservation, ToolStatus, Usage } from './schema.js';

export const SKELETON_FORMAT = 1;
export const SLICE_FORMAT = 1;

/** A step without what a server can compute: `n` is its call's, and `frameId` hashes a frame the skeleton holds. */
export type SkeletonStep = Omit<StepObservation, 'n' | 'frameId'>;

export interface SkeletonTool {
  n: number;
  side: boolean;
  prompt: number | null;
  status: ToolStatus;
  durationMs: number | null;
  steps: SkeletonStep[];
}

export interface SkeletonPrompt {
  index: number;
  cls: PromptClass;
  errors: number;
  wallSec: number | null;
  usage: Usage;
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
}

/** One main session and the subagents it spawned, as the local store holds them. */
export interface SessionRecords {
  main: SessionObservation;
  transcripts: { session: SessionObservation; prompts: PromptObservation[]; tools: ToolObservation[] }[];
}

/** Every main session of a store, with its records. */
export const sessionsOf = (store: { sessions: readonly SessionObservation[]; subagents: readonly SessionObservation[]; prompts: readonly PromptObservation[]; tools: readonly ToolObservation[] }): SessionRecords[] => {
  const recordsOf = (session: SessionObservation): SessionRecords['transcripts'][number] => ({
    session,
    prompts: store.prompts.filter((prompt) => prompt.session === session.session),
    tools: store.tools.filter((tool) => tool.session === session.session),
  });
  return store.sessions.map((main) => ({ main, transcripts: [main, ...store.subagents.filter((subagent) => subagent.parent === main.session)].map(recordsOf) }));
};

const transcriptOf = ({ session, prompts, tools }: SessionRecords['transcripts'][number]): SkeletonTranscript | null => {
  if (session.frame === undefined) return null;
  const framedPrompts: SkeletonPrompt[] = [];
  for (const { index, cls, errors, wallSec, usage, frame } of prompts) {
    if (frame === undefined) return null;
    framedPrompts.push({ index, cls, errors, wallSec, usage, frame });
  }
  const steppedTools: SkeletonTool[] = [];
  for (const { n, side, prompt, status, durationMs, steps } of tools) {
    if (steps === undefined) return null;
    steppedTools.push({ n, side, prompt, status, durationMs, steps: steps.map(({ seg, action, native, identity, status: reported, cost, parent, edges }) => ({ seg, action, native, identity, status: reported, cost, parent, edges })) });
  }
  return { harness: session.harness ?? 'claude-code', frame: session.frame, prompts: framedPrompts, tools: steppedTools };
};

/** The skeleton of a session; null when any record of it was captured before steps and frames, which holds no closed reading to send. */
export const skeletonOf = (records: SessionRecords, id: string): SessionSkeleton | null => {
  const transcripts: SkeletonTranscript[] = [];
  for (const entry of records.transcripts) {
    const transcript = transcriptOf(entry);
    if (transcript === null) return null;
    transcripts.push(transcript);
  }
  return { format: SKELETON_FORMAT, id, transcripts };
};

/** The stacks a session counts under: every language and framework any of its frames names. */
export const stacksOf = (skeleton: SessionSkeleton): string[] => {
  const stacks = new Set<string>();
  for (const { frame, prompts } of skeleton.transcripts) {
    for (const { stack } of [frame, ...prompts.map((prompt) => prompt.frame)]) for (const name of [...stack.languages, ...stack.frameworks]) stacks.add(name);
  }
  return [...stacks].sort();
};

/** Whether a stack can be asked for: `all`, or a name the vocabulary holds. */
export const ALL_STACKS = 'all';
export const isStack = (name: string): boolean => name === ALL_STACKS || LANGUAGES.has(name) || FRAMEWORKS.has(name);

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

const countOf = (value: unknown, at: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Refused(at, 'not a count');
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

const HARNESSES = ['claude-code', 'cursor'] as const satisfies readonly Harness[];
const PROMPT_CLASSES = ['no-tools', 'orchestration', 'research', 'edit-verify', 'edit-only', 'explore-only', 'shell-only', 'mixed'] as const satisfies readonly PromptClass[];
const STATUSES = ['ok', 'error', 'none'] as const satisfies readonly ToolStatus[];
const EDGE_KINDS = ['next', 'spawned', 'retried', 'after-error'] as const satisfies readonly StepEdge['kind'][];
const PLATFORMS: ReadonlySet<string> = new Set(['aix', 'android', 'cygwin', 'darwin', 'freebsd', 'haiku', 'linux', 'netbsd', 'openbsd', 'sunos', 'win32']);
const SHELLS: ReadonlySet<string> = new Set(Object.values(ACTION_TABLES).flatMap((table) => Object.values(table.shells)));
const REGISTRIES = ['npm', 'pypi', 'crates', 'go', 'rubygems', 'homebrew', 'skill', 'plugin', 'mcp'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[0-9a-f]{16}$/;
const SHORT_FLAG = /^-[A-Za-z]$/;

const parseFrame = (value: unknown, at: string): Frame => {
  const raw = fieldsOf(value, at, ['harness', 'harnessVersion', 'model', 'effort', 'day', 'platform', 'shell', 'stack']);
  const stackAt = under(at, 'stack');
  const stack = fieldsOf(raw.stack, stackAt, ['languages', 'frameworks', 'size']);
  const day = orNull(raw.day, under(at, 'day'), (entry, entryAt) => {
    const text = textOf(entry, entryAt);
    if (!DAY.test(text)) throw new Refused(entryAt, 'not a UTC day');
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

const parseUsage = (value: unknown, at: string): Usage => {
  const raw = fieldsOf(value, at, ['input', 'cacheWrite', 'cacheRead', 'output', 'thinking']);
  return {
    input: countOf(raw.input, under(at, 'input')),
    cacheWrite: countOf(raw.cacheWrite, under(at, 'cacheWrite')),
    cacheRead: countOf(raw.cacheRead, under(at, 'cacheRead')),
    output: countOf(raw.output, under(at, 'output')),
    thinking: countOf(raw.thinking, under(at, 'thinking')),
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
  if (flag !== LITERAL && !PUBLIC_FLAGS.has(flag) && !SHORT_FLAG.test(flag)) throw new Refused(at, 'outside the vocabulary');
  return flag;
};

const parseIdentity = (action: CanonicalAction, value: unknown, at: string): StepIdentity => {
  if (value === null) return null;
  if (action === 'shell.exec') {
    const raw = fieldsOf(value, at, ['program', 'sub', 'flags'], ['pulls']);
    const program = inSet(PUBLIC_PROGRAMS, raw.program, under(at, 'program'));
    const subs = PUBLIC_SUBCOMMANDS.get(program) ?? new Set<string>();
    const sub = orNull(raw.sub, under(at, 'sub'), (entry, entryAt) => inSet(subs, entry, entryAt));
    const flags = listOf(raw.flags, under(at, 'flags'), parseFlag);
    return raw.pulls === undefined ? { program, sub, flags } : { program, sub, flags, pulls: listOf(raw.pulls, under(at, 'pulls'), parsePull) };
  }
  if (action === 'mcp.call') {
    const raw = fieldsOf(value, at, ['server', 'tool']);
    const tool = textOf(raw.tool, under(at, 'tool'));
    if (tool !== LITERAL && !isMcpToolName(tool)) throw new Refused(under(at, 'tool'), 'outside the vocabulary');
    return { server: inSet(PUBLIC_MCP_SERVERS, raw.server, under(at, 'server')), tool };
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
  if (mcp !== undefined && PUBLIC_MCP_SERVERS.has(mcp.server) && isMcpToolName(mcp.tool)) return native;
  throw new Refused(at, 'outside the vocabulary');
};

const parseEdge = (value: unknown, at: string): StepEdge => {
  const raw = fieldsOf(value, at, ['kind', 'n', 'seg']);
  return { kind: oneOf(EDGE_KINDS, raw.kind, under(at, 'kind')), n: countOf(raw.n, under(at, 'n')), seg: countOf(raw.seg, under(at, 'seg')) };
};

const parseStep = (harness: Harness, value: unknown, at: string): SkeletonStep => {
  const raw = fieldsOf(value, at, ['seg', 'action', 'native', 'identity', 'status', 'cost', 'parent', 'edges']);
  const costAt = under(at, 'cost');
  const cost = fieldsOf(raw.cost, costAt, ['tokens', 'durationMs']);
  const action = oneOf(CANONICAL_ACTIONS, raw.action, under(at, 'action'));
  return {
    seg: countOf(raw.seg, under(at, 'seg')),
    action,
    native: parseNative(harness, raw.native, under(at, 'native')),
    identity: parseIdentity(action, raw.identity, under(at, 'identity')),
    status: oneOf(STATUSES, raw.status, under(at, 'status')),
    cost: { tokens: orNull(cost.tokens, under(costAt, 'tokens'), countOf), durationMs: orNull(cost.durationMs, under(costAt, 'durationMs'), countOf) },
    parent: orNull(raw.parent, under(at, 'parent'), countOf),
    edges: listOf(raw.edges, under(at, 'edges'), parseEdge),
  };
};

const parseTool = (harness: Harness, value: unknown, at: string): SkeletonTool => {
  const raw = fieldsOf(value, at, ['n', 'side', 'prompt', 'status', 'durationMs', 'steps']);
  return {
    n: countOf(raw.n, under(at, 'n')),
    side: booleanOf(raw.side, under(at, 'side')),
    prompt: orNull(raw.prompt, under(at, 'prompt'), countOf),
    status: oneOf(STATUSES, raw.status, under(at, 'status')),
    durationMs: orNull(raw.durationMs, under(at, 'durationMs'), countOf),
    steps: listOf(raw.steps, under(at, 'steps'), (entry, entryAt) => parseStep(harness, entry, entryAt)),
  };
};

const parsePrompt = (value: unknown, at: string): SkeletonPrompt => {
  const raw = fieldsOf(value, at, ['index', 'cls', 'errors', 'wallSec', 'usage', 'frame']);
  return {
    index: countOf(raw.index, under(at, 'index')),
    cls: oneOf(PROMPT_CLASSES, raw.cls, under(at, 'cls')),
    errors: countOf(raw.errors, under(at, 'errors')),
    wallSec: orNull(raw.wallSec, under(at, 'wallSec'), countOf),
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
    const raw = fieldsOf(value, '', ['format', 'id', 'transcripts']);
    if (raw.format !== SKELETON_FORMAT) throw new Refused('format', 'not a format this version reads');
    const id = textOf(raw.id, 'id');
    if (!ID.test(id)) throw new Refused('id', 'not a hash');
    const transcripts = listOf(raw.transcripts, 'transcripts', parseTranscript);
    if (transcripts.length === 0) throw new Refused('transcripts', 'empty');
    return { ok: true, skeleton: { format: SKELETON_FORMAT, id, transcripts } };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, field: error.field, reason: error.reason };
    throw error;
  }
};

/** One stack's replica, as the server signs it. `capped` says an account with no deposit got part of it. */
export interface Slice {
  format: typeof SLICE_FORMAT;
  stack: string;
  capped: { limit: number; served: number } | null;
  asOf: ReadAsOf;
  cells: Cell[];
  motifs: Motif[];
  reads: Read[];
}

/** The signature covers these exact bytes, so nothing has to be canonicalized on either side. */
export interface SignedSlice {
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

const isSignedSlice = (value: unknown): value is SignedSlice => isFields(value) && typeof value.payload === 'string' && typeof value.signature === 'string';

const isSlice = (value: unknown): value is Slice =>
  isFields(value) && value.format === SLICE_FORMAT && typeof value.stack === 'string' && isFields(value.asOf) && Array.isArray(value.cells) && Array.isArray(value.motifs) && Array.isArray(value.reads) && (value.capped === null || isFields(value.capped));

const signatureHolds = async ({ payload, signature }: SignedSlice, key: PinnedKey): Promise<boolean> => {
  try {
    const verifier = await crypto.subtle.importKey('jwk', { kty: key.kty, crv: key.crv, x: key.x }, 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', verifier, Uint8Array.from(atob(signature), (char) => char.charCodeAt(0)), new TextEncoder().encode(payload));
  } catch {
    return false;
  }
};

/** The slice, only when the pinned key signed these bytes for the stack that was asked for: a replica of another stack, under a good signature, is still the wrong answer. */
export const verifySlice = async (signed: unknown, key: PinnedKey, stack: string): Promise<{ ok: true; slice: Slice } | { ok: false; reason: string }> => {
  if (!isSignedSlice(signed)) return { ok: false, reason: 'not a signed slice' };
  if (!(await signatureHolds(signed, key))) return { ok: false, reason: 'the signature does not match the key pinned at login' };
  const slice: unknown = JSON.parse(signed.payload);
  if (!isSlice(slice)) return { ok: false, reason: 'not a signed slice this version reads' };
  if (slice.stack !== stack) return { ok: false, reason: `this slice is for stack ${slice.stack}, not ${stack}` };
  return { ok: true, slice };
};
