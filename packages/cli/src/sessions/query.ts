// The read side: recall, books, and measure. All three are pure functions of a loaded store (and, for measure, the MCP log).
import { firstCopies } from './derive.js';
import { errorKey } from './extract.js';
import { makeRedactor } from './redact.js';
import { SOURCES } from './sources.js';
import { harnessOf, observesUsage, type ErrorObservation, type HookCall, type PromptObservation, type RecallCall, type SessionObservation, type SignatureRecord } from './schema.js';
import { signatureRecord, type Store } from './store.js';
import type { SurvivalState } from './survival.js';

const DAY_MS = 86_400_000;
const sinceCutoff = (now: number, days: number | undefined): string | undefined => (days === undefined ? undefined : new Date(now - days * DAY_MS).toISOString());

export interface RecallQuery {
  /** Error text as pasted: it is normalized the way deposit normalizes an error. */
  error?: string;
  /** A file the session touched (a path, or a bare file name). */
  path?: string;
  cls?: string;
  sinceDays?: number;
}

export interface RecallMatch extends SignatureRecord {
  /** Tools that followed, most common first. */
  followedBy: Array<{ tool: string; count: number }>;
}

export interface RecallResult {
  query: RecallQuery;
  /** The normalized, redacted form of `error` that was matched. */
  normalized: string | null;
  matches: RecallMatch[];
}

/** `Bash | text` pasted whole selects the tool too. */
const splitTool = (query: string): { tool: string | undefined; text: string } => {
  const found = /^([^\s|]+) \| ([\s\S]*)$/.exec(query.trim());
  return found === null ? { tool: undefined, text: query } : { tool: found[1], text: found[2] ?? '' };
};

const touched = (session: SessionObservation, path: string): boolean => session.files.some((file) => file === path || file.endsWith(`/${path}`) || file.endsWith(`\\${path}`));

/** Which error rows a query selects, and the normalized text it matched them on. A count stated for a narrowed query reads through this, so it counts what the query narrowed to. */
export const recallRows = (store: Store, query: RecallQuery, now: number, redactDomains: readonly string[] = []): { normalized: string | null; keep: (error: ErrorObservation) => boolean } => {
  const redact = makeRedactor(redactDomains);
  const cutoff = sinceCutoff(now, query.sinceDays);
  let tool: string | undefined;
  let normalized: string | null = null;
  if (query.error !== undefined) {
    const split = splitTool(query.error);
    tool = split.tool;
    normalized = errorKey(split.text, redact);
  }
  const path = query.path === undefined ? undefined : redact(query.path);
  const sessions = path === undefined ? undefined : new Set(store.sessions.filter((session) => touched(session, path)).map((session) => session.session));
  const keep = (error: ErrorObservation): boolean => {
    if (cutoff !== undefined && (error.ts === null || error.ts < cutoff)) return false;
    if (query.cls !== undefined && error.cls !== query.cls) return false;
    if (sessions !== undefined && !sessions.has(error.session)) return false;
    if (tool !== undefined && error.tool !== tool) return false;
    if (normalized === null) return true;
    return normalized !== '' && error.sig.slice(error.sig.indexOf(' | ') + 3).includes(normalized);
  };
  return { normalized, keep };
};

export const recall = (store: Store, query: RecallQuery, now: number, limit = 10, redactDomains: readonly string[] = []): RecallResult => {
  const { normalized, keep } = recallRows(store, query, now, redactDomains);
  const bySig = new Map<string, ErrorObservation[]>();
  for (const error of store.errors) {
    if (keep(error)) bySig.set(error.sig, [...(bySig.get(error.sig) ?? []), error]);
  }
  const matches: RecallMatch[] = [...bySig.entries()]
    .map(([sig, list]) => signatureRecord(sig, list))
    .sort((a, b) => b.sessions - a.sessions || b.count - a.count || a.sig.localeCompare(b.sig))
    .slice(0, limit)
    .map((record) => ({ ...record, followedBy: Object.entries(record.following).map(([followed, count]) => ({ tool: followed, count })).sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)) }));
  return { query, normalized, matches };
};

export const formatRecall = (result: RecallResult): string => {
  if (result.matches.length === 0) return 'No matching signature in the store.';
  return result.matches
    .map((match) => {
      const followed = match.followedBy.slice(0, 3).map((entry) => `${entry.tool} x${String(entry.count)}`).join(', ');
      return [
        match.sig,
        `  ${String(match.sessions)} sessions, ${String(match.count)} errors, first ${match.firstSeen ?? 'unknown'}, last ${match.lastSeen ?? 'unknown'}`,
        `  harness ${match.harnessVersions.join(', ') || 'unknown'}; followed by ${followed || 'nothing'}; an edit followed ${String(match.editFollowed)} times`,
      ].join('\n');
    })
    .join('\n');
};

/** Below this many in its denominator a share is noise, so a cell has none and prints as too few. The counts stay in `--json`. */
export const BOOKS_MIN_PROMPTS = 30;

/** A signal in a row: how many of the prompts or commits that can carry it did, and the share when `of` reaches `BOOKS_MIN_PROMPTS`. */
export interface BooksShare {
  count: number;
  of: number;
  share: number | null;
}

/** The usage columns of a row. Each sums only the prompts that recorded the category, and is null when none did: absent, never a measured 0. */
export const BOOKS_USAGE_FIELDS = ['cacheRead', 'cacheWrite', 'output', 'thinking'] as const;

export interface BooksUsageCoverage {
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thinking: number;
}

export interface BooksRow {
  key: string;
  prompts: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  thinking: number | null;
  /** How many of `prompts` recorded each usage category; below `prompts` the column is a partial sum. */
  usageRecorded: BooksUsageCoverage;
  wallSec: number;
  turns: number;
  errors: number;
  /** Prompts that edited and then ran a command, over prompts that edited; null when none edited. */
  verifyAfterEdit: number | null;
  /**
   * Tokens (input, cache write, cache read, output) spent by the subagents these prompts spawned (A24): a subagent transcript joins its
   * parent's `Agent` call by tool-use id, and that call's prompt gives the row.
   */
  delegated: number;
  /** `verify` passed, of the prompts that edited and whose `verify` can be read (not `na`, not `masked`, not absent; `none` counts, since no runner read as passing). */
  verifyPassed: BooksShare;
  /** A stop, of the prompts carrying `stopped`. */
  stopped: BooksShare;
  /** A redo, of the prompts carrying `redo`. */
  redone: BooksShare;
  /** The prompts' `commits`, with or without a readable sha. */
  commits: number;
  /** Distinct shas of these prompts that survival has a known state for: survived, reverted, or unreachable, not unknown. */
  settled: number;
  /** Survived, of `settled`. */
  survived: BooksShare;
}

/** Each subagent's tokens, keyed by the parent prompt that spawned it (`<session>#<index>`). */
const delegatedByPrompt = (store: Store): Map<string, number> => {
  const promptOf = new Map<string, string>();
  for (const tool of store.tools) {
    if (tool.toolUseId !== null && tool.prompt !== null) promptOf.set(`${tool.session} ${tool.toolUseId}`, `${tool.session}#${String(tool.prompt)}`);
  }
  const totals = new Map<string, number>();
  for (const agent of store.subagents) {
    const prompt = promptOf.get(`${String(agent.parent)} ${String(agent.spawnedBy)}`);
    if (prompt === undefined) continue;
    const { input, cacheWrite, cacheRead, output } = agent.usage;
    totals.set(prompt, (totals.get(prompt) ?? 0) + input + cacheWrite + cacheRead + output);
  }
  return totals;
};

export type BooksBy = 'class' | 'model' | 'harness' | 'pull';

const promptKey = (session: string, index: number): string => `${session}#${String(index)}`;

const shareOf = (count: number, of: number): BooksShare => ({ count, of, share: of < BOOKS_MIN_PROMPTS ? null : Math.round((count / of) * 1000) / 1000 });

interface PromptCalls {
  shas: Set<string>;
  pulls: Set<string>;
}

/** Each prompt's shas and pulls, by the rule `commits` is derived under: a session's first copy of a call, off the sidechain. */
const callsByPrompt = (store: Store): Map<string, PromptCalls> => {
  const bySession = new Map<string, Store['tools']>();
  for (const tool of store.tools) {
    const list = bySession.get(tool.session);
    if (list === undefined) bySession.set(tool.session, [tool]);
    else list.push(tool);
  }
  const calls = new Map<string, PromptCalls>();
  for (const tools of bySession.values()) {
    for (const tool of firstCopies(tools)) {
      if (tool.prompt === null || (tool.commits === undefined && tool.pulls === undefined)) continue;
      const key = promptKey(tool.session, tool.prompt);
      const entry = calls.get(key) ?? { shas: new Set(), pulls: new Set() };
      for (const sha of tool.commits ?? []) if (sha !== null) entry.shas.add(sha);
      for (const pull of tool.pulls ?? []) entry.pulls.add(`${pull.ecosystem}:${pull.name}`);
      calls.set(key, entry);
    }
  }
  return calls;
};

const recordedBy = (list: readonly PromptObservation[], field: (typeof BOOKS_USAGE_FIELDS)[number]): number => list.filter((prompt) => observesUsage(prompt, field)).length;

/** The sum of one usage category over the prompts that recorded it, or null when none did. */
const usageSum = (list: readonly PromptObservation[], field: (typeof BOOKS_USAGE_FIELDS)[number]): number | null =>
  recordedBy(list, field) === 0 ? null : list.reduce((total, prompt) => total + (observesUsage(prompt, field) ? prompt.usage[field] : 0), 0);

export const books = (store: Store, by: BooksBy, now: number, sinceDays?: number, survival: ReadonlyMap<string, SurvivalState> = new Map()): BooksRow[] => {
  const cutoff = sinceCutoff(now, sinceDays);
  const groups = new Map<string, PromptObservation[]>();
  const harnesses = new Map(store.sessions.map((session) => [session.session, harnessOf(session)]));
  const calls = callsByPrompt(store);
  const keysOf = (prompt: PromptObservation): Iterable<string> => {
    if (by === 'pull') return calls.get(promptKey(prompt.session, prompt.index))?.pulls ?? [];
    return [by === 'class' ? prompt.cls : by === 'model' ? prompt.model : (harnesses.get(prompt.session) ?? 'claude-code')];
  };
  for (const prompt of store.prompts) {
    if (cutoff !== undefined && (prompt.ts === null || prompt.ts < cutoff)) continue;
    for (const key of keysOf(prompt)) {
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [prompt]);
      else group.push(prompt);
    }
  }
  const sum = (list: readonly PromptObservation[], pick: (prompt: PromptObservation) => number): number => list.reduce((total, prompt) => total + pick(prompt), 0);
  const delegated = delegatedByPrompt(store);
  return [...groups.entries()]
    .map(([key, list]) => {
      const verified = list.filter((prompt) => prompt.cls === 'edit-verify').length;
      const edited = verified + list.filter((prompt) => prompt.cls === 'edit-only').length;
      const readable = list.filter((prompt) => prompt.verify !== undefined && prompt.verify !== 'na' && prompt.verify !== 'masked');
      const carryingStop = list.filter((prompt) => prompt.stopped !== undefined);
      const carryingRedo = list.filter((prompt) => prompt.redo !== undefined);
      const states = [...new Set(list.flatMap((prompt) => [...(calls.get(promptKey(prompt.session, prompt.index))?.shas ?? [])]))].map((sha) => survival.get(sha));
      const settled = states.filter((state) => state !== undefined && state !== 'unknown').length;
      return {
        key,
        prompts: list.length,
        cacheRead: usageSum(list, 'cacheRead'),
        cacheWrite: usageSum(list, 'cacheWrite'),
        output: usageSum(list, 'output'),
        thinking: usageSum(list, 'thinking'),
        usageRecorded: { cacheRead: recordedBy(list, 'cacheRead'), cacheWrite: recordedBy(list, 'cacheWrite'), output: recordedBy(list, 'output'), thinking: recordedBy(list, 'thinking') },
        wallSec: Math.round(sum(list, (prompt) => prompt.wallSec ?? 0)),
        turns: sum(list, (prompt) => prompt.turns),
        errors: sum(list, (prompt) => prompt.errors),
        verifyAfterEdit: edited === 0 ? null : Math.round((verified / edited) * 1000) / 1000,
        delegated: sum(list, (prompt) => delegated.get(promptKey(prompt.session, prompt.index)) ?? 0),
        verifyPassed: shareOf(readable.filter((prompt) => prompt.verify === 'passed').length, readable.length),
        stopped: shareOf(carryingStop.filter((prompt) => prompt.stopped !== null).length, carryingStop.length),
        redone: shareOf(carryingRedo.filter((prompt) => prompt.redo === true).length, carryingRedo.length),
        commits: sum(list, (prompt) => prompt.commits ?? 0),
        settled,
        survived: shareOf(states.filter((state) => state === 'survived').length, settled),
      };
    })
    .sort((a, b) => b.prompts - a.prompts || a.key.localeCompare(b.key));
};

/** The closing line of `books` text: what the columns can and cannot be read as. */
export const BOOKS_CAVEAT = "These are associations in one operator's logs, not measured lift.";

const shareCell = (cell: BooksShare): string => (cell.share === null ? 'too few' : `${String(Math.round(cell.share * 100))}%`);

const USAGE_LABELS = { cacheRead: 'cache read', cacheWrite: 'cache write', output: 'output', thinking: 'thinking' } as const;

export const formatBooks = (rows: readonly BooksRow[], by: BooksBy): string => {
  if (rows.length === 0) return by === 'pull' ? 'No pulls in the store.' : 'No prompts in the store.';
  // A pull name, unlike a class, has no length it stays under.
  const width = Math.max(14, ...rows.map((row) => row.key.length));
  const usage = (row: BooksRow, field: (typeof BOOKS_USAGE_FIELDS)[number]): string => (row[field] === null ? 'n/a' : String(row[field]));
  const header = `${by.padEnd(width)} ${'prompts'.padStart(8)} ${'cache read'.padStart(14)} ${'cache write'.padStart(13)} ${'output'.padStart(11)} ${'thinking'.padStart(10)} ${'wall s'.padStart(9)} ${'turns'.padStart(7)} ${'errors'.padStart(7)} ${'verify'.padStart(7)} ${'delegated'.padStart(13)} ${'passed'.padStart(8)} ${'stop'.padStart(8)} ${'redo'.padStart(8)} ${'commits'.padStart(8)} ${'settled'.padStart(8)} ${'survived'.padStart(8)}`;
  const lines = rows.map(
    (row) =>
      `${row.key.padEnd(width)} ${String(row.prompts).padStart(8)} ${usage(row, 'cacheRead').padStart(14)} ${usage(row, 'cacheWrite').padStart(13)} ${usage(row, 'output').padStart(11)} ${usage(row, 'thinking').padStart(10)} ${String(row.wallSec).padStart(9)} ${String(row.turns).padStart(7)} ${String(row.errors).padStart(7)} ${(row.verifyAfterEdit === null ? '-' : `${String(Math.round(row.verifyAfterEdit * 100))}%`).padStart(7)} ${String(row.delegated).padStart(13)} ${shareCell(row.verifyPassed).padStart(8)} ${shareCell(row.stopped).padStart(8)} ${shareCell(row.redone).padStart(8)} ${String(row.commits).padStart(8)} ${String(row.settled).padStart(8)} ${shareCell(row.survived).padStart(8)}`,
  );
  // A column some prompts did not record is a partial sum: say how many did in a line under the table (a column no prompt recorded prints n/a and needs no line), so the table's columns stay aligned.
  const coverage = rows.flatMap((row) => BOOKS_USAGE_FIELDS.filter((field) => row.usageRecorded[field] > 0 && row.usageRecorded[field] < row.prompts).map((field) => `${row.key} ${USAGE_LABELS[field]}: ${String(row.usageRecorded[field])} of ${String(row.prompts)} prompts recorded`));
  return [header, ...lines, ...coverage].join('\n');
};

export interface Signal {
  sessions: number;
  /** Errors whose signature had already occurred in an earlier session, per hundred sessions. */
  recurringPer100: number | null;
  /** Distinct signatures among those recurring errors in the window. */
  recurringSignatures: number | null;
  /** Mean cache-write tokens of the window's sessions that recorded them; null when none did. */
  cacheWritePerSession: number | null;
  /** How many of `sessions` recorded cache-write tokens, the sessions `cacheWritePerSession` is a mean over. */
  cacheWriteSessions: number;
  /** MCP recall calls made during the window, per session. */
  recallPerSession: number | null;
  /** Hook lookups (SessionStart injection and PostToolUse recall) made in the window's sessions, per session. */
  hookRecallPerSession: number | null;
  /** Hook lookups that had something to say (an injected block or a recall hit), per session. */
  hookHitsPerSession: number | null;
  /** Sessions the SessionEnd hook deposited, per session (a deposit is a stop call that wrote something). */
  hookDepositsPerSession: number | null;
  /** Of `sessions`, those the Cursor source deposited (harness `cursor`). */
  cursorSessions: number;
  /** Of `sessions`, those each later source deposited, by harness (Cursor keeps `cursorSessions`); absent in an empty window. */
  otherSessions?: { [harness: string]: number };
}

export interface Measure {
  window: number;
  /** The cutoff the current window starts at, when `--since` pinned it. */
  since: string | null;
  last: Signal;
  before: Signal;
}

const order = (a: SessionObservation, b: SessionObservation): number => (a.tsFirst ?? '').localeCompare(b.tsFirst ?? '') || a.session.localeCompare(b.session);

/**
 * Without `since` the current window is the last `window` sessions, so it moves with every deposit. With it, the current window is the
 * first `window` sessions that started at or after the cutoff and the prior window is the `window` before it, so a reading pinned to an
 * install time keeps its start however many sessions come later.
 */
export const measure = (store: Store, calls: readonly RecallCall[], hookCalls: readonly HookCall[], window: number, since?: string): Measure => {
  const sessions = [...store.sessions].sort(order);
  const index = new Map(sessions.map((session, position) => [session.session, position]));
  const firstSeen = new Map<string, number>();
  for (const error of store.errors) {
    const position = index.get(error.session);
    if (position !== undefined) firstSeen.set(error.sig, Math.min(firstSeen.get(error.sig) ?? position, position));
  }
  const signal = (slice: readonly SessionObservation[]): Signal => {
    if (slice.length === 0) return { sessions: 0, cursorSessions: 0, recurringPer100: null, recurringSignatures: null, cacheWritePerSession: null, cacheWriteSessions: 0, recallPerSession: null, hookRecallPerSession: null, hookHitsPerSession: null, hookDepositsPerSession: null };
    const names = new Set(slice.map((session) => session.session));
    const recurringErrors = store.errors.filter((error) => names.has(error.session) && (index.get(error.session) ?? 0) > (firstSeen.get(error.sig) ?? 0));
    const recurring = recurringErrors.length;
    const from = slice.map((session) => session.tsFirst).filter((ts): ts is string => ts !== null).sort()[0];
    const to = slice.map((session) => session.tsLast).filter((ts): ts is string => ts !== null).sort().reverse()[0];
    const inWindow = from === undefined || to === undefined ? 0 : calls.filter((call) => call.at >= from && call.at <= to).length;
    const round = (value: number): number => Math.round(value * 100) / 100;
    // A session that never recorded cache writes holds a placeholder zero there, which would pull the mean down.
    const recorded = slice.filter((session) => observesUsage(session, 'cacheWrite'));
    const lookups = hookCalls.filter((call) => call.session !== null && names.has(call.session) && (call.event === 'session-start' || call.event === 'post-tool'));
    return {
      sessions: slice.length,
      cursorSessions: slice.filter((session) => harnessOf(session) === 'cursor').length,
      otherSessions: Object.fromEntries(SOURCES.filter((source) => source.harness !== 'cursor').map((source) => [source.harness, slice.filter((session) => harnessOf(session) === source.harness).length])),
      recurringPer100: round((recurring * 100) / slice.length),
      recurringSignatures: new Set(recurringErrors.map((error) => error.sig)).size,
      cacheWritePerSession: recorded.length === 0 ? null : Math.round(recorded.reduce((total, session) => total + session.usage.cacheWrite, 0) / recorded.length),
      cacheWriteSessions: recorded.length,
      recallPerSession: round(inWindow / slice.length),
      hookRecallPerSession: round(lookups.length / slice.length),
      hookHitsPerSession: round(lookups.filter((call) => call.hit).length / slice.length),
      hookDepositsPerSession: round(hookCalls.filter((call) => call.session !== null && names.has(call.session) && call.event === 'stop' && call.hit).length / slice.length),
    };
  };
  const start = since === undefined ? Math.max(sessions.length - window, 0) : sessions.findIndex((session) => (session.tsFirst ?? '') >= since);
  if (start < 0) return { window, since: since ?? null, last: signal([]), before: signal(sessions.slice(Math.max(sessions.length - window, 0))) };
  return { window, since: since ?? null, last: signal(sessions.slice(start, start + window)), before: signal(sessions.slice(Math.max(start - window, 0), start)) };
};

export const formatMeasure = (result: Measure): string => {
  const cell = (value: number | null): string => (value === null ? '-' : String(value));
  const cacheWrite = (signal: Signal): string => {
    if (signal.cacheWritePerSession === null) return signal.sessions === 0 ? '-' : 'n/a';
    return String(signal.cacheWritePerSession);
  };
  const row = (label: string, pick: (signal: Signal) => number | null): string => `${label.padEnd(36)} ${cell(pick(result.last)).padStart(12)} ${cell(pick(result.before)).padStart(12)}`;
  // A mean over only some of a window's sessions says so on its own line under the table, as `books` does, so a five-digit mean cannot push the `before` column out of line.
  const coverage = (['last', 'before'] as const).filter((name) => result[name].cacheWriteSessions > 0 && result[name].cacheWriteSessions < result[name].sessions).map((name) => `cache-write tokens per session, ${name}: ${String(result[name].cacheWriteSessions)} of ${String(result[name].sessions)} sessions recorded`);
  return [
    `${(result.since === null ? `G1 signals, last ${String(result.window)} sessions and the ${String(result.window)} before` : `G1 signals, ${String(result.window)} sessions from ${result.since} and the ${String(result.window)} before`).padEnd(36)} ${(result.since === null ? 'last' : 'from').padStart(12)} ${'before'.padStart(12)}`,
    row('sessions in the window', (signal) => signal.sessions),
    row('  of which Cursor', (signal) => signal.cursorSessions),
    ...SOURCES.filter((source) => source.harness !== 'cursor' && ((result.last.otherSessions?.[source.harness] ?? 0) > 0 || (result.before.otherSessions?.[source.harness] ?? 0) > 0)).map((source) => row(`  of which ${source.label}`, (signal) => signal.otherSessions?.[source.harness] ?? 0)),
    row('recurring errors per 100 sessions', (signal) => signal.recurringPer100),
    row('distinct recurring signatures', (signal) => signal.recurringSignatures),
    // `-` is an empty window; `n/a` is sessions in it that never recorded cache writes; a partial mean is named in a line under the table.
    `${'cache-write tokens per session'.padEnd(36)} ${cacheWrite(result.last).padStart(12)} ${cacheWrite(result.before).padStart(12)}`,
    row('recall calls per session', (signal) => signal.recallPerSession),
    row('hook recall calls per session', (signal) => signal.hookRecallPerSession),
    row('hook hits per session', (signal) => signal.hookHitsPerSession),
    row('hook deposits per session', (signal) => signal.hookDepositsPerSession),
    ...coverage,
  ].join('\n');
};
