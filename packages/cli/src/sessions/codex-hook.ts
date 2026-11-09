// The Codex recording hook: when the operator installs it (`oars sessions hook install --harness codex`), Codex runs it after each tool call and
// each model request, and it appends one closed-vocabulary row to `hook-rows.jsonl`. A row is a separately marked observation (`source: 'hook'`):
// it is never merged into a record the store reader (`codex.ts`) made from the rollout, so a Codex release that changes the rollout format
// degrades this record instead of stopping it. No prompt, command, output, or path enters a row; the payload's text is read here and goes no further.
// Fail-open: the hook prints nothing, takes no lock, and exits 0 on every error, leaving a note in `hook-calls.jsonl`.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { ACTION_TABLES, actionOf, type CanonicalAction } from './actions.js';
import { compileAllow, isDenial, slugOf } from './allow.js';
import { argClassOf, type ArgClass } from './call-shape.js';
import { appendHookCall } from './hook-calls.js';
import { mkdirOwnerOnly } from './owner-only.js';
import { makeRepoRoot } from './repo-root.js';
import { errorLine, tryLog } from './steps.js';
import { paths } from './store.js';

// The names the hook payload gives a tool that the rollout's table (`ACTION_TABLES.codex`) does not list: the hook contract says `Bash` and `apply_patch` carry `tool_input.command`.
const HOOK_TOOLS = new Map<string, CanonicalAction>([['Bash', 'shell.exec']]);

/** The events the installed entry registers, as Codex names them. */
export const CODEX_HOOK_EVENTS = ['SessionStart', 'PostToolUse', 'PostModelRequest'] as const;

export const ERROR_FLAGS = ['yes', 'no', 'unknown'] as const;
export type ErrorFlag = (typeof ERROR_FLAGS)[number];

export const CWD_CLASSES = ['repo', 'home', 'other', 'none'] as const;
export type CwdClass = (typeof CWD_CLASSES)[number];

export const RESULT_KINDS = ['string', 'object', 'array', 'null', 'absent'] as const;
export type ResultKind = (typeof RESULT_KINDS)[number];

/** The counters of one model request: a number the payload gave, else null. */
export interface HookUsage {
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  thinking: number | null;
  total: number | null;
}

/** One line of `hook-rows.jsonl`. Which fields are set depends on `kind`; `degraded` is true when the payload lacked a field the kind needs, and `missing` names those fields. */
export interface HookRow {
  v: 1;
  source: 'hook';
  harness: 'codex';
  kind: 'session' | 'tool' | 'model';
  at: string;
  session: string | null;
  turn: string | null;
  toolUseId: string | null;
  /** Set only when the payload names a subagent: such a row carries the parent's session id and is never keyed to the parent thread's rollout. */
  agentId: string | null;
  action: CanonicalAction | null;
  tool: string | null;
  argClass: ArgClass[] | null;
  resultKind: ResultKind | null;
  error: ErrorFlag | null;
  usage: HookUsage | null;
  model: string | null;
  cwdClass: CwdClass | null;
  degraded: boolean;
  missing: string[];
}

type Obj = { [key: string]: unknown };
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

const MODEL_NAME = /^[A-Za-z0-9._:/-]{1,64}$/;
// A model configured by path (`/models/x.gguf`, `./x`, `~/x`, `C:/x`, `a/b/c`) names a place on the machine, which no row may hold.
const PATH_SHAPED = /^(?:[/.~]|[A-Za-z]:)|\/.*\//;

/** A model name as a closed shape: the name when it is plain, else `other`. An `org/model` name is plain; a path is not. */
const modelOf = (value: unknown): string | null => {
  const name = str(value);
  return name === null ? null : MODEL_NAME.test(name) && !PATH_SHAPED.test(name) ? name : 'other';
};

// The three spellings Codex gives a finished command's outcome (`Exit code: N`, `Process exited with code N`, `exit code N`), at the start of a line.
const EXIT_LINE = /^[ \t]*(?:exit code:?[ \t]*|process exited with code[ \t]+)(-?\d+)[ \t]*$/im;

// The line a command's output begins after: the header above it is Codex's, the text below is whatever the command printed.
const OUTPUT_MARK = /(?:^|\n)Output:\n?/;

/** `unknown` unless the header Codex writes before the `Output:` line carries an exit line: the command's own text decides nothing, and a response with no such header says nothing. */
export const errorFlagOf = (response: unknown): ErrorFlag => {
  if (typeof response !== 'string') return 'unknown';
  const mark = OUTPUT_MARK.exec(response);
  if (mark === null) return 'unknown';
  const code = EXIT_LINE.exec(response.slice(0, mark.index))?.[1];
  return code === undefined ? 'unknown' : Number(code) === 0 ? 'no' : 'yes';
};

const resultKindOf = (response: unknown): ResultKind => {
  if (response === undefined) return 'absent';
  if (response === null) return 'null';
  if (Array.isArray(response)) return 'array';
  return typeof response === 'string' ? 'string' : 'object';
};

const USAGE_KEYS: readonly (readonly [keyof HookUsage, string])[] = [
  ['input', 'input_tokens'],
  ['cacheRead', 'cached_input_tokens'],
  ['cacheWrite', 'cache_write_input_tokens'],
  ['output', 'output_tokens'],
  ['thinking', 'reasoning_output_tokens'],
  ['total', 'total_tokens'],
];

const blank = (kind: HookRow['kind'], at: string, payload: Obj): HookRow => ({
  v: 1,
  source: 'hook',
  harness: 'codex',
  kind,
  at,
  session: str(payload.session_id),
  turn: str(payload.turn_id),
  toolUseId: null,
  agentId: str(payload.agent_id),
  action: null,
  tool: null,
  argClass: null,
  resultKind: null,
  error: null,
  usage: null,
  model: null,
  cwdClass: null,
  degraded: false,
  missing: [],
});

/** What one PostToolUse payload becomes. A field the payload lacks is named in `missing`; one it adds is ignored. */
const toolRow = (at: string, payload: Obj): HookRow => {
  const row = blank('tool', at, payload);
  const name = str(payload.tool_name);
  const aliased = name === null ? undefined : HOOK_TOOLS.get(name);
  const found = name === null ? undefined : aliased === undefined ? actionOf(ACTION_TABLES.codex, name) : { action: aliased, native: name };
  row.toolUseId = str(payload.tool_use_id);
  row.action = found?.action ?? null;
  row.tool = found?.native ?? null;
  row.argClass = isObj(payload.tool_input) ? argClassOf(payload.tool_input) : null;
  row.resultKind = resultKindOf(payload.tool_response);
  row.error = errorFlagOf(payload.tool_response);
  row.missing = [
    ...(row.session === null ? ['session_id'] : []),
    ...(row.turn === null ? ['turn_id'] : []),
    ...(row.toolUseId === null ? ['tool_use_id'] : []),
    ...(name === null ? ['tool_name'] : []),
    ...(row.argClass === null ? ['tool_input'] : []),
    ...(payload.tool_response === undefined ? ['tool_response'] : []),
  ];
  return row;
};

/** What one PostModelRequest payload becomes. `token_usage` is null on a failed or cancelled attempt: the row is then degraded, and carries no counts. */
const modelRow = (at: string, payload: Obj): HookRow => {
  const row = blank('model', at, payload);
  row.model = modelOf(payload.model);
  const usage = payload.token_usage;
  const missing = [...(row.session === null ? ['session_id'] : []), ...(row.turn === null ? ['turn_id'] : [])];
  if (isObj(usage)) {
    const counters: HookUsage = { input: null, cacheRead: null, cacheWrite: null, output: null, thinking: null, total: null };
    row.usage = counters;
    for (const [field, key] of USAGE_KEYS) {
      counters[field] = count(usage[key]);
      if (counters[field] === null) missing.push(`token_usage.${key}`);
    }
  } else missing.push('token_usage');
  row.missing = missing;
  return row;
};

/** What the working folder is, as a class and never a path: inside a repository, the home folder itself, anywhere else, or not given. */
const cwdClassOf = (cwd: string | null, home: string, repoRoot: (cwd: string) => string | null): CwdClass => {
  if (cwd === null) return 'none';
  if (slugOf(cwd) === slugOf(home)) return 'home';
  return repoRoot(cwd) === null ? 'other' : 'repo';
};

const sessionRow = (at: string, payload: Obj, home: string, repoRoot: (cwd: string) => string | null): HookRow => {
  const row = blank('session', at, payload);
  row.model = modelOf(payload.model);
  row.cwdClass = cwdClassOf(str(payload.cwd), home, repoRoot);
  row.missing = [...(row.session === null ? ['session_id'] : []), ...(row.model === null ? ['model'] : []), ...(row.cwdClass === 'none' ? ['cwd'] : [])];
  return row;
};

/** The row for one hook payload, or undefined for an event this hook does not record. */
export const hookRowOf = (payload: Obj, at: string, home: string = homedir(), repoRoot: (cwd: string) => string | null = makeRepoRoot()): HookRow | undefined => {
  const event = payload.hook_event_name;
  const row = event === 'PostToolUse' ? toolRow(at, payload) : event === 'PostModelRequest' ? modelRow(at, payload) : event === 'SessionStart' ? sessionRow(at, payload, home, repoRoot) : undefined;
  if (row !== undefined) row.degraded = row.missing.length > 0;
  return row;
};

/**
 * The saved `--allow` and `--deny` list, read strictly: undefined when `state.json` exists and cannot be read as a list of strings. Deposit
 * treats such a file as an empty list, which allows every source; a hook that did the same would record under a `--deny codex` it lost.
 */
export const savedList = async (storeDir: string): Promise<string[] | undefined> => {
  let text: string;
  try {
    text = await readFile(paths(storeDir).state, 'utf8');
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? [] : undefined;
  }
  try {
    const state: unknown = JSON.parse(text);
    if (!isObj(state)) return undefined;
    const list = state.allow;
    if (list === undefined) return [];
    return Array.isArray(list) && list.every((entry): entry is string => typeof entry === 'string') ? list : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether a row may be written: the saved list allows the `codex` source (the gate deposit applies), and the payload's folder is not one a
 * saved `--deny` names. The folder test uses the denials alone, because an `--allow codex` entry names no folder and would match none.
 * A payload with no folder cannot be tested, so it records only when the list holds no denial.
 */
export const mayRecord = (saved: readonly string[] | undefined, cwd: string | null): boolean => {
  if (saved === undefined || !compileAllow(saved).allows('codex')) return false;
  const denials = saved.filter(isDenial);
  if (denials.length === 0) return true;
  return cwd !== null && compileAllow(denials).allows(slugOf(cwd));
};

/** What the hook needs from the machine, so a test can stand in for each. */
export interface CodexHookRuntime {
  storeDir: string;
  home: string;
  now: () => number;
  /** The lockless append; a failure reaches the note in `hook-calls.jsonl` and no partial row is left. */
  append: (file: string, text: string) => Promise<void>;
  /** The repo-root lookup for the folder class; a test stands in for it. */
  repoRoot?: (cwd: string) => string | null;
}

/**
 * Reduces every absolute path in a note to `<path>`: a POSIX path, a drive path, or a UNC path, whether or not it sits under the home
 * folder (a failure's message can name any folder, and no path enters a row or a note). Three passes, widest first: a quoted run that starts
 * with a path is masked whole, to the last matching quote on the line and with the quotes kept, so a space or an apostrophe in it leaves no
 * tail; the hook's own home, matched in either separator and any case like the store's home scrub, goes with the rest of its token; then
 * any bare path token.
 */
const TOKEN_TAIL = /[^\s'"`,;)]*/.source;
const maskPaths = (text: string, home: string): string => {
  const quoted = text.replace(/(['"`])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\n]*\1/g, '$1<path>$1');
  const pattern = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/(?:\\\\|\/)/g, '[\\\\/]');
  const own = home === '' ? quoted : quoted.replace(new RegExp(pattern + TOKEN_TAIL, 'gi'), '<path>');
  return own.replace(/(?:[A-Za-z]:[\\/]|\\\\|(?<![\w.~<>-])\/)[^\s'"`,;)]*/g, '<path>');
};

// JSON.parse's message quotes the input, and the note must hold none of it, so the failure is a fixed line.
const parse = (text: string): Obj => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The hook input is not JSON.');
  }
  if (!isObj(parsed)) throw new Error('The hook input is not an object.');
  return parsed;
};

/**
 * Runs one hook call. It resolves whatever happens, prints nothing, and takes no lock. The row is built whole and written with one append, so a
 * failure before or during the write leaves no partial row. A call the consent gate refuses leaves no trace at all; one that wrote a row, or
 * failed, leaves a note in `hook-calls.jsonl` (the failure's first line, masked).
 */
export const runCodexHook = async (stdin: string, runtime: CodexHookRuntime): Promise<void> => {
  const started = performance.now();
  let session: string | null = null;
  let wrote = false;
  let failure: unknown;
  let failed = false;
  try {
    const payload = parse(stdin);
    session = str(payload.session_id);
    // The gate comes first, so a denied folder is never walked for its repo root.
    if (mayRecord(await savedList(runtime.storeDir), str(payload.cwd))) {
      const row = hookRowOf(payload, new Date(runtime.now()).toISOString(), runtime.home, runtime.repoRoot);
      if (row !== undefined) {
        const line = `${JSON.stringify(row)}\n`;
        await mkdirOwnerOnly(runtime.storeDir);
        await runtime.append(paths(runtime.storeDir).hookRows, line);
        wrote = true;
      }
    }
  } catch (thrown) {
    failed = true;
    failure = thrown;
  }
  if (!wrote && !failed) return;
  const ms = Math.round(performance.now() - started);
  // Built only for a failure, and inside the guard, so a message that is not a string cannot throw past the note.
  const error = failed
    ? await Promise.resolve()
        .then(() => errorLine(runtime.storeDir, new Error(maskPaths(failure instanceof Error ? failure.message : String(failure), runtime.home))))
        .catch(() => 'unknown error')
    : null;
  await tryLog(() => appendHookCall(runtime.storeDir, { at: new Date(runtime.now()).toISOString(), event: 'codex-record', session, hit: wrote, ms, error }));
};
