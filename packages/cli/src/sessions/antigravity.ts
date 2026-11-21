// The Google Antigravity source: an Antigravity conversation's transcript becomes the same capture records a Claude Code transcript does.
//
// OBSERVATION-DERIVED: Antigravity is closed source and publishes no format, so this reader follows the SHAPE of the files it writes (keys and types read from a
// local store; no value is copied into the repo, a test, or a doc), and every fixture in `antigravity.test.ts` is synthetic. `docs/sessions-store.md` says what is
// still unproven. Nothing is promised by the vendor, so a key that moves makes a file read as nothing, and `sessions verify` counts it as `shapeMoved`.
//
// Where it reads from (`antigravityRoot`): `$ANTIGRAVITY_HOME` (an oars-only override, mostly for tests), else the home, then `.gemini/antigravity`
// (`%USERPROFILE%\.gemini\antigravity` on Windows, beside Gemini CLI's own `.gemini`). Inside it,
// `brain/<conversationId>/.system_generated/logs/transcript_full.jsonl` is one session. `transcript.jsonl` beside it holds the same records with stringified
// arguments and is not read, and `conversations/<conversationId>.db` (SQLite, protobuf step payloads, where the model and token usage are likely kept) is not
// read either: the JSONL has no model and no usage, so a session here has neither (both stay null), and no working directory, so its folder is null.
// A line is
//   {step_index, type, source, status, created_at, content?, thinking?, error?, error_code?, tool_calls?[{name, args}]}
// `source` is `USER_EXPLICIT`, `MODEL`, or `SYSTEM`; `status` is `DONE` or `RUNNING`. A step's `step_index` can skip numbers (the file leaves some steps out), so the
// order of the lines is the order of the conversation. The step types:
//   USER_INPUT         the operator's prompt (`content`)
//   PLANNER_RESPONSE   the model's turn: `content` is its text, `thinking` is its reasoning (not read), and `tool_calls` are the calls it makes, with no id. Each call's
//                      result is the step that follows, so a call gets a made-up id and is matched to the next step of the type its tool writes
//   VIEW_FILE, LIST_DIRECTORY, GREP_SEARCH, SEARCH_WEB, READ_URL_CONTENT, RUN_COMMAND, CODE_ACTION, INVOKE_SUBAGENT, GENERIC
//                      a tool's result (`content`). A RUNNING step has no result yet, so its call stays unsettled; an `ERROR_MESSAGE` (`error`, `error_code`) that
//                      comes while a call is waiting is that call's failure, and with none waiting it is the harness's own notice and carries no turn
//   CHECKPOINT, CONVERSATION_HISTORY, EPHEMERAL_MESSAGE, SYSTEM_MESSAGE
//                      what the harness writes to itself (summaries and injected context): no turn, not read
// A step type the reader does not know is never dropped: it becomes one generic call named for the type (lower case) with its content as the result, which the action
// table files as `other`. An unknown tool is kept the same way under its own name. A tool step that no waiting call matches (the file left its call out) is a generic call too.

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** The Antigravity folder for an environment; a test passes its own so it never reads the real one. */
export const antigravityRoot = (env: { [name: string]: string | undefined }, home: string = homedir()): string => {
  const set = env.ANTIGRAVITY_HOME;
  return set === undefined || set === '' ? join(home, '.gemini', 'antigravity') : set;
};

type Obj = { [key: string]: unknown };
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A conversation found in the store, before its records are read. */
export interface AntigravitySession {
  /** The conversation's folder name; it names the skeleton. */
  id: string;
  file: string;
  size: number;
  mtimeMs: number;
}

export interface AntigravityStore {
  sessions: AntigravitySession[];
  /** The session as transcript text for `captureSession`; throws when the file cannot be read. */
  transcript: (session: AntigravitySession) => Promise<string>;
  /** Conversations skipped because their id is not a safe file name (it names a skeleton), counted so the skip is never silent. */
  rejected: number;
  /** Files dropped as holding nothing that held a record of a shape the reader does not know (a renamed `type` key). Read only by `sessions verify`; selection is unchanged. */
  shapeMoved: number;
  /** Items that could not be inspected, reported once each and never fatal; the reason names no path. */
  unreadable: { file: string; reason: string }[];
}

const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;

const reasonOf = (error: unknown, file: string): string => (error instanceof Error ? error.message : String(error)).split(file).join(basename(file));
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const iso = (value: unknown): string | undefined => {
  const text = str(value);
  // An absolute time only: a missing or relative one (not a date after 2000) says nothing about when.
  return text !== undefined && Date.parse(text) >= Date.parse('2000-01-01T00:00:00Z') ? text : undefined;
};

const lineTexts = (text: string): string[] => text.split('\n').filter((raw) => raw.trim() !== '');

/** The non-blank lines that are not JSON (a torn write), kept so `captureSession` counts them and the deposit line reports them. */
export const transcriptBadLines = (text: string): string[] => lineTexts(text).filter((raw) => parse(raw) === undefined);

/** The tools the reader names in the Claude Code vocabulary, so the extractor classifies them; the Antigravity name stays in `native` for the action table. */
const RENAMED: ReadonlyMap<string, string> = new Map([
  ['view_file', 'Read'],
  ['write_to_file', 'Write'],
  ['replace_file_content', 'Edit'],
  ['multi_replace_file_content', 'Edit'],
  ['grep_search', 'Grep'],
  ['search_web', 'WebSearch'],
  ['read_url_content', 'WebFetch'],
]);
/** The key that holds the path a file tool works on. */
const PATH_KEY: ReadonlyMap<string, string> = new Map([
  ['Read', 'AbsolutePath'],
  ['Write', 'TargetFile'],
  ['Edit', 'TargetFile'],
]);

/** The step type that carries each tool's result; a tool not listed (an unknown one) is matched to a `GENERIC` step. */
const RESULT_STEP: ReadonlyMap<string, string> = new Map([
  ['view_file', 'VIEW_FILE'],
  ['list_dir', 'LIST_DIRECTORY'],
  ['grep_search', 'GREP_SEARCH'],
  ['search_web', 'SEARCH_WEB'],
  ['read_url_content', 'READ_URL_CONTENT'],
  ['run_command', 'RUN_COMMAND'],
  ['write_to_file', 'CODE_ACTION'],
  ['replace_file_content', 'CODE_ACTION'],
  ['multi_replace_file_content', 'CODE_ACTION'],
  ['invoke_subagent', 'INVOKE_SUBAGENT'],
]);
const GENERIC = 'GENERIC';

/** Steps that carry no turn: the harness writing to itself. */
const HARNESS_STEPS: ReadonlySet<string> = new Set(['CHECKPOINT', 'CONVERSATION_HISTORY', 'EPHEMERAL_MESSAGE', 'SYSTEM_MESSAGE']);
/** The result step types the reader knows; each is the result of the tool that `RESULT_STEP` names it for. */
const RESULT_STEPS: ReadonlySet<string> = new Set([...RESULT_STEP.values(), GENERIC]);

/** A path written the Windows way: a drive letter or a UNC share. */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const PATH_ARGS = ['AbsolutePath', 'TargetFile', 'Cwd', 'DirectoryPath', 'SearchPath'];

/** True when a call's arguments name a path written the Windows way; the command tool runs PowerShell there and a POSIX shell elsewhere. */
const windowsCall = (calls: readonly Obj[]): boolean =>
  calls.some((call) => {
    const args = isObj(call.args) ? call.args : {};
    return PATH_ARGS.some((key) => WINDOWS_PATH.test(str(args[key]) ?? ''));
  });

/** The tool name the extractor reads for a native one, and the input it keeps: a path for a file tool, the command for a shell call, else the arguments. */
const callOf = (native: string, args: Obj, shell: string): { name: string; input: Obj } => {
  if (native === 'run_command') return { name: shell, input: str(args.CommandLine) === undefined ? {} : { command: args.CommandLine } };
  const name = RENAMED.get(native) ?? native;
  const key = PATH_KEY.get(name);
  if (key === undefined) return { name, input: args };
  const path = str(args[key]);
  return { name, input: path === undefined ? {} : { file_path: path } };
};

interface Waiting {
  id: string;
  native: string;
  step: string;
}

/** The session file as the lines `captureSession` reads. */
export const antigravityLines = (text: string, fallbackId: string): Obj[] => {
  const records = lineTexts(text)
    .map(parse)
    .filter((record): record is Obj => isObj(record) && typeof record.type === 'string');
  const lines: Obj[] = [];
  const base: Obj = { sessionId: fallbackId };
  // The command tool runs what the machine's shell is; the paths the conversation names say which machine it was.
  const shell = windowsCall(records.flatMap((record) => (Array.isArray(record.tool_calls) ? record.tool_calls.filter(isObj) : []))) ? 'PowerShell' : 'Bash';
  const waiting: Waiting[] = [];
  let at: string | undefined;
  let sequence = 0;
  const stamp = (value: unknown): string => {
    const candidate = iso(value);
    if (candidate !== undefined && (at === undefined || Date.parse(candidate) >= Date.parse(at))) at = candidate;
    return at ?? new Date(0).toISOString();
  };
  const assistant = (when: string, content: Obj[], step: number): void => {
    sequence += 1;
    lines.push({ ...base, type: 'assistant', uuid: `${fallbackId}-a${String(sequence)}`, requestId: `${fallbackId}-s${String(step)}`, timestamp: when, message: { role: 'assistant', content } });
  };
  const result = (id: string, failure: string | undefined, when: string, output: string): void => {
    sequence += 1;
    lines.push({
      ...base,
      type: 'user',
      uuid: `${fallbackId}-r${String(sequence)}`,
      timestamp: when,
      // A step has one time, not a start and an end, so no duration is claimed.
      noDuration: true,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: failure !== undefined, content: failure ?? output }] },
    });
  };

  records.forEach((record, position) => {
    const kind = String(record.type);
    const when = stamp(record.created_at);
    const body = typeof record.content === 'string' ? record.content : '';
    const step = typeof record.step_index === 'number' ? record.step_index : position;
    if (kind === 'USER_INPUT') {
      if (body.trim() === '') return;
      sequence += 1;
      lines.push({ ...base, type: 'user', uuid: `${fallbackId}-u${String(sequence)}`, timestamp: when, message: { role: 'user', content: [{ type: 'text', text: body }] } });
    } else if (kind === 'PLANNER_RESPONSE') {
      const content: Obj[] = body.trim() === '' ? [] : [{ type: 'text', text: body }];
      (Array.isArray(record.tool_calls) ? record.tool_calls.filter(isObj) : []).forEach((entry, index) => {
        const native = str(entry.name);
        if (native === undefined) return;
        const id = `${fallbackId}-s${String(step)}-c${String(index)}`;
        const { name, input } = callOf(native, isObj(entry.args) ? entry.args : {}, shell);
        content.push({ type: 'tool_use', id, name, ...(name === native || name === 'PowerShell' ? {} : { native }), input });
        waiting.push({ id, native, step: RESULT_STEP.get(native) ?? GENERIC });
      });
      if (content.length > 0) assistant(when, content, step);
    } else if (kind === 'ERROR_MESSAGE') {
      // The oldest waiting call is the one the error answers; with none waiting it is a notice about the model call and is not a turn.
      const failed = waiting.shift();
      if (failed !== undefined) result(failed.id, str(record.error) ?? (body.trim() === '' ? 'tool failed' : body), when, '');
    } else if (!HARNESS_STEPS.has(kind)) {
      const index = waiting.findIndex((call) => call.step === kind);
      const [match] = index === -1 ? [] : waiting.splice(index, 1);
      let id = match?.id;
      if (id === undefined) {
        // The file left this step's call out, or the type is one the reader does not know: a generic call, so the step is still counted.
        id = `${fallbackId}-s${String(step)}`;
        const name = kind.toLowerCase();
        assistant(when, [{ type: 'tool_use', id, name, input: {} }], step);
      }
      // A RUNNING step has no result yet: its call stays unsettled.
      if (record.status === 'DONE') result(id, undefined, when, body);
    }
  });
  return lines;
};

/** The conversation ids and counts a live run reports: how many records of each type, how many of a type the reader does not know, and the tools the calls name. */
export const antigravityCounts = (text: string): { steps: number; types: { [type: string]: number }; unknownTypes: number; tools: { [tool: string]: number } } => {
  const records = lineTexts(text)
    .map(parse)
    .filter(isObj);
  const types: { [type: string]: number } = {};
  const tools: { [tool: string]: number } = {};
  let unknownTypes = 0;
  for (const record of records) {
    const kind = str(record.type) ?? 'none';
    types[kind] = (types[kind] ?? 0) + 1;
    if (!['USER_INPUT', 'PLANNER_RESPONSE', 'ERROR_MESSAGE'].includes(kind) && !HARNESS_STEPS.has(kind) && !RESULT_STEPS.has(kind)) unknownTypes += 1;
    for (const call of Array.isArray(record.tool_calls) ? record.tool_calls.filter(isObj) : []) {
      const name = str(call.name) ?? 'none';
      tools[name] = (tools[name] ?? 0) + 1;
    }
  }
  return { steps: records.length, types, unknownTypes, tools };
};

const FILE = join('.system_generated', 'logs', 'transcript_full.jsonl');

export const openAntigravityStore = async (root: string): Promise<AntigravityStore | undefined> => {
  const base = join(root, 'brain');
  const unreadable: { file: string; reason: string }[] = [];
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return undefined;
    unreadable.push({ file: base, reason: reasonOf(error, base) });
    return { sessions: [], transcript: () => Promise.reject(new Error('no sessions')), rejected: 0, shapeMoved: 0, unreadable };
  }
  const sessions: AntigravitySession[] = [];
  let rejected = 0;
  let shapeMoved = 0;
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(base, entry.name, FILE);
    try {
      const info = await stat(file);
      const text = await readFile(file, 'utf8');
      if (!SAFE_ID.test(entry.name)) {
        rejected += 1;
        continue;
      }
      // A conversation that holds no prompt, response, or step is no session; one whose records carry no `type` is a shape the reader does not know.
      if (antigravityLines(text, entry.name).length === 0) {
        if (lineTexts(text).map(parse).some((record) => isObj(record) && typeof record.type !== 'string')) shapeMoved += 1;
        continue;
      }
      sessions.push({ id: entry.name, file, size: info.size, mtimeMs: Math.floor(info.mtimeMs) });
    } catch (error) {
      // A conversation folder with no transcript yet is no session; any other failure is reported.
      if (!missing(error)) unreadable.push({ file, reason: reasonOf(error, file) });
    }
  }
  return {
    sessions: sessions.sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id)),
    rejected,
    shapeMoved,
    unreadable,
    transcript: async (session) => {
      const raw = await readFile(session.file, 'utf8');
      const lines = [...antigravityLines(raw, session.id).map((line) => JSON.stringify(line)), ...transcriptBadLines(raw)];
      return lines.join('\n') + (lines.length === 0 ? '' : '\n');
    },
  };
};
