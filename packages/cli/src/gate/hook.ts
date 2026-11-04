// `oars gate hook`: the PreToolUse hook that records a crossing as it happens. It only records. It reads the call the harness hands it, runs the same
// `checkCall` replay runs, and appends one row per crossing to `crossings.jsonl`; it never answers the harness (no permission decision, no changed input), so the call
// runs as asked whatever happens here. Every failure is swallowed: malformed input, a missing store, a full disk, a throw. It imports only what it needs, because the
// harness waits on it before every matching tool call, and it ends before `deadlineMs` however slow the registry is.
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRedactor } from '../sessions/redact.js';
import { checkCall, type Crossing } from './checks.js';
import { loadIndex, keepIndex, noveltyOf, scopesOf } from './novelty.js';
import { GATE_VERSION, parseRows, permissionOf, type CrossingRecord, type RegistryRow } from './record.js';
import { askable, type RegistryAnswer, type RegistryReader } from './registry.js';
import { ageOf, againstLatestOf, askedOf, DAY_MS } from './registry-state.js';
import { repositoryOfCwd } from './scope.js';

/** Where the crossings go. Named here, not imported from `replay.ts`, which reads transcripts and would be loaded for nothing. */
export const crossingsPath = (storeDir: string): string => join(storeDir, 'crossings.jsonl');
/** The hook's kept registry answers, small and its own: reading the record for them would scan it. */
export const registryCachePath = (storeDir: string): string => join(storeDir, 'gate-registry.jsonl');

/** A registry answer the hook kept is used for this many days. A `latest` is read "as of the crossing", so an older one is asked again. */
export const HOOK_REGISTRY_DAYS = 1;
/** The room a row's write is given after the registry ask has been cut off. */
const WRITE_RESERVE_MS = 150;
/** An ask with less than this left is not started: it could not finish. */
const MIN_ASK_MS = 100;

export interface GateHookDeps {
  storeDir: string;
  now: () => number;
  /** The process clock: ms since the process started in the entry, so the deadline counts node's own start. */
  clock: () => number;
  /** The whole hook ends by this many ms on `clock`. */
  deadlineMs: number;
  /** Asks the package manager. Absent: no question is ever asked. */
  registry?: RegistryReader;
  /** Appends text to a file. Replaceable so a full disk can be tried. */
  append?: (file: string, text: string) => Promise<void>;
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

/** A kept answer is dated by its UTC day, so "a day" is that day and the next: at most 48 hours old. */
const fresh = (row: RegistryRow, now: number): boolean => now - Date.parse(row.day) < (HOOK_REGISTRY_DAYS + 1) * DAY_MS;

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
const registryAnswer = async (deps: GateHookDeps, crossing: Crossing, cwd: string | null, kept: ReadonlyMap<string, RegistryRow>): Promise<{ answer: RegistryAnswer; asked: boolean } | undefined> => {
  if (!askedOf(crossing) || crossing.versionForm === 'url' || !askable(crossing.class, crossing.name)) return undefined;
  const held = kept.get(keyOf(crossing));
  if (held !== undefined && fresh(held, deps.now())) return { answer: asAnswer(held), asked: false };
  if (deps.registry === undefined || cwd === null || !(await isFolder(cwd))) return undefined;
  const left = deps.deadlineMs - WRITE_RESERVE_MS - deps.clock();
  if (left < MIN_ASK_MS) return undefined;
  const answer = await within(deps.registry({ class: crossing.class, name: crossing.name, cwd }), left);
  return answer === undefined ? undefined : { answer, asked: true };
};

const recordOf = (
  input: { session: string; toolUseId: string | null; agent: string | null; permission: CrossingRecord['permission']; ts: string },
  crossing: Crossing,
  novelty: CrossingRecord['novelty'],
  read: { answer: RegistryAnswer } | undefined,
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
  arm: 'none',
  lineShown: 'none',
  session: input.session,
  agent: input.agent,
  toolUseId: input.toolUseId,
  ts: input.ts,
  name: crossing.name,
  version: crossing.version,
});

const appendText = async (file: string, body: string): Promise<void> => {
  await mkdir(join(file, '..'), { recursive: true });
  await appendFile(file, body);
};

/**
 * Records the crossings of one tool call. Resolves with nothing in every case: the caller writes no output, so the harness never reads a decision from this hook.
 * Nothing is written, and no network is touched, for a call that crosses nothing.
 */
export const runGateHook = async (stdin: string, deps: GateHookDeps): Promise<void> => {
  const input = parse(stdin);
  const tool = text(input.tool_name);
  const session = text(input.session_id);
  if (tool === null || session === null) return;
  const call = { tool, input: input.tool_input };
  let check = checkCall(call, makeRedactor());
  if (check.crossings.length === 0) return;
  const domains = await redactDomains(deps.storeDir);
  if (domains.length > 0) check = checkCall(call, makeRedactor(domains));
  const append = deps.append ?? appendText;
  const cwd = text(input.cwd);
  const ts = new Date(deps.now()).toISOString();
  const common = { session, toolUseId: text(input.tool_use_id), agent: text(input.agent_id), permission: permissionOf(text(input.permission_mode) ?? 'unknown'), ts };
  const index = await loadIndex(deps.storeDir, crossingsPath(deps.storeDir));
  const repository = cwd === null ? '' : await repositoryOfCwd(cwd);
  const kept = await keptAnswers(deps.storeDir);
  const rows: CrossingRecord[] = [];
  const lines = new Set<string>();
  const answered: RegistryRow[] = [];
  for (const crossing of check.crossings) {
    const { novelty, add } = noveltyOf(index, scopesOf(keyOf(crossing), repository, session));
    for (const line of add) lines.add(line);
    const read = await registryAnswer(deps, crossing, cwd, kept);
    if (read?.asked === true && read.answer.state !== 'unreachable') {
      answered.push({ kind: 'registry', v: GATE_VERSION, day: ts.slice(0, 10), class: crossing.class, state: read.answer.state, created: read.answer.created, name: crossing.name, latest: read.answer.latest });
    }
    rows.push(recordOf(common, crossing, novelty, read));
  }
  // The record first: an index line for a row that was never written would call the next crossing of the name old.
  await append(crossingsPath(deps.storeDir), rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  await keepIndex(deps.storeDir, index, [...lines]).catch(() => undefined);
  if (answered.length > 0) await append(registryCachePath(deps.storeDir), answered.map((row) => `${JSON.stringify(row)}\n`).join('')).catch(() => undefined);
};

/** What the hook writes to stdout: nothing, whatever happened. The harness reads no decision and no changed input from it, so the call runs as asked. */
export const gateHook = async (stdin: string, deps: GateHookDeps): Promise<string> => {
  try {
    await runGateHook(stdin, deps);
  } catch {
    // Fail-open: a recorder that cannot record must not cost a session its tool call.
  }
  return '';
};
