// The step log: `pipeline-runs.jsonl`, one row per run of a pipeline step, appended when the step ends (runtime-commons pipeline spec 3.1).
// Local only: it sits in the store directory beside `hook-calls.jsonl`, and `measure` prints the spec 3.2 counters from it.
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { CliError, ExitCode } from '../errors.js';
import { makeRedactor } from './redact.js';
import { CAPTURE_VERSION, EXTRACTOR_VERSION, parseStepRow, type Step, type StepCounts, type StepRow, type StepStatus, type Trigger } from './schema.js';
import { digest, newTrace, paths, readRedactDomains, type DepositTrace } from './store.js';

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

/**
 * Reduces the home folder to `<home>` in whatever form a path takes: either separator, any letter case (a Windows drive letter, a
 * `transcript_path` from hook stdin). An empty home matches nothing, since splitting on '' would garble the whole message.
 */
const scrubHome = (text: string): string => {
  const home = homedir();
  if (home === '') return text;
  const pattern = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/(?:\\\\|\/)/g, '[\\\\/]');
  return text.replace(new RegExp(pattern, 'gi'), '<home>');
};

/** The first informative line of a failure, masked like every other text the store keeps (D1's text rule) and cut to 300 characters. */
export const errorLine = async (storeDir: string, error: unknown): Promise<string> => {
  const first = (error instanceof Error ? error.message : String(error)).split('\n').find((line) => line.trim() !== '') ?? 'unknown error';
  // A path under the home folder is reduced to `<home>`, so the shared record never holds the user name (the class A rule in docs/sessions-store.md).
  const scrubbed = scrubHome(first);
  // A store whose state.json cannot be read still gets its failure row (spec 4.4): the line is masked with no domains then.
  const domains = await readRedactDomains(storeDir).catch((): string[] => []);
  return makeRedactor(domains)(scrubbed).slice(0, 300);
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

/** Writes a row without ever failing: a log that cannot be appended (or a failure line that cannot be redacted) must not change a step's outcome or hide its real error. */
export const tryLog = async (write: () => Promise<void>): Promise<void> => {
  try {
    await write();
  } catch {
    // The step's value, or its own error, is what the caller gets.
  }
};

/** Logs a failed step: `error`, the failure's first line, and the key the step had from its inputs. */
const logFailure = (context: StepContext, step: Step, ms: number, key: string | null, failure: unknown): Promise<void> =>
  tryLog(async () => logStep(context, step, 'error', ms, { in: {}, out: {}, key }, await errorLine(context.storeDir, failure)));

/**
 * Runs `work` and logs its row: `ok` with what it reports, or `error` with the failure's first line and `failedKey` (a key built from
 * the step's inputs before the work, so a retry of the same work has the same key), after which the failure goes on to the caller.
 */
export const runStep = async <T>(context: StepContext, step: Step, work: () => Promise<{ value: T; report: StepReport }>, failedKey: string): Promise<T> => {
  const started = performance.now();
  let done: { value: T; report: StepReport };
  try {
    done = await work();
  } catch (error) {
    await logFailure(context, step, performance.now() - started, failedKey, error);
    throw error;
  }
  await tryLog(() => logStep(context, step, 'ok', performance.now() - started, done.report, null));
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

/**
 * Keys that failed on three runs in a row, per step and trigger (a nightly that fails every night is not cleared by the `stop` deposits
 * between nights). A `skipped` or `deferred` row is no run of its step (a deferred deposit neither failed nor succeeded: it is waiting in the pending list); an `ok` row ends the open streaks of its own step and trigger, and of its step on the same key under another trigger, because a step's
 * good run can carry a key (verify's high-water mark) that its failed run could not know before the work.
 */
export const stuckSteps = (rows: readonly StepRow[]): StuckStep[] => {
  const streaks = new Map<string, StuckStep>();
  for (const row of rows) {
    if (row.key === null || row.status === 'skipped' || row.status === 'deferred') continue;
    const id = `${row.step}:${row.trigger}:${row.key}`;
    if (row.status === 'ok') {
      // Its own trigger's streaks end whatever key the good run carries; another trigger's streak ends only on the same key, which now has output (spec 4.2).
      for (const open of [...streaks.keys()]) if (open.startsWith(`${row.step}:${row.trigger}:`) || (open.startsWith(`${row.step}:`) && open.endsWith(`:${row.key}`))) streaks.delete(open);
      continue;
    }
    streaks.set(id, { step: row.step, key: row.key, runs: (streaks.get(id)?.runs ?? 0) + 1, error: row.error ?? '' });
  }
  return [...streaks.values()].filter((streak) => streak.runs >= STUCK_RUNS);
};

export interface StepLine {
  step: Step;
  /** The extractor version the runs ran at: spec 3.2 counts step time per `ev`. */
  ev: string;
  runs: number;
  ok: number;
  error: number;
  skipped: number;
  /** Stop deposits that found the store locked and went to the pending list: not failed runs, and not in `error`. */
  deferred: number;
  /** Mean wall time of the runs that ran (not the skipped or deferred ones), in ms. */
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
  /** The newest ok index's output: the recurring signatures and projects it holds. */
  indexed: StepCounts;
  /** The newest ok verify's `out`: invariants checked and passed, `cv-behind` sessions, sessions failing the raw audit (`merkle`), and stuck steps. */
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
  const lines = new Map<string, { step: Step; ev: string; runs: number; ok: number; error: number; skipped: number; deferred: number; ms: number }>();
  const deposited: StepCounts = {};
  const failures: StepCounts = {};
  let derived: StepCounts = {};
  let indexed: StepCounts = {};
  let verify: StepCounts | null = null;
  const recall = { queries: 0, matches: 0 };
  for (const row of rows) {
    const line = lines.get(`${row.step}@${row.ev}`) ?? { step: row.step, ev: row.ev, runs: 0, ok: 0, error: 0, skipped: 0, deferred: 0, ms: 0 };
    line.runs += 1;
    line[row.status] += 1;
    if (row.status !== 'skipped' && row.status !== 'deferred') line.ms += row.ms;
    lines.set(`${row.step}@${row.ev}`, line);
    if (row.status === 'error') add(failures, `${row.step}@${row.ev}`, 1);
    if (row.status !== 'ok') continue;
    if (row.step === 'deposit') for (const [kind, count] of Object.entries(row.out)) add(deposited, kind, count);
    if (row.step === 'derive') derived = row.out;
    if (row.step === 'index') indexed = row.out;
    if (row.step === 'verify') verify = row.out;
    if (row.step === 'recall') {
      recall.queries += 1;
      recall.matches += row.out.matches ?? 0;
    }
  }
  const steps = [...lines.values()].map((line): StepLine => ({ step: line.step, ev: line.ev, runs: line.runs, ok: line.ok, error: line.error, skipped: line.skipped, deferred: line.deferred, meanMs: line.runs === line.skipped + line.deferred ? 0 : Math.round(line.ms / (line.runs - line.skipped - line.deferred)) }));
  return { runs: rows.length, steps, deposited, derived, indexed, verify, recall, failures, stuck: stuckSteps(rows) };
};

export const formatStepCounters = (counters: StepCounters): string => {
  if (counters.runs === 0) return 'pipeline step log: no step has run yet';
  const row = (label: string, value: string): string => `${label.padEnd(40)} ${value.padStart(12)}`;
  const by = (label: string, counts: StepCounts): string[] => Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => row(`${label} ${kind}`, String(count)));
  const verify = counters.verify;
  return [
    row('pipeline step log (all time)', 'value'),
    ...counters.steps.flatMap((line) => [row(`${line.step}@${line.ev} runs (ok/error/skipped)`, `${String(line.ok)}/${String(line.error)}/${String(line.skipped)}`), row(`${line.step}@${line.ev} mean ms`, String(line.meanMs)), ...(line.deferred === 0 ? [] : [row(`${line.step}@${line.ev} deferred (store locked)`, String(line.deferred))])]),
    ...by('records deposited,', counters.deposited),
    ...by('records derived,', counters.derived),
    ...by('index holds,', counters.indexed),
    ...(verify === null ? [] : [row('invariants passed of checked', `${String(verify.passed ?? 0)}/${String(verify.checked ?? 0)}`), row('cv-behind sessions', String(verify.cvBehind ?? 0)), row('sessions failing the raw audit', String(verify.merkle ?? 0))]),
    ...(counters.recall.queries === 0 ? [] : [row('recall queries', String(counters.recall.queries)), row('recall matches', String(counters.recall.matches))]),
    ...by('failed runs,', counters.failures),
    row('stuck steps', String(counters.stuck.length)),
    ...counters.stuck.map((stuck) => `  stuck: ${stuck.step} key ${stuck.key}, ${String(stuck.runs)} runs in a row: ${stuck.error}`),
  ].join('\n');
};

/** A key built from its inputs and `ev` (spec 4.2), hashed; a recall has none in the spec (a lookup writes nothing), so its query is the input. */
export const stampKey = (...parts: readonly string[]): string => digest([EXTRACTOR_VERSION, ...parts]);

/**
 * A deposit's key from its inputs (spec 4.2 names the files' state, which is not known before the work): `cv`, `ev`, the trigger, the allow
 * entries or transcript asked for, and the redact domains. The `stop` hook passes no domains (it reads none), so its key has none.
 */
export const inputKey = (trigger: Trigger, requested: readonly string[], domains: readonly string[]): string =>
  digest([CAPTURE_VERSION, EXTRACTOR_VERSION, trigger, ...[...requested].sort(), '--', ...[...domains].sort()]);

/**
 * Runs a deposit and logs its rows: `deposit` with the records it wrote by kind, then, when it ended with the whole-store pass,
 * `derive` and `index` (spec 4.1: one row per step at a nightly or manual run). `key` is built from the deposit's inputs (the trigger and the transcripts
 * it was asked to deposit), so the failed row and the ok row of one deposit carry the same key and a failure that recovers is not stuck.
 * A deposit that fails logs `error` and, when a derive was to follow, `skipped` for it and for the index (spec 4.4). A derive that fails
 * after the deposit wrote its records logs `deposit` ok, `derive` error, and `index` skipped; an index that fails logs `derive` ok and then
 * `index` error; the failure goes on to the caller. The SessionEnd hook runs
 * `withDerive` false: derive follows at the nightly run.
 */
export const runDeposit = async <T>(context: StepContext, withDerive: boolean, key: string, work: (trace: DepositTrace) => Promise<{ value: T; in: StepCounts }>): Promise<T> => {
  const trace = newTrace();
  const started = performance.now();
  let done: { value: T; in: StepCounts };
  try {
    done = await work(trace);
  } catch (error) {
    // A usage error is the operator's mistake, not a failed run of the step: no row, so repeating it is never "stuck".
    if (error instanceof CliError && error.exitCode === ExitCode.USAGE) throw error;
    await logFailure(context, 'deposit', performance.now() - started, key, error);
    if (withDerive) {
      await tryLog(() => logSkipped(context, 'derive'));
      await tryLog(() => logSkipped(context, 'index'));
    }
    throw error;
  }
  // The pending sessions a deposit took first are inputs it was asked for beside its own transcripts.
  const counted = { ...done.in, ...trace.pending };
  // A Stop deposit that found the store locked wrote nothing and went to the pending list: its own outcome, with the refusal's line.
  const refusal = trace.deferred;
  if (refusal !== undefined) {
    await tryLog(() => logStep(context, 'deposit', 'deferred', performance.now() - started, { in: counted, out: trace.kinds, key }, refusal));
    return done.value;
  }
  const derive = trace.derive;
  const failure = trace.deriveFailure;
  const index = trace.index;
  const indexFailure = trace.indexFailure;
  // The deposit row keeps its own time: the derive and index passes ran inside its work and have rows of their own.
  const passes = (derive?.ms ?? failure?.ms ?? 0) + (index?.ms ?? indexFailure?.ms ?? 0);
  await tryLog(() => logStep(context, 'deposit', 'ok', performance.now() - started - passes, { in: counted, out: trace.kinds, key }, null));
  if (derive !== undefined) await tryLog(() => logStep(context, 'derive', 'ok', derive.ms, { in: derive.in, out: derive.out, key: derive.key }, null));
  if (failure !== undefined) {
    await logFailure(context, 'derive', failure.ms, failure.key, failure.error);
    await tryLog(() => logSkipped(context, 'index'));
    throw failure.error;
  }
  if (index !== undefined) await tryLog(() => logStep(context, 'index', 'ok', index.ms, { in: index.in, out: index.out, key: index.key }, null));
  if (indexFailure !== undefined) {
    await logFailure(context, 'index', indexFailure.ms, indexFailure.key, indexFailure.error);
    throw indexFailure.error;
  }
  return done.value;
};
