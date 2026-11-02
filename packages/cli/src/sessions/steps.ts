// The step log: `pipeline-runs.jsonl`, one row per run of a pipeline step, appended when the step ends (runtime-commons pipeline spec 3.1).
// Local only: it sits in the store directory beside `hook-calls.jsonl`, and `measure` prints the spec 3.2 counters from it.
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { makeRedactor } from './redact.js';
import { CAPTURE_VERSION, EXTRACTOR_VERSION, parseStepRow, type Step, type StepCounts, type StepRow, type StepStatus, type Trigger } from './schema.js';
import { depositKey, digest, newTrace, paths, readRedactDomains, type DepositTrace } from './store.js';

/** Where one run's rows get their identity: the steps of one nightly or manual run share `run`. */
export interface StepContext {
  storeDir: string;
  now: () => number;
  run: string;
  trigger: Trigger;
}

export const newContext = (storeDir: string, now: () => number, trigger: Trigger): StepContext => ({ storeDir, now, run: randomUUID(), trigger });

/** What a step reports when it ends: the counts it read and wrote and its idempotency key (spec 4.2). */
export interface StepReport {
  in: StepCounts;
  out: StepCounts;
  key: string | null;
}

export const appendStep = async (storeDir: string, row: StepRow): Promise<void> => {
  await mkdir(storeDir, { recursive: true });
  await appendFile(paths(storeDir).pipelineRuns, `${JSON.stringify(row)}\n`, { mode: 0o600 });
};

export const readSteps = async (storeDir: string): Promise<StepRow[]> => {
  let text = '';
  try {
    text = await readFile(paths(storeDir).pipelineRuns, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const rows: StepRow[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const row = parseStepRow(JSON.parse(line));
      if (row !== undefined) rows.push(row);
    } catch {
      // A torn last line is skipped.
    }
  }
  return rows;
};

/** The first informative line of a failure, masked like every other text the store keeps (D1's text rule) and cut to 300 characters. */
export const errorLine = async (storeDir: string, error: unknown): Promise<string> => {
  const first = (error instanceof Error ? error.message : String(error)).split('\n').find((line) => line.trim() !== '') ?? 'unknown error';
  return makeRedactor(await readRedactDomains(storeDir))(first).slice(0, 300);
};

/** Appends the row for a step that ended (or was skipped) now, having taken `ms`. */
export const logStep = (context: StepContext, step: Step, status: StepStatus, ms: number, report: StepReport, error: string | null): Promise<void> =>
  appendStep(context.storeDir, {
    at: new Date(context.now()).toISOString(),
    run: context.run,
    trigger: context.trigger,
    step,
    status,
    ms: Math.round(ms),
    in: report.in,
    out: report.out,
    cv: CAPTURE_VERSION,
    ev: EXTRACTOR_VERSION,
    key: report.key,
    error,
  });

/** A step an earlier step of the run left undone (spec 4.4): logged `skipped`, with no counts and no key. */
export const logSkipped = (context: StepContext, step: Step): Promise<void> => logStep(context, step, 'skipped', 0, { in: {}, out: {}, key: null }, null);

/**
 * Runs `work` and logs its row: `ok` with what it reports, or `error` with the failure's first line and `failedKey` (the key the work
 * had, read afterwards because a failed step leaves its inputs as they were), after which the failure goes on to the caller.
 */
export const runStep = async <T>(
  context: StepContext,
  step: Step,
  work: () => Promise<{ value: T; report: StepReport }>,
  failedKey: () => Promise<string | null> = () => Promise.resolve(null),
): Promise<T> => {
  const started = performance.now();
  let done: { value: T; report: StepReport };
  try {
    done = await work();
  } catch (error) {
    await logStep(context, step, 'error', performance.now() - started, { in: {}, out: {}, key: await failedKey() }, await errorLine(context.storeDir, error));
    throw error;
  }
  await logStep(context, step, 'ok', performance.now() - started, done.report, null);
  return done.value;
};

/** The runs of one step and key that failed in a row. Three is the line spec 4.4 draws. */
export const STUCK_RUNS = 3;

export interface StuckStep {
  step: Step;
  key: string;
  /** Failed runs in a row, ending at the newest. */
  runs: number;
  /** The first error line of the newest failure. */
  error: string;
}

/** Keys that failed on three runs in a row (a `skipped` row is no run of its step, an `ok` row ends the streak). */
export const stuckSteps = (rows: readonly StepRow[]): StuckStep[] => {
  const streaks = new Map<string, StuckStep>();
  for (const row of rows) {
    if (row.key === null || row.status === 'skipped') continue;
    const id = `${row.step}:${row.key}`;
    if (row.status === 'ok') {
      streaks.delete(id);
      continue;
    }
    streaks.set(id, { step: row.step, key: row.key, runs: (streaks.get(id)?.runs ?? 0) + 1, error: row.error ?? '' });
  }
  return [...streaks.values()].filter((streak) => streak.runs >= STUCK_RUNS);
};

export interface StepLine {
  step: Step;
  runs: number;
  ok: number;
  error: number;
  skipped: number;
  /** Mean wall time of the runs that ran (not the skipped ones), in ms. */
  meanMs: number;
}

/** The spec 3.2 counters this pipeline can derive locally from the step log. */
export interface StepCounters {
  runs: number;
  steps: StepLine[];
  /** Capture records deposited, by kind, summed over every ok deposit. */
  deposited: StepCounts;
  /** The newest ok derive's output, by type. */
  derived: StepCounts;
  /** The newest ok verify's `out`: invariants checked and passed, `cv-behind` sessions, and stuck steps. */
  verify: StepCounts | null;
  recall: { queries: number; matches: number };
  /** Failed runs by `<step>@<ev>`. */
  failures: StepCounts;
  stuck: StuckStep[];
}

const add = (counts: StepCounts, kind: string, count: number): void => {
  counts[kind] = (counts[kind] ?? 0) + count;
};

export const stepCounters = (rows: readonly StepRow[]): StepCounters => {
  const lines = new Map<Step, { runs: number; ok: number; error: number; skipped: number; ms: number }>();
  const deposited: StepCounts = {};
  const failures: StepCounts = {};
  let derived: StepCounts = {};
  let verify: StepCounts | null = null;
  const recall = { queries: 0, matches: 0 };
  for (const row of rows) {
    const line = lines.get(row.step) ?? { runs: 0, ok: 0, error: 0, skipped: 0, ms: 0 };
    line.runs += 1;
    line[row.status] += 1;
    if (row.status !== 'skipped') line.ms += row.ms;
    lines.set(row.step, line);
    if (row.status === 'error') add(failures, `${row.step}@${row.ev}`, 1);
    if (row.status !== 'ok') continue;
    if (row.step === 'deposit') for (const [kind, count] of Object.entries(row.out)) add(deposited, kind, count);
    if (row.step === 'derive') derived = row.out;
    if (row.step === 'verify') verify = row.out;
    if (row.step === 'recall') {
      recall.queries += 1;
      recall.matches += row.out.matches ?? 0;
    }
  }
  const steps = [...lines.entries()].map(([step, line]): StepLine => ({ step, runs: line.runs, ok: line.ok, error: line.error, skipped: line.skipped, meanMs: line.runs === line.skipped ? 0 : Math.round(line.ms / (line.runs - line.skipped)) }));
  return { runs: rows.length, steps, deposited, derived, verify, recall, failures, stuck: stuckSteps(rows) };
};

export const formatStepCounters = (counters: StepCounters): string => {
  if (counters.runs === 0) return 'pipeline step log: no step has run yet';
  const row = (label: string, value: string): string => `${label.padEnd(36)} ${value.padStart(12)}`;
  const by = (label: string, counts: StepCounts): string[] => Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => row(`${label} ${kind}`, String(count)));
  const verify = counters.verify;
  return [
    row('pipeline step log', 'value'),
    ...counters.steps.flatMap((line) => [row(`${line.step} runs (ok/error/skipped)`, `${String(line.ok)}/${String(line.error)}/${String(line.skipped)}`), row(`${line.step} mean ms`, String(line.meanMs))]),
    ...by('records deposited,', counters.deposited),
    ...by('records derived,', counters.derived),
    ...(verify === null ? [] : [row('invariants passed of checked', `${String(verify.passed ?? 0)}/${String(verify.checked ?? 0)}`), row('cv-behind sessions', String(verify.cvBehind ?? 0))]),
    ...(counters.recall.queries === 0 ? [] : [row('recall queries', String(counters.recall.queries)), row('recall matches', String(counters.recall.matches))]),
    ...by('failed runs,', counters.failures),
    row('stuck steps', String(counters.stuck.length)),
    ...counters.stuck.map((stuck) => `  stuck: ${stuck.step} key ${stuck.key}, ${String(stuck.runs)} runs in a row: ${stuck.error}`),
  ].join('\n');
};

/** A key built from its inputs and `ev` (spec 4.2), hashed; a recall has none in the spec (a lookup writes nothing), so its query is the input. */
export const stampKey = (...parts: readonly string[]): string => digest([EXTRACTOR_VERSION, ...parts]);

/**
 * Runs a deposit and logs its rows: `deposit` with the records it wrote by kind, then, when it ended with the whole-store pass,
 * `derive` (spec 4.1: one derive row per nightly or manual run). A deposit that fails logs `error` and, when a derive was to follow,
 * `skipped` for it (spec 4.4). The SessionEnd hook runs `withDerive` false: derive follows at the nightly run.
 */
export const runDeposit = async <T>(context: StepContext, withDerive: boolean, work: (trace: DepositTrace) => Promise<{ value: T; in: StepCounts }>): Promise<T> => {
  const trace = newTrace();
  const started = performance.now();
  let done: { value: T; in: StepCounts };
  try {
    done = await work(trace);
  } catch (error) {
    await logStep(context, 'deposit', 'error', performance.now() - started, { in: {}, out: {}, key: trace.key ?? (await depositKey(context.storeDir)) }, await errorLine(context.storeDir, error));
    if (withDerive) await logSkipped(context, 'derive');
    throw error;
  }
  const derive = trace.derive;
  await logStep(context, 'deposit', 'ok', performance.now() - started - (derive?.ms ?? 0), { in: done.in, out: trace.kinds, key: trace.key }, null);
  if (derive !== undefined) await logStep(context, 'derive', 'ok', derive.ms, { in: derive.in, out: derive.out, key: derive.key }, null);
  return done.value;
};
