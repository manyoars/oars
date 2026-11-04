import type { components } from '@manyoars/oars-client';

export type ProblemDetail = components['schemas']['ProblemDetail'];

/** Design §3.2's exit-code table. */
export const ExitCode = {
  OK: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  AUTH: 3,
  INVALID: 4,
  CONFLICT: 5,
  RATE_LIMITED: 7,
  UNREACHABLE: 8,
  /** `pool fetch` hit the pool's weekly cap: nothing is wrong, and the bundle on disk is untouched. */
  CAPPED: 10,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

const codes = (exit: ExitCode, ...names: string[]): Array<[string, ExitCode]> => names.map((name) => [name, exit]);

// Problem codes (or types) from spec 1 §13, T87 and T92. EXPIRED_TOKEN and ACCESS_DENIED are the device flow's own, raised locally.
const BY_CODE: ReadonlyMap<string, ExitCode> = new Map([
  ...codes(ExitCode.AUTH, 'EXPIRED_TOKEN', 'ACCESS_DENIED'),
  ...codes(ExitCode.CONFLICT, 'IDEMPOTENCY_CONFLICT'),
  ...codes(ExitCode.RATE_LIMITED, 'RATE_LIMITED'),
]);

/** The exit code for a failed response. The problem's code (then its type) decides; the status covers what has none. Text is never read. */
export const exitCodeForProblem = (status: number, problem?: ProblemDetail): ExitCode => {
  const key = problem?.code ?? problem?.type;
  const byCode = key === undefined ? undefined : BY_CODE.get(key);
  if (byCode !== undefined) return byCode;
  if (status === 401 || status === 403) return ExitCode.AUTH;
  if (status === 400 || status === 422) return ExitCode.INVALID;
  if (status === 429) return ExitCode.RATE_LIMITED;
  if (status === 502 || status === 503 || status === 504) return ExitCode.UNREACHABLE;
  return ExitCode.UNEXPECTED;
};

/** A failure the CLI reports and exits on. `step` names where it happened in `--json` documents. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
    readonly step: string,
    readonly problem: ProblemDetail = { title: message },
    /** Extra fields for the `--json` failure document, such as the invariants a strict verify failed. */
    readonly details?: object,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** Keeps the known string fields of a response body that should be a ProblemDetail; anything else (HTML from a proxy) is no problem. */
export const toProblem = (body: unknown): ProblemDetail | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const problem: ProblemDetail = {};
  for (const key of ['actionUrl', 'code', 'detail', 'title', 'type'] as const) {
    const value: unknown = Reflect.get(body, key);
    if (typeof value === 'string') problem[key] = value;
  }
  return problem;
};

/** A CliError for a non-2xx response; its message is the problem's title, else detail, else the status. */
export const problemError = (step: string, status: number, body: unknown): CliError => {
  const problem = toProblem(body);
  const message = problem?.title ?? problem?.detail ?? `The platform answered HTTP ${String(status)}`;
  return new CliError(message, exitCodeForProblem(status, problem), step, { ...problem, title: message, status });
};

/** The network's own reason for a failed fetch: the first of these that is not blank. */
const reasonOf = (error: Error): string => {
  const inner = error.cause;
  if (!(inner instanceof Error)) return error.message === '' ? 'no reason given' : error.message;
  // Node 24 tries every address of a dual-stack host and reports an AggregateError whose own message is empty.
  const first = inner instanceof AggregateError && inner.errors[0] instanceof Error ? inner.errors[0].message : '';
  const code = 'code' in inner && typeof inner.code === 'string' ? inner.code : '';
  return [first, inner.message, code, error.message].find((reason) => reason !== '') ?? 'no reason given';
};

/**
 * A request that never got an answer (after the retries). Node's fetch reports every network failure as "fetch failed" and keeps
 * the reason (`getaddrinfo ENOTFOUND host`, `connect ECONNREFUSED`) on its cause, so the message gives that reason, and names
 * `server` when the caller knows it: a user whose server does not resolve yet can see which one.
 */
export const unreachableError = (step: string, cause: unknown, server?: string): CliError => {
  const reason = cause instanceof Error ? reasonOf(cause) : String(cause);
  return new CliError(`Cannot reach the server${server === undefined ? '' : ` at ${server}`}: ${reason}`, ExitCode.UNREACHABLE, step);
};
