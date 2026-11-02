// The `oars sessions` command group's bodies: each returns the `--json` document and the text a human sees.
import { readFile } from 'node:fs/promises';
import type { Outcome } from '../cli.js';
import { parseAllowList } from './allow.js';
import { CliError, ExitCode } from '../errors.js';
import { books, formatBooks, formatMeasure, formatRecall, measure, recall, type BooksBy, type RecallQuery } from './query.js';
import { readHookCalls } from './hook-calls.js';
import { buildIndex, contextBlock, inRepository, readIndex, type ContextOptions } from './hook-index.js';
import { hookStatus, installHooks, scheduleStatus, setSchedule, settingsPath, uninstallHooks, type InstallRuntime, type Scope } from './install.js';
import { serve } from './mcp.js';
import { CAPTURE_VERSION } from './schema.js';
import { deposit, loadStore, readCalls, readRedactDomains, readSkeletons, slugOf, type SessionsRuntime, type Store } from './store.js';
import { formatVerify, verifyAll, verifyCaptured, type InvariantResult } from './verify.js';

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
  const result = await deposit(runtimeOf(deps), { allow: [...options.allow, ...fromFiles.flat()], redactDomains: options.redactDomains, now: deps.now });
  const lines = [
    `Deposited ${String(result.sessions)} sessions and ${String(result.subagents)} subagent transcripts (${String(result.lines)} lines, ${String(result.badLines)} unparseable) as ${String(result.observations)} observations; ${String(result.unchanged)} files unchanged.`,
    `Read ${String(result.folders.length)} folders; skipped ${String(result.skippedFolders)} not on the allowlist.`,
    ...(result.cursor === 0 ? [] : [`Read ${String(result.cursor)} Cursor sessions.`]),
    ...result.cursorUnreadable.map((reason) => `Cursor store not read: ${reason}`),
    ...(result.missing.length === 0 ? [] : [`No project folder matched: ${result.missing.join(', ')}.`]),
  ];
  return { document: { ok: true, ...result }, text: lines.join('\n') };
};

export const sessionsRecall = async (deps: SessionsDeps, query: RecallQuery): Promise<Outcome> => {
  if (query.error === undefined && query.path === undefined && query.cls === undefined) {
    throw new CliError('Pass --error "<text>", --path <file>, or --class <name>.', ExitCode.USAGE, 'usage');
  }
  const { storeDir } = runtimeOf(deps);
  const result = recall(await loadStore(storeDir), query, deps.now(), undefined, await readRedactDomains(storeDir));
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

/**
 * The store restricted to one repository (the test `measure --repo` uses). `books` reads its rows from `prompts` alone, and looks a
 * subagent up by the kept prompt that spawned it, so the kept sessions and prompts are enough; the kept subagents only keep the
 * newer-capture count to this repository.
 */
const inRepositoryStore = (store: Store, repo: string): Store => {
  const sessions = store.sessions.filter((session) => inRepository(session.project, repo));
  const mains = new Set(sessions.map((session) => session.session));
  const subagents = store.subagents.filter((agent) => agent.parent !== null && mains.has(agent.parent));
  const newer = (cv: string): boolean => Number(cv) > Number(CAPTURE_VERSION);
  return {
    ...store,
    sessions,
    subagents,
    prompts: store.prompts.filter((prompt) => mains.has(prompt.session)),
    newerCaptures: [...sessions, ...subagents].filter((record) => newer(record.cv)).length,
  };
};

export const sessionsBooks = async (deps: SessionsDeps, options: { by: BooksBy; sinceDays: number | undefined; repo?: string }): Promise<Outcome> => {
  const loaded = await loadStore(runtimeOf(deps).storeDir);
  const store = options.repo === undefined ? loaded : inRepositoryStore(loaded, options.repo);
  const rows = books(store, options.by, deps.now(), options.sinceDays);
  return { document: { ok: true, by: options.by, rows, newerCaptures: store.newerCaptures }, text: [formatBooks(rows, options.by), ...newerNotice(store)].join('\n') };
};

export const sessionsMeasure = async (deps: SessionsDeps, options: { last: number; since: string | undefined; repo?: string }): Promise<Outcome> => {
  const runtime = runtimeOf(deps);
  const loaded = await loadStore(runtime.storeDir);
  const { repo } = options;
  // The same repository test recall uses, so worktrees and subfolders count; other repositories' errors drop out with their sessions.
  const store = repo === undefined ? loaded : { ...loaded, sessions: loaded.sessions.filter((session) => inRepository(session.project, repo)) };
  // A call with a folder counts only for its own repository; an older call has none and counts for every repository.
  const calls = (await readCalls(runtime.storeDir)).filter((call) => repo === undefined || call.cwd === undefined || inRepository(slugOf(call.cwd), repo));
  const result = measure(store, calls, await readHookCalls(runtime.storeDir), options.last, options.since);
  return { document: { ok: true, ...result, newerCaptures: store.newerCaptures }, text: [formatMeasure(result), ...newerNotice(store)].join('\n') };
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
  const { skeletons, unreadable } = await readSkeletons(storeDir, options.session);
  const store = await loadStore(storeDir);
  const mine = <T extends { session: string }>(records: readonly T[]): T[] => records.filter((record) => options.session === undefined || record.session === options.session);
  const results = [...verifyAll(skeletons), ...verifyCaptured(mine([...store.sessions, ...store.subagents]), mine(store.tools))];
  const report: VerifyReport = { sessions: skeletons.length, unreadable, invariants: results.map((result) => ({ ...result, pass: result.violations === 0 })) };
  const failed = [...results.filter((result) => result.violations > 0).map((result) => result.name), ...(unreadable > 0 ? ['unreadable skeletons'] : [])];
  return {
    failed,
    report,
    document: { ok: true, ...report, newerCaptures: store.newerCaptures },
    text: [formatVerify(results, skeletons.length), ...newerNotice(store), ...(unreadable > 0 ? [`FAIL  ${String(unreadable)} unreadable skeleton files (torn or corrupted); redeposit to rebuild them`] : [])].join('\n'),
  };
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
