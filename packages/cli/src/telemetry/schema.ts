// The closed schema every telemetry event passes before it reaches the spool. A field the schema does not know is dropped and counted, and a value
// that does not fit its rule is dropped the same way, so what the spool holds is bounded by this file, not by whoever wrote the event. A rule admits
// a closed word, a small whole number, or a short list of closed words: never free text, a path, or a URL (none of them fits `TOKEN`).
// Later briefs add event types: add one line to `EVENTS`.
import { ExitCode } from '../errors.js';
import { FIELD_ROWS } from '../sessions/pool-outbox.js';
import { OTHER, HARNESSES } from '../sessions/pool-wire.js';
import { LITERAL, publicModel, publicVersion } from '../sessions/public-vocabulary.js';

/** Bumped when an event type or field changes meaning; every spooled event carries it. */
export const SCHEMA_VERSION = 1;

/** What an event field may hold: a closed word, a whole number, or a list of either. */
export type Value = string | number | string[] | number[];

/** A value a rule admits, or `undefined` for a value it refuses. */
type Rule = (value: unknown) => Value | undefined;
type FieldRules = ReadonlyMap<string, Rule>;

/** A command or option name as the program defines it: letters, digits, and hyphens. No space, slash, dot, colon, or quote. */
const TOKEN = /^[a-z][A-Za-z0-9-]{0,31}$/;

const tokens =
  (max: number): Rule =>
  (value) =>
    Array.isArray(value) && value.length <= max && value.every((entry) => typeof entry === 'string' && TOKEN.test(entry)) ? value.map(String) : undefined;

const whole =
  (max: number): Rule =>
  (value) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;

const oneOf =
  (allowed: readonly string[]): Rule =>
  (value) =>
    typeof value === 'string' && allowed.includes(value) ? value : undefined;

/** A model or harness version as the public vocabulary knows it, else the closed word `other`: a private or gateway name never reaches the spool. */
export const publicWord = (shape: (value: string | null) => string | null, value: unknown): string => {
  if (typeof value !== 'string') return 'other';
  const named = shape(value);
  return named === null || named === LITERAL ? 'other' : named;
};
export const modelWord = (value: unknown): string => publicWord(publicModel, value);
export const versionWord = (value: unknown): string => publicWord(publicVersion, value);

const MODEL_OR_VERSION =
  (word: (value: unknown) => string): Rule =>
  (value) =>
    typeof value === 'string' && word(value) === value ? value : undefined;

/** A short list whose every entry is one of `allowed`. */
const listOf =
  (allowed: readonly string[], max: number): Rule =>
  (value) =>
    Array.isArray(value) && value.length <= max && value.every((entry) => typeof entry === 'string' && allowed.includes(entry)) ? value.map(String) : undefined;
/** A list of whole numbers, none above `max`: the counts that sit beside a list of names. */
const counts =
  (length: number, max: number): Rule =>
  (value) =>
    Array.isArray(value) && value.length <= length && value.every((entry) => typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0 && entry <= max) ? value.map(Number) : undefined;

/** A list of names, every one of them in `allowed`. */
const namesIn =
  (allowed: ReadonlySet<string>, length: number): Rule =>
  (value) =>
    Array.isArray(value) && value.length <= length && value.every((entry) => typeof entry === 'string' && allowed.has(entry)) ? value.map(String) : undefined;

/** A list of values the pool wire's own public vocabulary admits, or the word `other` for one it does not: the caller maps, the schema checks again. */
const publicList =
  (visible: (value: string | null) => string | null, length: number): Rule =>
  (value) =>
    Array.isArray(value) && value.length <= length && value.every((entry) => typeof entry === 'string' && (entry === OTHER || (entry !== LITERAL && visible(entry) === entry))) ? value.map(String) : undefined;

/** A fixed number of lowercase hexadecimal digits: a hash, which names nothing. */
const hex =
  (digits: number): Rule =>
  (value) =>
    typeof value === 'string' && new RegExp(`^[0-9a-f]{${String(digits)}}$`).test(value) ? value : undefined;

/** A problem code as a server names it: lowercase words joined with underscores. No space, slash, dot, colon, or quote, so no path, URL, or sentence fits. */
const CODE = /^[a-z][a-z0-9_]{0,39}$/;
const code: Rule = (value) => (typeof value === 'string' && CODE.test(value) ? value : undefined);

const rules = (fields: { [name: string]: Rule }): FieldRules => new Map(Object.entries(fields));

const DAY_MS = 86_400_000;

/** What went wrong, as a closed word chosen from the exit code; the error's own text never comes here. */
export const ERROR_CLASSES = ['usage', 'auth', 'invalid', 'conflict', 'rate-limited', 'unreachable', 'capped', 'unexpected'] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Which hook fired: the six session hooks, and `gate` for `oars gate hook`. */
export const HOOK_NAMES = ['session-start', 'prompt', 'pre-tool', 'post-tool', 'stop', 'nightly', 'gate'] as const;
/** What a hook came to: it found something, found nothing, found something and held it back (the unexposed arm), or failed. */
export const HOOK_OUTCOMES = ['hit', 'miss', 'held', 'error'] as const;
/** How a recall was asked and by whom. */
export const RECALL_FORMS = ['pattern', 'entity', 'question', 'text', 'legacy'] as const;
export const RECALL_MODES = ['pull', 'push'] as const;
export const RECALL_ARMS = ['shown', 'held'] as const;
/** The read families a recall can serve, as the program names them. */
export const RECALL_FAMILY_NAMES = ['recovery', 'fit', 'cost', 'change', 'live', 'adoption', 'method', 'next-step', 'tool-day', 'version-boundary', 'substitution', 'interaction', 'day-move', 'entity'] as const;
export const FETCH_HARNESSES = ['claude-code', 'cursor', 'codex', 'copilot', 'gemini', 'grok', 'opencode', 'vscode-copilot', 'otel', 'other'] as const;

const BYTES = 1 << 26;
const COUNT = 1_000_000;
/** The built-in error classes a crash may name; any other class (a library's, a program's, or text set as a name) is `other`. */
export const CRASH_CLASSES = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'other'] as const;
export type CrashClass = (typeof CRASH_CLASSES)[number];

const HUGE = 2 ** 50;
const ENTRIES = 1_000_000_000;
const WIRE_NAMES: ReadonlySet<string> = new Set(Object.keys(FIELD_ROWS));
const WIRE_HARNESSES: readonly string[] = [...HARNESSES, OTHER];
/** At most as many names as the register holds, so a batch's whole field list fits. */
const WIRE_LENGTH = WIRE_NAMES.size;

/** One line per event type. */
const EVENTS: ReadonlyMap<string, FieldRules> = new Map([
  ['command', rules({ path: tokens(4), flags: tokens(40), durationMs: whole(DAY_MS), exitCode: whole(255), errorClass: oneOf(ERROR_CLASSES) })],
  ['hook', rules({ name: oneOf(HOOK_NAMES), latencyMs: whole(DAY_MS), outcome: oneOf(HOOK_OUTCOMES), bytes: whole(BYTES), harness: oneOf(WIRE_HARNESSES), harnessVersion: MODEL_OR_VERSION(versionWord), model: MODEL_OR_VERSION(modelWord) })],
  [
    'recall',
    rules({ form: oneOf(RECALL_FORMS), mode: oneOf(RECALL_MODES), families: listOf(RECALL_FAMILY_NAMES, 16), kind: oneOf(['hit', 'miss']), reads: whole(COUNT), evidence: whole(COUNT), tokens: whole(COUNT), arm: oneOf(RECALL_ARMS) }),
  ],
  [
    'deposit',
    rules({
      step: oneOf(['build', 'send']),
      sessions: whole(COUNT),
      batched: whole(COUNT),
      sent: whole(COUNT),
      bytes: whole(BYTES),
      excludedFolder: whole(COUNT),
      excludedTerm: whole(COUNT),
      excludedNoRaw: whole(COUNT),
      excludedNoTerms: whole(COUNT),
      excludedUnreadable: whole(COUNT),
      notEnded: whole(COUNT),
      uncaptured: whole(COUNT),
      refused: whole(COUNT),
      withdrawn: whole(COUNT),
      discarded: whole(COUNT),
    }),
  ],
  ['fetch', rules({ harness: oneOf(FETCH_HARNESSES), fetches: whole(COUNT), etagHits: whole(COUNT), capHits: whole(COUNT), reads: whole(COUNT) })],
  // The nightly snapshot of the session store. `readFailed` is 1 when the store could not be read, and then no count is sent.
  [
    'store-health',
    rules({
      readFailed: whole(1),
      sessions: whole(ENTRIES),
      subagents: whole(ENTRIES),
      skeletons: whole(ENTRIES),
      unparseable: whole(ENTRIES),
      rawBytes: whole(HUGE),
      verifyChecked: whole(ENTRIES),
      verifyFailed: whole(ENTRIES),
      captureVersions: counts(32, 10_000),
      extractorVersions: counts(32, 10_000),
      harnessVersions: publicList(publicVersion, 32),
      models: publicList(publicModel, 32),
      outboxBytes: whole(HUGE),
      egressBytes: whole(HUGE),
    }),
  ],
  // What one nightly run cost. `failed` is 1 when the run failed.
  ['run-cost', rules({ totalMs: whole(DAY_MS), parseMs: whole(DAY_MS), peakRssMb: whole(1_000_000), failed: whole(1) })],
  // An error nobody planned for: its class and a hash of its stack. Never its message.
  ['crash', rules({ errorClass: oneOf(CRASH_CLASSES), stackHash: hex(16) })],
  // One deposit pass, for one harness: the register's field names, and beside them how many batches held each and how many bytes it took.
  [
    'wire',
    rules({
      harness: oneOf(WIRE_HARNESSES),
      batches: whole(ENTRIES),
      bytes: whole(HUGE),
      fields: namesIn(WIRE_NAMES, WIRE_LENGTH),
      present: counts(WIRE_LENGTH, ENTRIES),
      fieldBytes: counts(WIRE_LENGTH, HUGE),
    }),
  ],
  // One send of one batch: whether the pool took it, the HTTP status, and the code of its refusal.
  ['wire-send', rules({ sent: whole(1), status: whole(599), code, bytes: whole(HUGE) })],
]);

export const EVENT_TYPES: readonly string[] = [...EVENTS.keys()];

/** The field names a type admits, so a test can feed every one. */
export const fieldNamesOf = (type: string): string[] => [...(EVENTS.get(type)?.keys() ?? [])];

/** The error class for an exit code: closed words only. */
export const errorClassOf = (exit: ExitCode): ErrorClass | undefined => {
  switch (exit) {
    case ExitCode.OK:
      return undefined;
    case ExitCode.USAGE:
      return 'usage';
    case ExitCode.AUTH:
      return 'auth';
    case ExitCode.INVALID:
      return 'invalid';
    case ExitCode.CONFLICT:
      return 'conflict';
    case ExitCode.RATE_LIMITED:
      return 'rate-limited';
    case ExitCode.UNREACHABLE:
      return 'unreachable';
    case ExitCode.CAPPED:
      return 'capped';
    default:
      return 'unexpected';
  }
};

/** What a field set came to: the fields that fit, and how many did not (an unknown name, or a value its rule refused). */
export interface Sanitized {
  data: { [field: string]: Value };
  dropped: number;
}

/** The lists of a `wire` event that are read index by index, so one refused (or a different length) would leave the others misaligned. */
const PARALLEL_LISTS = ['fields', 'present', 'fieldBytes'];

/** Keeps the parallel lists only when every one sent came through and they are the same length; otherwise none of them, each kept one counted as dropped. */
const alignParallel = (sent: object, data: Sanitized['data'], dropped: number): Sanitized => {
  const given = PARALLEL_LISTS.filter((name) => name in sent);
  const kept = given.filter((name) => data[name] !== undefined);
  // Every rule for these three names returns a list, so `flat` of the one-element wrapper is that list's length.
  const lengths = new Set(kept.map((name) => [data[name]].flat().length));
  if (kept.length === given.length && lengths.size <= 1) return { data, dropped };
  for (const name of kept) Reflect.deleteProperty(data, name);
  return { data, dropped: dropped + kept.length };
};

/** Passes `fields` through the rules of `type`; `undefined` for a type the schema does not know. */
export const sanitize = (type: string, fields: object): Sanitized | undefined => {
  const known = EVENTS.get(type);
  if (known === undefined) return undefined;
  const data: Sanitized['data'] = {};
  let dropped = 0;
  for (const [name, value] of Object.entries(fields)) {
    const accepted = known.get(name)?.(value);
    if (accepted === undefined) dropped += 1;
    else data[name] = accepted;
  }
  return type === 'wire' ? alignParallel(fields, data, dropped) : { data, dropped };
};
