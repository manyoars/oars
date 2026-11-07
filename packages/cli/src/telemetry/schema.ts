// The closed schema every telemetry event passes before it reaches the spool. A field the schema does not know is dropped and counted, and a value
// that does not fit its rule is dropped the same way, so what the spool holds is bounded by this file, not by whoever wrote the event. A rule admits
// a closed word, a small whole number, or a short list of closed words: never free text, a path, or a URL (none of them fits `TOKEN`).
// Later briefs add event types: add one line to `EVENTS`.
import { ExitCode } from '../errors.js';
import { LITERAL, publicModel, publicVersion } from '../sessions/public-vocabulary.js';

/** Bumped when an event type or field changes meaning; every spooled event carries it. */
export const SCHEMA_VERSION = 1;

/** A value a rule admits, or `undefined` for a value it refuses. */
type Rule = (value: unknown) => string | number | string[] | undefined;
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

const rules = (fields: { [name: string]: Rule }): FieldRules => new Map(Object.entries(fields));

const DAY_MS = 86_400_000;

/** What went wrong, as a closed word chosen from the exit code; the error's own text never comes here. */
export const ERROR_CLASSES = ['usage', 'auth', 'invalid', 'conflict', 'rate-limited', 'unreachable', 'capped', 'unexpected'] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Which hook fired: the five session hooks, and `gate` for `oars gate hook`. */
export const HOOK_NAMES = ['session-start', 'pre-tool', 'post-tool', 'stop', 'nightly', 'gate'] as const;
/** What a hook came to: it found something, found nothing, found something and held it back (the unexposed arm), or failed. */
export const HOOK_OUTCOMES = ['hit', 'miss', 'held', 'error'] as const;
/** How a recall was asked and by whom. */
export const RECALL_FORMS = ['pattern', 'entity', 'question', 'text', 'legacy'] as const;
export const RECALL_MODES = ['pull', 'push'] as const;
export const RECALL_ARMS = ['shown', 'held'] as const;
/** The read families a recall can serve, as the program names them. */
export const RECALL_FAMILY_NAMES = ['recovery', 'fit', 'cost', 'change', 'live', 'adoption', 'method', 'next-step', 'tool-day', 'version-boundary', 'substitution', 'interaction', 'day-move'] as const;
export const FETCH_HARNESSES = ['claude-code', 'cursor', 'codex', 'copilot', 'gemini', 'grok', 'vscode-copilot', 'other'] as const;

const BYTES = 1 << 26;
const COUNT = 1_000_000;

/** One line per event type. */
const EVENTS: ReadonlyMap<string, FieldRules> = new Map([
  ['command', rules({ path: tokens(4), flags: tokens(40), durationMs: whole(DAY_MS), exitCode: whole(255), errorClass: oneOf(ERROR_CLASSES) })],
  ['hook', rules({ name: oneOf(HOOK_NAMES), latencyMs: whole(DAY_MS), outcome: oneOf(HOOK_OUTCOMES), bytes: whole(BYTES), harnessVersion: MODEL_OR_VERSION(versionWord), model: MODEL_OR_VERSION(modelWord) })],
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
  data: { [field: string]: string | number | string[] };
  dropped: number;
}

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
  return { data, dropped };
};
