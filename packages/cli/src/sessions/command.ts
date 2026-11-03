// The `oars sessions` command group's bodies: each returns the `--json` document and the text a human sees.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Outcome } from '../cli.js';
import { parseAllowList } from './allow.js';
import { CliError, ExitCode } from '../errors.js';
import { EVALUATOR_MODEL, fillArms, sidecarSaver } from './gold-arms.js';
import { armsPath, coverageLines, formatScore, isGoldDocument, parseGold, renderGold, sampleGold, scoreGold, type GoldDocument } from './gold.js';
import { makeRedactor } from './redact.js';
import { books, formatBooks, formatMeasure, formatRecall, measure, recall, type BooksBy, type RecallQuery } from './query.js';
import { readHookCalls } from './hook-calls.js';
import { buildIndex, contextBlock, inRepository, readIndex, type ContextOptions } from './hook-index.js';
import { hookStatus, installHooks, scheduleStatus, setSchedule, settingsPath, uninstallHooks, type InstallRuntime, type Scope } from './install.js';
import { serve } from './mcp.js';
import { refreshPool } from './pool.js';
import { FAMILIES } from './read.js';
import { formatReads, isFamily, parseSlice, selectReads } from './read-rows.js';
import { CAPTURE_VERSION, OLDEST_READABLE_CAPTURE, type StepRow } from './schema.js';
import { deposit, frozenSessions, loadStore, readCalls, readRedactDomains, readSkeletons, slugOf, type SessionsRuntime, type Store } from './store.js';
import { formatStepCounters, inputKey, newContext, readSteps, stampKey, runDeposit, runStep, stepCounters, stuckSteps, type StuckStep } from './steps.js';
import { auditCounts, auditStore, formatAudit, type SessionAudit, type T0Counts } from './audit.js';
import { CAPTURE_INVARIANTS, formatSessionResults, formatVerify, verifyAll, verifyCaptured, verifySessions, type InvariantResult, type SessionVerification } from './verify.js';

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
  const allow = [...options.allow, ...fromFiles.flat()];
  const result = await runDeposit(newContext(runtime.storeDir, deps.now, 'manual'), true, inputKey('manual', allow, options.redactDomains), async (trace) => {
    const done = await deposit(runtime, { allow, redactDomains: options.redactDomains, now: deps.now }, trace);
    return { value: done, in: { transcript: done.sessions + done.subagents + done.unchanged } };
  });
  const lines = [
    `Deposited ${String(result.sessions)} sessions and ${String(result.subagents)} subagent transcripts (${String(result.lines)} lines, ${String(result.badLines)} unparseable) as ${String(result.observations)} observations; ${String(result.unchanged)} files unchanged.`,
    `Read ${String(result.folders.length)} folders; skipped ${String(result.skippedFolders)} not on the allowlist.`,
    ...(result.cursor === 0 ? [] : [`Read ${String(result.cursor)} Cursor sessions.`]),
    ...result.cursorUnreadable.map((reason) => `Cursor store not read: ${reason}`),
    ...(result.cursorRejected === 0 ? [] : [`Skipped ${String(result.cursorRejected)} Cursor sessions whose id is not a safe file name.`]),
    ...(result.missing.length === 0 ? [] : [`No project folder matched: ${result.missing.join(', ')}.`]),
  ];
  return { document: { ok: true, ...result }, text: lines.join('\n') };
};

export const sessionsRecall = async (deps: SessionsDeps, query: RecallQuery): Promise<Outcome> => {
  if (query.error === undefined && query.path === undefined && query.cls === undefined) {
    throw new CliError('Pass --error "<text>", --path <file>, or --class <name>.', ExitCode.USAGE, 'usage');
  }
  const { storeDir } = runtimeOf(deps);
  // The key is the query and `ev`, known before the work, so a recall that keeps failing is the same key each time.
  const key = stampKey(query.error ?? '', query.path ?? '', query.cls ?? '', String(query.sinceDays ?? ''));
  const result = await runStep(
    newContext(storeDir, deps.now, 'manual'),
    'recall',
    async () => {
      const found = recall(await loadStore(storeDir), query, deps.now(), undefined, await readRedactDomains(storeDir));
      return { value: found, report: { in: { query: 1 }, out: { matches: found.matches.length }, key } };
    },
    key,
  );
  return { document: { ok: true, ...result }, text: formatRecall(result) };
};

/**
 * `read`: rows from the current pool's reads. The step log holds it under its own step, because the `recall` counters answer how often a recall was asked for. Every row states
 * its clusters; no floor applies, because every cell here is the operator's own.
 */
export const sessionsRead = async (deps: SessionsDeps, options: { family: string | undefined; slices: readonly string[] }): Promise<Outcome> => {
  const { family } = options;
  if (family !== undefined && !isFamily(family)) throw new CliError(`Pass --family as one of ${FAMILIES.join(', ')}.`, ExitCode.USAGE, 'usage');
  const slice = parseSlice(options.slices);
  if (slice === undefined) throw new CliError('Pass --slice as <axis>=<value>.', ExitCode.USAGE, 'usage');
  const { storeDir } = runtimeOf(deps);
  const key = stampKey(family ?? '', ...options.slices);
  const { pool, reads, newer } = await runStep(
    newContext(storeDir, deps.now, 'manual'),
    'read',
    async () => {
      const store = await loadStore(storeDir);
      const refreshed = await refreshPool(storeDir, store);
      const selected = selectReads(refreshed.reads, { family, slice });
      return { value: { pool: refreshed.pool.version, reads: selected, newer: store }, report: { in: { reads: refreshed.reads.length }, out: { rows: selected.length }, key } };
    },
    key,
  );
  return { document: { ok: true, pool, reads, newerCaptures: newer.newerCaptures }, text: [formatReads(reads), ...newerNotice(newer)].join('\n') };
};

/** `recall --context`: the injection block for a repository, from the hook index (built from the store when no deposit has written one). */
export const sessionsContext = async (deps: SessionsDeps, options: ContextOptions): Promise<Outcome> => {
  const { storeDir } = runtimeOf(deps);
  // The manual recall verb (spec 4.1): its key is what it looks up, the repository's cwd and the harness, known before the work.
  const key = stampKey('context', options.cwd, options.harness ?? '');
  const block = await runStep(
    newContext(storeDir, deps.now, 'manual'),
    'recall',
    async () => {
      const index = (await readIndex(storeDir)) ?? buildIndex(await loadStore(storeDir), await readRedactDomains(storeDir), new Date(deps.now()).toISOString());
      const found = contextBlock(index, options);
      return { value: found, report: { in: { query: 1 }, out: { matches: found === undefined ? 0 : 1 }, key } };
    },
    key,
  );
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

export const sessionsBooks = async (deps: SessionsDeps, options: { by: BooksBy; sinceDays: number | undefined; repo?: string }): Promise<Outcome> => {
  const loaded = await loadStore(runtimeOf(deps).storeDir);
  const store = options.repo === undefined ? loaded : inRepositoryStore(loaded, options.repo);
  const rows = books(store, options.by, deps.now(), options.sinceDays);
  // A mistyped root over a populated store must not read as an empty store.
  const table =
    rows.length === 0 && options.repo !== undefined
      ? `No prompts for ${options.repo} in the store (${String(loaded.prompts.length)} prompts across all repositories).`
      : formatBooks(rows, options.by);
  return { document: { ok: true, by: options.by, rows, newerCaptures: store.newerCaptures }, text: [table, ...newerNotice(store)].join('\n') };
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
  /** Every session's rows 1 to 10 with a status each (t743; spec 5.4 item 5): `pass`, `fail`, or `not run` when the row had nothing to check. */
  sessionResults: SessionVerification[];
  /** Layer 4 at T0, local (spec 2.4): each session's raw-file match, recomputed root, and count bindings, with the count of each row of the result table. */
  audit: { counts: T0Counts; sessions: SessionAudit[] };
}

/** With `strict`, any violated invariant, stuck step, `merkle: root mismatch`, or `merkle: counts do not bind` also fails the command (exit 4) after the full report is printed; the report is built first so callers can emit it. */
export const sessionsVerify = async (deps: SessionsDeps, options: { session: string | undefined }): Promise<Outcome & { failed: string[]; report: VerifyReport }> => {
  const runtime = runtimeOf(deps);
  const { storeDir } = runtime;
  // When the store cannot be read there is no high-water mark yet, so a failed run's key is the session asked for and `ev`.
  return runStep(newContext(storeDir, deps.now, 'manual'), 'verify', async () => {
    // Every skeleton is read even for one session: row 6 takes its subagent transcripts' lines, which `<id>.json` alone would miss.
    const everySkeleton = await readSkeletons(storeDir);
    const { unreadable } = options.session === undefined ? everySkeleton : await readSkeletons(storeDir, options.session);
    const skeletons = everySkeleton.skeletons.filter((skeleton) => options.session === undefined || skeleton.session === options.session);
    const store = await loadStore(storeDir);
    const mine = <T extends { session: string }>(records: readonly T[]): T[] => records.filter((record) => options.session === undefined || record.session === options.session);
    const captured = mine([...store.sessions, ...store.subagents]);
    // A session behind the current version whose transcript is in neither the harness nor raw/ (or, for a Cursor session, whose composer is gone from Cursor) can never be captured again: counted apart, never a strict failure.
    const frozen = await frozenSessions(runtime, captured.filter((session) => Number(session.cv) >= OLDEST_READABLE_CAPTURE && Number(session.cv) < Number(CAPTURE_VERSION)));
    const results = [...verifyAll(skeletons, everySkeleton.skeletons), ...verifyCaptured(captured, mine(store.tools), frozen)];
    const sessionResults = verifySessions(everySkeleton.skeletons, captured, mine(store.tools), frozen).filter((entry) => options.session === undefined || entry.session === options.session);
    const audits = await auditStore(runtime, captured, skeletons);
    const audit = { counts: auditCounts(audits), sessions: audits };
    // A root that misses a file which matches, or records that disagree with each other, leave `W` at 0 (spec 2.4): they fail `--strict` like a violated invariant.
    const merkleFailed = (['root mismatch', 'counts do not bind'] as const).filter((result) => audit.counts[result] > 0).map((result) => `merkle: ${result}`);
    // Steps whose key failed on three runs in a row (spec 4.4), read before this run's own row is appended; each fails `--strict` like a violated invariant.
    // A step log that cannot be read leaves the invariant check as it is: the stuck check is an extra, never a reason `verify` fails.
    // A verify that got here has succeeded, so a verify streak is the one this run ends and is not listed.
    const stuck = stuckSteps(await readSteps(storeDir).catch((): StepRow[] => [])).filter((entry) => entry.step !== 'verify');
    const report: VerifyReport = { sessions: skeletons.length, unreadable, cvFrozen: frozen.size, invariants: results.map((result) => ({ ...result, pass: result.violations === 0 })), stuck, sessionResults, audit };
    const failed = [...results.filter((result) => result.violations > 0).map((result) => result.name), ...(unreadable > 0 ? ['unreadable skeletons'] : []), ...merkleFailed, ...stuck.map((entry) => `stuck: ${entry.step}`)];
    const stuckLines = stuck.map((entry) => `FAIL  ${entry.step} is stuck: key ${entry.key} failed ${String(entry.runs)} runs in a row: ${entry.error}`);
    const highWater = mine([...store.sessions, ...store.subagents]).map((session) => `${session.session}:${String(session.rev)}:${session.cv}`).sort();
    const resultLines = formatSessionResults(sessionResults);
    const outcome = {
      failed,
      report,
      document: { ok: true, ...report, newerCaptures: store.newerCaptures },
      text: [formatVerify(results, skeletons.length), ...(resultLines === '' ? [] : [resultLines]), formatAudit(audits), ...(frozen.size > 0 ? [`${String(frozen.size)} cv-frozen sessions: behind the current capture version, but the transcript is gone from the harness and raw/ (or, for a Cursor session, the composer is gone from Cursor), so they cannot be captured again`] : []), ...newerNotice(store), ...(unreadable > 0 ? [`FAIL  ${String(unreadable)} unreadable skeleton files (torn or corrupted); redeposit to rebuild them`] : []), ...stuckLines].join('\n'),
    };
    const cvBehind = results.find((result) => result.name === CAPTURE_INVARIANTS[0])?.violations ?? 0;
    // The key is the sessions checked, each at its rev and cv, and the code's ev (spec 4.2).
    const key = stampKey(...highWater);
    const counts = { checked: results.length, passed: results.filter((result) => result.violations === 0).length, cvBehind, cvFrozen: frozen.size, stuck: stuck.length };
    return { value: outcome, report: { in: { session: mine(store.sessions).length, subagent: mine(store.subagents).length }, out: counts, key } };
  }, stampKey('verify', options.session ?? ''));
};

const GOLD_MODE = 0o600;

/** `gold sample`: writes the blind gold file and its hidden sidecar. It never overwrites one: the file may hold judgments. */
export const sessionsGoldSample = async (deps: SessionsDeps, options: { size: number; batch: number; seed: string | undefined; excludeTerms: string[]; outDir: string | undefined }): Promise<Outcome> => {
  const runtime = runtimeOf(deps);
  const date = new Date(deps.now()).toISOString().slice(0, 10);
  const dir = options.outDir ?? join(dirname(runtime.projectsRoot), 'session-commons', 'review');
  const file = join(dir, `outcome-gold-${date}.md`);
  const arms = armsPath(file);
  const taken = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
  if (await taken(file)) throw new CliError(`${file} already exists, and it may hold judgments. Move it, or pass another --out-dir.`, ExitCode.USAGE, 'usage');
  if (await taken(arms)) throw new CliError(`${arms} already exists, and it may hold readings. Move it, or pass another --out-dir.`, ExitCode.USAGE, 'usage');
  const store = await loadStore(runtime.storeDir);
  const redact = makeRedactor(await readRedactDomains(runtime.storeDir));
  const { document, views, unreadable } = await sampleGold(runtime, store, redact, { size: options.size, batch: options.batch, seed: options.seed ?? date, date, excludeTerms: options.excludeTerms });
  await mkdir(dir, { recursive: true });
  // The check above came before a long draw; `wx` holds the promise if another run wrote in between.
  await writeFile(arms, JSON.stringify(document), { mode: GOLD_MODE, flag: 'wx' });
  await writeFile(file, renderGold(views, { date, batch: options.batch }), { mode: GOLD_MODE, flag: 'wx' });
  const subagents = document.entries.filter((entry) => entry.subagents > 0).length;
  const lines = [
    `Wrote ${String(document.entries.length)} prompts, drawn from ${String(document.frame)}, to ${file}.`,
    options.excludeTerms.length === 0 ? 'No --exclude-term given: no session was excluded.' : `Excluded ${String(document.excludedSessions)} sessions the draw reached that mention an excluded term.`,
    `Passed over ${String(unreadable)} prompts whose transcript is gone or no longer matches the store.`,
    `${String(subagents)} sampled prompts ran subagents, whose work is not read.`,
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
  if (outcome.failure !== undefined) throw new CliError(`${outcome.failure.message} ${String(outcome.left)} readings are left, and every answer so far is saved. Rerun this command to go on.`, ExitCode.UNEXPECTED, 'unexpected');
  const score = scoreGold(document.entries, new Map());
  const lines = [
    `Asked ${String(outcome.asked)} readings on ${EVALUATOR_MODEL}, with ${String(outcome.left)} left. The gold file is unchanged.`,
    `${String(outcome.changed)} prompts have a transcript that is gone or no longer matches what the judge sees, so their text arms are unread.`,
    ...coverageLines(score),
  ];
  return { document: { ok: true, asked: outcome.asked, left: outcome.left, changed: outcome.changed, model: EVALUATOR_MODEL, coverage: score.coverage }, text: lines.join('\n') };
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
