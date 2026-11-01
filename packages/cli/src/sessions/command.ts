// The `oars sessions` command group's bodies: each returns the `--json` document and the text a human sees.
import type { Outcome } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import { books, formatBooks, formatMeasure, formatRecall, measure, recall, type BooksBy, type RecallQuery } from './query.js';
import { buildIndex, contextBlock, readIndex, type ContextOptions } from './hook-index.js';
import { serve } from './mcp.js';
import { deposit, loadStore, readCalls, readRedactDomains, readSkeletons, type SessionsRuntime } from './store.js';
import { formatVerify, verifyAll, type InvariantResult } from './verify.js';

export interface SessionsDeps {
  sessions: SessionsRuntime | undefined;
  now: () => number;
}

const runtimeOf = (deps: SessionsDeps): SessionsRuntime => {
  if (deps.sessions === undefined) throw new CliError('The session store is not configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
  return deps.sessions;
};

export const sessionsDeposit = async (deps: SessionsDeps, options: { allow: string[]; redactDomains: string[] }): Promise<Outcome> => {
  const result = await deposit(runtimeOf(deps), { allow: options.allow, redactDomains: options.redactDomains, now: deps.now });
  const lines = [
    `Deposited ${String(result.sessions)} sessions (${String(result.lines)} lines, ${String(result.badLines)} unparseable) as ${String(result.observations)} observations; ${String(result.unchanged)} files unchanged.`,
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

export const sessionsBooks = async (deps: SessionsDeps, options: { by: BooksBy; sinceDays: number | undefined }): Promise<Outcome> => {
  const rows = books(await loadStore(runtimeOf(deps).storeDir), options.by, deps.now(), options.sinceDays);
  return { document: { ok: true, by: options.by, rows }, text: formatBooks(rows, options.by) };
};

export const sessionsMeasure = async (deps: SessionsDeps, options: { last: number }): Promise<Outcome> => {
  const runtime = runtimeOf(deps);
  const result = measure(await loadStore(runtime.storeDir), await readCalls(runtime.storeDir), options.last);
  return { document: { ok: true, ...result }, text: formatMeasure(result) };
};

export interface VerifyReport {
  sessions: number;
  /** Skeleton files that could not be parsed: not an invariant, so counted apart from them. */
  unreadable: number;
  invariants: Array<InvariantResult & { pass: boolean }>;
}

/** With `strict`, any violated invariant also fails the command (exit 4) after the full report is printed; the report is built first so callers can emit it. */
export const sessionsVerify = async (deps: SessionsDeps, options: { session: string | undefined }): Promise<Outcome & { failed: string[]; report: VerifyReport }> => {
  const { skeletons, unreadable } = await readSkeletons(runtimeOf(deps).storeDir, options.session);
  const results = verifyAll(skeletons);
  const report: VerifyReport = { sessions: skeletons.length, unreadable, invariants: results.map((result) => ({ ...result, pass: result.violations === 0 })) };
  const failed = [...results.filter((result) => result.violations > 0).map((result) => result.name), ...(unreadable > 0 ? ['unreadable skeletons'] : [])];
  return {
    failed,
    report,
    document: { ok: true, ...report },
    text: [formatVerify(results, skeletons.length), ...(unreadable > 0 ? [`FAIL  ${String(unreadable)} unreadable skeleton files (torn or corrupted); redeposit to rebuild them`] : [])].join('\n'),
  };
};
