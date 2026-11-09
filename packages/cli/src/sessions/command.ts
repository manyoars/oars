// The `oars sessions` command group's bodies: each returns the `--json` document and the text a human sees.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Outcome } from '../cli.js';
import { denialOf, parseAllowList, runAllow } from './allow.js';
import { SOURCES, sourceLabel, type Source } from './sources.js';
import { CliError, ExitCode } from '../errors.js';
import { loadTerms } from './exclusion.js';
import { EVALUATOR_MODEL, fillArms, sidecarSaver } from './gold-arms.js';
import { armsPath, coverageLines, formatScore, isGoldDocument, parseGold, plural, renderGold, sampleGold, scoreGold, type GoldDocument } from './gold.js';
import { makeRedactor } from './redact.js';
import { books, BOOKS_CAVEAT, formatBooks, formatMeasure, formatRecall, measure, type BooksBy } from './query.js';
import { formatLineage, loadLineage, walkLineage } from './lineage.js';
import type { Emit } from '../telemetry/emit.js';
import { recallFields } from '../telemetry/fields.js';
import { appendRecall, readRecalls } from './recall-object.js';
import { deriveConsequences, formatRecallCounts, recallCounts } from './recall-consequence.js';
import { pull, pullRefusal, type PullInput } from './recall-reads.js';
import { MISS_TEXT } from './recall-render.js';
import { EMPTY_RECALL, emptyBooks, nothingFoundLines, savedListNote } from './empty-state.js';
import { readHookCalls } from './hook-calls.js';
import { buildIndex, contextBlock, inRepository, readIndex, type ContextOptions } from './hook-index.js';
import { CODEX_TRUST_NOTICE, codexHookStatus, installCodexHook, uninstallCodexHook, type CodexInstall } from './codex-hook-install.js';
import { enrollmentOf } from './machine.js';
import { hookStatus, installHooks, installMachineHooks, readSettings, removeSchedule, SCHEDULE_REFUSED, scheduleStatus, settingsPath, uninstallHooks, type InstallRuntime, type Scope } from './install.js';
import { recordSchedule } from './pool-due.js';
import { serve } from './mcp.js';
import { refreshPool, servedPool } from './pool.js';
import { recallPool } from './recall-bundle.js';
import { booksLines, lastFetchedBundle } from './pool-books.js';
import { formatPackageBooks, packageBooks } from './package-books.js';
import { scanStore } from './exclusion.js';
import { vocabulary } from './vocab-load.js';
import { FAMILIES } from './read.js';
import { formatNotReadable, notReadable } from './read-readable.js';
import { formatReads, isFamily, parseSlice, selectReads } from './read-rows.js';
import { CAPTURE_VERSION, OLDEST_READABLE_CAPTURE, type StepRow } from './schema.js';
import { harnessFileCounts, type HarnessFiles } from './harness-files.js';
import { deposit, frozenSessions, loadStore, paths, readCalls, readRedactDomains, readSaved, readSkeletons, skippedFolders, slugOf, type SessionsRuntime, type SkippedScope, type Store } from './store.js';
import { formatStepCounters, inputKey, newContext, readSteps, stampKey, runDeposit, runStep, stepCounters, stuckSteps, tryLog, type StuckStep } from './steps.js';
import { formatSelfBaseline, selfBaseline as selfBaselineOf, type SelfBaselineResult } from './baseline.js';
import { staleBatchesAnywhere } from './pool-outbox.js';
import { outboxTotals, type OutboxTotals } from './pool-totals.js';
import { auditCounts, auditStore, formatAudit, type SessionAudit, type T0Counts } from './audit.js';
import { readSurvival, recordSurvival, SURVIVAL_DAYS } from './survival.js';
import { CAPTURE_INVARIANTS, formatSessionResults, formatVerify, verifyAll, verifyCaptured, verifySessions, type InvariantResult, type SessionVerification } from './verify.js';

export interface SessionsDeps {
  sessions: SessionsRuntime | undefined;
  install: InstallRuntime | undefined;
  now: () => number;
  /** Records a telemetry event; absent in a run that has none. */
  telemetry?: Emit | undefined;
}

const runtimeOf = (deps: SessionsDeps): SessionsRuntime => {
  if (deps.sessions === undefined) throw new CliError('The session store is not configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
  return deps.sessions;
};

/** A list that names nothing is a mistake, not a request for the default (every folder): it is refused. */
const readAllowFile = async (file: string): Promise<string[]> => {
  let entries: string[];
  try {
    entries = parseAllowList(await readFile(file, 'utf8'));
  } catch {
    throw new CliError(`Cannot read the --allow-file ${file}.`, ExitCode.USAGE, 'usage');
  }
  if (entries.length === 0) throw new CliError(`The --allow-file ${file} names no folder. Without --allow or --allow-file, deposit reads every folder.`, ExitCode.USAGE, 'usage');
  return entries;
};

export const sessionsDeposit = async (deps: SessionsDeps, options: { allow: string[]; allowFiles: string[]; deny?: string[]; redactDomains: string[] }): Promise<Outcome> => {
  const fromFiles = await Promise.all(options.allowFiles.map((file) => readAllowFile(file)));
  const runtime = runtimeOf(deps);
  const table = runtime.sources ?? SOURCES;
  const allow = [...options.allow, ...fromFiles.flat(), ...(options.deny ?? []).map(denialOf)];
  const { result, read } = await runDeposit(newContext(runtime.storeDir, deps.now, 'manual'), true, inputKey('manual', allow, options.redactDomains), async (trace) => {
    // Survival reads the folders this deposit reads, from the list saved before the deposit merges this run's entries into it.
    const scope = runAllow((await readSaved(runtime.storeDir)).allow, allow);
    const done = await deposit(runtime, { allow, redactDomains: options.redactDomains, now: deps.now }, trace);
    return { value: { result: done, read: scope }, in: { transcript: done.sessions + done.subagents + done.unchanged } };
  });
  const survival = await recordSurvival(runtime, read, deps.now);
  const lines = [
    `Deposited ${String(result.sessions)} sessions and ${String(result.subagents)} subagent transcripts (${String(result.lines)} lines, ${String(result.badLines)} unparseable) as ${String(result.observations)} observations; ${String(result.unchanged)} files unchanged.`,
    `Read ${String(result.folders.length)} folders; skipped ${String(result.skippedFolders)} not on the allowlist.`,
    // The list an earlier run saved decides what a plain deposit reads; the run says so instead of looking like "every source".
    ...savedListNote(read, allow, paths(runtime.storeDir).state),
    ...Object.entries(result.sources).flatMap(([name, counts]) => [
      ...(counts.read === 0 ? [] : [`Read ${String(counts.read)} ${sourceLabel(name, table)} sessions.`]),
      ...counts.unreadable.map((reason) => `${sourceLabel(name, table)} store not read: ${reason}`),
      ...(counts.rejected === 0 ? [] : [`Skipped ${String(counts.rejected)} ${sourceLabel(name, table)} sessions whose id is not a safe file name.`]),
    ]),
    ...(result.missing.length === 0 ? [] : [`No project folder matched: ${result.missing.join(', ')}.`]),
    survival === null
      ? 'Commit survival not read this run.'
      : `Commits older than ${String(SURVIVAL_DAYS)} days: ${String(survival.survived)} survived, ${String(survival.reverted)} reverted, ${String(survival.unreachable)} unreachable, ${String(survival.unknown)} unknown.`,
    // Nothing parsed and nothing already deposited: say where it looked, so an empty result is not a silent one.
    ...(result.sessions + result.subagents + result.unchanged === 0 ? nothingFoundLines(result, runtime, table, read) : []),
  ];
  return { document: { ok: true, ...result, survival }, text: lines.join('\n') };
};

const isAnswerable = (query: PullInput): boolean => ('form' in query ? true : query.error !== undefined || query.path !== undefined || query.cls !== undefined);

/**
 * One pull: it writes its own recall record, a hit or a miss, because no harness writes one for it. A record that cannot be written costs the asker nothing, and
 * this command answers an operator, so the `--error`, `--path`, and `--class` forms keep the signature text they have always printed; the MCP tool, which answers an agent, does not.
 */
export const sessionsRecall = async (deps: SessionsDeps, query: PullInput, sid: string | null = null): Promise<Outcome> => {
  if (!isAnswerable(query)) {
    throw new CliError('Pass --error "<text>", --path <file>, --class <name>, --pattern <id>, --entity <name>, --family <name>, or --text "<text>".', ExitCode.USAGE, 'usage');
  }
  const refusal = pullRefusal(query);
  if (refusal !== undefined) throw new CliError(refusal, ExitCode.USAGE, 'usage');
  const { storeDir } = runtimeOf(deps);
  // The key is the query and `ev`, known before the work, so a recall that keeps failing is the same key each time.
  const key = stampKey(JSON.stringify(query));
  const { found: result, empty } = await runStep(
    newContext(storeDir, deps.now, 'manual'),
    'recall',
    async () => {
      const store = await loadStore(storeDir);
      const found = pull(store, query, { sid, now: deps.now(), frame: null, redactDomains: await readRedactDomains(storeDir), current: await recallPool(storeDir, store, servedPool) });
      return { value: { found, empty: store.sessions.length === 0 }, report: { in: { query: 1 }, out: { matches: found.legacy?.matches.length ?? found.reads.length }, key } };
    },
    key,
  );
  await tryLog(() => appendRecall(storeDir, result.recall));
  // Counts and closed words only: how it was asked, the families it served, how many reads, and its arm. Never the query or the answer.
  deps.telemetry?.('recall', recallFields(result.recall, result.reads.map((read) => read.family), result.legacy !== undefined));
  // A miss over a store with no sessions is not "no match": the store has nothing to match, and the text names the command that fills it.
  if (result.legacy !== undefined) return { document: { ok: true, ...result.legacy, recall: result.recall }, text: empty && result.legacy.matches.length === 0 ? EMPTY_RECALL : formatRecall(result.legacy) };
  // The document states the recall and not the raw reads: a read's tool, keys, and versions are store strings that can carry text, and `recall.evidence` already states them closed.
  return { document: { ok: true, recall: result.recall }, text: result.recall.answer.rendered === '' ? (empty ? EMPTY_RECALL : MISS_TEXT) : result.recall.answer.rendered };
};

/** `recall --counts`: push and pull, shown and held, as counts only. */
export const sessionsRecallCounts = async (deps: SessionsDeps, day: string | undefined): Promise<Outcome> => {
  const { storeDir } = runtimeOf(deps);
  const rows = recallCounts(deriveConsequences(await loadStore(storeDir), await readRecalls(storeDir)), day);
  return { document: { ok: true, day: day ?? null, rows }, text: formatRecallCounts(rows) };
};

/** `lineage`: a walk over files the derive already wrote. It computes nothing, so it logs no step. */
export const sessionsLineage = async (deps: SessionsDeps, ref: string): Promise<Outcome> => {
  const hops = walkLineage(await loadLineage(runtimeOf(deps).storeDir), ref);
  return { document: { ok: true, hops }, text: formatLineage(hops) };
};

/**
 * `read`: rows from the current pool's reads. The step log holds it under its own step, because the `recall` counters answer how often a recall was asked for. Every row states
 * its clusters and order. No floor applies at order 1, because every cell here is the operator's own; above it a read below its floor does not exist, so this also says what the
 * store cannot read, which tells that apart from a read that found nothing. A recall states a read as counts; this verb is the one way out for a read's whole value and for an experimental read.
 */
export const sessionsRead = async (deps: SessionsDeps, options: { family: string | undefined; slices: readonly string[] }): Promise<Outcome> => {
  const { family } = options;
  if (family !== undefined && !isFamily(family)) throw new CliError(`Pass --family as one of ${FAMILIES.join(', ')}.`, ExitCode.USAGE, 'usage');
  const slice = parseSlice(options.slices);
  if (slice === undefined) throw new CliError('Pass --slice as <axis>=<value>.', ExitCode.USAGE, 'usage');
  const { storeDir } = runtimeOf(deps);
  const key = stampKey(family ?? '', ...options.slices);
  const { pool, reads, unreadable, newer } = await runStep(
    newContext(storeDir, deps.now, 'manual'),
    'read',
    async () => {
      const store = await loadStore(storeDir);
      const refreshed = await refreshPool(storeDir, store);
      const selected = selectReads(refreshed.reads, { family, slice });
      const missing = notReadable(refreshed.reads).filter((row) => family === undefined || row.family === family);
      return { value: { pool: refreshed.pool.version, reads: selected, unreadable: missing, newer: store }, report: { in: { reads: refreshed.reads.length }, out: { rows: selected.length }, key } };
    },
    key,
  );
  return { document: { ok: true, pool, reads, notReadable: unreadable, newerCaptures: newer.newerCaptures }, text: [formatReads(reads), ...formatNotReadable(unreadable), ...newerNotice(newer)].join('\n') };
};

/** `recall --context`: the injection block for a repository, from the hook index (built from the store when no deposit has written one). */
export const sessionsContext = async (deps: SessionsDeps, options: ContextOptions): Promise<Outcome> => {
  const { storeDir } = runtimeOf(deps);
  // The manual recall verb (spec 4.1): its key is what it looks up, the repository's cwd and the harness, known before the work.
  const key = stampKey('context', options.cwd, options.harness ?? '');
  const step = await runStep(
    newContext(storeDir, deps.now, 'manual'),
    'recall',
    async () => {
      const index = (await readIndex(storeDir)) ?? buildIndex(await loadStore(storeDir), await readRedactDomains(storeDir), new Date(deps.now()).toISOString());
      const found = contextBlock(index, options);
      return { value: { found, noProjects: Object.keys(index.projects).length === 0 }, report: { in: { query: 1 }, out: { matches: found === undefined ? 0 : 1 }, key } };
    },
    key,
  );
  // Nothing to inject because the store holds no sessions at all is an empty store, not a quiet repository: say so and name the command that fills it.
  // An index that names projects answers alone; the store is loaded only when the index is empty, to tell an empty store from an index with nothing to say.
  const block = step.found;
  const text = block ?? (step.noProjects && (await loadStore(storeDir)).sessions.length === 0 ? EMPTY_RECALL : 'Nothing recurs in this repository yet.');
  return { document: { ok: true, context: block ?? null }, text };
};

export const sessionsMcp = async (deps: SessionsDeps): Promise<void> => {
  await serve(runtimeOf(deps), deps.now, deps.telemetry);
};

/** Names shown in the `verify` and `books` text; each `--json` document carries them all. */
const SKIPPED_NAMES_SHOWN = 10;

/** One line for the folders the allowlist leaves out: the store holds nothing from them, and it says so rather than looking complete. */
const skippedNotice = (scope: SkippedScope): string[] => {
  if (scope.folders === 0) return [];
  const shown = scope.names.slice(0, SKIPPED_NAMES_SHOWN).join(', ');
  const more = scope.names.length > SKIPPED_NAMES_SHOWN ? `, and ${String(scope.names.length - SKIPPED_NAMES_SHOWN)} more` : '';
  const one = scope.folders === 1;
  const folders = one ? '1 project folder holds' : `${String(scope.folders)} project folders hold`;
  // Main transcripts only: a folder with none holds subagent transcripts only, or could not be listed.
  const transcripts = scope.transcripts === 0 ? 'no main transcript' : scope.transcripts === 1 ? '1 main transcript' : `${String(scope.transcripts)} main transcripts`;
  return [`${folders} ${transcripts}; ${one ? 'it is' : 'they are'} never read: not on the allowlist. Not captured: ${shown}${more}.`];
};

/** The three counts per harness, as numbers only: no cause, no path, no verdict. */
const harnessFilesLines = (files: HarnessFiles, table: readonly Source[]): string[] => {
  const rows = Object.entries(files).map(([harness, counts]) => `  ${harness === 'claude-code' ? 'Claude Code' : sourceLabel(harness, table)}: seen ${String(counts.seen)}, yielded ${String(counts.yielded)}, unreadable ${String(counts.unreadable)}`);
  return rows.length === 0 ? [] : ['Session files per harness:', ...rows];
};

/** Scope is an extra, like the step log: a projects root this process cannot list reports an empty scope and fails neither `verify` nor `books`. */
const scopeOf = (runtime: SessionsRuntime): Promise<SkippedScope> => skippedFolders(runtime).catch((): SkippedScope => ({ folders: 0, transcripts: 0, names: [] }));

/** One line for a store a newer oars wrote into (spec state-on-open row for a newer `cv`: read known fields, warn). */
const newerNotice = (store: Store): string[] => (store.newerCaptures > 0 ? [`captured by a newer oars; upgrade oars (${String(store.newerCaptures)} sessions)`] : []);

/**
 * The store restricted to one repository (the test `measure --repo` uses). `books` reads its rows from `prompts`, and looks up a
 * subagent, a sha, or a pull by the kept prompt it belongs to, so the kept sessions and prompts are enough; the kept subagents only keep
 * the newer-capture count to this repository.
 */
const inRepositoryStore = (store: Store, repo: string): Store => {
  const sessions = store.sessions.filter((session) => inRepository(session.project, repo));
  const mains = new Set(sessions.map((session) => session.session));
  // A subagent is kept by its own project, like a session: its parent's session record may be absent from the store.
  const subagents = store.subagents.filter((agent) => inRepository(agent.project, repo));
  const newer = (cv: string): boolean => Number(cv) > Number(CAPTURE_VERSION);
  return {
    ...store,
    sessions,
    subagents,
    prompts: store.prompts.filter((prompt) => mains.has(prompt.session)),
    newerCaptures: [...sessions, ...subagents].filter((record) => newer(record.cv)).length,
  };
};

/**
 * `books --by package`: the store's tool calls per public package, after the A38 scan `oars sessions exclusions` runs (a missing term file excludes everything).
 * The scan reads the transcripts and writes nothing; the store is only read.
 */
const packageBooksOutcome = async (deps: SessionsDeps, options: { sinceDays: number | undefined; termsFile: string }): Promise<Outcome> => {
  const runtime = runtimeOf(deps);
  const [{ excluded }, store] = await Promise.all([scanStore(runtime, options.termsFile), loadStore(runtime.storeDir)]);
  const cutoff = options.sinceDays === undefined ? undefined : new Date(deps.now() - options.sinceDays * 86_400_000).toISOString();
  const result = packageBooks(store, new Set(excluded.map((entry) => entry.session)), vocabulary(), cutoff);
  // The same empty-store text the other `books` forms print, so it names the command that fills the store.
  const table = store.sessions.length === 0 && store.prompts.length === 0 ? emptyBooks('public package pulls') : formatPackageBooks(result);
  return { document: { ok: true, by: 'package', ...result, newerCaptures: store.newerCaptures }, text: [table, ...newerNotice(store)].join('\n') };
};

export const sessionsBooks = async (deps: SessionsDeps, options: { by: BooksBy | 'package'; sinceDays: number | undefined; repo?: string; termsFile?: string }): Promise<Outcome> => {
  if (options.by === 'package') {
    if (options.repo !== undefined) throw new CliError('--repo does not apply to --by package: its rows are public package names across the whole store.', ExitCode.USAGE, 'usage');
    return packageBooksOutcome(deps, { sinceDays: options.sinceDays, termsFile: options.termsFile ?? '' });
  }
  const runtime = runtimeOf(deps);
  const { storeDir } = runtime;
  const loaded = await loadStore(storeDir);
  const store = options.repo === undefined ? loaded : inRepositoryStore(loaded, options.repo);
  const rows = books(store, options.by, deps.now(), options.sinceDays, await readSurvival(storeDir));
  // A mistyped root, or a --since window nothing falls in, over a populated store must not read as an empty store.
  const emptyWindow = rows.length === 0 && options.sinceDays !== undefined && store.prompts.length > 0;
  const table =
    loaded.sessions.length === 0 && loaded.prompts.length === 0
      ? emptyBooks(options.by === 'pull' ? 'pulls' : 'prompts')
      : store.prompts.length === 0 && options.repo !== undefined
        ? `No prompts for ${options.repo} in the store (${String(loaded.prompts.length)} prompts across all repositories).`
        : emptyWindow
          ? `No ${options.by === 'pull' ? 'pulls' : 'prompts'} in the --since window.`
          : formatBooks(rows, options.by);
  const scope = await scopeOf(runtime);
  const bundle = await lastFetchedBundle(storeDir);
  return { document: { ok: true, by: options.by, rows, newerCaptures: store.newerCaptures, scope, pool: bundle?.books ?? null }, text: [table, ...skippedNotice(scope), ...newerNotice(store), '', ...booksLines(bundle), ...(rows.length === 0 ? [] : ['', BOOKS_CAVEAT])].join('\n') };
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
  // The step counters are all-time over the whole log: `--repo`, `--last`, and `--since` filter the G1 table only.
  // A step log that cannot be read leaves the G1 table as it is (the same rule as `verify`'s stuck check).
  const steps = stepCounters(await readSteps(runtime.storeDir).catch((): StepRow[] => []));
  return { document: { ok: true, ...result, steps, newerCaptures: store.newerCaptures }, text: [formatMeasure(result), formatStepCounters(steps), ...newerNotice(store)].join('\n') };
};

export interface VerifyReport {
  sessions: number;
  /** Skeleton files that could not be parsed: not an invariant, so counted apart from them. */
  unreadable: number;
  invariants: Array<InvariantResult & { pass: boolean }>;
  /** Steps whose key failed on three runs in a row (spec 4.4), with the first error line of the newest failure. */
  stuck: StuckStep[];
  /** Sessions behind the current capture version whose transcript is gone from the harness and `raw/` (or, for a Cursor session, whose composer is gone from Cursor): counted apart from `cv-behind`, never a strict failure. */
  cvFrozen: number;
  /** Folders under the projects root that hold transcripts but are not on the allowlist, so are never read: scope, not a failure. */
  scope: SkippedScope;
  /** Every session's rows 1 to 10 with a status each (spec 5.4 item 5): `pass`, `fail`, or `not run` when the row had nothing to check. */
  sessionResults: SessionVerification[];
  /** Per harness, the session files seen, how many yielded records, and how many were unreadable (`harness-files.ts` defines them). Read from the harness's own store on this machine; nothing is sent. */
  harnessFiles: HarnessFiles;
  /** Layer 4 at T0, local (spec 2.4): each session's raw-file match, recomputed root, and count bindings, with the count of each row of the result table. */
  audit: { counts: T0Counts; sessions: SessionAudit[] };
  /** Layer 2 at T0, local (spec 2.2): each session's week against the operator's own other weeks on its harness; `not run` below 1,000 calls or 4 baseline weeks. */
  selfBaseline: SelfBaselineResult[];
  /** Batches in any server's outbox built under an older vocabulary, field list, or skeleton format: never printed, never sent, and removed by the next `pool deposit`. Counted from local folders; nothing is sent. */
  staleBatches: number;
  /** The outboxes' sent and masked counts (`pool-totals.ts`). */
  sentBatches: number;
  sentRaw: number;
  rawCopies: number;
  rawMasked: number;
}

/** With `strict`, any violated invariant, stuck step, `merkle: root mismatch`, or `merkle: counts do not bind` also fails the command (exit 4) after the full report is printed; the report is built first so callers can emit it. */
export const sessionsVerify = async (deps: SessionsDeps, options: { session: string | undefined }): Promise<Outcome & { failed: string[]; report: VerifyReport }> => {
  const runtime = runtimeOf(deps);
  const { storeDir } = runtime;
  // When the store cannot be read there is no high-water mark yet, so a failed run's key is the session asked for and `ev`.
  return runStep(newContext(storeDir, deps.now, 'manual'), 'verify', async () => {
    // Every skeleton is read even for one session: row 6 takes its subagent transcripts' lines, which `<id>.json` alone would miss.
    const everySkeleton = await readSkeletons(storeDir, undefined, true);
    const { unreadable } = options.session === undefined ? everySkeleton : await readSkeletons(storeDir, options.session, true);
    const skeletons = everySkeleton.skeletons.filter((skeleton) => options.session === undefined || skeleton.session === options.session);
    const store = await loadStore(storeDir);
    const mine = <T extends { session: string }>(records: readonly T[]): T[] => records.filter((record) => options.session === undefined || record.session === options.session);
    const captured = mine([...store.sessions, ...store.subagents]);
    // A session behind the current version whose transcript is in neither the harness nor raw/ (or, for a Cursor session, whose composer is gone from Cursor) can never be captured again: counted apart, never a strict failure.
    const frozen = await frozenSessions(runtime, captured.filter((session) => Number(session.cv) >= OLDEST_READABLE_CAPTURE && Number(session.cv) < Number(CAPTURE_VERSION)));
    const results = [...verifyAll(skeletons, everySkeleton.skeletons), ...verifyCaptured(captured, mine(store.tools), frozen)];
    const sessionResults = verifySessions(everySkeleton.skeletons, captured, mine(store.tools), frozen).filter((entry) => options.session === undefined || entry.session === options.session);
    // The baseline reads every week of the store, so --session only picks which results are reported.
    const selfBaseline = selfBaselineOf([...store.sessions, ...store.subagents], store.tools, store.prompts, deps.now()).filter((entry) => options.session === undefined || entry.session === options.session);
    const audits = await auditStore(runtime, captured, skeletons);
    const audit = { counts: auditCounts(audits), sessions: audits };
    // A root that misses a file which matches, or records that disagree with each other, leave `W` at 0 (spec 2.4): they fail `--strict` like a violated invariant.
    const merkleFailed = (['root mismatch', 'counts do not bind'] as const).filter((result) => audit.counts[result] > 0).map((result) => `merkle: ${result}`);
    // Steps whose key failed on three runs in a row (spec 4.4), read before this run's own row is appended; each fails `--strict` like a violated invariant.
    // A step log that cannot be read leaves the invariant check as it is: the stuck check is an extra, never a reason `verify` fails.
    // A verify that got here has succeeded, so a verify streak is the one this run ends and is not listed.
    const stuck = stuckSteps(await readSteps(storeDir).catch((): StepRow[] => [])).filter((entry) => entry.step !== 'verify');
    const scope = await scopeOf(runtime);
    // Like the scope, an extra: a store that cannot be read is an unreadable count inside it, and a failure outside it leaves the section out.
    const harnessFiles = await harnessFileCounts(runtime).catch((): HarnessFiles => ({}));
    // A local count like the scope: an outbox folder that cannot be read is no reason for `verify` to fail.
    const staleBatches = await staleBatchesAnywhere(storeDir).catch(() => 0);
    const totals: OutboxTotals = await outboxTotals(storeDir).catch(() => ({ sentBatches: 0, sentRaw: 0, rawCopies: 0, rawMasked: 0 }));
    const report: VerifyReport = { sessions: skeletons.length, unreadable, cvFrozen: frozen.size, scope, harnessFiles, invariants: results.map((result) => ({ ...result, pass: result.violations === 0 })), stuck, sessionResults, audit, selfBaseline, staleBatches, ...totals };
    const failed = [...results.filter((result) => result.violations > 0).map((result) => result.name), ...(unreadable > 0 ? ['unreadable skeletons'] : []), ...merkleFailed, ...stuck.map((entry) => `stuck: ${entry.step}`)];
    const stuckLines = stuck.map((entry) => `FAIL  ${entry.step} is stuck: key ${entry.key} failed ${String(entry.runs)} runs in a row: ${entry.error}`);
    const highWater = mine([...store.sessions, ...store.subagents]).map((session) => `${session.session}:${String(session.rev)}:${session.cv}`).sort();
    const resultLines = formatSessionResults(sessionResults);
    const outcome = {
      failed,
      report,
      document: { ok: true, ...report, newerCaptures: store.newerCaptures },
      text: [formatVerify(results, skeletons.length), formatAudit(audits), formatSelfBaseline(selfBaseline), ...(resultLines === '' ? [] : [resultLines]), ...(frozen.size > 0 ? [`${String(frozen.size)} cv-frozen sessions: behind the current capture version, but the transcript is gone from the harness and raw/ (or, for a Cursor session, the composer is gone from Cursor), so they cannot be captured again`] : []), ...harnessFilesLines(harnessFiles, runtime.sources ?? SOURCES), ...skippedNotice(scope), ...(staleBatches > 0 ? [`${String(staleBatches)} outbox batches were built under an older vocabulary, field list, or skeleton format; they will never be sent, and oars pool deposit removes them`] : []), ...(totals.sentBatches + totals.sentRaw > 0 ? [`${String(totals.sentBatches)} outbox ${totals.sentBatches === 1 ? 'batch' : 'batches'} and ${String(totals.sentRaw)} raw ${totals.sentRaw === 1 ? 'copy were' : 'copies were'} already sent`] : []), ...(totals.rawCopies > 0 ? [`${String(totals.rawCopies)} queued raw ${totals.rawCopies === 1 ? 'copy holds' : 'copies hold'} ${String(totals.rawMasked)} placeholders (masked values, plus any a transcript already held as text)`] : []), ...newerNotice(store), ...(unreadable > 0 ? [`FAIL  ${String(unreadable)} unreadable skeleton files (torn or corrupted); redeposit to rebuild them`] : []), ...stuckLines].join('\n'),
    };
    const cvBehind = results.find((result) => result.name === CAPTURE_INVARIANTS[0])?.violations ?? 0;
    // The key is the sessions checked, each at its rev and cv, and the code's ev (spec 4.2).
    const key = stampKey(...highWater);
    const counts = { checked: results.length, passed: results.filter((result) => result.violations === 0).length, cvBehind, cvFrozen: frozen.size, stuck: stuck.length, merkle: audit.counts['root mismatch'] + audit.counts['counts do not bind'] };
    return { value: outcome, report: { in: { session: mine(store.sessions).length, subagent: mine(store.subagents).length }, out: counts, key } };
  }, stampKey('verify', options.session ?? ''));
};

const GOLD_MODE = 0o600;

/**
 * The sidecar, then the gold file, each created with `wx`: the existence check in `gold sample` came before a long draw, so this is what holds the
 * promise never to overwrite a file that may hold judgments if another run wrote in between.
 */
export const writeGoldFiles = async (file: string, arms: string, sidecar: string, rendered: string): Promise<void> => {
  await writeFile(arms, sidecar, { mode: GOLD_MODE, flag: 'wx' });
  await writeFile(file, rendered, { mode: GOLD_MODE, flag: 'wx' });
};

/** `gold sample`: writes the blind gold file and its hidden sidecar. It never overwrites one: the file may hold judgments. */
export const sessionsGoldSample = async (deps: SessionsDeps, options: { size: number; batch: number; seed: string | undefined; termsFile: string; excludeTerms: string[]; outDir: string | undefined }): Promise<Outcome> => {
  const runtime = runtimeOf(deps);
  // With no terms every session is excluded, so a draw would be empty: say so before anything is read or written.
  if ((await loadTerms(options.termsFile)).length === 0) throw new CliError('The term file is missing or empty, so every session is excluded. Set OARS_EXCLUSION_TERMS to a file of terms, one per line.', ExitCode.INVALID, 'unreadable');
  const date = new Date(deps.now()).toISOString().slice(0, 10);
  const dir = options.outDir ?? join(dirname(runtime.projectsRoot), 'session-commons', 'review');
  const file = join(dir, `outcome-gold-${date}.md`);
  const arms = armsPath(file);
  const taken = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
  if (await taken(file)) throw new CliError(`${file} already exists, and it may hold judgments. Move it, or pass another --out-dir.`, ExitCode.USAGE, 'usage');
  if (await taken(arms)) throw new CliError(`${arms} already exists, and it may hold readings. Move it, or pass another --out-dir.`, ExitCode.USAGE, 'usage');
  const store = await loadStore(runtime.storeDir);
  const redact = makeRedactor(await readRedactDomains(runtime.storeDir));
  const { document, views, unreadable } = await sampleGold(runtime, store, redact, { size: options.size, batch: options.batch, seed: options.seed ?? date, date, termsFile: options.termsFile, extraTerms: options.excludeTerms });
  await mkdir(dir, { recursive: true });
  await writeGoldFiles(file, arms, JSON.stringify(document), renderGold(views, { date, batch: options.batch }));
  const subagents = document.entries.filter((entry) => entry.subagents > 0).length;
  const lines = [
    `Wrote ${plural(document.entries.length, 'prompt')}, drawn from ${String(document.frame)}, to ${file}.`,
    `Excluded ${plural(document.excludedSessions, 'session')} the draw reached under the exclusion rule (a listed term, no raw to scan, or unreadable).`,
    `Passed over ${plural(unreadable, 'prompt')} whose transcript no longer matches the store.`,
    `${plural(subagents, 'sampled prompt')} ran subagents, whose work is not read.`,
    `Score it after any batch: oars sessions gold score ${file}`,
  ];
  return { document: { ok: true, file, prompts: document.entries.length, frame: document.frame, excludedSessions: document.excludedSessions, unreadable, subagentPrompts: subagents }, text: lines.join('\n') };
};

const readGold = async (file: string): Promise<{ text: string; document: GoldDocument }> => {
  const text = await readFile(file, 'utf8').catch(() => {
    throw new CliError(`Cannot read the gold file ${file}.`, ExitCode.USAGE, 'usage');
  });
  const arms = armsPath(file);
  const document = await readFile(arms, 'utf8').then((raw): unknown => JSON.parse(raw)).catch(() => undefined);
  if (!isGoldDocument(document)) throw new CliError(`Cannot read the arms file ${arms}, which holds the signals for this gold file.`, ExitCode.USAGE, 'usage');
  return { text, document };
};

/** `gold score`: reads whatever is judged so far, so it runs after any batch. */
export const sessionsGoldScore = async (options: { file: string }): Promise<Outcome> => {
  const { text, document } = await readGold(options.file);
  const { judged, unreadable } = parseGold(text);
  const score = scoreGold(document.entries, judged);
  return { document: { ok: true, ...score, unreadable }, text: formatScore(score, unreadable) };
};

/** `gold arms`: the text arms and the fresh readers, into the sidecar only. It prints coverage and no reading: a read waits for judgments. */
export const sessionsGoldArms = async (deps: SessionsDeps, options: { file: string }): Promise<Outcome> => {
  const runtime = runtimeOf(deps);
  if (runtime.evaluator === undefined) throw new CliError('No evaluator is configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
  const { document } = await readGold(options.file);
  const redact = makeRedactor(await readRedactDomains(runtime.storeDir));
  const outcome = await fillArms(runtime, document, redact, runtime.evaluator, sidecarSaver(armsPath(options.file), document, GOLD_MODE));
  if (outcome.failure !== undefined) throw new CliError(`${outcome.failure.message} ${plural(outcome.left, 'reading')} left, and every answer so far is saved. Rerun this command to go on.`, ExitCode.UNEXPECTED, 'unexpected');
  const score = scoreGold(document.entries, new Map());
  const lines = [
    `Asked ${plural(outcome.asked, 'reading')} on ${EVALUATOR_MODEL}, with ${String(outcome.left)} left. The gold file is unchanged.`,
    outcome.changed === 1
      ? '1 prompt has a transcript that is gone or no longer matches what the judge sees, so its text arm is unread.'
      : `${String(outcome.changed)} prompts have a transcript that is gone or no longer matches what the judge sees, so their text arms are unread.`,
    ...coverageLines(score),
  ];
  return { document: { ok: true, asked: outcome.asked, left: outcome.left, changed: outcome.changed, model: EVALUATOR_MODEL, coverage: score.coverage }, text: lines.join('\n') };
};

const installOf = (deps: SessionsDeps): InstallRuntime => {
  if (deps.install === undefined) throw new CliError('Hook install is not configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
  return deps.install;
};

const codexOf = (deps: SessionsDeps): CodexInstall => {
  const codex = installOf(deps).codex;
  if (codex === undefined) throw new CliError('The Codex hook is not configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
  return codex;
};

/** `--harness codex` writes to the Codex home, so a settings-file flag beside it names a target that does not apply. */
const refuseSettingsFlags = (options: HookTarget): void => {
  if (options.scope !== undefined || options.file !== undefined) throw new CliError('--harness codex writes hooks.json in the Codex home; --scope and --file apply to Claude Code settings only.', ExitCode.USAGE, 'usage');
};

export interface HookTarget {
  scope: Scope | undefined;
  file: string | undefined;
}

/** `--scope`, else `file` when `--file` names one, else the user settings. */
const hookScope = (options: HookTarget): Scope => options.scope ?? (options.file === undefined ? 'user' : 'file');

/** What `--schedule off` and `--schedule on` say: the recorded choice about the background sweep and send that the session-end hook and every command start. */
const SENDS_OFF = 'The background sweep and the pool send are off, as you chose with --schedule off (telemetry has its own switch: oars telemetry off). Turn them back on with: oars sessions hook install --schedule on';
const SENDS_ON = 'Background sweeps and sends are on: a due sweep and send starts from the session-end hook and from any oars command, at most about hourly.';

/** `--machine`: the Stop and SessionEnd entries for a cloud VM, a VPS, or a runner, and for a user-scope file the enrollment block too. Refused beside every flag it does not take, before anything is written. */
const installMachine = async (deps: SessionsDeps, options: HookTarget & { keepRetention?: boolean; schedule: 'nightly' | 'off' | 'on' | undefined; harness?: 'codex' | undefined; env?: readonly string[] | undefined; termsFile?: string | undefined }): Promise<Outcome> => {
  const refuse = (message: string): CliError => new CliError(message, ExitCode.USAGE, 'usage');
  if (options.harness !== undefined || options.schedule !== undefined) throw refuse('--machine writes the Stop and SessionEnd entries of a machine; --harness and --schedule do not apply to it.');
  if (options.keepRetention === true) throw refuse('--keep-retention does not apply to --machine: a machine install leaves cleanupPeriodDays alone.');
  const scope = hookScope(options);
  if (scope === 'file') throw refuse('--machine takes --scope project (the .claude/settings.json of a repository, committed) or --scope user (the ~/.claude/settings.json of a VPS or runner).');
  if (options.file !== undefined) throw refuse('--file does not apply to --machine: it writes the user or project settings file named by --scope.');
  const runtime = installOf(deps);
  const file = settingsPath(runtime, scope, undefined);
  const lines: string[] = [];
  let result;
  if (scope === 'project') {
    if ((options.env ?? []).length > 0 || options.termsFile !== undefined) throw refuse('--env and --terms-file belong to --scope user: a project settings file is committed, and the enrollment block holds salts and terms.');
    result = await installMachineHooks(file, undefined);
    lines.push(`Installed ${result.installed.join(' and ')} machine hooks in ${file}. They run only where OARS_HOST_CLASS is set to a class other than local; set it, and the rest of the enrollment block, in the environment that runs the session.`);
  } else {
    // A file that cannot be read is refused before the terms file is written.
    await readSettings(file);
    const enrollment = await enrollmentOf(options.env ?? [], options.termsFile, runtime.cwd);
    result = await installMachineHooks(file, enrollment.env);
    lines.push(`Installed ${result.installed.join(' and ')} machine hooks and the enrollment block in ${file}, which is now readable by its owner only.`);
    if (enrollment.termsPath !== undefined) lines.push(`The exclusion terms are in ${enrollment.termsPath} (owner-only), named by OARS_EXCLUSION_TERMS.`);
    if (enrollment.env.OARS_EXCLUSION_TERMS === undefined && enrollment.env.OARS_EXCLUSION_TERMS_INLINE === undefined) lines.push('No exclusion terms were given: with no term file every session is excluded (fail-closed), so nothing will be built.');
  }
  return { document: { ok: true, machine: true, install: result }, text: lines.join('\n') };
};

export const sessionsHookInstall = async (
  deps: SessionsDeps,
  options: HookTarget & { keepRetention: boolean; schedule: 'nightly' | 'off' | 'on' | undefined; harness?: 'codex' | undefined; machine?: boolean | undefined; env?: readonly string[] | undefined; termsFile?: string | undefined },
): Promise<Outcome> => {
  if (options.machine === true) return installMachine(deps, options);
  if ((options.env ?? []).length > 0 || options.termsFile !== undefined) throw new CliError('--env and --terms-file belong to --machine.', ExitCode.USAGE, 'usage');
  if (options.harness === 'codex') {
    refuseSettingsFlags(options);
    if (options.schedule !== undefined) throw new CliError('--schedule applies to the Claude Code hooks, not --harness codex.', ExitCode.USAGE, 'usage');
    const result = await installCodexHook(codexOf(deps));
    return { document: { ok: true, harness: 'codex', ...result, trust: 'asked by codex' }, text: `Installed ${result.installed.join(', ')} hooks in ${result.file}.\n${CODEX_TRUST_NOTICE}` };
  }
  const runtime = installOf(deps);
  // `--schedule nightly` asked for the task this version no longer registers: refused before anything is written.
  if (options.schedule === 'nightly') throw new CliError(SCHEDULE_REFUSED, ExitCode.USAGE, 'usage');
  const lines: string[] = [];
  const document: { ok: true; install?: object; schedule?: string; sends?: 'on' | 'off' } = { ok: true };
  // `--schedule off` or `on` alone touches no settings file; it removes the old task and records the choice.
  if (options.schedule === undefined || options.scope !== undefined || options.file !== undefined) {
    const file = settingsPath(runtime, hookScope(options), options.file);
    const result = await installHooks(runtime, file, options.keepRetention);
    document.install = result;
    lines.push(`Installed ${result.installed.join(', ')} hooks in ${file}.`, result.retention);
  }
  const removed = await removeSchedule(runtime);
  if (removed !== undefined) {
    document.schedule = removed;
    lines.push(removed);
  }
  if (options.schedule !== undefined) {
    const storeDir = deps.sessions?.storeDir;
    if (storeDir !== undefined) await recordSchedule(storeDir, options.schedule);
    document.sends = options.schedule;
    // An explicit `off` that found no task still says why nothing was removed, so the output is never empty.
    if (options.schedule === 'off' && removed === undefined) lines.push(`No scheduled task to remove${runtime.platform === 'win32' ? '' : ' (only Windows ever had one)'}.`);
    lines.push(options.schedule === 'off' ? SENDS_OFF : SENDS_ON);
  }
  return { document, text: lines.join('\n') };
};

export const sessionsHookUninstall = async (deps: SessionsDeps, options: HookTarget & { harness?: 'codex' | undefined }): Promise<Outcome> => {
  if (options.harness === 'codex') {
    refuseSettingsFlags(options);
    const result = await uninstallCodexHook(codexOf(deps));
    return { document: { ok: true, harness: 'codex', ...result }, text: result.removed.length === 0 ? `No Many Oars hooks in ${result.file}.` : `Removed ${result.removed.join(', ')} hooks from ${result.file}; other hooks are untouched.` };
  }
  const runtime = installOf(deps);
  const file = settingsPath(runtime, hookScope(options), options.file);
  const result = await uninstallHooks(file);
  const removed = await removeSchedule(runtime);
  const text = result.removed.length === 0 ? `No Many Oars hooks in ${file}.` : `Removed ${result.removed.join(', ')} hooks from ${file}; other settings and hooks are untouched (cleanupPeriodDays is left as it is).`;
  return { document: { ok: true, ...result, ...(removed === undefined ? {} : { schedule: removed }) }, text: removed === undefined ? text : `${text}\n${removed}` };
};

export const sessionsHookStatus = async (deps: SessionsDeps, options: { file: string | undefined; harness?: 'codex' | undefined }): Promise<Outcome> => {
  if (options.harness === 'codex') {
    const result = await codexHookStatus(codexOf(deps));
    return { document: { ok: true, harness: 'codex', ...result }, text: `codex: ${result.file}: ${result.installed.length === 0 ? 'no hooks' : result.installed.join(', ')}` };
  }
  const runtime = installOf(deps);
  const files = await hookStatus(runtime, options.file);
  const schedule = await scheduleStatus(runtime);
  const lines = files.map((item) => `${item.scope}: ${item.file}: ${item.installed.length === 0 ? 'no hooks' : item.installed.join(', ')} (cleanupPeriodDays ${String(item.retentionDays)})`);
  return { document: { ok: true, files, ...(schedule === undefined ? {} : { schedule }) }, text: (schedule === undefined ? lines : [...lines, schedule]).join('\n') };
};
