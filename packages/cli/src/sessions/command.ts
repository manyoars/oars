// The `oars sessions` command group's bodies: each returns the `--json` document and the text a human sees.
import { readFile } from 'node:fs/promises';
import type { Outcome } from '../cli.js';
import { parseAllowList } from './allow.js';
import { CliError, ExitCode } from '../errors.js';
import { books, formatBooks, formatMeasure, formatRecall, measure, recall, type BooksBy, type RecallQuery } from './query.js';
import { readHookCalls } from './hook-calls.js';
import { buildIndex, contextBlock, readIndex, type ContextOptions } from './hook-index.js';
import { hookStatus, installHooks, scheduleStatus, setSchedule, settingsPath, uninstallHooks, type InstallRuntime, type Scope } from './install.js';
import { serve } from './mcp.js';
import { deposit, loadStore, readCalls, readRedactDomains, readSkeletons, type SessionsRuntime, type Store } from './store.js';
import { formatStepCounters, newContext, readSteps, stampKey, runDeposit, runStep, stepCounters, stuckSteps } from './steps.js';
import { CAPTURE_INVARIANTS, formatVerify, verifyAll, verifyCaptured, type InvariantResult } from './verify.js';

export interface SessionsDeps {
  sessions: SessionsRuntime | undefined;
  install: InstallRuntime | undefined;
  now: () => number;
}

const runtimeOf = (deps: SessionsDeps): SessionsRuntime => {
  if (deps.sessions === undefined) throw new CliError('The session store is not configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
  return deps.sessions;
};

const readAllowFile = async (file: string): Promise<string[]> => {
  try {
    return parseAllowList(await readFile(file, 'utf8'));
  } catch {
    throw new CliError(`Cannot read the --allow-file ${file}.`, ExitCode.USAGE, 'usage');
  }
};

export const sessionsDeposit = async (deps: SessionsDeps, options: { allow: string[]; allowFiles: string[]; redactDomains: string[] }): Promise<Outcome> => {
  const fromFiles = await Promise.all(options.allowFiles.map((file) => readAllowFile(file)));
  const runtime = runtimeOf(deps);
  const result = await runDeposit(newContext(runtime.storeDir, deps.now, 'manual'), true, async (trace) => {
    const done = await deposit(runtime, { allow: [...options.allow, ...fromFiles.flat()], redactDomains: options.redactDomains, now: deps.now }, trace);
    return { value: done, in: { transcript: done.sessions + done.subagents + done.unchanged } };
  });
  const lines = [
    `Deposited ${String(result.sessions)} sessions and ${String(result.subagents)} subagent transcripts (${String(result.lines)} lines, ${String(result.badLines)} unparseable) as ${String(result.observations)} observations; ${String(result.unchanged)} files unchanged.`,
    `Read ${String(result.folders.length)} folders; skipped ${String(result.skippedFolders)} not on the allowlist.`,
    ...(result.missing.length === 0 ? [] : [`No project folder matched: ${result.missing.join(', ')}.`]),
  ];
  return { document: { ok: true, ...result }, text: lines.join('\n') };
};

export const sessionsRecall = async (deps: SessionsDeps, query: RecallQuery): Promise<Outcome> => {
  if (query.error === undefined && query.path === undefined && query.cls === undefined) {
    throw new CliError('Pass --error "<text>", --path <file>, or --class <name>.', ExitCode.USAGE, 'usage');
  }
  const { storeDir } = runtimeOf(deps);
  const result = await runStep(newContext(storeDir, deps.now, 'manual'), 'recall', async () => {
    const found = recall(await loadStore(storeDir), query, deps.now(), undefined, await readRedactDomains(storeDir));
    const key = stampKey(query.error ?? '', query.path ?? '', query.cls ?? '', String(query.sinceDays ?? ''));
    return { value: found, report: { in: { query: 1 }, out: { matches: found.matches.length }, key } };
  });
  return { document: { ok: true, ...result }, text: formatRecall(result) };
};

/** `recall --context`: the injection block for a repository, from the hook index (built from the store when no deposit has written one). */
export const sessionsContext = async (deps: SessionsDeps, options: ContextOptions): Promise<Outcome> => {
  const { storeDir } = runtimeOf(deps);
  const index = (await readIndex(storeDir)) ?? buildIndex(await loadStore(storeDir), await readRedactDomains(storeDir), new Date(deps.now()).toISOString());
  const block = contextBlock(index, options);
  return { document: { ok: true, context: block ?? null }, text: block ?? 'Nothing recurs in this repository yet.' };
};

export const sessionsMcp = async (deps: SessionsDeps): Promise<void> => {
  await serve(runtimeOf(deps), deps.now);
};

/** One line for a store a newer oars wrote into (spec state-on-open row for a newer `cv`: read known fields, warn). */
const newerNotice = (store: Store): string[] => (store.newerCaptures > 0 ? [`captured by a newer oars; upgrade oars (${String(store.newerCaptures)} sessions)`] : []);

export const sessionsBooks = async (deps: SessionsDeps, options: { by: BooksBy; sinceDays: number | undefined }): Promise<Outcome> => {
  const store = await loadStore(runtimeOf(deps).storeDir);
  const rows = books(store, options.by, deps.now(), options.sinceDays);
  return { document: { ok: true, by: options.by, rows, newerCaptures: store.newerCaptures }, text: [formatBooks(rows, options.by), ...newerNotice(store)].join('\n') };
};

export const sessionsMeasure = async (deps: SessionsDeps, options: { last: number; since: string | undefined }): Promise<Outcome> => {
  const runtime = runtimeOf(deps);
  const store = await loadStore(runtime.storeDir);
  const result = measure(store, await readCalls(runtime.storeDir), await readHookCalls(runtime.storeDir), options.last, options.since);
  const steps = stepCounters(await readSteps(runtime.storeDir));
  return { document: { ok: true, ...result, steps, newerCaptures: store.newerCaptures }, text: [formatMeasure(result), formatStepCounters(steps), ...newerNotice(store)].join('\n') };
};

export interface VerifyReport {
  sessions: number;
  /** Skeleton files that could not be parsed: not an invariant, so counted apart from them. */
  unreadable: number;
  invariants: Array<InvariantResult & { pass: boolean }>;
}

/** With `strict`, any violated invariant also fails the command (exit 4) after the full report is printed; the report is built first so callers can emit it. */
export const sessionsVerify = async (deps: SessionsDeps, options: { session: string | undefined }): Promise<Outcome & { failed: string[]; report: VerifyReport }> => {
  const { storeDir } = runtimeOf(deps);
  return runStep(newContext(storeDir, deps.now, 'manual'), 'verify', async () => {
    const { skeletons, unreadable } = await readSkeletons(storeDir, options.session);
    const store = await loadStore(storeDir);
    const mine = <T extends { session: string }>(records: readonly T[]): T[] => records.filter((record) => options.session === undefined || record.session === options.session);
    const results = [...verifyAll(skeletons), ...verifyCaptured(mine([...store.sessions, ...store.subagents]), mine(store.tools))];
    const report: VerifyReport = { sessions: skeletons.length, unreadable, invariants: results.map((result) => ({ ...result, pass: result.violations === 0 })) };
    const failed = [...results.filter((result) => result.violations > 0).map((result) => result.name), ...(unreadable > 0 ? ['unreadable skeletons'] : [])];
    // Steps whose key failed on three runs in a row (spec 4.4), read before this run's own row is appended.
    const stuck = stuckSteps(await readSteps(storeDir));
    const stuckLines = stuck.map((entry) => `FAIL  ${entry.step} is stuck: key ${entry.key} failed ${String(entry.runs)} runs in a row: ${entry.error}`);
    const highWater = [...mine(store.sessions)].map((session) => `${session.session}:${String(session.rev)}:${session.cv}`).sort();
    const outcome = {
      failed,
      report,
      document: { ok: true, ...report, stuck, newerCaptures: store.newerCaptures },
      text: [formatVerify(results, skeletons.length), ...newerNotice(store), ...(unreadable > 0 ? [`FAIL  ${String(unreadable)} unreadable skeleton files (torn or corrupted); redeposit to rebuild them`] : []), ...stuckLines].join('\n'),
    };
    const cvBehind = results.find((result) => result.name === CAPTURE_INVARIANTS[0])?.violations ?? 0;
    // The key is the sessions checked, each at its rev and cv, and the code's ev (spec 4.2).
    const key = stampKey(...highWater);
    const counts = { checked: results.length, passed: results.filter((result) => result.violations === 0).length, cvBehind, stuck: stuck.length };
    return { value: outcome, report: { in: { session: highWater.length }, out: counts, key } };
  });
};

const installOf = (deps: SessionsDeps): InstallRuntime => {
  if (deps.install === undefined) throw new CliError('Hook install is not configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
  return deps.install;
};

export interface HookTarget {
  scope: Scope | undefined;
  file: string | undefined;
}

export const sessionsHookInstall = async (deps: SessionsDeps, options: HookTarget & { keepRetention: boolean; schedule: 'nightly' | 'off' | undefined }): Promise<Outcome> => {
  const runtime = installOf(deps);
  const lines: string[] = [];
  const document: { ok: true; install?: object; schedule?: string } = { ok: true };
  // `--schedule` alone touches no settings file: nothing is written to one the operator has not named.
  if (options.schedule === undefined || options.scope !== undefined || options.file !== undefined) {
    const file = settingsPath(runtime, options.scope ?? 'file', options.file);
    const result = await installHooks(runtime, file, options.keepRetention);
    document.install = result;
    lines.push(`Installed ${result.installed.join(', ')} hooks in ${file}.`, result.retention);
  }
  if (options.schedule !== undefined) {
    const line = await setSchedule(runtime, options.schedule);
    document.schedule = line;
    lines.push(line);
  }
  return { document, text: lines.join('\n') };
};

export const sessionsHookUninstall = async (deps: SessionsDeps, options: HookTarget): Promise<Outcome> => {
  const runtime = installOf(deps);
  const file = settingsPath(runtime, options.scope ?? 'file', options.file);
  const result = await uninstallHooks(file);
  const text = result.removed.length === 0 ? `No Many Oars hooks in ${file}.` : `Removed ${result.removed.join(', ')} hooks from ${file}; other settings and hooks are untouched (cleanupPeriodDays is left as it is).`;
  return { document: { ok: true, ...result }, text };
};

export const sessionsHookStatus = async (deps: SessionsDeps, options: { file: string | undefined }): Promise<Outcome> => {
  const runtime = installOf(deps);
  const files = await hookStatus(runtime, options.file);
  const schedule = await scheduleStatus(runtime);
  const lines = files.map((item) => `${item.scope}: ${item.file}: ${item.installed.length === 0 ? 'no hooks' : item.installed.join(', ')} (cleanupPeriodDays ${String(item.retentionDays)})`);
  return { document: { ok: true, files, schedule }, text: [...lines, schedule].join('\n') };
};
