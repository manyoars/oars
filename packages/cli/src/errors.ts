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
  HUMAN: 6,
  RATE_LIMITED: 7,
  UNREACHABLE: 8,
  PARTIAL: 9,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

const codes = (exit: ExitCode, ...names: string[]): Array<[string, ExitCode]> => names.map((name) => [name, exit]);

// Problem codes (or types) from spec 1 §13, T87 and T92. EXPIRED_TOKEN and ACCESS_DENIED are the device flow's own, raised locally.
const BY_CODE: ReadonlyMap<string, ExitCode> = new Map([
  ...codes(ExitCode.AUTH, 'SDK_KEY_INVALID', 'EXPIRED_TOKEN', 'ACCESS_DENIED'),
  ...codes(
    ExitCode.INVALID,
    'MANIFEST_INVALID',
    'MULTI_SERVICE_DISABLED',
    'PRICE_NOT_FOUND',
    'PRICE_INACTIVE',
    'FEE_POLICY_INVALID',
    'LIVE_MODE_REQUIRED',
    'TEST_MODE_ONLY',
  ),
  ...codes(ExitCode.CONFLICT, 'IDEMPOTENCY_CONFLICT', 'WORKLOAD_FINGERPRINT_EXISTS'),
  ...codes(ExitCode.HUMAN, 'ACCOUNT_NOT_READY', 'PAYMENT_METHOD_REQUIRED', 'INSUFFICIENT_CREDITS', 'COMPUTE_CAP_REACHED'),
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

/** What a deploy that stopped after registering leaves behind: the workload, the key shown only once, and the command that resumes. */
export interface PartialDeploy {
  workloadId: string;
  /** Only when the run that failed minted it: no rerun can show it again. */
  sdkKey?: string;
  rerun: string;
}

/** A failure the CLI reports and exits on. `step` names where it happened in `--json` documents. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
    readonly step: string,
    readonly problem: ProblemDetail = { title: message },
    readonly partial?: PartialDeploy,
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

/** A request that never got an answer (after the retries). */
export const unreachableError = (step: string, cause: unknown): CliError =>
  new CliError(`Cannot reach the server: ${cause instanceof Error ? cause.message : String(cause)}`, ExitCode.UNREACHABLE, step);
