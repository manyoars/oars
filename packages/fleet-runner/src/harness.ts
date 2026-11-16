// The harness adapter: the seam between the runner and a real harness (Claude Code on Bedrock, later). `prepare` does the spec section 3 reset in a temp folder,
// `run` drives the harness headless, `check` runs the task's check script. The runner decides void or valid from what these report (spec section 9).
// The only adapter in this package is the scripted fake (`fake-harness.ts`); a real one is a later brief.
import type { Order } from './order.js';

export type ExitKind = 'ok' | 'crash' | 'api-error' | 'rate-limit' | 'auth-rejected' | 'disk-full' | 'network-down';

export interface ToolPin {
  name: string;
  pin: string;
}

/** What the order says a run must be; `prepare` and `run` report what they saw, and any difference voids the run. */
export interface Expected {
  taskSetVersion: string;
  fixtureTag: string;
  manifestVersion: string;
  harnessVersion: string;
  modelId: string;
  /** The tools that must be installed, with pins; empty for the no-tool arm. */
  toolPins: ToolPin[];
}

export interface RunRequest {
  runId: string;
  /** 1-based number of this run among all runs started in the order, void ones included. */
  sequence: number;
  /** 1-based try at this slot: 1 for the first run, 2 for the rerun after a void run. */
  attempt: number;
  order: Order;
  taskId: string;
  category: string;
  arm: string;
  side: string | null;
  repeat: number;
  expected: Expected;
}

export interface Prepared {
  /** The temp folder of this run. */
  dir: string;
  /** The tools found installed in the harness config folder. */
  installedPins: ToolPin[];
  taskSetVersion: string;
  fixtureTag: string;
  manifestVersion: string;
  /** Deletes the temp folder (spec section 3: after the run no run sees another run's files). */
  dispose: () => Promise<void>;
}

export interface TokenCounts {
  input: number;
  cache: number;
  output: number;
}

export interface RunResult {
  exit: { kind: ExitKind; code: number };
  /** The harness's transcript in the temp folder; null when it wrote none. */
  transcriptPath: string | null;
  harnessVersion: string;
  modelId: string;
  tokens: TokenCounts;
  /** The pool session id of the transcript, when the adapter can read it; null here. */
  poolSessionId: string | null;
}

export type CheckResult = 'pass' | 'fail';

export interface HarnessAdapter {
  prepare: (request: RunRequest) => Promise<Prepared>;
  run: (prepared: Prepared, request: RunRequest) => Promise<RunResult>;
  check: (prepared: Prepared, request: RunRequest) => Promise<CheckResult>;
}
