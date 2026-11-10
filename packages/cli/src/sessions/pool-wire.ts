// What crosses the wire between `oars pool` and the pool server (recall spec Sections 2.5, 4, and 5). A skeleton is one session as a closed list of fields, each value redacted first: the records a cell is
// computed from, with every class A field left out, so any later derivation can run over old data while nothing private leaves. The client builds a skeleton and checks it before
// sending, and the server parses it again, field by field, because a live URL takes anything from anyone. This file imports nothing from the file system: the Worker bundles it.

import { ACTION_TABLES, CANONICAL_ACTIONS, mcpOf, type CanonicalAction } from './actions.js';
import { CLOSED_ARG_VALUES, CUSTOM_AGENT, FRAMEWORKS, isPublicMcpTool, isRegistryVersion, LANGUAGES, LITERAL, PRIVATE, publicEffort, publicVersion, PUBLIC_PACKAGES, projectedAgentType, PUBLIC_FLAGS, REPO_SIZES, TOOL_INPUT_KEYS, VOCAB_VERSION, type RepoSize } from './public-vocabulary.js';
import { ARG_CLASSES, CHANGE_KINDS, DIFF_SHAPES, DIRECTORY_KINDS, EXTENSION_CLASSES, NAME_KINDS, PATH_DEPTHS, PATTERN_FEATURES, TARGET_CLASSES, TEMPLATE_SLOTS, VALUE_SIZES, type ArgClass, type ArgFeature, type ArgName, type ArgValue, type ChangeKind, type DiffShape, type DirectoryKind, type ExtensionClass, type NameKind, type PathDepth, type PatternFeature, type TargetClass, type ValueSize } from './call-shape.js';
import type { Cell } from './cells.js';
import type { Redactor } from './redact.js';
import type { Motif } from './motif.js';
import type { Recall } from './recall-object.js';
import type { Read, ReadAsOf } from './read.js';
import { recoveryCallsOf, RECOVERY_CALLS, type RecoveryCalls } from './recovery-calls.js';
import { projectLanguage, projectLanguageShare } from './strata.js';
import { ERROR_CODES, LANGUAGE_SHARES, type EditDigest, PROMPT_INTERVENTIONS, type PromptIntervention, type Frame, type FrameStack, type Harness, type LanguageShare, type PromptClass, type PromptObservation, type PullIdentity, type SessionObservation, type ShellIdentity, type StepIdentity, type StepEdge, type StepObservation, type Strata, type ToolObservation, type ToolStatus, type Usage, type UsageField } from './schema.js';

// Format 3 (step 1 of the wire): a tool carries its `errorCode` and, for a failed call, what followed it (`recoveryCalls`). Formats 1 and 2 are refused by name; nothing is deployed, so nothing is migrated.
// Format 4 (layer 1 of a call's parameters): a tool may carry `argFeatures`, `argValues`, and `changeKind`. The pool reads formats 3 and 4 (`READ_FORMATS`): a format 3 batch is read as before, and one of those
// three names in it is a field format 3 does not know, so it goes to the bag and is served from nowhere. The table is "Formats on open" in docs/pool.md.
// Format 5 (layer 2 of a call's parameters): a tool may carry `names`, the file, directory, and variable names its values held. The pool reads formats 3, 4, and 5, and a name field in a batch of an older format goes to the bag the same way.
// Format 6 (exposure): a batch may carry `recommendations`, one entry for each recommendation the session was shown or held back from, so the pool can tell shown from held. A batch with none says nothing, and the pool reads that as unknown, never as unexposed.
// Format 7 (edit digests): a tool may carry `digests`, the digest of the old and new text of an Edit, MultiEdit, or Write call, so an edit that restores earlier content can be told from one that does not. A `git restore` names its path the way an edit
// does, in `names`, so it needs no field of its own. The pool reads formats 3 to 7, and a recommendations or digests list in an older batch goes to the bag the same way.
export const SKELETON_FORMAT = 7;
/** The formats the parser reads, oldest first: the client builds only the last. */
export const READ_FORMATS = [3, 4, 5, 6, SKELETON_FORMAT] as const;
export type SkeletonFormat = (typeof READ_FORMATS)[number];
/** The tool fields format 4 added: a format 3 batch that holds one is holding a field it does not define. */
export const FORMAT_4_TOOL_FIELDS = ['argFeatures', 'argValues', 'changeKind'] as const;
/** The tool fields format 5 added: a batch of format 4 or 3 that holds one is holding a field it does not define. */
export const FORMAT_5_TOOL_FIELDS = ['names', 'namesDropped', 'templates', 'templatesDropped', 'diffShape'] as const;
/** The batch fields format 6 added: a batch of an older format that holds one is holding a field it does not define. */
export const FORMAT_6_BATCH_FIELDS = ['recommendations'] as const;
/** The format that added exposure. A batch of an older format holds no `recommendations`, and its failed calls are checked with the rule they were built under. */
export const EXPOSURE_FORMAT = 6;
/** The format that added edit digests. */
export const DIGEST_FORMAT = 7;
/** The tool fields format 7 added: a batch of format 6 or older that holds one is holding a field it does not define. */
export const FORMAT_7_TOOL_FIELDS = ['digests'] as const;
/**
 * The version of the field list: every field name a batch can hold (`BATCH_FIELDS` in `pool-outbox.ts`). It moves with any field added, so a server told the version knows which names a batch may carry,
 * and a test pins the list to it (`pool-wire-additive.test.ts`). A field is deprecated and left on the list, never removed (conclusion section 17, rule 3).
 */
export const FIELD_LIST_VERSION = 14;
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

/** The closed list of how a step came about (`schema.ts` `StepEdge`). */
export const EDGE_KINDS = ['next', 'spawned', 'retried', 'after-error'] as const satisfies readonly StepEdge['kind'][];

/** One edge arriving at a step: its kind, and the position of the step it names, counted over the steps of one transcript in call order (the batch's own ordinal, never a call number). A `spawned` edge names a step of the spawning transcript. */
export interface SkeletonEdge {
  /** `other` for a kind the reader does not know (see `OTHER`); it names no step the parser can check, so only its shape is held. */
  kind: StepEdge['kind'] | typeof OTHER;
  target: number;
}

/**
 * A step without what a server can compute: `n` is its call's position, `seg` its place in the call (the array position), and `frameId` hashes a frame the skeleton holds. Its cost is
 * two buckets, never the exact counts. `parent` is the position of the spawning call in the `tools` of the transcript its transcript's `spawnedIn` names (Section 1.2's `parent` ordinal).
 */
export type SkeletonStep = Omit<StepObservation, 'n' | 'seg' | 'frameId' | 'cost' | 'edges' | 'status'> & {
  /** The edges that arrive at this step, `retried` already decided by the client (the pool holds no raw key to compare); absent when none arrive. */
  edges?: SkeletonEdge[];
  /** `other` for a status the reader does not know (see `OTHER`). */
  status: ToolStatus | typeof OTHER;
  /** A `tokens` bucket of the step's tokens. */
  tokens: number | null;
  /** An `ms` bucket of the step's time. */
  ms: number | null;
  /** True when `tokens` was divided among the calls of one response, not measured for this step; absent otherwise. */
  allocated?: true;
  /** A `tokens` bucket of the tokens the run spent after this step (spec Section 1.2): the bucket of the exact sum, never a sum of buckets, summed over the later steps that reported tokens (a lower bound). Null when steps follow and none reported tokens; 0 only when nothing follows or the later steps reported zero. */
  remainingTokens: number | null;
  /** The projected type of the subagent whose run holds the step, a built-in or `custom`; null on a main-run step. */
  agentType: string | null;
  /** The step's frame: a position in its transcript's `frames`, the frame of the call that made it, with that call's own model and harness version (t867). The parser refuses a position outside the list. */
  frame: number;
  /** The skill whose run the step's call sits in, the name after redaction or `private`; absent outside a run. The harness marks no end to a run but stops naming the skill on the next line, and a step carries the skill its call's line named. */
  skill?: string;
};

/** A call's order is its position in `tools`, and its `prompt` is a position in the same transcript's `prompts`: ordinals inside the batch, never the session's own numbers. */
export interface SkeletonTool {
  side: boolean;
  prompt: number | null;
  status: ToolStatus | typeof OTHER;
  /** Exact, per tool: the one exact time on the wire, which W reads on `ledger` (Section 1.2, `durationMs`). A cell never reads it. */
  durationMs: number | null;
  /** The failed call's class, a member of `ERROR_CODES` (a user refusal, a policy denial, and a real failure are three codes); null on a call that did not fail and on one whose capture holds none. Never result text. */
  errorCode: string | null;
  /** For a failed call, what followed it: the actions of up to the next 5 calls of its prompt and whether an edit was among them. Absent on a call that did not fail. Never a signature, command, or text. */
  recoveryCalls?: RecoveryCalls;
  /** The call's input key names, sorted (t870): a public tool's from its pinned list in `TOOL_INPUT_KEYS`, any other tool's from the name gate, and none for a tool that went as `private`. Never a value. Absent when none is sent. */
  keys?: string[];
  /** A `count` bucket of the key names the call held that were not sent: off a public tool's pinned list, or kept `private` by the gate. Absent when none was dropped. */
  keysDropped?: number;
  /** The class of the call's path target, derived at capture from the target's base and suffix (`targetClassOf`): the base name itself does not go. Absent on a call captured before it. */
  targetClass?: TargetClass | typeof OTHER;
  /** The classes of the call's arguments as a sorted set, derived at capture (`argClassOf`); never a value. Absent on a call captured before it. */
  argClass?: Array<ArgClass | typeof OTHER>;
  /** Each sent key's value features (layer 1), sorted by key: closed-list members only, never the value. Only a key in `keys` has one. Absent when none is sent. */
  argFeatures?: SkeletonArgFeature[];
  /** Each sent key's closed value (layer 1): a boolean as `true` or `false`, or a member of its tool's list in `CLOSED_ARG_VALUES`. Only a key in `keys` has one. Absent when none is sent. */
  argValues?: SkeletonArgValue[];
  /** What changed from the previous call of the same tool in the same prompt (layer 1), a sorted set of `CHANGE_KINDS` members. Absent on the first such call and on a call captured before it. */
  changeKind?: Array<ChangeKind | typeof OTHER>;
  /** The name tokens of the call's values (layer 2), sorted by kind and name: file, directory, and variable names, flag values that are names, a custom agent's name. Each passed the one gate (`wireName`); never a value. Absent when none is sent. */
  names?: SkeletonArgName[];
  /** A `count` bucket of the name tokens the call held that were not sent: one the redactor changes, an exclusion term matches, or that has no name shape. Absent when none was dropped; never the names. */
  namesDropped?: number;
  /** The old and new text of an Edit (one pair), a MultiEdit (one pair per edit, in order), or a Write (a new digest only), each a digest of the exact text, plain so the same text matches across sessions. Never the text. Absent on any other call. */
  digests?: SkeletonDigest[];
  /** One template per shell command of the call (layer 3), in the order the commands run: its program, subcommand, and flags, and every literal argument as a slot of `TEMPLATE_SLOTS`. Each kept word passed the one gate (`wireName`, `wireFlag`); never an argument. Absent when none is sent. */
  templates?: string[];
  /** A `count` bucket of the templates the call held that were not sent: one with a kept word the redactor changes, an exclusion term matches, or that has no name shape. Absent when none was dropped; never the templates. */
  templatesDropped?: number;
  /** What an edit did (layer 3), a sorted set of `DIFF_SHAPES` members: the shape of the change and never its text. Absent for a call that is no edit and for one that changed nothing. */
  diffShape?: Array<DiffShape | typeof OTHER>;
  steps: SkeletonStep[];
}

/** One edit's digests: the first 32 hex digits of the SHA-256 of the exact UTF-8 text. A Write has `new` alone, never the digest of an empty string for `old`. */
export interface SkeletonDigest {
  old?: string;
  new: string;
}

/** One sent key's value features as the wire holds them: each a closed-list member, or `other` for one this reader does not know. */
export interface SkeletonArgFeature {
  key: string;
  valueSize: ValueSize | typeof OTHER;
  pathDepth?: PathDepth | typeof OTHER;
  extension?: ExtensionClass | typeof OTHER;
  dirKind?: DirectoryKind | typeof OTHER;
  patternFeatures?: Array<PatternFeature | typeof OTHER>;
}

/** One name token as the wire holds it: its kind from the closed list (`other` for one this reader does not know) and the name as sent, which has the shape of a name (`other` when it has none). */
export interface SkeletonArgName {
  kind: NameKind | typeof OTHER;
  name: string;
}

/** One sent key's closed value as the wire holds it, or `other` for one off the list this reader holds. */
export interface SkeletonArgValue {
  key: string;
  enumValue: string;
}

/**
 * A prompt's usage as `tokens` buckets: `thinking` is a token count (the thinking tokens of the output), so it takes the same edges as the rest. A category the source
 * never recorded is null, never the bucket of zero: a prompt with no counts at all sends five nulls, and a partial total sends a number only for the categories it observed.
 */
export type SkeletonUsage = { [field in keyof Usage]: number | null };

/** A language of the stack with its share of the touched files (spec Section 7): one of four buckets, never a count. */
export interface LanguageShareEntry {
  language: string;
  languageShare: LanguageShare | typeof OTHER;
}

/**
 * The MCP servers, skills, and plugins in reach of a session, each the name after redaction or `private` (a plugin has no pinned list, so it is always `private`). `filled` says whether the harness recorded a
 * `setup` or a `funnel` at all: an unfilled reach lists nothing and must not be read as a session with no tools.
 */
export interface Reach {
  filled: boolean;
  mcp: string[];
  skills: string[];
  plugins: string[];
}

/** How many people the operator's organization has (an operator's setting, read locally, never looked up). */
export const ORG_SIZES = ['solo', '2-10', '11-100', '101-1000', 'over-1000', 'unknown'] as const;
export type OrgSize = (typeof ORG_SIZES)[number];
/** Whether the repository's local git log shows one commit author or several (distinct authors, counted and then dropped). */
export const TEAMS = ['solo', 'team', 'unknown'] as const;
export type Team = (typeof TEAMS)[number];
/** Whether the repository is public or private (an operator's setting, read locally, never looked up). */
export const REPO_VISIBILITIES = ['public', 'private', 'unknown'] as const;
export type RepoVisibility = (typeof REPO_VISIBILITIES)[number];

/** Where a session ran, as a trusted machine states it for a batch it admitted: the five host classes an enrollment knows (`HOST_CLASSES` in `machine.ts`, not imported: the pool bundles this file). */
export const CLAIMED_HOST_CLASSES = ['local', 'vps', 'cloud', 'ci', 'hosted'] as const;
export type ClaimedHostClass = (typeof CLAIMED_HOST_CLASSES)[number];
/** What started the session, as an enrollment declares it. */
export const CLAIMED_LAUNCHERS = ['interactive', 'orchestrated', 'scheduled', 'ci', 'hosted-run', 'unknown'] as const;
export type ClaimedLauncher = (typeof CLAIMED_LAUNCHERS)[number];

/** The host class and launcher the trusted machine states for a batch a cloud VM held: a claim of the depositor's own machine, never a fact the pool stamped. `other` is a value this reader does not know. */
export interface Claimed {
  hostClass: ClaimedHostClass | typeof OTHER;
  launcher: ClaimedLauncher | typeof OTHER;
}

/** What the pool can state about whom a deposit covers. It is not a filter: no read uses it. Anything not read locally is `unknown`. */
export interface Coverage {
  orgSize: OrgSize;
  team: Team;
  repoVisibility: RepoVisibility;
}

export const NO_COVERAGE: Coverage = { orgSize: 'unknown', team: 'unknown', repoVisibility: 'unknown' };

/** A repo key is the store-salted hash a session record holds of its repository's identity: sixteen lowercase hex characters. */
const REPO_KEY = /^[0-9a-f]{16}$/;

/** The UTC hour of day, 0 to 23, of a timestamp, whatever offset it was written in; null when there is none or it does not parse. */
export const hourOf = (ts: string | null | undefined): number | null => {
  if (ts === null || ts === undefined || ts === '') return null;
  const millis = Date.parse(ts);
  return Number.isNaN(millis) ? null : new Date(millis).getUTCHours();
};

/**
 * The frame a skeleton holds: the stored frame, with the stack's shares beside its languages. A language whose share is not known is in `languages` and has no entry here. `reach`, `repoKey`, and the coverage bands
 * are on the transcript's frame and the frames of its list, not on a prompt's. `hour` is the UTC hour beside `day` and joins no cell. Every one is optional: an absent field was not sent.
 */
export type SkeletonFrame = Omit<Frame, 'stack' | 'harness'> & { harness: WireHarness; stack: Omit<FrameStack, 'size'> & { size: RepoSize | typeof OTHER | null; languageShares: LanguageShareEntry[] }; reach?: Reach; repoKey?: string; orgSize?: OrgSize | typeof OTHER; team?: Team | typeof OTHER; repoVisibility?: RepoVisibility | typeof OTHER; hour?: number };

export interface SkeletonPrompt {
  cls: PromptClass | typeof OTHER;
  /** A `count` bucket. */
  errors: number;
  /** A `seconds` bucket. */
  wallSec: number | null;
  usage: SkeletonUsage;
  /** A `calls` bucket of the prompt's steps that only look (`file.read`, `file.search`, `web.search`, `web.fetch`); null when the record holds no count. */
  explore: number | null;
  /** A `count` bucket of the responses that reported usage: what a partial `usage` sum covers. Absent only when the record predates the coverage (capture version 20). */
  usageResponses?: number;
  /** Whether a human stepped in after this prompt's work and how, one of the closed list (t882; docs/sessions-store.md "Prompt intervention"). Absent when the stored prompt predates the signal: absent means not computed, `unknown` means computed and not sayable. An outcome row, never a grade. */
  intervention?: PromptIntervention | typeof OTHER;
  frame: SkeletonFrame;
}

export interface SkeletonTranscript {
  /** The transcript's Merkle root and the count of its lines it covers (Section 2, "Subagents"): one pair for each transcript, the main's first. */
  merkleRoot: string;
  leaves: number;
  harness: WireHarness;
  frame: SkeletonFrame;
  /** The distinct frames the transcript's steps ran in, the transcript's own first; a step's `frame` is a position in it. */
  frames: SkeletonFrame[];
  /** The position, in the batch's `transcripts`, of the transcript that spawned this one; null for the main run, and for a subagent whose spawner the batch does not hold or the harness does not name. */
  spawnedIn: number | null;
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
  deltaKind: DeltaKind | typeof OTHER;
  field: DeltaField | typeof OTHER;
  name: string | null;
  registry: string | null;
  metric: DeltaMetric | typeof OTHER;
  change: number;
}

/** Whether a recommendation reached the asker (`shown`) or was withheld by the holdback (`held`). The local row's arm, as the closed list holds it. */
export const RECOMMENDATION_ARMS = ['shown', 'held'] as const;
export type RecommendationArm = (typeof RECOMMENDATION_ARMS)[number];

/**
 * One recommendation of the session as the local row holds it: its `id`, the `arm` it was drawn into, the `poolVersion` it answered from, and the window of calls it covers, `from` up to but not including `to`, as positions in the
 * main run's calls that are not sidechain (the line the local consequence window reads). It holds no text, query, or evidence. `other` is an arm this reader does not know.
 */
export interface SkeletonRecommendation {
  id: string;
  arm: RecommendationArm | typeof OTHER;
  poolVersion: string;
  from: number;
  to: number;
}

export interface SessionSkeleton {
  format: SkeletonFormat;
  /** The vocabulary version the client built the batch under: stored with it, so a read can tell a batch of an older list from a current one. */
  vocabVersion: string;
  /** `FIELD_LIST_VERSION` as the client held it: the fields a batch of this version may carry. */
  fieldsVersion: number;
  /** A hash the client computes per account, so a redeposit replaces and two accounts' sessions cannot be joined. Never the session's own id. */
  id: string;
  /** The main transcript first, then each subagent's. */
  transcripts: SkeletonTranscript[];
  /** One for the batch: a hash of the main transcript's non-null call durations in call order, only with `MIN_TIMED_CALLS` of them; a subagent's calls never join it. */
  timingPrint: string | null;
  /** Only on a batch a trusted machine admitted from a held branch: the machine writes it from its own enrollment record, never the client that built the batch. */
  claimed?: Claimed;
  /** The batch's client-built delta entries (Section 2, "Deltas"): changes between the client's own before and after windows, each carried once, by the batch of the session that filled the after window. */
  deltas: DeltaEntry[];
  /** The recommendations the main session was shown or held back from (format 6), in window order. Absent when it had none, and a pool reads absent as unknown exposure, never as unexposed. */
  recommendations?: SkeletonRecommendation[];
}

/** A usage category's `tokens` bucket, or null when the record says the source never recorded it. A record that predates `usageObserved` reads every category as observed. */
const observedBucket = (value: number, observed: readonly UsageField[] | undefined, field: UsageField): number | null => (observed === undefined || observed.includes(field) ? bucketOf('tokens', value) : null);

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

/** No session leaves this machine sooner than this after it ends, whatever `session_idle_hours` is: time for `oars sessions deposit --deny` or a delete to act on it first. Today the longer idle window governs; this is the floor under it. */
export const HOLD_WINDOW_MS = HOUR_MS;

/**
 * Whether a session's batch may be built at `now`: no transcript of it, main or subagent, has gained a line for `SESSION_IDLE_HOURS`. A transcript gains a line when capture sees it change, which
 * stamps a new `rev` in epoch milliseconds, but a transcript can grow after the last capture, so `written` (the newest write to any raw file of the session, 0 when none is known) counts too: the
 * session was last active at the later of the two. A subagent that died without an end marker holds its session back at most that long.
 */
export const hasEnded = (records: SessionRecords, now: number, written: number, idleMs: number = SESSION_IDLE_HOURS * HOUR_MS): boolean => now - Math.max(written, ...records.transcripts.map(({ session }) => session.rev)) >= Math.max(idleMs, HOLD_WINDOW_MS);

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

/** One command of a shell call as the projection reads it (`projectStoredShell`): a program, its subcommand, and its flags, each the name after redaction or `private`. */
export interface ShellCommand {
  program: string;
  subcommand: string | null;
  flags: readonly string[];
}

/** Reads a stored shell call's commands in order. The client passes the projection; this file holds no vocabulary snapshot, so the Worker can bundle it. */
export type ShellReader = (tool: ToolObservation) => readonly ShellCommand[];


/** The most characters a name may hold on the wire. A longer value is not a name: it counts as redacted. */
export const NAME_MAX = 128;
// A name is a word: letters, digits, and a few joiners, with an optional leading `@` for a scope. A mis-parsed command line, a path, an email, or a quoted string fails it. A `/` is not a joiner here: a name holding one is a path (`src/acme/plan.md`).
const WIRE_NAME = /^@?[A-Za-z0-9_][A-Za-z0-9_.+-]*(?::[A-Za-z0-9_.+-]+)*$/;
// A pull's package `name` is the one place a `/` belongs: a scope (`@scope/pkg`) or a Go module path (`golang.org/x/tools`).
const WIRE_PULL_NAME = /^@?[A-Za-z0-9_][A-Za-z0-9_.+-]*(?:[/:][A-Za-z0-9_.+-]+)*$/;

/** Whether a value has the shape of a name (and so can be told from a command line, a path, or an email) and is within `NAME_MAX`. */
export const isWireName = (name: string): boolean => name.length <= NAME_MAX && WIRE_NAME.test(name);

/** The shape of a pull's package name: a name, or a scope or module path with `/` in it. */
export const isWirePullName = (name: string): boolean => name.length <= NAME_MAX && WIRE_PULL_NAME.test(name);

/** What the client holds against a value before it leaves: the redactor, and the exclusion terms the operator keeps. This is the one gate; the pool assigns every other class. */
export interface WireGate {
  readonly redact: Redactor;
  readonly terms: readonly string[];
}

/** No redaction and no terms: the name shape and the length limit still apply. A local read, which sends nothing, uses it. */
export const OPEN_GATE: WireGate = { redact: (text) => text, terms: [] };

/** The redactor leaves the name and each of its underscore-delimited parts as they are: `_` is a word character to it, so a host inside `mcp__git.acme.internal__run` is invisible to a pass over the whole name. */
const unchanged = (gate: WireGate, name: string): boolean => gate.redact(name) === name && name.split(/_+/).every((part) => gate.redact(part) === part);

/** Whether a name clears the one gate: it has the name shape, the redactor leaves it as it is, and it holds none of the exclusion terms. A name token that is really the word `private` passes; only this says a name was refused. */
const passesGate = (gate: WireGate, name: string, hasShape: (name: string) => boolean): boolean => {
  const lower = name.toLowerCase();
  return hasShape(name) && unchanged(gate, name) && !gate.terms.some((term) => term !== '' && lower.includes(term.toLowerCase()));
};

/**
 * A name as the wire holds it: the value itself, or `private` when it counts as redacted. A value counts as redacted when the redactor changes it, it holds an exclusion term, it fails the name shape, or it is over
 * `NAME_MAX` characters, because a secret, an employer's name, or a mis-parsed command is not a name and nothing downstream can take it back. `keys` (t870) sends its names through this same function.
 */
export const wireName = (gate: WireGate, name: string, hasShape: (name: string) => boolean = isWireName): string => (passesGate(gate, name, hasShape) ? name : PRIVATE);

const FLAG_DASHES = /^-{1,2}/;
const SHORT_FLAG = /^-[A-Za-z]$/;
// The long form has its own shape, with no `:` (the joiner `WIRE_NAME` allows for `scope:name`), because `--password:hunter2` is a value joined to its flag and no part of it is a name.
const LONG_FLAG = /^--[A-Za-z0-9][A-Za-z0-9_.+-]*$/;
/**
 * The shape of a flag name: a long flag (two dashes, then a name with no `:`) or a short one (one dash, one letter), or a single-dash token longer than one letter only when the public flag list holds it (`-NoProfile`, `-Command`). A value joined to its flag
 * fails it: `--token=abc`, `--password:hunter2`, and a short flag with its value attached (`-psecret123`, `-uuser:pass`), which no list holds.
 */
const isWireFlag = (flag: string): boolean => SHORT_FLAG.test(flag) || PUBLIC_FLAGS.has(flag) || (flag.length <= NAME_MAX && LONG_FLAG.test(flag));

/** A multi-letter single-dash flag no public list holds (`go test -race`, `-psecret123`): the client before t900 dropped it, so this one does too, and an old and a new client key one motif for one command. */
const isDroppedFlag = (flag: string): boolean => flag.length > 2 && flag.startsWith('-') && !flag.startsWith('--') && !PUBLIC_FLAGS.has(flag);

/** A flag name as the wire holds it: the name after the one gate, or `private` when it counts as redacted. Only the name is ever read, never a value. */
const wireFlag = (gate: WireGate, flag: string): string => (isWireFlag(flag) && wireName(gate, flag.replace(FLAG_DASHES, '')) !== PRIVATE ? flag : PRIVATE);

/**
 * A call's key names as the wire holds them (t870): names only, never a value. A public tool (one with a pinned input list) sends the names on its list and counts the rest; any other tool sends a name only when it passes the
 * name gate, and a tool that went as `private` sends none, so a private tool's keys name no private work. `dropped` counts the distinct names not sent.
 */
export const wireKeys = (stored: readonly string[], native: string | undefined, gate: WireGate): { keys: string[]; dropped: number } => {
  const distinct = [...new Set(stored)];
  const listed = native === undefined ? undefined : TOOL_INPUT_KEYS.get(native);
  const kept = native === undefined || native === PRIVATE ? [] : distinct.filter((name) => (listed === undefined ? wireName(gate, name) !== PRIVATE : listed.has(name)));
  return { keys: kept.sort(), dropped: distinct.length - kept.length };
};

/** A stored closed-list member, else dropped: a hand-edited record never puts a value off the list on the wire. */
const memberOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((entry) => entry === value);

/** Whether a closed value is one the wire may carry for a tool's key: a boolean's two words, or a member of the tool's list. */
export const isClosedValue = (native: string | undefined, key: string, value: string): boolean => value === 'true' || value === 'false' || (native !== undefined && CLOSED_ARG_VALUES.get(native)?.get(key)?.has(value) === true);

/**
 * A call's value features as the wire sends them (layer 1): only a sent key's, and only closed-list members, so a hand-edited record never puts a value on the wire. An entry whose size is off its list is dropped whole, a
 * path or pattern field off its list is left out, and a pattern holding no listed feature sends none.
 */
export const wireFeatures = (stored: readonly ArgFeature[] | undefined, sent: ReadonlySet<string>): ArgFeature[] =>
  (stored ?? []).flatMap((feature): ArgFeature[] => {
    const valueSize = memberOf(VALUE_SIZES, feature.valueSize);
    if (!sent.has(feature.key) || valueSize === undefined) return [];
    const pathDepth = memberOf(PATH_DEPTHS, feature.pathDepth);
    const extension = memberOf(EXTENSION_CLASSES, feature.extension);
    const dirKind = memberOf(DIRECTORY_KINDS, feature.dirKind);
    const patternFeatures = PATTERN_FEATURES.filter((entry) => feature.patternFeatures?.includes(entry) === true);
    return [{ key: feature.key, valueSize, ...(pathDepth === undefined ? {} : { pathDepth }), ...(extension === undefined ? {} : { extension }), ...(dirKind === undefined ? {} : { dirKind }), ...(patternFeatures.length === 0 ? {} : { patternFeatures }) }];
  });

/** A call's closed values as the wire sends them (layer 1): only a sent key's, and only a value `isClosedValue` admits. */
export const wireValues = (stored: readonly ArgValue[] | undefined, sent: ReadonlySet<string>, native: string | undefined): ArgValue[] =>
  (stored ?? []).filter(({ key, enumValue }) => sent.has(key) && isClosedValue(native, key, enumValue)).map(({ key, enumValue }) => ({ key, enumValue }));

/** A call's change kinds as the wire sends them: the closed-list members, in the list's order. */
export const wireChange = (stored: readonly ChangeKind[] | undefined): ChangeKind[] => CHANGE_KINDS.filter((kind) => stored?.includes(kind) === true);

/** A call's diff shapes as the wire sends them: the closed-list members, in the list's order. */
export const wireDiffShape = (stored: readonly DiffShape[] | undefined): DiffShape[] => DIFF_SHAPES.filter((shape) => stored?.includes(shape) === true);

/**
 * A call's name tokens as the wire sends them (layer 2): every stored token whose kind is on the closed list, through the one gate (`wireName`): a token the operator's exclusion terms or the redactor's secret shapes match, or that has no name shape,
 * is dropped and counted in `dropped`. No floor, no threshold: a name is sent as it is.
 */
export const wireNames = (stored: readonly ArgName[] | undefined, gate: WireGate): { names: ArgName[]; dropped: number } => {
  const known = (stored ?? []).filter(({ kind }) => NAME_KINDS.includes(kind));
  const names = known.filter(({ name }) => passesGate(gate, name, isWireName));
  return { names, dropped: known.length - names.length };
};

/** A digest as capture writes it: the first 32 hex digits of a SHA-256, lowercase. */
const DIGEST = /^[0-9a-f]{32}$/;

/** A call's edit digests as the wire sends them: a pair whose digest is not that shape is dropped whole, so a corrupt store row costs the pair and never the deposit. */
export const wireDigests = (stored: readonly EditDigest[] | undefined): SkeletonDigest[] =>
  (stored ?? []).filter((pair) => DIGEST.test(pair.new) && (pair.old === undefined || DIGEST.test(pair.old))).map((pair) => (pair.old === undefined ? { new: pair.new } : { old: pair.old, new: pair.new }));
const TEMPLATE_SLOT_LIST: readonly string[] = TEMPLATE_SLOTS;
/**
 * Whether every word of a template is one the wire may carry: a slot of `TEMPLATE_SLOTS`, the `--` marker, a flag with a slot joined to it, a flag, or a name (the program or subcommand), the last two as the caller judges them. A template is a single line of words
 * set apart by one space, since no name or flag holds a space.
 */
const templateHolds = (template: string, name: (word: string) => boolean, flag: (word: string) => boolean): boolean =>
  template.split(' ').every((word) => {
    if (TEMPLATE_SLOT_LIST.includes(word) || word === '--') return true;
    if (!word.startsWith('-')) return name(word);
    const joined = word.indexOf('=');
    return joined < 0 ? flag(word) : flag(word.slice(0, joined)) && TEMPLATE_SLOT_LIST.includes(word.slice(joined + 1));
  });

/** Whether a received template has the shape the wire sends: the pool's check, which holds no operator terms and no redactor. */
export const isWireTemplate = (template: string): boolean => templateHolds(template, isWireName, isWireFlag);

/**
 * A call's command templates as the wire sends them (layer 3): every stored template whose kept words (program, subcommand, flags) all clear the one gate, as a name or a flag does. A template with a word the redactor changes, an exclusion term matches, or that
 * has no name shape is dropped whole and counted in `dropped`. No floor, no threshold: a template is sent as it is, and a literal is only ever a slot.
 */
export const wireTemplates = (stored: readonly string[] | undefined, gate: WireGate): { templates: string[]; dropped: number } => {
  const known = stored ?? [];
  const templates = known.filter((template) =>
    templateHolds(
      template,
      (word) => wireName(gate, word) !== PRIVATE,
      (flag) => wireFlag(gate, flag) !== PRIVATE,
    ),
  );
  return { templates, dropped: known.length - templates.length };
};

/** The basename of a program as capture read it: a path never goes on the wire. */
const basenameOf = (program: string): string => program.replace(/^.*[\\/]/, '');

/**
 * A projected command as the server's parser reads it: the program as its basename after the gate (the stored identity reads `<literal>` for a program off the curated list, so the name comes from the call's segments),
 * and the subcommand and flag names the reader gives, each through the same gate and never a flag value. Which of them the reader holds for a program is capture's; the wire adds no list of its own.
 */
const wireCommand = ({ program, subcommand, flags }: ShellCommand, raw: string | undefined, gate: WireGate): ShellIdentity => {
  const named = program !== PRIVATE ? program : raw;
  if (named === undefined) return { program: PRIVATE, sub: null, flags: [] };
  const sent = wireName(gate, basenameOf(named));
  // A private program holds no subcommand or flag: the parser refuses one that does.
  if (sent === PRIVATE) return { program: PRIVATE, sub: null, flags: [] };
  return { program: sent, sub: subcommand === null ? null : wireName(gate, subcommand), flags: flags.filter((flag) => !isDroppedFlag(flag)).map((flag) => wireFlag(gate, flag)) };
};

/** A pull in the wire's spelling: its package name after the gate. A version beside a name that is not on the public list could identify it, so it goes as `<literal>` (null stays null), the rule capture applies. */
const wirePull = (pull: PullIdentity, gate: WireGate): PullIdentity => {
  const name = wireName(gate, pull.name, isWirePullName);
  return { ...pull, name, version: !PUBLIC_PACKAGES.has(name) && pull.version !== null ? LITERAL : pull.version };
};

/** A non-shell step's identity in the wire's spelling; a shell step's comes from `wireCommand`. `raw` is the harness's own tool name, class A, which an MCP call's masked identity is read back from. */
const wireIdentity = (identity: StepIdentity, harness: Harness, raw: string, gate: WireGate): StepIdentity => {
  if (identity === null || 'program' in identity) return identity;
  if ('server' in identity) {
    const table = ACTION_TABLES[harness];
    const parsed = mcpOf(table, raw);
    const server = wireName(gate, identity.server === LITERAL ? (parsed?.server ?? LITERAL) : identity.server);
    // A tool beside a masked server has no server to belong to, and a harness that does not delimit the server cannot split the tool from it: both go as the literal.
    const name = identity.tool === LITERAL ? parsed?.tool : identity.tool;
    const tool = server === PRIVATE || !table.toolDelimited || name === undefined ? PRIVATE : wireName(gate, name);
    return { server, tool: tool === PRIVATE ? LITERAL : tool };
  }
  if ('skill' in identity) return { skill: wireName(gate, identity.skill) };
  return { host: identity.host === null ? null : wireName(gate, identity.host) };
};

/**
 * A stored tool's steps as the wire holds them: each shell step's identity is replaced by the projected command, and every long-tail name (a native name, MCP server, skill, host, program, or pull name) is
 * sent as it is after the gate, or `private` when it counts as redacted. A `private` program holds no pull. The one place a deposit and a local read take it from.
 */
export const projectedSteps = (tool: ToolObservation, read: ShellReader, harness: Harness, gate: WireGate = OPEN_GATE): StepObservation[] => {
  const commands = read(tool);
  const steps = tool.steps ?? [];
  // `segments` pair with the steps when their counts agree (`projectLiteralStep`): segment `at` is step `at`, and its `run` starts with the program's basename.
  const segments = tool.segments?.length === steps.length ? tool.segments : undefined;
  return steps.map((step, at) => {
    const native = admittedNative(harness, step.native) ? step.native : wireName(gate, step.native === LITERAL ? tool.tool : step.native);
    if (step.action !== 'shell.exec') return { ...step, native, identity: wireIdentity(step.identity, harness, tool.tool, gate) };
    const command = wireCommand(commands[at] ?? { program: PRIVATE, subcommand: null, flags: [] }, segments?.[at]?.run.split(' ')[0], gate);
    const pulls = step.identity !== null && 'program' in step.identity ? step.identity.pulls : undefined;
    return { ...step, native, identity: pulls === undefined || command.program === PRIVATE ? command : { ...command, pulls: pulls.map((pull) => wirePull(pull, gate)) } };
  });
};

/** A failed call's stored `errorCode` as the wire holds it: a member of the closed list, else `other`; null for a call that did not fail and for one captured without a code (the wire does not guess one). */
const wireErrorCode = ({ status, errorCode }: ToolObservation): string | null => (status !== 'error' || errorCode === undefined ? null : ERROR_CODES.has(errorCode) ? errorCode : 'other');

/** A transcript's calls in the order they ran, which is the order a skeleton holds them in. */
const byCall = (tools: readonly ToolObservation[]): ToolObservation[] => [...tools].sort((a, b) => a.n - b.n);

/** Where a transcript's calls and steps sit on the wire: a call's position by its number, and a step's position over the transcript's steps in call order by `<call number>/<segment>`. */
interface Places {
  calls: ReadonlyMap<number, number>;
  steps: ReadonlyMap<string, number>;
}

const placesOf = (tools: readonly ToolObservation[]): Places => {
  const calls = new Map<number, number>();
  const steps = new Map<string, number>();
  for (const [position, { n, steps: held }] of byCall(tools).entries()) {
    calls.set(n, position);
    for (const step of held ?? []) steps.set(`${String(n)}/${String(step.seg)}`, steps.size);
  }
  return { calls, steps };
};

/** The step of a call that carries the runs it spawned: its first spawn step, else its first step. A call with no step carries none. */
const carrier = (steps: readonly { action: string }[]): number => Math.max(0, steps.findIndex(({ action }) => action === 'agent.spawn'));

/** What a run does about the subagent runs its calls spawned: the exact tokens each call's runs spent, by the call's position in the main run. Empty for a subagent's run. */
type Spawned = ReadonlyMap<number, number>;

/**
 * A model or harness version string as the wire holds it: the string after the gate (`wireName`), null staying null. The pool assigns its class. Capture's closed value (`<literal>`) goes as it is, the form a client before
 * t900 sent, so an old and a new client key one closed frame to one pool cell; the parser accepts it.
 */
const wireString = (gate: WireGate, value: string | null): string | null => (value === null || value === LITERAL ? value : wireName(gate, value));

/**
 * A stored frame with the UTC hour of `ts` beside its day, and its stack's language shares: each stored share is read through its projection, so a share outside the list is dropped and its language stays in `languages`. A stored
 * language outside the pinned list is `other`, and `other` holds the first share a record gives it. A record captured before the strata holds none.
 */
const wireFrame = (frame: Frame, strata: Strata | undefined, gate: WireGate, ts: string | null | undefined): SkeletonFrame => {
  const shares = new Map<string, LanguageShare>();
  for (const { language, share } of strata?.languages ?? []) {
    const held = projectLanguageShare(share);
    const name = projectLanguage(language);
    if (held !== null && !shares.has(name)) shares.set(name, held);
  }
  const hour = hourOf(ts);
  return { ...frame, harnessVersion: wireString(gate, frame.harnessVersion), model: wireString(gate, frame.model), stack: { ...frame.stack, languageShares: [...shares].map(([language, languageShare]) => ({ language, languageShare })) }, ...(hour === null ? {} : { hour }) };
};

/** Each of `names` after the gate (a name that counts as redacted reads `private`), sorted. */
const listedAll = (gate: WireGate, names: Iterable<string>): string[] => [...new Set(names)].map((name) => wireName(gate, name)).sort();

/**
 * The reach a session's record shows (t867): the servers of the tools its `funnel` offered or loaded and of the MCP tools it called, the skills it called, and the plugins its `setup` names. A record
 * with neither `setup` nor `funnel` is unfilled (a harness that records none, or a capture before version 12) and lists nothing, so the absence is not read as no tools.
 */
const reachOf = (session: SessionObservation, tools: readonly ToolObservation[], harness: Harness, gate: WireGate): Reach => {
  if (session.setup === undefined && session.funnel === undefined) return { filled: false, mcp: [], skills: [], plugins: [] };
  const table = ACTION_TABLES[harness];
  const servers = new Set<string>();
  const skills = new Set<string>();
  for (const name of [...(session.funnel?.offered ?? []), ...(session.funnel?.loaded ?? [])]) {
    const server = mcpOf(table, name)?.server;
    if (server !== undefined) servers.add(server);
  }
  for (const { steps, skill } of tools) {
    if (skill !== undefined) skills.add(skill);
    for (const { identity } of steps ?? []) {
      if (identity !== null && 'server' in identity) servers.add(identity.server);
      if (identity !== null && 'skill' in identity) skills.add(identity.skill);
    }
  }
  return { filled: true, mcp: listedAll(gate, servers), skills: listedAll(gate, skills), plugins: (session.setup?.plugins ?? []).map(() => PRIVATE) };
};

const transcriptOf = (
  { session, prompts, tools, root }: SessionRecords['transcripts'][number],
  spawner: { index: number; places: Places } | null,
  spawned: Spawned,
  agentType: string | null,
  read: ShellReader,
  gate: WireGate,
  coverage: Coverage,
): SkeletonTranscript | null => {
  if (session.frame === undefined || root === null) return null;
  const harness = session.harness ?? 'claude-code';
  const framedPrompts: SkeletonPrompt[] = [];
  const promptAt = new Map<number, number>();
  for (const { index, cls, errors, wallSec, usage, usageObserved, usageResponses, frame, strata, ts, intervention } of [...prompts].sort((a, b) => a.index - b.index)) {
    if (frame === undefined) return null;
    promptAt.set(index, framedPrompts.length);
    framedPrompts.push({
      cls,
      errors: bucketOf('count', errors),
      wallSec: wallSec === null ? null : bucketOf('seconds', wallSec),
      usage: {
        input: observedBucket(usage.input, usageObserved, 'input'),
        cacheWrite: observedBucket(usage.cacheWrite, usageObserved, 'cacheWrite'),
        cacheRead: observedBucket(usage.cacheRead, usageObserved, 'cacheRead'),
        output: observedBucket(usage.output, usageObserved, 'output'),
        thinking: observedBucket(usage.thinking, usageObserved, 'thinking'),
      },
      explore: projectExplore(strata?.explore),
      ...(usageResponses === undefined ? {} : { usageResponses: bucketOf('count', usageResponses) }),
      ...(intervention === undefined ? {} : { intervention }),
      frame: wireFrame(frame, strata, gate, ts),
    });
  }
  // The frames the steps ran in: the transcript's own first, then one for each distinct (prompt frame, call model, call harness version) a call shows, so a model that changes in the middle of a prompt
  // reaches the steps that ran on it. A call that recorded neither takes its prompt's frame, or the transcript's before the first prompt.
  const reach = reachOf(session, tools, harness, gate);
  // The repo key and the bands describe the session, not a prompt, so they sit where the reach does. A session in no repository sends no key, and so does one whose record holds anything but a key's shape: the emitter is the privacy control.
  const where = { reach, ...(session.repo !== null && REPO_KEY.test(session.repo) ? { repoKey: session.repo } : {}), ...coverage };
  const transcriptFrame: SkeletonFrame = { ...wireFrame(session.frame, session.strata, gate, session.tsFirst), ...where };
  const frames: SkeletonFrame[] = [transcriptFrame];
  const frameAtKey = new Map<string, number>([[JSON.stringify(transcriptFrame), 0]]);
  const frameOfCall = ({ model, harnessVersion }: ToolObservation, promptPosition: number | null): number => {
    const base = promptPosition === null ? undefined : framedPrompts[promptPosition]?.frame;
    const held: SkeletonFrame = {
      ...(base ?? transcriptFrame),
      ...(model === undefined ? {} : { model: wireString(gate, model) }),
      ...(harnessVersion === null ? {} : { harnessVersion: wireString(gate, harnessVersion) }),
      ...where,
    };
    const key = JSON.stringify(held);
    const found = frameAtKey.get(key);
    if (found !== undefined) return found;
    frames.push(held);
    frameAtKey.set(key, frames.length - 1);
    return frames.length - 1;
  };
  const steppedTools: SkeletonTool[] = [];
  const own = placesOf(tools);
  // The exact tokens of every step, by call and step, which the `remainingTokens` buckets below are computed from: a bucket of a sum is not a sum of buckets.
  const exact: Array<Array<number | null>> = [];
  let unrecorded = 0;
  const ordered = byCall(tools);
  for (const [at, tool] of ordered.entries()) {
    if (tool.steps === undefined) return null;
    const { side, prompt, status, durationMs } = tool;
    const errorCode = wireErrorCode(tool);
    const recoveryCalls = recoveryCallsOf(ordered, at);
    // A subagent's call names the prompt that spawned it, which its own transcript holds no record of: such a number takes the next position past the prompts, one per distinct number, so
    // the calls that shared a prompt still share one, and no position reads as a prompt.
    if (prompt !== null && !promptAt.has(prompt)) promptAt.set(prompt, framedPrompts.length + unrecorded++);
    const promptPosition = prompt === null ? null : (promptAt.get(prompt) ?? null);
    const projected = projectedSteps(tool, read, harness, gate);
    exact.push(projected.map(({ cost }) => cost.tokens));
    const frame = frameOfCall(tool, promptPosition);
    const steps = projected.map(({ action, native, identity, status: reported, cost, parent, edges }): SkeletonStep => {
      // An edge names a step by its position in the transcript it sits in; a `spawned` edge sits in the spawner, and one with no spawner in the batch goes unsent, since it names nothing here.
      const arriving = edges.flatMap(({ kind, n: from, seg: fromSeg }): SkeletonEdge[] => {
        const target = (kind === 'spawned' ? spawner?.places : own)?.steps.get(`${String(from)}/${String(fromSeg)}`);
        return target === undefined ? [] : [{ kind, target }];
      });
      return {
      action,
      native,
      identity,
      status: reported,
      tokens: cost.tokens === null ? null : bucketOf('tokens', cost.tokens),
      ms: cost.durationMs === null ? null : bucketOf('ms', cost.durationMs),
      ...(cost.allocated === true ? { allocated: true as const } : {}),
      remainingTokens: 0,
      agentType,
      parent: parent === null || spawner === null ? null : (spawner.places.calls.get(parent) ?? null),
      frame,
      ...(arriving.length === 0 ? {} : { edges: arriving }),
      ...(tool.skill === undefined ? {} : { skill: wireName(gate, tool.skill) }),
      };
    });
    const { keys, dropped } = wireKeys(tool.keys, steps[0]?.native, gate);
    const targetClass = memberOf(TARGET_CLASSES, tool.targetClass);
    const stored = tool.argClass;
    const argClass = stored === undefined ? undefined : ARG_CLASSES.filter((kind) => stored.includes(kind));
    const sent = new Set(keys);
    const argFeatures = wireFeatures(tool.argFeatures, sent);
    const argValues = wireValues(tool.argValues, sent, steps[0]?.native);
    const changeKind = wireChange(tool.changeKind);
    const { names, dropped: namesDropped } = wireNames(tool.names, gate);
    const digests = wireDigests(tool.digests);
    const { templates, dropped: templatesDropped } = wireTemplates(tool.templates, gate);
    const diffShape = wireDiffShape(tool.diffShape);
    steppedTools.push({
      side,
      prompt: promptPosition,
      status,
      durationMs,
      errorCode,
      ...(recoveryCalls === null ? {} : { recoveryCalls }),
      ...(keys.length === 0 ? {} : { keys }),
      ...(dropped === 0 ? {} : { keysDropped: bucketOf('count', dropped) }),
      ...(targetClass === undefined ? {} : { targetClass }),
      ...(argClass === undefined ? {} : { argClass: argClass.sort() }),
      ...(argFeatures.length === 0 ? {} : { argFeatures }),
      ...(argValues.length === 0 ? {} : { argValues }),
      ...(changeKind.length === 0 ? {} : { changeKind }),
      ...(names.length === 0 ? {} : { names }),
      ...(namesDropped === 0 ? {} : { namesDropped: bucketOf('count', namesDropped) }),
      ...(digests.length === 0 ? {} : { digests }),
      ...(templates.length === 0 ? {} : { templates }),
      ...(templatesDropped === 0 ? {} : { templatesDropped: bucketOf('count', templatesDropped) }),
      ...(diffShape.length === 0 ? {} : { diffShape }),
      steps,
    });
  }
  // A step's remaining tokens are those of the steps after it in its own run; a main-run step also counts the subagent runs its later steps spawned (a run belongs to the spawning call's carrier step).
  // `later` sums the steps that reported tokens; `laterKnown` is how many did, so a run whose later steps all reported nothing stays null instead of reading as zero.
  let later = 0;
  let laterSteps = 0;
  let laterKnown = 0;
  for (let call = steppedTools.length - 1; call >= 0; call -= 1) {
    const steps = steppedTools[call]?.steps ?? [];
    const held = carrier(steps);
    for (let at = steps.length - 1; at >= 0; at -= 1) {
      const step = steps[at];
      if (step === undefined) continue;
      step.remainingTokens = laterSteps > 0 && laterKnown === 0 ? null : bucketOf('tokens', later);
      const own = exact[call]?.[at] ?? null;
      const spawnedTokens = at === held ? (spawned.get(call) ?? 0) : 0;
      later += (own ?? 0) + spawnedTokens;
      laterSteps += 1;
      if (own !== null || spawnedTokens > 0) laterKnown += 1;
    }
  }
  return { merkleRoot: root.merkleRoot, leaves: root.leaves, harness, frame: transcriptFrame, frames, spawnedIn: spawner?.index ?? null, prompts: framedPrompts, tools: steppedTools };
};

/**
 * The recommendations of one session, from the local rows after `deriveConsequences` has given each its window. Only a row that showed or withheld something is carried: a miss recommended nothing, so it is neither shown nor held, and
 * a row with no window has no calls to place. They go in window order, then by id, so one store builds one batch.
 */
export const recommendationsOf = (recalls: readonly Recall[], session: string): SkeletonRecommendation[] =>
  recalls
    .flatMap(({ sid, id, arm, poolVersion, answer, consequence }) => (sid === session && answer.kind === 'hit' && consequence !== undefined ? [{ id, arm, poolVersion, from: consequence.window.from, to: consequence.window.to }] : []))
    .sort((a, b) => a.from - b.from || a.to - b.to || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** The hash a batch's timing print is made with, over the durations in call order: the client's `contentHash` (D1's `hP`). */
export type Print = (durations: readonly number[]) => string;

/**
 * The skeleton of a session; null when any record of it was captured before steps and frames, or a transcript of it has no root, which holds no closed reading to send. The batch holds the main
 * transcript's run first, then each subagent's as its own run; its `id` is the main session's, and its one `timingPrint` is over the main transcript's calls alone.
 */
export const skeletonOf = (records: SessionRecords, id: string, read: ShellReader, print: Print, deltas: readonly DeltaEntry[] = [], gate: WireGate = OPEN_GATE, coverage: Coverage = NO_COVERAGE, recommendations: readonly SkeletonRecommendation[] = []): SessionSkeleton | null => {
  const mainTools = byCall(records.transcripts[0]?.tools ?? []);
  const places = records.transcripts.map(({ tools }) => placesOf(tools));
  const spawners = places[0]?.calls ?? new Map<number, number>();
  // A subagent's step names the call that spawned it by that call's `n` in the transcript its session record names as `spawnedIn`, which the skeleton holds as a position in the batch: that transcript's, and the call's within it.
  // A record that names none the batch holds, or itself, or lies on a cycle of spawners, sends no link; one whose spawner sits on a cycle it is not on keeps its link.
  const spawnerOf = records.transcripts.map(({ session }, index): number | null => {
    const at = index === 0 || session.spawnedIn === null ? -1 : records.transcripts.findIndex((held) => held.session.session === session.spawnedIn);
    return at === -1 ? null : at;
  });
  const cyclic = (index: number): boolean => {
    let at: number | null = spawnerOf[index] ?? null;
    for (let hop = 0; hop < spawnerOf.length && at !== null && at !== index; hop += 1) at = spawnerOf[at] ?? null;
    return at === index;
  };
  // The exact tokens of the runs each main-run call spawned. A run a subagent spawned names a call of that other transcript, so it joins no main-run step.
  const spawned = new Map<number, number>();
  for (const [index, entry] of records.transcripts.entries()) {
    if (spawnerOf[index] !== 0) continue;
    for (const tool of entry.tools) {
      for (const { cost, parent } of tool.steps ?? []) {
        const position = parent === null ? undefined : spawners.get(parent);
        if (position !== undefined) spawned.set(position, (spawned.get(position) ?? 0) + (cost.tokens ?? 0));
      }
    }
  }
  const transcripts: SkeletonTranscript[] = [];
  for (const [index, entry] of records.transcripts.entries()) {
    const at = spawnerOf[index] ?? null;
    const spawnerPlaces = at === null || cyclic(index) ? undefined : places[at];
    const transcript = transcriptOf(entry, at === null || spawnerPlaces === undefined ? null : { index: at, places: spawnerPlaces }, index === 0 ? spawned : new Map(), index === 0 ? null : projectedAgentType(entry.session.agentType ?? CUSTOM_AGENT), read, gate, coverage);
    if (transcript === null) return null;
    transcripts.push(transcript);
  }
  const durations = mainTools.flatMap(({ durationMs }) => (durationMs === null ? [] : [durationMs]));
  return { format: SKELETON_FORMAT, vocabVersion: VOCAB_VERSION, fieldsVersion: FIELD_LIST_VERSION, id, transcripts, timingPrint: durations.length < MIN_TIMED_CALLS ? null : print(durations), deltas: [...deltas], ...(recommendations.length === 0 ? {} : { recommendations: recommendations.map((entry) => ({ ...entry })) }) };
};

/**
 * The version bucket of a session that recorded none: Cursor, Gemini, and Grok Build keep no harness version in their local files, and neither does a VS Code Copilot Chat session whose requests carry no `agent.extensionVersion`, so their cells are
 * `<harness>/unknown/<model>`. It is the one non-numeric word a bundle can be asked for, so those harnesses are served the cells they have.
 */
export const UNKNOWN_VERSION = 'unknown';

/** A harness version a bundle can be asked for: public, so the request carries nothing private, or `unknown` for a harness with none on record. The admitted list replaces this shape rule when it ships. */
export const isBundleVersion = (version: string): boolean => version === UNKNOWN_VERSION || (version !== LITERAL && publicVersion(version) === version);

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

/** The value a reader gives an enumerated field whose value it does not know (conclusion section 17, rule 3). */
export const OTHER = 'other';

/** The harness of a transcript or a frame: one the schema names, or `other` for one a newer client names. */
export type WireHarness = Harness | typeof OTHER;

/**
 * What one parse sets aside: a field the reader does not know, a value it does not know, and a literal a client sent beside `other`. The bag is the stored form of these (the `extensions` column), the fields kept as sent and
 * read by nothing that serves: no cell, read, or bundle is derived from it. `at` is the field's path, as a refusal names it.
 */
export interface Extension {
  at: string;
  kind: 'field' | 'value' | 'literal';
  value: unknown;
}

interface Collected {
  extensions: Extension[];
  others: number;
  /** The batch's format, read first, so a field a later format added is read only in a batch of that format. */
  format: SkeletonFormat;
}

/** The one way into the bag: an entry over `MAX_EXTENSION_BYTES` (as JSON, in UTF-8) is refused as too large at its path, whatever kind it is and whatever the deposit's own cap is. */
const bagged = (held: Collected, entry: Extension): void => {
  if (new TextEncoder().encode(JSON.stringify(entry.value)).length > MAX_EXTENSION_BYTES) throw new Refused(entry.at, 'too large');
  held.extensions.push(entry);
};

/**
 * A value no vocabulary of this reader holds: counted, kept as sent in the bag, and read as `other`. The bag is the stored form of what the reader does not serve; the client's projection is the gate on what it
 * sends (lead 194), so the pool keeps the value and serves nothing from it.
 */
const unknownValue = (held: Collected, at: string, sent: string): typeof OTHER => {
  held.others += 1;
  bagged(held, { at, kind: 'value', value: sent });
  return OTHER;
};

/** The fields a client may send a literal beside (`<field>Literal`) when the field itself says `other`: the enumerated fields, whose values a closed list holds. */
export const ENUMERATED_FIELDS: ReadonlySet<string> = new Set(['harness', 'harnessVersion', 'model', 'effort', 'platform', 'shell', 'size', 'languages', 'frameworks', 'language', 'languageShare', 'cls', 'status', 'action', 'native', 'agentType', 'program', 'sub', 'flags', 'registry', 'name', 'version', 'server', 'tool', 'skill', 'host', 'deltaKind', 'field', 'metric', 'intervention']);
/**
 * The fields that may be absent at formats 3, 4, and 5 (a format 4 batch reads `OPTIONAL.tool` less `FORMAT_5_TOOL_FIELDS`, and a format 3 batch also less `FORMAT_4_TOOL_FIELDS`), by the level of the batch that holds them. An absent one reads as null, or as empty for a list, exactly as a sent null does, so a batch with all of them left out is
 * served from what remains. A field the cells need to be sound (a harness, a status, a bucket of tokens) is never here.
 */
export const OPTIONAL = {
  batch: ['timingPrint', 'deltas', 'claimed', 'recommendations'],
  frame: ['harnessVersion', 'model', 'effort', 'day', 'shell', 'reach', 'repoKey', 'orgSize', 'team', 'repoVisibility', 'hour'],
  stack: ['size', 'languageShares'],
  prompt: ['wallSec', 'explore', 'usageResponses', 'intervention'],
  tool: ['prompt', 'durationMs', 'errorCode', 'recoveryCalls', 'keys', 'keysDropped', 'targetClass', 'argClass', 'argFeatures', 'argValues', 'changeKind', 'names', 'namesDropped', 'templates', 'templatesDropped', 'diffShape', 'digests'],
  step: ['tokens', 'ms', 'allocated', 'parent', 'skill', 'edges', 'remainingTokens'],
  transcript: ['spawnedIn'],
} as const satisfies { readonly [level: string]: readonly string[] };

/** The fields of a value feature that only a path or a pattern holds: absent, never null, since a feature of another kind of value has no such field. */
const FEATURE_OPTIONAL = ['pathDepth', 'extension', 'dirKind', 'patternFeatures'] as const;

/** The most bytes (as JSON) one field this reader does not know, or one literal, may hold: an enumerated value or a literal never needs more, and a newer client's larger structure belongs in a new format version. The deposit's own cap is no part of this. */
export const MAX_EXTENSION_BYTES = 8 * 1024;

const LITERAL_SUFFIX = 'Literal';
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * The object at `at`, holding every field of `known` and, of the rest, any of `optional`. A name that is neither is not refused: it goes to the bag as it came (rule 3), so a newer client loses nothing
 * against this reader. The emitter is what keeps a class A field out of a batch, not this check. A shape error still refuses: a name that is no field name, a missing field, a literal that is not text.
 */
const fieldsOf = (held: Collected, value: unknown, at: string, known: readonly string[], optional: readonly string[] = []): Fields => {
  if (!isFields(value)) throw new Refused(at === '' ? 'skeleton' : at, 'not an object');
  for (const key of known) if (!Object.hasOwn(value, key)) throw new Refused(under(at, key), 'missing');
  for (const key of Object.keys(value)) {
    if (known.includes(key) || optional.includes(key)) continue;
    if (!FIELD_NAME.test(key)) throw new Refused(under(at, key), 'not a field name');
    const entry = value[key];
    const stem = key.endsWith(LITERAL_SUFFIX) ? key.slice(0, -LITERAL_SUFFIX.length) : undefined;
    // A literal sits beside an `other` and nowhere else; beside a value this reader knows it is a field it does not know.
    const literal = stem !== undefined && ENUMERATED_FIELDS.has(stem) && (known.includes(stem) || optional.includes(stem)) && value[stem] === OTHER;
    if (literal) textOf(entry, under(at, key));
    bagged(held, { at: under(at, key), kind: literal ? 'literal' : 'field', value: entry });
  }
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

/** The allocation marker is `true` or absent: a depositor cannot say `false`, since an unmarked step is the measured one. */
const allocatedOf = (value: unknown, at: string): true => {
  if (value !== true) throw new Refused(at, 'not true');
  return true;
};

/** An absent field reads as null: an optional field is absent or null alike. */
const orNull = <T>(value: unknown, at: string, item: (entry: unknown, entryAt: string) => T): T | null => (value === null || value === undefined ? null : item(value, at));

/** An absent list reads as empty. */
const listOrEmpty = <T>(value: unknown, at: string, item: (entry: unknown, entryAt: string) => T): T[] => (value === undefined ? [] : listOf(value, at, item));

const booleanOf = (value: unknown, at: string): boolean => {
  if (typeof value !== 'boolean') throw new Refused(at, 'not a boolean');
  return value;
};

/** A value from a closed list, or `other` for a text the list does not hold; the list narrows the type, so no caller needs a cast. A value that is no text is a shape error. */
const oneOf = <T extends string>(held: Collected, list: readonly T[], value: unknown, at: string): T | typeof OTHER => {
  const name = textOf(value, at);
  return list.find((entry) => entry === name) ?? (name === OTHER ? OTHER : unknownValue(held, at, name));
};

const inSet = (held: Collected, allowed: ReadonlySet<string>, value: unknown, at: string): string => {
  const name = textOf(value, at);
  return name === PRIVATE || name === OTHER || allowed.has(name) ? name : unknownValue(held, at, name);
};

/** A long-tail name field: `private`, `other`, or a name (the pool assigns its class, `packages/pool/src/field-classes.ts`). A value that is no name is refused: a client that sends one has not run its gate. */
const nameIn = (value: unknown, at: string, hasShape: (name: string) => boolean = isWireName): string => {
  const name = textOf(value, at);
  if (name === PRIVATE || name === OTHER || hasShape(name)) return name;
  throw new Refused(at, 'not a name');
};

/** A model or harness version: null, or a long-tail name (`private`, `other`, the older client's literal, or a name). A value that is no name is set aside, as a native name is. */
const nameOrNull = (held: Collected, value: unknown, at: string): string | null => {
  if (value === null || value === undefined) return null;
  const name = textOf(value, at);
  return name === LITERAL ? name : nameValue(held, name, at);
};

/** A long-tail name in a field whose value the pool classes: `private`, `other`, or a name; a value that is no name is set aside. */
const nameValue = (held: Collected, name: string, at: string): string => (name === PRIVATE || name === OTHER || isWireName(name) ? name : unknownValue(held, at, name));

const exactlyIn = (held: Collected, allowed: ReadonlySet<string>) => (value: unknown, at: string): string => {
  const name = textOf(value, at);
  return allowed.has(name) || name === OTHER ? name : unknownValue(held, at, name);
};

/** `publicEffort` and its like hand back what is public and the literal for what is not, so only a value they return unchanged is in the vocabulary. */
const heldTo = (held: Collected, isHeld: (value: string | null) => string | null, value: unknown, at: string): string | null => {
  if (value === null || value === undefined) return null;
  const name = textOf(value, at);
  return name === OTHER || isHeld(name) === name ? name : unknownValue(held, at, name);
};

// `satisfies` checks every entry is a `Harness` but not that every `Harness` is listed; this refuses a list that leaves one out at compile time.
const allHarnesses = <const T extends readonly Harness[]>(list: [Exclude<Harness, T[number]>] extends [never] ? T : never): T => list;
export const HARNESSES = allHarnesses(['claude-code', 'cursor', 'codex', 'copilot', 'gemini', 'grok', 'opencode', 'pi', 'vscode-copilot', 'otel']);
const PROMPT_CLASSES = ['no-tools', 'orchestration', 'research', 'edit-verify', 'edit-only', 'explore-only', 'shell-only', 'mixed'] as const satisfies readonly PromptClass[];
const STATUSES = ['ok', 'error', 'none'] as const satisfies readonly ToolStatus[];
const PLATFORMS: ReadonlySet<string> = new Set(['aix', 'android', 'cygwin', 'darwin', 'freebsd', 'haiku', 'linux', 'netbsd', 'openbsd', 'sunos', 'win32']);
const SHELLS: ReadonlySet<string> = new Set(Object.values(ACTION_TABLES).flatMap((table) => Object.values(table.shells)));
/** The registries a package comes from; a pull may also come from a skill, plugin, or MCP registry. */
export const PACKAGE_REGISTRIES = ['npm', 'pypi', 'crates', 'go', 'rubygems', 'homebrew'] as const;
const NO_NAME: ReadonlySet<string> = new Set();
const REGISTRIES = [...PACKAGE_REGISTRIES, 'skill', 'plugin', 'mcp'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[0-9a-f]{16}$/;
/** A real date, not just its shape. `Date.parse` rolls 2026-02-31 over to March instead of failing, so the day must also survive the trip back to text. */
const isCalendarDay = (text: string): boolean => {
  if (!DAY.test(text)) return false;
  const parsed = Date.parse(text);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === text;
};

/** The languages a share can name: the pinned list and `other`, which `projectLanguage` gives any language off the list. The frame's own `languages` stay closed to the list. */
const SHARE_LANGUAGES: ReadonlySet<string> = new Set([...LANGUAGES, 'other']);

const parseLanguageShare = (held: Collected, value: unknown, at: string): LanguageShareEntry => {
  const raw = fieldsOf(held, value, at, ['language', 'languageShare']);
  return { language: exactlyIn(held, SHARE_LANGUAGES)(raw.language, under(at, 'language')), languageShare: oneOf(held, LANGUAGE_SHARES, raw.languageShare, under(at, 'languageShare')) };
};

/** A reach, each list held to its own row; an unfilled reach lists nothing. A plugin has no pinned list, so only the word `private` stands for one. */
const parseReach = (held: Collected, value: unknown, at: string): Reach => {
  const raw = fieldsOf(held, value, at, ['filled', 'mcp', 'skills', 'plugins']);
  const filled = booleanOf(raw.filled, under(at, 'filled'));
  const reach = {
    filled,
    mcp: listOf(raw.mcp, under(at, 'mcp'), (entry, entryAt) => nameIn(entry, entryAt)),
    skills: listOf(raw.skills, under(at, 'skills'), (entry, entryAt) => nameIn(entry, entryAt)),
    plugins: listOf(raw.plugins, under(at, 'plugins'), (entry, entryAt) => inSet(held, NO_NAME, entry, entryAt)),
  };
  if (!filled && reach.mcp.length + reach.skills.length + reach.plugins.length > 0) throw new Refused(at, 'an unfilled reach lists nothing');
  return reach;
};

/** A claim, each member held to its closed list. */
const parseClaimed = (held: Collected, value: unknown, at: string): Claimed => {
  const raw = fieldsOf(held, value, at, ['hostClass', 'launcher']);
  return { hostClass: oneOf(held, CLAIMED_HOST_CLASSES, raw.hostClass, under(at, 'hostClass')), launcher: oneOf(held, CLAIMED_LAUNCHERS, raw.launcher, under(at, 'launcher')) };
};

/** Sixteen lowercase hex characters and nothing else, so no path or remote text can ride in a repo key. */
const parseRepoKey = (value: unknown, at: string): string => {
  const text = textOf(value, at);
  if (!REPO_KEY.test(text)) throw new Refused(at, 'outside the vocabulary');
  return text;
};

const parseHour = (value: unknown, at: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 23) throw new Refused(at, 'not an hour');
  return value;
};

const parseFrame = (held: Collected, value: unknown, at: string): SkeletonFrame => {
  const raw = fieldsOf(held, value, at, ['harness', 'platform', 'stack'], OPTIONAL.frame);
  const stackAt = under(at, 'stack');
  const stack = fieldsOf(held, raw.stack, stackAt, ['languages', 'frameworks'], OPTIONAL.stack);
  const day = orNull(raw.day, under(at, 'day'), (entry, entryAt) => {
    const text = textOf(entry, entryAt);
    if (!isCalendarDay(text)) throw new Refused(entryAt, 'not a UTC day');
    return text;
  });
  return {
    harness: oneOf(held, HARNESSES, raw.harness, under(at, 'harness')),
    harnessVersion: nameOrNull(held, raw.harnessVersion, under(at, 'harnessVersion')),
    model: nameOrNull(held, raw.model, under(at, 'model')),
    effort: heldTo(held, publicEffort, raw.effort, under(at, 'effort')),
    day,
    platform: exactlyIn(held, PLATFORMS)(raw.platform, under(at, 'platform')),
    shell: orNull(raw.shell, under(at, 'shell'), exactlyIn(held, SHELLS)),
    stack: {
      languages: listOf(stack.languages, under(stackAt, 'languages'), exactlyIn(held, LANGUAGES)),
      frameworks: listOf(stack.frameworks, under(stackAt, 'frameworks'), exactlyIn(held, FRAMEWORKS)),
      size: orNull(stack.size, under(stackAt, 'size'), (entry, entryAt) => oneOf(held, REPO_SIZES, entry, entryAt)),
      languageShares: listOrEmpty(stack.languageShares, under(stackAt, 'languageShares'), (entry, entryAt) => parseLanguageShare(held, entry, entryAt)),
    },
    ...(raw.reach === undefined ? {} : { reach: parseReach(held, raw.reach, under(at, 'reach')) }),
    ...(raw.repoKey === undefined ? {} : { repoKey: parseRepoKey(raw.repoKey, under(at, 'repoKey')) }),
    ...(raw.orgSize === undefined ? {} : { orgSize: oneOf(held, ORG_SIZES, raw.orgSize, under(at, 'orgSize')) }),
    ...(raw.team === undefined ? {} : { team: oneOf(held, TEAMS, raw.team, under(at, 'team')) }),
    ...(raw.repoVisibility === undefined ? {} : { repoVisibility: oneOf(held, REPO_VISIBILITIES, raw.repoVisibility, under(at, 'repoVisibility')) }),
    ...(raw.hour === undefined ? {} : { hour: parseHour(raw.hour, under(at, 'hour')) }),
  };
};

const bucketIn = (kind: BucketKind, value: unknown, at: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > EDGES[kind].length) throw new Refused(at, 'not a bucket');
  return value;
};

const parseUsage = (held: Collected, value: unknown, at: string): SkeletonUsage => {
  const raw = fieldsOf(held, value, at, ['input', 'cacheWrite', 'cacheRead', 'output', 'thinking']);
  const bucket = (field: keyof SkeletonUsage): number | null => orNull(raw[field], under(at, field), (entry, entryAt) => bucketIn('tokens', entry, entryAt));
  return { input: bucket('input'), cacheWrite: bucket('cacheWrite'), cacheRead: bucket('cacheRead'), output: bucket('output'), thinking: bucket('thinking') };
};

const parsePull = (held: Collected, value: unknown, at: string): PullIdentity => {
  const raw = fieldsOf(held, value, at, ['registry', 'name', 'version']);
  const name = nameIn(raw.name, under(at, 'name'), isWirePullName);
  const version = orNull(raw.version, under(at, 'version'), (entry, entryAt) => {
    const text = textOf(entry, entryAt);
    // A version beside a masked name could identify it: capture masks the two together.
    if (!PUBLIC_PACKAGES.has(name) && text !== LITERAL) throw new Refused(entryAt, 'a name off the public list holds no version');
    return text === LITERAL || text === OTHER || isRegistryVersion(text) ? text : unknownValue(held, entryAt, text);
  });
  return { registry: oneOf(held, REGISTRIES, raw.registry, under(at, 'registry')), name, version };
};

const parseFlag = (held: Collected, value: unknown, at: string): string => {
  const flag = textOf(value, at);
  return flag === PRIVATE || flag === OTHER || isWireFlag(flag) ? flag : unknownValue(held, at, flag);
};

/** What a reader sets aside whole: a part of a step it cannot read against a vocabulary. Its place is noted and its content kept as sent, as for any value it does not know (see `unknownValue`). */
const setAside = (held: Collected, at: string, sent: unknown): void => {
  bagged(held, { at, kind: 'value', value: sent });
};

const parseIdentity = (held: Collected, harness: WireHarness, action: CanonicalAction, value: unknown, at: string): StepIdentity => {
  if (value === null) return null;
  // An action this reader does not know holds an identity it cannot read: the step goes without one and the place of what it held is noted.
  if (action === OTHER) {
    setAside(held, at, value);
    return null;
  }
  if (action === 'shell.exec') {
    const raw = fieldsOf(held, value, at, ['program', 'sub', 'flags'], ['pulls']);
    // A program is a name, `private`, or `other`; only `other` holds no subcommand, flag, or pull here.
    const program = textOf(raw.program, under(at, 'program'));
    nameIn(program, under(at, 'program'));
    // The subcommands, flags, and pulls of a program this reader does not know cannot be read against its lists: it takes none, and notes what it left.
    if (program === OTHER) {
      for (const key of ['sub', 'flags', 'pulls']) if (raw[key] !== undefined && !(raw[key] === null || (Array.isArray(raw[key]) && raw[key].length === 0))) setAside(held, under(at, key), raw[key]);
      return { program: OTHER, sub: null, flags: [] };
    }
    if (program === PRIVATE) {
      if (!(Array.isArray(raw.flags) && raw.flags.length === 0)) throw new Refused(under(at, 'flags'), 'a private program holds no flags');
      if (raw.pulls !== undefined) throw new Refused(under(at, 'pulls'), 'a private program holds no pulls');
    }
    // A private program holds no subcommand, so one it sends is set aside, as its flags are refused.
    const sub = orNull(raw.sub, under(at, 'sub'), (entry, entryAt) => (program === PRIVATE ? unknownValue(held, entryAt, textOf(entry, entryAt)) : nameValue(held, textOf(entry, entryAt), entryAt)));
    const flags = listOf(raw.flags, under(at, 'flags'), (entry, entryAt) => parseFlag(held, entry, entryAt));
    return raw.pulls === undefined ? { program, sub, flags } : { program, sub, flags, pulls: listOf(raw.pulls, under(at, 'pulls'), (entry, entryAt) => parsePull(held, entry, entryAt)) };
  }
  if (action === 'mcp.call') {
    const raw = fieldsOf(held, value, at, ['server', 'tool']);
    const server = nameIn(raw.server, under(at, 'server'));
    const tool = textOf(raw.tool, under(at, 'tool'));
    // The same rule capture applies (`callIdentity`), so a name it would have masked is refused here rather than stored.
    if (harness === OTHER) {
      // The name crosses as the literal, and what the client sent is kept in the bag.
      if (tool !== OTHER && tool !== LITERAL) setAside(held, under(at, 'tool'), tool);
      return { server, tool: tool === OTHER ? tool : LITERAL };
    }
    const admitted = tool === LITERAL || tool === OTHER || (server !== PRIVATE && ACTION_TABLES[harness].toolDelimited && (isPublicMcpTool(server, tool) || isWireName(tool)));
    return { server, tool: admitted ? tool : unknownValue(held, under(at, 'tool'), tool) };
  }
  if (action === 'skill.run') return { skill: nameIn(fieldsOf(held, value, at, ['skill']).skill, under(at, 'skill')) };
  if (action === 'web.fetch' || action === 'web.search') {
    const { host } = fieldsOf(held, value, at, ['host']);
    return { host: orNull(host, under(at, 'host'), (entry, entryAt) => nameIn(entry, entryAt)) };
  }
  throw new Refused(at, 'this action has no identity');
};

/** Whether the harness's table names this native, so it can cross as itself; anything else (including the literal) crosses as `private`. */
const admittedNative = (harness: WireHarness, native: string): boolean => {
  if (native === PRIVATE) return true;
  if (harness === OTHER) return false;
  const table = ACTION_TABLES[harness];
  if (Object.hasOwn(table.rows, native)) return true;
  const mcp = mcpOf(table, native);
  return mcp !== undefined && table.toolDelimited && isPublicMcpTool(mcp.server, mcp.tool);
};

const parseNative = (held: Collected, harness: WireHarness, value: unknown, at: string): string => {
  const native = textOf(value, at);
  // The tools of a harness this reader does not know are off any table it holds, so they cross as `private`, the way capture masks a name its table lacks.
  if (harness === OTHER) return native === OTHER || isWireName(native) ? native : unknownValue(held, at, native);
  return native === OTHER || admittedNative(harness, native) || isWireName(native) ? native : unknownValue(held, at, native);
};

/** A subagent type as the projection leaves it: a built-in of a harness, or `custom`; a custom agent's own name is private and never admitted. */
const parseAgentType = (held: Collected, value: unknown, at: string): string => {
  const name = textOf(value, at);
  return name === OTHER || projectedAgentType(name) === name ? name : unknownValue(held, at, name);
};

const parseEdge = (held: Collected, value: unknown, at: string): SkeletonEdge => {
  const raw = fieldsOf(held, value, at, ['kind', 'target']);
  return { kind: oneOf(held, EDGE_KINDS, raw.kind, under(at, 'kind')), target: countOf(raw.target, under(at, 'target')) };
};

const parseStep = (held: Collected, harness: WireHarness, value: unknown, at: string): SkeletonStep => {
  const raw = fieldsOf(held, value, at, ['action', 'native', 'identity', 'status', 'agentType', 'frame'], OPTIONAL.step);
  const action = oneOf(held, CANONICAL_ACTIONS, raw.action, under(at, 'action'));
  return {
    action,
    native: parseNative(held, harness, raw.native, under(at, 'native')),
    identity: parseIdentity(held, harness, action, raw.identity, under(at, 'identity')),
    status: oneOf(held, STATUSES, raw.status, under(at, 'status')),
    tokens: orNull(raw.tokens, under(at, 'tokens'), (entry, entryAt) => bucketIn('tokens', entry, entryAt)),
    ms: orNull(raw.ms, under(at, 'ms'), (entry, entryAt) => bucketIn('ms', entry, entryAt)),
    ...(raw.allocated === undefined ? {} : { allocated: allocatedOf(raw.allocated, under(at, 'allocated')) }),
    remainingTokens: orNull(raw.remainingTokens, under(at, 'remainingTokens'), (entry, entryAt) => bucketIn('tokens', entry, entryAt)),
    agentType: orNull(raw.agentType, under(at, 'agentType'), (entry, entryAt) => parseAgentType(held, entry, entryAt)),
    parent: orNull(raw.parent, under(at, 'parent'), countOf),
    frame: countOf(raw.frame, under(at, 'frame')),
    ...(raw.edges === undefined ? {} : { edges: listOf(raw.edges, under(at, 'edges'), (entry, entryAt) => parseEdge(held, entry, entryAt)) }),
    ...(raw.skill === undefined ? {} : { skill: nameIn(raw.skill, under(at, 'skill')) }),
  };
};

/** A call's `errorCode`: absent or null is none; otherwise a member of the closed list (a value off it reads as `other` and goes to the bag), and only on a call that did not succeed or sit out. */
const parseErrorCode = (held: Collected, status: SkeletonTool['status'], value: unknown, at: string): string | null => {
  if (value === undefined || value === null) return null;
  const code = exactlyIn(held, ERROR_CODES)(value, at);
  if (status === 'ok' || status === 'none') throw new Refused(at, 'only a failed call has one');
  return code;
};

/** A call's `recoveryCalls`: absent is none; otherwise at most 5 actions (a value off the list reads as `other`) and a flag, and only on a call that did not succeed or sit out; the transcript parse then refuses one on a call whose status is not `error`. */
const parseRecovery = (held: Collected, status: SkeletonTool['status'], value: unknown, at: string): RecoveryCalls | undefined => {
  if (value === undefined) return undefined;
  if (status === 'ok' || status === 'none') throw new Refused(at, 'only a failed call has one');
  const raw = fieldsOf(held, value, at, ['next', 'editFollowed']);
  const next = listOf(raw.next, under(at, 'next'), (entry, entryAt) => oneOf(held, CANONICAL_ACTIONS, entry, entryAt));
  if (next.length > RECOVERY_CALLS) throw new Refused(under(at, 'next'), `more than ${String(RECOVERY_CALLS)} calls`);
  return { next, editFollowed: booleanOf(raw.editFollowed, under(at, 'editFollowed')) };
};

/**
 * A call's `keys`: absent is none. A tool with a pinned input list sends names on it, and a name off it reads as `other` and goes to the bag; any other tool's names must have the shape of a name. Key names
 * only, so a value that is no name shape is not a key.
 */
const parseKeys = (held: Collected, native: string | undefined, value: unknown, at: string): string[] | undefined => {
  if (value === undefined) return undefined;
  const listed = native === undefined ? undefined : TOOL_INPUT_KEYS.get(native);
  return listOf(value, at, (entry, entryAt) => {
    const name = textOf(entry, entryAt);
    return (listed === undefined ? isWireName(name) : listed.has(name)) ? name : unknownValue(held, entryAt, name);
  });
};

/** The call's `keys` as sent and as read: a feature or a value names one of them, and one that read as `other` (a name off a pinned list this reader holds) makes its entry's key `other` too. */
interface SentKeys {
  sent: readonly unknown[];
  read: readonly string[];
}

/** A sent key's entry names a key of the call's own `keys`, so a feature or a value never names a key the call did not send. */
const sentKey = (held: Collected, keys: SentKeys, value: unknown, at: string): string => {
  const key = textOf(value, at);
  const index = keys.sent.indexOf(key);
  if (index < 0) throw new Refused(at, 'not a key the call sent');
  return keys.read[index] === OTHER ? unknownValue(held, at, key) : key;
};

const parseFeature = (held: Collected, keys: SentKeys, value: unknown, at: string): SkeletonArgFeature => {
  const raw = fieldsOf(held, value, at, ['key', 'valueSize'], FEATURE_OPTIONAL);
  const pathDepth = raw.pathDepth === undefined ? undefined : oneOf(held, PATH_DEPTHS, raw.pathDepth, under(at, 'pathDepth'));
  const extension = raw.extension === undefined ? undefined : oneOf(held, EXTENSION_CLASSES, raw.extension, under(at, 'extension'));
  const dirKind = raw.dirKind === undefined ? undefined : oneOf(held, DIRECTORY_KINDS, raw.dirKind, under(at, 'dirKind'));
  const patternFeatures = raw.patternFeatures === undefined ? undefined : listOf(raw.patternFeatures, under(at, 'patternFeatures'), (entry, entryAt) => oneOf(held, PATTERN_FEATURES, entry, entryAt));
  return {
    key: sentKey(held, keys, raw.key, under(at, 'key')),
    valueSize: oneOf(held, VALUE_SIZES, raw.valueSize, under(at, 'valueSize')),
    ...(pathDepth === undefined ? {} : { pathDepth }),
    ...(extension === undefined ? {} : { extension }),
    ...(dirKind === undefined ? {} : { dirKind }),
    ...(patternFeatures === undefined ? {} : { patternFeatures }),
  };
};

/** A closed value this reader does not hold for the key reads as `other` and goes to the bag, as any value off a list does. */
const parseValue = (held: Collected, keys: SentKeys, native: string | undefined, value: unknown, at: string): SkeletonArgValue => {
  const raw = fieldsOf(held, value, at, ['key', 'enumValue']);
  const key = sentKey(held, keys, raw.key, under(at, 'key'));
  const enumValue = textOf(raw.enumValue, under(at, 'enumValue'));
  return { key, enumValue: key !== OTHER && isClosedValue(native, key, enumValue) ? enumValue : unknownValue(held, under(at, 'enumValue'), enumValue) };
};

/** The tool fields a format 5 or 6 batch may hold: format 7's are fields it does not know. */
const FORMAT_6_TOOL: readonly string[] = OPTIONAL.tool.filter((name) => !FORMAT_7_TOOL_FIELDS.some((added) => added === name));
/** The tool fields a format 4 batch may hold: format 5's are fields it does not know. */
const FORMAT_4_TOOL: readonly string[] = FORMAT_6_TOOL.filter((name) => !FORMAT_5_TOOL_FIELDS.some((added) => added === name));
/** The tool fields a format 3 batch may hold: format 4's three are fields it does not know too. */
const FORMAT_3_TOOL: readonly string[] = FORMAT_4_TOOL.filter((name) => !FORMAT_4_TOOL_FIELDS.some((added) => added === name));

/** A name token: its kind off the closed list, and a name that has the shape of one. Either off its list or shape reads as `other` and goes to the bag, as any value off a list does. */
const parseName = (held: Collected, value: unknown, at: string): SkeletonArgName => {
  const raw = fieldsOf(held, value, at, ['kind', 'name']);
  const name = textOf(raw.name, under(at, 'name'));
  return { kind: oneOf(held, NAME_KINDS, raw.kind, under(at, 'kind')), name: isWireName(name) ? name : unknownValue(held, under(at, 'name'), name) };
};

/** A digest is the shape capture writes, or the batch is refused: unlike a name, no newer client's value is a digest of another shape, and the field holds only what a hash can. */
const digestOf = (value: unknown, at: string): string => {
  const digest = textOf(value, at);
  if (!DIGEST.test(digest)) throw new Refused(at, 'not a digest');
  return digest;
};

const parseDigest = (held: Collected, value: unknown, at: string): SkeletonDigest => {
  const raw = fieldsOf(held, value, at, ['new'], ['old']);
  const old = raw.old === undefined ? undefined : digestOf(raw.old, under(at, 'old'));
  return { ...(old === undefined ? {} : { old }), new: digestOf(raw.new, under(at, 'new')) };
};

const parseTemplate = (held: Collected, value: unknown, at: string): string => {
  const template = textOf(value, at);
  return isWireTemplate(template) ? template : unknownValue(held, at, template);
};
const parseTool = (held: Collected, harness: WireHarness, value: unknown, at: string): SkeletonTool => {
  const layered = held.format >= 4;
  const named = held.format >= 5;
  const digested = held.format >= DIGEST_FORMAT;
  const raw = fieldsOf(held, value, at, ['side', 'status', 'steps'], digested ? OPTIONAL.tool : named ? FORMAT_6_TOOL : layered ? FORMAT_4_TOOL : FORMAT_3_TOOL);
  const status = oneOf(held, STATUSES, raw.status, under(at, 'status'));
  const errorCode = parseErrorCode(held, status, raw.errorCode, under(at, 'errorCode'));
  const recoveryCalls = parseRecovery(held, status, raw.recoveryCalls, under(at, 'recoveryCalls'));
  const steps = listOf(raw.steps, under(at, 'steps'), (entry, entryAt) => parseStep(held, harness, entry, entryAt));
  const keys = parseKeys(held, steps[0]?.native, raw.keys, under(at, 'keys'));
  const keysDropped = raw.keysDropped === undefined ? undefined : bucketIn('count', raw.keysDropped, under(at, 'keysDropped'));
  const targetClass = raw.targetClass === undefined ? undefined : oneOf(held, TARGET_CLASSES, raw.targetClass, under(at, 'targetClass'));
  const argClass = raw.argClass === undefined ? undefined : listOf(raw.argClass, under(at, 'argClass'), (entry, entryAt) => oneOf(held, ARG_CLASSES, entry, entryAt));
  const sentKeys: SentKeys = { sent: Array.isArray(raw.keys) ? raw.keys : [], read: keys ?? [] };
  const argFeatures = !layered || raw.argFeatures === undefined ? undefined : listOf(raw.argFeatures, under(at, 'argFeatures'), (entry, entryAt) => parseFeature(held, sentKeys, entry, entryAt));
  const argValues = !layered || raw.argValues === undefined ? undefined : listOf(raw.argValues, under(at, 'argValues'), (entry, entryAt) => parseValue(held, sentKeys, steps[0]?.native, entry, entryAt));
  const changeKind = !layered || raw.changeKind === undefined ? undefined : listOf(raw.changeKind, under(at, 'changeKind'), (entry, entryAt) => oneOf(held, CHANGE_KINDS, entry, entryAt));
  const names = !named || raw.names === undefined ? undefined : listOf(raw.names, under(at, 'names'), (entry, entryAt) => parseName(held, entry, entryAt));
  const namesDropped = !named || raw.namesDropped === undefined ? undefined : bucketIn('count', raw.namesDropped, under(at, 'namesDropped'));
  const digests = !digested || raw.digests === undefined ? undefined : listOf(raw.digests, under(at, 'digests'), (entry, entryAt) => parseDigest(held, entry, entryAt));
  const templates = !named || raw.templates === undefined ? undefined : listOf(raw.templates, under(at, 'templates'), (entry, entryAt) => parseTemplate(held, entry, entryAt));
  const templatesDropped = !named || raw.templatesDropped === undefined ? undefined : bucketIn('count', raw.templatesDropped, under(at, 'templatesDropped'));
  const diffShape = !named || raw.diffShape === undefined ? undefined : listOf(raw.diffShape, under(at, 'diffShape'), (entry, entryAt) => oneOf(held, DIFF_SHAPES, entry, entryAt));
  return {
    side: booleanOf(raw.side, under(at, 'side')),
    prompt: orNull(raw.prompt, under(at, 'prompt'), countOf),
    status,
    durationMs: orNull(raw.durationMs, under(at, 'durationMs'), countOf),
    errorCode,
    ...(recoveryCalls === undefined ? {} : { recoveryCalls }),
    ...(keys === undefined ? {} : { keys }),
    ...(keysDropped === undefined ? {} : { keysDropped }),
    ...(targetClass === undefined ? {} : { targetClass }),
    ...(argClass === undefined ? {} : { argClass }),
    ...(argFeatures === undefined ? {} : { argFeatures }),
    ...(argValues === undefined ? {} : { argValues }),
    ...(changeKind === undefined ? {} : { changeKind }),
    ...(names === undefined ? {} : { names }),
    ...(namesDropped === undefined ? {} : { namesDropped }),
    ...(digests === undefined ? {} : { digests }),
    ...(templates === undefined ? {} : { templates }),
    ...(templatesDropped === undefined ? {} : { templatesDropped }),
    ...(diffShape === undefined ? {} : { diffShape }),
    steps,
  };
};

const parsePrompt = (held: Collected, value: unknown, at: string): SkeletonPrompt => {
  const raw = fieldsOf(held, value, at, ['cls', 'errors', 'usage', 'frame'], OPTIONAL.prompt);
  return {
    cls: oneOf(held, PROMPT_CLASSES, raw.cls, under(at, 'cls')),
    errors: bucketIn('count', raw.errors, under(at, 'errors')),
    wallSec: orNull(raw.wallSec, under(at, 'wallSec'), (entry, entryAt) => bucketIn('seconds', entry, entryAt)),
    usage: parseUsage(held, raw.usage, under(at, 'usage')),
    explore: orNull(raw.explore, under(at, 'explore'), (entry, entryAt) => bucketIn('calls', entry, entryAt)),
    ...(raw.usageResponses === undefined ? {} : { usageResponses: bucketIn('count', raw.usageResponses, under(at, 'usageResponses')) }),
    // A sent null reads as an absent field, the way every optional field does.
    ...(raw.intervention === undefined || raw.intervention === null ? {} : { intervention: oneOf(held, PROMPT_INTERVENTIONS, raw.intervention, under(at, 'intervention')) }),
    frame: parseFrame(held, raw.frame, under(at, 'frame')),
  };
};

const ROOT = /^[0-9a-f]{64}$/;
const PRINT = /^[0-9a-f]{16}$/;

const parseRoot = (value: unknown, at: string): string => {
  const root = textOf(value, at);
  if (!ROOT.test(root)) throw new Refused(at, 'not a SHA-256');
  return root;
};

const parseTranscript = (held: Collected, value: unknown, at: string): SkeletonTranscript => {
  const raw = fieldsOf(held, value, at, ['merkleRoot', 'leaves', 'harness', 'frame', 'frames', 'prompts', 'tools'], OPTIONAL.transcript);
  const harness = oneOf(held, HARNESSES, raw.harness, under(at, 'harness'));
  const merkleRoot = parseRoot(raw.merkleRoot, under(at, 'merkleRoot'));
  const leaves = countOf(raw.leaves, under(at, 'leaves'));
  // Read in the order the fields are met, so the bag holds what was set aside in that order.
  const frame = parseFrame(held, raw.frame, under(at, 'frame'));
  const frames = listOf(raw.frames, under(at, 'frames'), (entry, entryAt) => parseFrame(held, entry, entryAt));
  // Absent reads as null: a client that names no spawner sends none.
  const spawnedIn = orNull(raw.spawnedIn, under(at, 'spawnedIn'), countOf);
  const prompts = listOf(raw.prompts, under(at, 'prompts'), (entry, entryAt) => parsePrompt(held, entry, entryAt));
  const tools = listOf(raw.tools, under(at, 'tools'), (entry, entryAt) => parseTool(held, harness, entry, entryAt));
  // What followed a call is read off the calls themselves, so a list that disagrees with them is a wrong deposit, not a new reading. A batch of a format before 6 was built when a failed edit still counted, so it is checked with that rule.
  tools.forEach((tool, index) => {
    if (tool.recoveryCalls !== undefined && JSON.stringify(tool.recoveryCalls) !== JSON.stringify(recoveryCallsOf(tools, index, held.format < EXPOSURE_FORMAT))) throw new Refused(`${at}.tools[${String(index)}].recoveryCalls`, 'not what followed the call');
  });
  return { merkleRoot, leaves, harness, frame, frames, spawnedIn, prompts, tools };
};

const DELTA_FIELDS = ['plugin', 'package', 'permissionMode', 'effort'] as const satisfies readonly DeltaField[];
/** The kinds each field can take: a plugin comes or goes, a package only goes (an addition is adoption, which `pool` reads from the calls), and a mode or an effort changes. */
const KINDS_OF = { plugin: ['added', 'removed'], package: ['removed'], permissionMode: ['changed'], effort: ['changed'] } as const satisfies { readonly [field in DeltaField]: readonly DeltaKind[] };
/** The one metric each field's change is measured in, and the bucket edges that metric is held to. */
const METRIC_OF = { plugin: 'callsPerSession', package: 'callsPerSession', permissionMode: 'callsPerSession', effort: 'thinking' } as const satisfies { readonly [field in DeltaField]: DeltaMetric };
const METRIC_EDGES = { callsPerSession: 'count', thinking: 'tokens' } as const satisfies { readonly [metric in DeltaMetric]: BucketKind };
const ALL_KINDS = ['added', 'removed', 'changed'] as const satisfies readonly DeltaKind[];
const ALL_METRICS = ['callsPerSession', 'thinking'] as const satisfies readonly DeltaMetric[];

const nullOnly = (value: unknown, at: string): null => {
  if (value !== null) throw new Refused(at, 'outside the vocabulary');
  return null;
};

/**
 * The entry of a delta, held to its field's own row. A plugin has no registry to pass, so only the word `private` stands for one; a package is a public name with its registry, or `private` with none; a mode
 * and an effort are named by their field and carry no name. The change is a signed bucket of the field's metric.
 */
const parseDelta = (held: Collected, value: unknown, at: string): DeltaEntry => {
  const raw = fieldsOf(held, value, at, ['deltaKind', 'field', 'name', 'registry', 'metric', 'change']);
  const field = oneOf(held, DELTA_FIELDS, raw.field, under(at, 'field'));
  // A field this reader does not know has no row to hold its kind, metric, name, or registry to: the first two read against every kind and metric, and the last two are kept as sent.
  const kinds = field === OTHER ? ALL_KINDS : KINDS_OF[field];
  const deltaKind = oneOf(held, kinds, raw.deltaKind, under(at, 'deltaKind'));
  const metric = oneOf(held, field === OTHER ? ALL_METRICS : [METRIC_OF[field]], raw.metric, under(at, 'metric'));
  const named = field === 'plugin' || field === 'package';
  if (field === OTHER) {
    for (const key of ['name', 'registry']) if (raw[key] !== null) setAside(held, under(at, key), raw[key]);
  }
  const name = named ? inSet(held, field === 'package' ? PUBLIC_PACKAGES : NO_NAME, raw.name, under(at, 'name')) : field === OTHER ? null : nullOnly(raw.name, under(at, 'name'));
  const registry = field === 'package' && name !== PRIVATE ? oneOf(held, PACKAGE_REGISTRIES, raw.registry, under(at, 'registry')) : field === OTHER ? null : nullOnly(raw.registry, under(at, 'registry'));
  const change = raw.change;
  const limit = metric === OTHER ? Math.max(...ALL_METRICS.map((kind) => EDGES[METRIC_EDGES[kind]].length)) : EDGES[METRIC_EDGES[metric]].length;
  if (typeof change !== 'number' || !Number.isInteger(change) || Math.abs(change) > limit) throw new Refused(under(at, 'change'), 'not a signed bucket');
  return { deltaKind, field, name, registry, metric, change };
};

/** A parsed batch: the skeleton every derivation reads, the bag of what this reader did not know, and the count of values it read as `other`. Only the skeleton is ever served from. */
export interface ParsedSkeleton {
  ok: true;
  skeleton: SessionSkeleton;
  extensions: Extension[];
  others: number;
}

const VOCAB_TEXT = /^[0-9A-Za-z._-]{1,32}$/;
/** The deposit time of the pool a recommendation answered from: an instant, or a version word. */
const POOL_VERSION = /^[0-9A-Za-z:.+_-]{1,40}$/;

/** The batch fields a batch of format 5 or older may hold: format 6's are fields it does not know. */
const FORMAT_5_BATCH: readonly string[] = OPTIONAL.batch.filter((name) => !FORMAT_6_BATCH_FIELDS.some((added) => added === name));

/** One recommendation: a hash id, its arm off the closed list, the version it answered from, and a window that is two counts in order. Past-the-calls is checked once the transcripts are known. */
const parseRecommendation = (held: Collected, value: unknown, at: string): SkeletonRecommendation => {
  const raw = fieldsOf(held, value, at, ['id', 'arm', 'poolVersion', 'from', 'to']);
  const id = textOf(raw.id, under(at, 'id'));
  if (!ID.test(id)) throw new Refused(under(at, 'id'), 'not a hash');
  const poolVersion = textOf(raw.poolVersion, under(at, 'poolVersion'));
  if (!POOL_VERSION.test(poolVersion)) throw new Refused(under(at, 'poolVersion'), 'not a version');
  const from = countOf(raw.from, under(at, 'from'));
  const to = countOf(raw.to, under(at, 'to'));
  if (to < from) throw new Refused(under(at, 'to'), 'ends before it starts');
  return { id, arm: oneOf(held, RECOMMENDATION_ARMS, raw.arm, under(at, 'arm')), poolVersion, from, to };
};

/** The skeleton in `value`, rebuilt from the fields read, with the bag of what was set aside; else the first field that is a shape error, and why. */
export const parseSkeleton = (value: unknown): ParsedSkeleton | Refusal => {
  const held: Collected = { extensions: [], others: 0, format: SKELETON_FORMAT };
  try {
    // The earlier forms are named, since their fields would otherwise read as a list of strangers; any other format is a form this reader does not know.
    if (isFields(value) && typeof value.format === 'number' && value.format < READ_FORMATS[0]) throw new Refused('format', `the format ${String(value.format)} form is no longer read; send format ${String(SKELETON_FORMAT)}`);
    // The format is read first, since which batch fields it defines depends on it.
    const declared = isFields(value) ? READ_FORMATS.find((known) => known === value.format) : undefined;
    const raw = fieldsOf(held, value, '', ['format', 'vocabVersion', 'fieldsVersion', 'id', 'transcripts'], declared !== undefined && declared < EXPOSURE_FORMAT ? FORMAT_5_BATCH : OPTIONAL.batch);
    const format = READ_FORMATS.find((known) => known === raw.format);
    if (format === undefined) throw new Refused('format', 'not a format this version reads');
    held.format = format;
    const vocabVersion = textOf(raw.vocabVersion, 'vocabVersion');
    if (!VOCAB_TEXT.test(vocabVersion)) throw new Refused('vocabVersion', 'not a version');
    const fieldsVersion = countOf(raw.fieldsVersion, 'fieldsVersion');
    const id = textOf(raw.id, 'id');
    if (!ID.test(id)) throw new Refused('id', 'not a hash');
    const deltas = listOrEmpty(raw.deltas, 'deltas', (entry, entryAt) => parseDelta(held, entry, entryAt));
    const transcripts = listOf(raw.transcripts, 'transcripts', (entry, entryAt) => parseTranscript(held, entry, entryAt));
    if (transcripts.length === 0) throw new Refused('transcripts', 'empty');
    const recommendations = format < EXPOSURE_FORMAT ? [] : listOrEmpty(raw.recommendations, 'recommendations', (entry, entryAt) => parseRecommendation(held, entry, entryAt));
    // Positions are the only ordinals on the wire, so a window must lie within the main run's own calls: the ones that are not sidechain, which is the line the windows were counted on.
    const mainCalls = (transcripts[0]?.tools ?? []).filter(({ side }) => !side).length;
    recommendations.forEach(({ to }, index) => {
      if (to > mainCalls) throw new Refused(`recommendations[${String(index)}].to`, 'past the main run\'s calls');
    });
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
    // A spawner is another transcript of the batch whose own spawners lead to a run with none, so the batch is a forest and the main run is its first root.
    transcripts.forEach(({ spawnedIn }, index) => {
      if (spawnedIn === null) return;
      const spawnedAt = `transcripts[${String(index)}].spawnedIn`;
      if (index === 0) throw new Refused(spawnedAt, 'the main run has no spawner');
      if (spawnedIn >= transcripts.length || spawnedIn === index) throw new Refused(spawnedAt, 'no such transcript');
      let above: number | null = spawnedIn;
      for (let hop = 0; hop < transcripts.length && above !== null; hop += 1) above = transcripts[above]?.spawnedIn ?? null;
      if (above !== null) throw new Refused(spawnedAt, 'a spawner cycle');
    });
    const stepsOf = transcripts.map(({ tools }) => tools.reduce((all, { steps }) => all + steps.length, 0));
    transcripts.forEach(({ prompts, tools, frames, spawnedIn }, index) => {
      if (frames.length === 0) throw new Refused(`transcripts[${String(index)}].frames`, 'empty');
      // The call and prompt of every step in the transcript's order, which an edge's target is a position in.
      const placed = tools.flatMap(({ prompt, steps }) => steps.map(() => ({ prompt })));
      let before = 0;
      tools.forEach(({ prompt, steps }, call) => {
        const callAt = `transcripts[${String(index)}].tools[${String(call)}]`;
        // Past the prompts it names a prompt with no record, numbered in order of appearance: no more of those than calls.
        if (prompt !== null && prompt >= prompts.length + tools.length) throw new Refused(`${callAt}.prompt`, 'no such prompt position');
        steps.forEach(({ parent, frame, edges }, position) => {
          const stepAt = `${callAt}.steps[${String(position)}]`;
          if (parent !== null && (spawnedIn === null || parent >= (transcripts[spawnedIn]?.tools.length ?? 0))) throw new Refused(`${stepAt}.parent`, 'no such call in the spawning transcript');
          if (frame >= frames.length) throw new Refused(`${stepAt}.frame`, 'no such frame position');
          const here = before + position;
          (edges ?? []).forEach(({ kind, target }, edge) => {
            const edgeAt = `${stepAt}.edges[${String(edge)}]`;
            if (kind === OTHER) return;
            if (kind === 'spawned') {
              if (spawnedIn === null) throw new Refused(`${edgeAt}.kind`, 'a spawned edge needs a spawning transcript');
              if (target >= (stepsOf[spawnedIn] ?? 0)) throw new Refused(`${edgeAt}.target`, 'no such step in the spawning transcript');
              return;
            }
            // The other kinds name an earlier step of the same transcript; a next stays inside one prompt.
            if (target >= here) throw new Refused(`${edgeAt}.target`, 'not an earlier step of this transcript');
            if (kind === 'next' && placed[target]?.prompt !== prompt) throw new Refused(`${edgeAt}.target`, 'a next edge crosses a prompt');
          });
        });
        before += steps.length;
      });
    });
    const claimed = raw.claimed === undefined ? {} : { claimed: parseClaimed(held, raw.claimed, 'claimed') };
    return { ok: true, skeleton: { format, vocabVersion, fieldsVersion, id, transcripts, timingPrint, deltas, ...claimed, ...(recommendations.length === 0 ? {} : { recommendations }) }, extensions: held.extensions, others: held.others };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, field: error.field, reason: error.reason };
    throw error;
  }
};

/**
 * One count of a stack stratum (spec Section 4, rule 3), across every harness version, so it is never joined to one. The two pairs hold two values each, joined by a slash:
 * `languageShare` is `<language>/<share bucket>` and `repoFilesExplore` is `<stack size, xs to xl>/<explore calls bucket>`.
 */
export interface StrataCell {
  dimension: 'language' | 'framework' | 'repoFiles' | 'languageShare' | 'repoFilesExplore';
  value: string;
  sessions: number;
  clusters: number;
}

/**
 * The floors a pool served the bundle at, stated so a client can print them and holds none of its own. `public` is the clusters a cell needs to be served and a read to count it, `disclosure` the clusters that must hold a signature's hash
 * before its text may be requested, and `families` the read families that have a public floor of their own (a family not listed is at `public`). Both are the deploy's to set, so a client reads them here and never applies one.
 */
export interface BundleFloors {
  public: number;
  disclosure: number;
  /** The floor a cell of closed public vocabulary is served at, at most `public`. Absent in a bundle signed before the pool split its floor by cell class. */
  clear?: number;
  families?: FamilyFloors;
}

/** A floor per read family, keyed by the family's name as the pool states it. A client applies none and prints only the families it knows, so a name this version has never heard of (a family a later pool adds) is carried as stated and not refused. */
export interface FamilyFloors {
  [family: string]: number;
}

/** A number the pool can state, or the plain statement that nothing measures it yet. `no source yet` is never a zero: a measured nothing and an unmeasured one must not read alike. */
export type Sourced = { state: 'value'; value: number } | { state: 'no source yet'; reason: string };

/**
 * The set of four (direction conclusion, section 20 rule 1), as totals. Served cells and the below-floor backlog are totals over the cells this bundle derived from; the backlog is one number and names no
 * tuple, week, or value. The panel is one account count and names no account. `demand` and `goal` hold a place each for a source a later brief adds. `floor`, the versions, and `asOf` are its lineage (section 17 rule 6).
 */
export interface Books {
  floor: number;
  format: typeof BUNDLE_FORMAT;
  vocabVersion: string;
  asOf: ReadAsOf;
  served: { total: number; byWeek: { week: string; cells: number }[]; byTuple: { tuple: string; cells: number }[] };
  backlog: number;
  panel: Sourced;
  /** The UTC day the panel was counted: the pool reads its deposits once a day. */
  panelDay: string | null;
  demand: { comparisonReadOwners: Sourced; followOnReads: Sourced };
  goal: { readYield: Sourced; costPerServedCell: Sourced; yieldPerServedCell: Sourced };
}

/** One harness version's replica, as the server signs it. It names its harness, which the signature covers, so a bundle for one harness cannot stand in for another's. Nothing in it is keyed by stack. */
export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  harness: Harness;
  harnessVersion: string;
  vocabVersion: string;
  /** The public floor the pool applied (`floors.public`): every cell and read is at or above it except a family on a lower floor of its own, which states its floor on each read and in `floors.families`. A clear cell is held to `floors.clear`, so a read on clear cells alone states that floor, the lowest among the cells it cites. */
  floor: number;
  asOf: ReadAsOf;
  cells: Cell[];
  motifs: Motif[];
  reads: Read[];
  strata: StrataCell[];
  /** Additive: a bundle from a pool before the floors were bindings holds none, and a client that does not know the field ignores it. */
  floors?: BundleFloors;
  /** Absent in a bundle signed before the set of four existed, which `oars sessions books` reads as no pool books. */
  books?: Books;
}

/** The signature covers these exact bytes, so nothing has to be canonicalized on either side. */
export interface SignedBundle {
  /** Names the signing key (S17). A bundle with no `kid` is read as `LEGACY_KEY_ID`, the name a pre-key-id sign-in pins its one key under. */
  kid?: string;
  payload: string;
  /** Ed25519 over the payload's UTF-8 bytes, in base64. */
  signature: string;
}

/** The key id of a bundle that names none, and of a sign-in file written before key ids: the pool's default `BUNDLE_KEY_ID`. */
export const LEGACY_KEY_ID = 'k1';

/** Key ids this release no longer trusts: the way a leaked signing key is rotated out (docs/pool.md, "Rotating the bundle signing key"). A bundle signed under one is refused even when its key is pinned. */
export const RETIRED_KEY_IDS: ReadonlySet<string> = new Set<string>();

/** The public half of the pool's key, as a client pins it at login. */
export interface PinnedKey {
  kty: string;
  crv: string;
  x: string;
}

/** The keys pinned for one server, by key id. One entry until the pool rotates its key. */
export interface PinnedKeys {
  [kid: string]: PinnedKey;
}

/**
 * Public keys this release of oars ships, by key id: the only way a key id the login did not pin becomes trusted, because a server at a pool's URL must not be able to introduce a key by naming a new id (S17). Empty until the pool's first rotation
 * (docs/pool.md, "Rotating the bundle signing key"); a bundle is checked against the keys pinned at login and these, a shipped key winning under a shared id, so a server cannot shadow it with a key of its own.
 */
export const RELEASE_KEYS: Readonly<PinnedKeys> = Object.freeze({});

/** The first key id a login offers that the server's entry does not hold and no release ships, or none: such an id could only have come from the server. */
export const unpinnedKid = (held: PinnedKeys, offered: PinnedKeys, released: PinnedKeys = RELEASE_KEYS): string | undefined =>
  Object.keys(offered).find((kid) => !Object.hasOwn(held, kid) && !Object.hasOwn(released, kid));

const isSignedBundle = (value: unknown): value is SignedBundle => isFields(value) && typeof value.payload === 'string' && typeof value.signature === 'string' && (value.kid === undefined || typeof value.kid === 'string');

const isFloor = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** The floors a bundle states, or none: a client prints what is here, so a value that is not a whole number of at least 1 is refused and not shown, while a family this client does not know is carried (in `--json`) and not printed, since `floorSentence` prints only the families this client knows (additive, section 17 rule 3). */
const isFloors = (value: unknown): value is BundleFloors =>
  isFields(value) && isFloor(value.public) && isFloor(value.disclosure) && (value.clear === undefined || isFloor(value.clear)) && (value.families === undefined || (isFields(value.families) && Object.values(value.families).every(isFloor)));

const isSourced = (value: unknown): value is Sourced =>
  isFields(value) && ((value.state === 'value' && typeof value.value === 'number') || (value.state === 'no source yet' && typeof value.reason === 'string'));

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The set of four a bundle may carry: every field the `books` read prints is present and of its type, with its format, vocabulary version, and the two served lists checked as well, so a signed bundle with a malformed block reads as not a bundle, not as a crash in the printer. */
const isBooks = (value: unknown): value is Books =>
  isFields(value) &&
  isFloor(value.floor) &&
  value.format === BUNDLE_FORMAT &&
  typeof value.vocabVersion === 'string' &&
  isFields(value.asOf) &&
  (value.asOf.day === null || typeof value.asOf.day === 'string') &&
  isFields(value.served) &&
  isCount(value.served.total) &&
  Array.isArray(value.served.byWeek) &&
  Array.isArray(value.served.byTuple) &&
  isCount(value.backlog) &&
  isSourced(value.panel) &&
  (value.panelDay === null || typeof value.panelDay === 'string') &&
  isFields(value.demand) &&
  isSourced(value.demand.comparisonReadOwners) &&
  isSourced(value.demand.followOnReads) &&
  isFields(value.goal) &&
  isSourced(value.goal.readYield) &&
  isSourced(value.goal.costPerServedCell) &&
  isSourced(value.goal.yieldPerServedCell);

// A bundle states the floor it applied (`floor`), and a client cannot tell which floor a bundle without one applied, so a format 1 bundle with no `floor` is refused as not a bundle this version reads.
const isBundle = (value: unknown): value is Bundle =>
  isFields(value) && value.format === BUNDLE_FORMAT && typeof value.harness === 'string' && isHarness(value.harness) && typeof value.harnessVersion === 'string' && typeof value.vocabVersion === 'string' && typeof value.floor === 'number' && isFields(value.asOf) && Array.isArray(value.cells) && Array.isArray(value.motifs) && Array.isArray(value.reads) && Array.isArray(value.strata) && (value.floors === undefined || isFloors(value.floors)) && (value.books === undefined || isBooks(value.books));

const signatureHolds = async ({ payload, signature }: SignedBundle, key: PinnedKey): Promise<boolean> => {
  try {
    const verifier = await crypto.subtle.importKey('jwk', { kty: key.kty, crv: key.crv, x: key.x }, 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', verifier, Uint8Array.from(atob(signature), (char) => char.charCodeAt(0)), new TextEncoder().encode(payload));
  } catch {
    return false;
  }
};

/** A key id as the pool sends them: letters, digits, dot, dash, and underscore, 1 to 32 characters. */
export const isKeyId = (kid: string): boolean => /^[A-Za-z0-9._-]{1,32}$/.test(kid);

/** A key id for a message: the id as the pool sends them (letters, digits, dot, dash, underscore), and a stand-in for anything else, since the pool or a man in the middle chose it. */
const keyIdName = (kid: string): string => (isKeyId(kid) ? kid : '(unreadable key id)');

/** The bundle, only when the pinned key signed these bytes for the harness and version that were asked for: another harness's or version's bundle, under a good signature, is still the wrong answer. */
export const verifyBundle = async (signed: unknown, keys: PinnedKeys, harness: Harness, harnessVersion: string, retired: ReadonlySet<string> = RETIRED_KEY_IDS, released: PinnedKeys = RELEASE_KEYS): Promise<{ ok: true; bundle: Bundle } | { ok: false; reason: string }> => {
  if (!isSignedBundle(signed)) return { ok: false, reason: 'not a signed bundle' };
  const kid = signed.kid ?? LEGACY_KEY_ID;
  const named = keyIdName(kid);
  if (retired.has(kid)) return { ok: false, reason: `this bundle is signed with key ${named}, which this release of oars no longer trusts. Upgrade with npm install -g @manyoars/oars` };
  const trusted: PinnedKeys = { ...keys, ...released };
  const key = Object.hasOwn(trusted, kid) ? trusted[kid] : undefined;
  if (key === undefined) return { ok: false, reason: `this bundle is signed with key ${named}, which is not pinned for this server and not shipped in this release of oars. Upgrade with npm install -g @manyoars/oars` };
  if (!(await signatureHolds(signed, key))) return { ok: false, reason: `the signature does not match the key ${named} pinned at login` };
  const bundle: unknown = JSON.parse(signed.payload);
  if (!isBundle(bundle)) return { ok: false, reason: 'not a signed bundle this version reads' };
  if (bundle.vocabVersion !== VOCAB_VERSION) return { ok: false, reason: `this bundle is for vocabulary version ${bundle.vocabVersion}, not ${VOCAB_VERSION}` };
  if (bundle.harness !== harness) return { ok: false, reason: `this bundle is for harness ${bundle.harness}, not ${harness}` };
  if (bundle.harnessVersion !== harnessVersion) return { ok: false, reason: `this bundle is for harness version ${bundle.harnessVersion}, not ${harnessVersion}` };
  return { ok: true, bundle };
};
