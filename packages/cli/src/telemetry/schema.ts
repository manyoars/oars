// The closed schema every telemetry event passes before it reaches the spool. A field the schema does not know is dropped and counted, and a value
// that does not fit its rule is dropped the same way, so what the spool holds is bounded by this file, not by whoever wrote the event. A rule admits
// a closed word, a small whole number, or a short list of closed words: never free text, a path, or a URL (none of them fits `TOKEN`).
// Later briefs add event types: add one line to `EVENTS`.
import { ExitCode } from '../errors.js';

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

const rules = (fields: { [name: string]: Rule }): FieldRules => new Map(Object.entries(fields));

const DAY_MS = 86_400_000;

/** What went wrong, as a closed word chosen from the exit code; the error's own text never comes here. */
export const ERROR_CLASSES = ['usage', 'auth', 'invalid', 'conflict', 'rate-limited', 'unreachable', 'capped', 'unexpected'] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** One line per event type. */
const EVENTS: ReadonlyMap<string, FieldRules> = new Map([
  ['command', rules({ path: tokens(4), flags: tokens(40), durationMs: whole(DAY_MS), exitCode: whole(255), errorClass: oneOf(ERROR_CLASSES) })],
]);

export const EVENT_TYPES: readonly string[] = [...EVENTS.keys()];

export const isEventType = (type: string): boolean => EVENTS.has(type);

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
