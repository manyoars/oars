// `oars gate hook`: the PreToolUse hook that records a crossing as it happens. It records, and says something only when the policy (`policy.ts`) says to: a note, or a deny labeled with a fact. It reads the call the harness hands it, runs the same
// `checkCall` replay runs, and appends one row per crossing to `crossings.jsonl`; it never allows a call and never changes its input, so the call
// runs as asked whatever happens here. Every failure is swallowed: malformed input, a missing store, a full disk, a throw. It imports only what it needs, because the
// harness waits on it before every matching tool call, and it ends before `deadlineMs` however slow the registry is.
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRedactor } from '../sessions/redact.js';
import { checkCall, type Crossing } from './checks.js';
import { withLocalBin, type LocalBinMemo } from './local-bin.js';
import type { FillAsk } from './hook-fill.js';
import { decide, type Decision } from './notes.js';
import { loadPolicy, type PolicySource } from './policy.js';
import { loadIndex, keepIndex, noveltyOf, scopesOf } from './novelty.js';
import { GATE_VERSION, folderKey, parseRows, permissionOf, type CrossingRecord, type RegistryRow } from './record.js';
import { askable, type RegistryAnswer, type RegistryReader } from './registry.js';
import { ageOf, againstLatestOf, askedOf, DAY_MS } from './registry-state.js';
import { repositoryOfCwd } from './scope.js';

/** Where the crossings go. Named here, not imported from `replay.ts`, which reads transcripts and would be loaded for nothing. */
export const crossingsPath = (storeDir: string): string => join(storeDir, 'crossings.jsonl');
/** The hook's kept registry answers, small and its own: reading the record for them would scan it. */
export const registryCachePath = (storeDir: string): string => join(storeDir, 'gate-registry.jsonl');

/** The registry ask is cut at this many ms on the process clock, less a write reserve; `hook-main.ts` ends the process a short grace after it, so the whole call is under a second. */
export const DEADLINE_MS = 800;

/** A registry answer the hook kept is used for this many days. A `latest` is read "as of the crossing", so an older one is asked again. */
export const HOOK_REGISTRY_DAYS = 1;
/** A not-found answer is trusted this long: a name can be published any minute, and a block rests on the answer. */
export const NOT_FOUND_MS = 600_000;
/** The room a row's write is given after the registry ask has been cut off. */
const WRITE_RESERVE_MS = 150;
/** One call hands at most this many names to helpers; the rest wait for a later sight, so a call naming dozens cannot start dozens of processes. */
const MAX_HELPERS = 3;
/** An ask with less than this left is not started: it could not finish. */
const MIN_ASK_MS = 100;

export interface GateHookDeps {
  storeDir: string;
  now: () => number;
  /** The process clock: ms since the process started in the entry, so the deadline counts node's own start. */
  clock: () => number;
  /** The whole hook ends by this many ms on `clock`. */
  deadlineMs: number;
  /** The draw for the holdback, in [0, 1). Absent: `Math.random`. */
  random?: () => number;
  /** Asks the package manager. Absent: no question is ever asked. */
  registry?: RegistryReader;
  /** Appends text to a file. Replaceable so a full disk can be tried. */
  append?: (file: string, text: string) => Promise<void>;
  /** Called with the name whose ask was cut or had no time to start, so a helper can finish it and fill the cache for the next sight. Absent: nothing is finished. */
  fill?: (ask: FillAsk) => Promise<void>;
  /** Whether a helper already holds the name, which keeps the hook from asking the manager a second time. Absent: never locked. */
  locked?: (ask: FillAsk) => Promise<boolean>;
  /** Told what is about to be written (and `null` once it is), so a process that must stop at a hard deadline can write the record it has. */
  stage?: (pending: { file: string; text: string } | null) => void;
}

interface Input {
  [key: string]: unknown;
}

const isInput = (value: unknown): value is Input => typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const parse = (stdin: string): Input => {
  try {
    const parsed: unknown = JSON.parse(stdin);
    return isInput(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const isFolder = (path: string): Promise<boolean> =>
  stat(path).then(
    (found) => found.isDirectory(),
    () => false,
  );

/** The organization domains a deposit saved to mask, read only when a call crossed something. */
const redactDomains = async (storeDir: string): Promise<string[]> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(storeDir, 'state.json'), 'utf8'));
    const domains: unknown = isInput(parsed) ? parsed.redactDomains : undefined;
    return Array.isArray(domains) ? domains.filter((domain): domain is string => typeof domain === 'string') : [];
  } catch {
    return [];
  }
};

const keyOf = (crossing: Pick<Crossing, 'class' | 'name'>): string => `${crossing.class}\0${crossing.name}`;

const keptAnswers = async (storeDir: string): Promise<Map<string, RegistryRow>> => {
  const body = await readFile(registryCachePath(storeDir), 'utf8').catch(() => '');
  const kept = new Map<string, RegistryRow>();
  for (const row of parseRows(body)) {
    if (row.kind === 'registry') kept.set(keyOf(row), row);
  }
  return kept;
};

/** A kept answer is dated by its UTC day, so "a day" is that day and the next: at most 48 hours old. Every kept answer is trusted only for the folder that asked, since its config can name another registry and a note says "the registry your package manager uses". A not-found answer is also cut short, since a name can be published any minute. */
const fresh = (row: RegistryRow, now: number, folder: string): boolean =>
  row.folder === folder && (row.state === 'not-found' ? row.ts !== undefined && now - Date.parse(row.ts) < NOT_FOUND_MS : now - Date.parse(row.day) < (HOOK_REGISTRY_DAYS + 1) * DAY_MS);

const within = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, Math.max(ms, 0));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });

const asAnswer = (row: RegistryRow): RegistryAnswer => ({ state: row.state, latest: row.latest, created: row.created });

/** The registry state at the moment: a kept answer first, else one bounded ask. `undefined` is "not read": not asked, not askable, or not answered in time. */
const registryAnswer = async (deps: GateHookDeps, crossing: Crossing, cwd: string | null, kept: ReadonlyMap<string, RegistryRow>, helpers: { started: number }): Promise<{ answer: RegistryAnswer; asked: boolean } | undefined> => {
  if (!askedOf(crossing) || crossing.versionForm === 'url' || !askable(crossing.class, crossing.name)) return undefined;
  const held = kept.get(keyOf(crossing));
  if (held !== undefined && cwd !== null && fresh(held, deps.now(), folderKey(cwd))) return { answer: asAnswer(held), asked: false };
  if (deps.registry === undefined || cwd === null || !(await isFolder(cwd))) return undefined;
  const ask: FillAsk = { class: crossing.class, name: crossing.name, cwd };
  // A helper already asks for this name (or failed within the last five minutes): one ask per name, so this sight reads nothing.
  if ((await deps.locked?.(ask).catch(() => false)) === true) return undefined;
  const left = deps.deadlineMs - WRITE_RESERVE_MS - deps.clock();
  const stop = new AbortController();
  const answer = left < MIN_ASK_MS ? undefined : await within(deps.registry({ ...ask, signal: stop.signal }), left);
  if (answer === undefined) {
    // Not answered in time: the row reads not-read, and a helper finishes the ask so the next sight reads it from the cache. This ask is stopped first, so the manager is never asked twice at once.
    stop.abort();
    if (helpers.started < MAX_HELPERS) {
      helpers.started += 1;
      await deps.fill?.(ask).catch(() => undefined);
    }
    return undefined;
  }
  return { answer, asked: true };
};

const recordOf = (
  input: { session: string; toolUseId: string | null; agent: string | null; permission: CrossingRecord['permission']; ts: string },
  crossing: Crossing,
  novelty: CrossingRecord['novelty'],
  read: { answer: RegistryAnswer } | undefined,
  policy: PolicySource,
  decision: Decision,
): CrossingRecord => ({
  kind: 'crossing',
  v: GATE_VERSION,
  via: 'hook',
  day: input.ts.slice(0, 10),
  class: crossing.class,
  form: crossing.form,
  program: crossing.program,
  versionForm: crossing.versionForm,
  statusReports: crossing.statusReports,
  // What a transcript gives is not read here and not guessed: replay fills these in.
  origin: 'not-read',
  novelty,
  decidedBy: 'not-read',
  permission: input.permission,
  status: 'not-read',
  next: 'not-read',
  removedLater: 'not-read',
  depth: input.agent === null ? 'main' : 'subagent',
  miss: 'not-read',
  againstLatest: read === undefined ? 'not-read' : againstLatestOf(crossing, read.answer),
  registryState: read?.answer.state ?? 'not-read',
  registryAge: read === undefined ? 'not-read' : ageOf(read.answer, input.ts),
  arm: decision.arm,
  lineShown: decision.arm === 'held' ? 'none' : decision.lineId,
  lineHeld: decision.arm === 'held' ? decision.lineId : 'none',
  policy,
  session: input.session,
  agent: input.agent,
  toolUseId: input.toolUseId,
  ts: input.ts,
  name: crossing.name,
  version: crossing.version,
});

const appendText = async (file: string, body: string): Promise<void> => {
  await mkdir(join(file, '..'), { recursive: true });
  await appendFile(file, body, { mode: 0o600 });
};

/** A row for a note that never reached the agent: no exposure, no arm. Used when a deny prints instead of the note. */
const withoutExposure = (row: CrossingRecord): CrossingRecord =>
  row.arm === 'none' ? row : { ...row, arm: 'none', lineShown: 'none', lineHeld: 'none' };

/** A block is a deny whose reason is the label; else the notes are context for the agent. Never an allow, an ask, or a changed input: with neither, nothing is printed. */
const outputOf = (blocks: readonly string[], notes: readonly string[]): string => {
  if (blocks.length > 0) return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: blocks.join('\n') } });
  return notes.length > 0 ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notes.join('\n') } }) : '';
};

/**
 * Records the crossings of one tool call. Resolves with the JSON to print: a note as context, or a deny labeled with the fact; never an allow or a changed call.
 * Nothing is written, and no network is touched, for a call that crosses nothing.
 */
export const runGateHook = async (stdin: string, deps: GateHookDeps): Promise<string> => {
  const input = parse(stdin);
  const tool = text(input.tool_name);
  const session = text(input.session_id);
  if (tool === null || session === null) return '';
  const call = { tool, input: input.tool_input };
  let check = checkCall(call, makeRedactor());
  if (check.crossings.length === 0) return '';
  const domains = await redactDomains(deps.storeDir);
  if (domains.length > 0) check = checkCall(call, makeRedactor(domains));
  const append = deps.append ?? appendText;
  const cwd = text(input.cwd);
  const ts = new Date(deps.now()).toISOString();
  const common = { session, toolUseId: text(input.tool_use_id), agent: text(input.agent_id), permission: permissionOf(text(input.permission_mode) ?? 'unknown'), ts };
  const index = await loadIndex(deps.storeDir, crossingsPath(deps.storeDir));
  const repository = cwd === null ? '' : await repositoryOfCwd(cwd);
  const kept = await keptAnswers(deps.storeDir);
  const { policy, source } = await loadPolicy(deps.storeDir);
  const random = deps.random ?? Math.random;
  const blocks: string[] = [];
  const notes: string[] = [];
  const rows: CrossingRecord[] = [];
  const lines = new Set<string>();
  const answered: RegistryRow[] = [];
  const binMemo: LocalBinMemo = new Map();
  const inCall = new Set<string>();
  const helpers = { started: 0 };
  for (const seen of check.crossings) {
    // A project's own bin is a stat walk, local and fast; it runs before the registry ask so a bin that is there is never asked about.
    const crossing = await withLocalBin(seen, cwd, binMemo);
    const scopes = scopesOf(keyOf(crossing), repository, session);
    const { novelty, add, noted: indexed } = noveltyOf(index, scopes);
    // One name twice in a call is one sight: the repeat reads as noted, so its note does not print again and its row is not a second draw.
    const key = keyOf(crossing);
    const noted = indexed || inCall.has(key);
    inCall.add(key);
    for (const line of add) lines.add(line);
    const read = await registryAnswer(deps, crossing, cwd, kept, helpers);
    const state = read?.answer.state;
    const answeredState = state === 'found' || state === 'not-found' ? state : undefined;
    // A sight with no answer (a cut ask, no time, a name not asked, an unreachable registry) spends nothing: the session's note waits for the first sight that has one.
    if (answeredState !== undefined && !noted) lines.add(scopes.read);
    if (read?.asked === true && read.answer.state !== 'unreachable') {
      answered.push({ kind: 'registry', v: GATE_VERSION, day: ts.slice(0, 10), ts, folder: folderKey(cwd ?? ''), class: crossing.class, state: read.answer.state, created: read.answer.created, name: crossing.name, latest: read.answer.latest });
    }
    const decision = decide(policy, answeredState === undefined ? undefined : { state: answeredState, created: read?.answer.created ?? null, noted }, deps.now(), random, crossing.name);
    if (decision.kind === 'block' && decision.text !== null && !blocks.includes(decision.text)) blocks.push(decision.text);
    if (decision.kind === 'note' && decision.text !== null) notes.push(decision.text);
    rows.push(recordOf(common, crossing, novelty, read, source, decision));
  }
  // A call that holds a block prints only the deny, so a note row (shown or held) was never in front of the agent: it reads as no exposure, since a row cannot be backfilled.
  const written = blocks.length > 0 ? rows.map(withoutExposure) : rows;
  // The record first: an index line for a row that was never written would call the next crossing of the name old.
  const record = { file: crossingsPath(deps.storeDir), text: written.map((row) => `${JSON.stringify(row)}\n`).join('') };
  deps.stage?.(record);
  try {
    await append(record.file, record.text);
  } finally {
    deps.stage?.(null);
  }
  await keepIndex(deps.storeDir, index, [...lines]).catch(() => undefined);
  if (answered.length > 0) await append(registryCachePath(deps.storeDir), answered.map((row) => `${JSON.stringify(row)}\n`).join('')).catch(() => undefined);
  return outputOf(blocks, notes);
};

/** What the hook writes to stdout: the JSON of a note or a deny, or '' when silent and on any failure, so the call runs as asked. */
export const gateHook = async (stdin: string, deps: GateHookDeps): Promise<string> => {
  try {
    return await runGateHook(stdin, deps);
  } catch {
    // Fail-open: a recorder that cannot record must not cost a session its tool call.
  }
  return '';
};
