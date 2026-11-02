// The read side: recall, books, and measure. All three are pure functions of a loaded store (and, for measure, the MCP log).
import { errorKey } from './extract.js';
import { makeRedactor } from './redact.js';
import { harnessOf, type ErrorObservation, type HookCall, type PromptObservation, type RecallCall, type SessionObservation, type SignatureRecord } from './schema.js';
import { signatureRecord, type Store } from './store.js';

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

export const recall = (store: Store, query: RecallQuery, now: number, limit = 10, redactDomains: readonly string[] = []): RecallResult => {
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
  const bySig = new Map<string, ErrorObservation[]>();
  for (const error of store.errors) {
    if (cutoff !== undefined && (error.ts === null || error.ts < cutoff)) continue;
    if (query.cls !== undefined && error.cls !== query.cls) continue;
    if (sessions !== undefined && !sessions.has(error.session)) continue;
    if (tool !== undefined && error.tool !== tool) continue;
    if (normalized !== null) {
      const text = error.sig.slice(error.sig.indexOf(' | ') + 3);
      if (normalized === '' || !text.includes(normalized)) continue;
    }
    bySig.set(error.sig, [...(bySig.get(error.sig) ?? []), error]);
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

export interface BooksRow {
  key: string;
  prompts: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thinking: number;
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

export type BooksBy = 'class' | 'model' | 'harness';

export const books = (store: Store, by: BooksBy, now: number, sinceDays?: number): BooksRow[] => {
  const cutoff = sinceCutoff(now, sinceDays);
  const groups = new Map<string, PromptObservation[]>();
  const harnesses = new Map(store.sessions.map((session) => [session.session, harnessOf(session)]));
  for (const prompt of store.prompts) {
    if (cutoff !== undefined && (prompt.ts === null || prompt.ts < cutoff)) continue;
    const key = by === 'class' ? prompt.cls : by === 'model' ? prompt.model : (harnesses.get(prompt.session) ?? 'claude-code');
    groups.set(key, [...(groups.get(key) ?? []), prompt]);
  }
  const sum = (list: readonly PromptObservation[], pick: (prompt: PromptObservation) => number): number => list.reduce((total, prompt) => total + pick(prompt), 0);
  const delegated = delegatedByPrompt(store);
  return [...groups.entries()]
    .map(([key, list]) => {
      const verified = list.filter((prompt) => prompt.cls === 'edit-verify').length;
      const edited = verified + list.filter((prompt) => prompt.cls === 'edit-only').length;
      return {
        key,
        prompts: list.length,
        cacheRead: sum(list, (prompt) => prompt.usage.cacheRead),
        cacheWrite: sum(list, (prompt) => prompt.usage.cacheWrite),
        output: sum(list, (prompt) => prompt.usage.output),
        thinking: sum(list, (prompt) => prompt.usage.thinking),
        wallSec: Math.round(sum(list, (prompt) => prompt.wallSec ?? 0)),
        turns: sum(list, (prompt) => prompt.turns),
        errors: sum(list, (prompt) => prompt.errors),
        verifyAfterEdit: edited === 0 ? null : Math.round((verified / edited) * 1000) / 1000,
        delegated: sum(list, (prompt) => delegated.get(`${prompt.session}#${String(prompt.index)}`) ?? 0),
      };
    })
    .sort((a, b) => b.prompts - a.prompts || a.key.localeCompare(b.key));
};

export const formatBooks = (rows: readonly BooksRow[], by: BooksBy): string => {
  if (rows.length === 0) return 'No prompts in the store.';
  const header = `${by.padEnd(14)} ${'prompts'.padStart(8)} ${'cache read'.padStart(14)} ${'cache write'.padStart(13)} ${'output'.padStart(11)} ${'thinking'.padStart(10)} ${'wall s'.padStart(9)} ${'turns'.padStart(7)} ${'errors'.padStart(7)} ${'verify'.padStart(7)} ${'delegated'.padStart(13)}`;
  const lines = rows.map(
    (row) =>
      `${row.key.padEnd(14)} ${String(row.prompts).padStart(8)} ${String(row.cacheRead).padStart(14)} ${String(row.cacheWrite).padStart(13)} ${String(row.output).padStart(11)} ${String(row.thinking).padStart(10)} ${String(row.wallSec).padStart(9)} ${String(row.turns).padStart(7)} ${String(row.errors).padStart(7)} ${(row.verifyAfterEdit === null ? '-' : `${String(Math.round(row.verifyAfterEdit * 100))}%`).padStart(7)} ${String(row.delegated).padStart(13)}`,
  );
  return [header, ...lines].join('\n');
};

export interface Signal {
  sessions: number;
  /** Errors whose signature had already occurred in an earlier session, per hundred sessions. */
  recurringPer100: number | null;
  /** Distinct signatures among those recurring errors in the window. */
  recurringSignatures: number | null;
  /** Mean cache-write tokens of a session in the window. */
  cacheWritePerSession: number | null;
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
    if (slice.length === 0) return { sessions: 0, cursorSessions: 0, recurringPer100: null, recurringSignatures: null, cacheWritePerSession: null, recallPerSession: null, hookRecallPerSession: null, hookHitsPerSession: null, hookDepositsPerSession: null };
    const names = new Set(slice.map((session) => session.session));
    const recurringErrors = store.errors.filter((error) => names.has(error.session) && (index.get(error.session) ?? 0) > (firstSeen.get(error.sig) ?? 0));
    const recurring = recurringErrors.length;
    const from = slice.map((session) => session.tsFirst).filter((ts): ts is string => ts !== null).sort()[0];
    const to = slice.map((session) => session.tsLast).filter((ts): ts is string => ts !== null).sort().reverse()[0];
    const inWindow = from === undefined || to === undefined ? 0 : calls.filter((call) => call.at >= from && call.at <= to).length;
    const round = (value: number): number => Math.round(value * 100) / 100;
    const lookups = hookCalls.filter((call) => call.session !== null && names.has(call.session) && (call.event === 'session-start' || call.event === 'post-tool'));
    return {
      sessions: slice.length,
      cursorSessions: slice.filter((session) => harnessOf(session) === 'cursor').length,
      recurringPer100: round((recurring * 100) / slice.length),
      recurringSignatures: new Set(recurringErrors.map((error) => error.sig)).size,
      cacheWritePerSession: Math.round(slice.reduce((total, session) => total + session.usage.cacheWrite, 0) / slice.length),
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
  const row = (label: string, pick: (signal: Signal) => number | null): string => `${label.padEnd(36)} ${cell(pick(result.last)).padStart(12)} ${cell(pick(result.before)).padStart(12)}`;
  return [
    `${(result.since === null ? `G1 signals, last ${String(result.window)} sessions and the ${String(result.window)} before` : `G1 signals, ${String(result.window)} sessions from ${result.since} and the ${String(result.window)} before`).padEnd(36)} ${(result.since === null ? 'last' : 'from').padStart(12)} ${'before'.padStart(12)}`,
    row('sessions in the window', (signal) => signal.sessions),
    row('  of which Cursor', (signal) => signal.cursorSessions),
    row('recurring errors per 100 sessions', (signal) => signal.recurringPer100),
    row('distinct recurring signatures', (signal) => signal.recurringSignatures),
    row('cache-write tokens per session', (signal) => signal.cacheWritePerSession),
    row('recall calls per session', (signal) => signal.recallPerSession),
    row('hook recall calls per session', (signal) => signal.hookRecallPerSession),
    row('hook hits per session', (signal) => signal.hookHitsPerSession),
    row('hook deposits per session', (signal) => signal.hookDepositsPerSession),
  ].join('\n');
};
