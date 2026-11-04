// The Gemini CLI source (t817): a Gemini CLI chat file becomes the same capture records a Claude Code transcript does.
//
// FIXTURE-DERIVED: written from the open-source Gemini CLI (github.com/google-gemini/gemini-cli, Apache-2.0, commit 89e9d25d, v0.67.0-nightly.20261020), not from
// a live store. Nothing was copied; the reader is original. Paths below are under `packages/core/src/`. `docs/sessions-store.md` says what a live run would still
// have to prove, and no vendor text promises the on-disk format (the code itself migrates `.json` to `.jsonl` and marks `$set.messages` deprecated).
//
// Where it reads from (`geminiRoot`): `$GEMINI_CLI_HOME`, else the home, then `.gemini` (`%USERPROFILE%\.gemini` on Windows; config/storage.ts, utils/paths.ts). Inside it,
// `tmp/<slug>/chats/session-<time>-<id8>.jsonl` is one session (services/chatRecordingService.ts:801-823), a subagent's is `chats/<parentSessionId>/<agentId>.jsonl`
// (:786-814), and a legacy `*.json` holds one pretty-printed object (:1647). `tmp/<slug>/.project_root` names the project folder (config/projectRegistry.ts); it is the
// only place a working directory exists, so a session's cwd is that folder and a directory change inside a session is not recorded. The prompt log `logs.json`, the
// `checkpoint-*.json` copies, and the opt-in telemetry file are not read: the first is a subset of the chat file and the others are copies or off by default.
// The file is the vendor's own journal, folded the way its loader does (services/chatRecordingService.ts:304-530): a line is
//   {sessionId, projectHash, ...}      the head metadata (may carry legacy `messages`)
//   {id, timestamp, type, content, displayContent?, toolCalls?, tokens?, model?}   a message; the same `id` appended again replaces the earlier record in its place
//   {$rewindTo: id}                    drop that message and every later one (an unknown id clears all)
//   {$patch: {id|updates, content?, toolCalls?[{id, result}], removeIds?, orderIds?}}
//   {$set: {...}}                      metadata; a deprecated `messages` replaces the history
// A `user` message is a prompt unless its parts are all `functionResponse` (a tool result, geminiChat.ts) or it starts with `/`, `?`, `<session_context>`, or
// `<hook_context>`, the vendor's own resume filter (utils/sessionUtils.ts:97). `displayContent` is what the operator typed. A `gemini` message is a response:
// its text (`thought` parts left out), its `toolCalls[{id, name, args, result, status, timestamp}]`, and `tokens{input, output, cached, thoughts, tool, total}`
// (chatRecordingTypes.ts), one per request, never cumulative. `tokens.input` is the prompt count, which includes the cache (telemetry/uiTelemetry.ts:317-320),
// and capture's fields are disjoint, so the cache is subtracted. A shell call's `status` is `success` for a nonzero exit; the exit code is a trailer line of its
// result text (tools/shell.ts:953-979, wrapped in `<untrusted_context>` by utils/textUtils.ts), and that line decides.

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';

/** The Gemini folder for an environment; a test passes its own so it never reads the real one. */
export const geminiRoot = (env: { [name: string]: string | undefined }, home: string = homedir()): string => {
  const set = env.GEMINI_CLI_HOME;
  return join(set === undefined || set === '' ? home : set, '.gemini');
};

type Obj = { [key: string]: unknown };
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A session found in the store, before its records are read. */
export interface GeminiSession {
  /** The head's `sessionId` (else the file's name); a subagent's is `<parent>-<file name>`. It names the skeleton. */
  id: string;
  /** What `.project_root` names; null when the project folder has none. */
  folder: string | null;
  file: string;
  size: number;
  mtimeMs: number;
  /** The parent session's id for a subagent's file; null for a main session. */
  parent: string | null;
}

export interface GeminiStore {
  sessions: GeminiSession[];
  /** The session as transcript text for `captureSession`; throws when the file cannot be read or holds no parseable line. */
  transcript: (session: GeminiSession) => Promise<string>;
  /** Sessions skipped because their id is not a safe file name (it names a skeleton), counted so the skip is never silent. */
  rejected: number;
  /** Items that could not be inspected, reported once each and never fatal; the reason names no path. */
  unreadable: { file: string; reason: string }[];
}

const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;

/** An error's message with `file` cut to its base name, so a reason that is logged names no folder. */
const reasonOf = (error: unknown, file: string): string => (error instanceof Error ? error.message : String(error)).split(file).join(basename(file));

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const iso = (value: unknown): string | undefined => {
  const text = str(value);
  // An absolute time only: a missing or relative one (not a date after 2000) says nothing about when.
  return text !== undefined && Date.parse(text) >= Date.parse('2000-01-01T00:00:00Z') ? text : undefined;
};

const lineTexts = (text: string): string[] => text.split('\n').filter((raw) => raw.trim() !== '');

/** A legacy `.json` file is one object that holds its own `sessionId`; its lines are not records. */
const wholeObject = (text: string): Obj | undefined => {
  const whole = parse(text);
  return isObj(whole) && str(whole.sessionId) !== undefined ? whole : undefined;
};

/** The non-blank lines that are not JSON (a torn write), kept so `captureSession` counts them and the deposit line reports them. */
export const chatBadLines = (text: string): string[] => (wholeObject(text) === undefined ? lineTexts(text).filter((raw) => parse(raw) === undefined) : []);

/** The messages a chat file holds once its records are folded the way the vendor's loader folds them (chatRecordingService.ts:304-530), and its metadata. */
const foldChat = (text: string): { meta: Obj; messages: Obj[] } => {
  const whole = wholeObject(text);
  const records = whole === undefined ? lineTexts(text).map(parse) : [whole];
  if (records.length > 0 && !records.some(isObj)) throw new Error('no parseable line');
  const messages = new Map<string, Obj>();
  let meta: Obj = {};
  const seed = (list: unknown): void => {
    for (const message of Array.isArray(list) ? list : []) {
      const id = isObj(message) ? str(message.id) : undefined;
      if (isObj(message) && id !== undefined) messages.set(id, message);
    }
  };
  const patchOne = (patch: unknown): void => {
    const existing = isObj(patch) ? messages.get(str(patch.id) ?? '') : undefined;
    if (!isObj(patch) || existing === undefined) return;
    if (patch.content !== undefined) existing.content = patch.content;
    if (Array.isArray(patch.toolCalls) && existing.type === 'gemini' && Array.isArray(existing.toolCalls)) {
      const held: unknown[] = existing.toolCalls;
      for (const raw of patch.toolCalls) {
        const change: unknown = raw;
        const target: unknown = isObj(change) ? held.find((candidate) => isObj(candidate) && candidate.id === change.id) : undefined;
        if (isObj(change) && isObj(target) && 'result' in change) target.result = change.result;
      }
    }
  };
  for (const record of records) {
    if (!isObj(record)) continue;
    if (typeof record.$rewindTo === 'string') {
      const ids = [...messages.keys()];
      const at = ids.indexOf(record.$rewindTo);
      if (at === -1) messages.clear();
      else for (const id of ids.slice(at)) messages.delete(id);
    } else if (isObj(record.$patch)) {
      const patch = record.$patch;
      patchOne(patch);
      for (const update of Array.isArray(patch.updates) ? patch.updates : []) patchOne(update);
      for (const id of Array.isArray(patch.removeIds) ? patch.removeIds : []) if (typeof id === 'string') messages.delete(id);
      if (Array.isArray(patch.orderIds)) {
        const ordered = patch.orderIds.flatMap((id) => (typeof id === 'string' && messages.has(id) ? [id] : []));
        const rest = [...messages.keys()].filter((id) => !ordered.includes(id));
        const held = new Map(messages);
        messages.clear();
        for (const id of [...rest, ...ordered]) messages.set(id, held.get(id) ?? {});
      }
    } else if (str(record.id) !== undefined) {
      messages.set(String(record.id), record);
    } else if (isObj(record.$set)) {
      if (Array.isArray(record.$set.messages)) {
        messages.clear();
        seed(record.$set.messages);
      }
      meta = { ...meta, ...record.$set };
    } else if (str(record.sessionId) !== undefined && str(record.projectHash) !== undefined) {
      meta = { ...meta, ...record };
      seed(record.messages);
    }
  }
  return { meta, messages: [...messages.values()] };
};

/** The text of a `PartListUnion`: a string, a part, or a list of them; a `thought` part is the model's reasoning, not its answer. */
const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  return isObj(value) && value.thought !== true && typeof value.text === 'string' ? value.text : '';
};

const partsOf = (value: unknown): Obj[] => (Array.isArray(value) ? value.filter(isObj) : isObj(value) ? [value] : []);

/** A user message the operator did not type: slash commands, help, and context the CLI or a hook injects (utils/sessionUtils.ts:97). */
const NOT_TYPED = ['/', '?', '<session_context>', '<hook_context>'];

/** Gemini tools the reader names in the Claude Code vocabulary, so the extractor classifies them; the Gemini name stays in `native` for the action table. */
const RENAMED: ReadonlyMap<string, string> = new Map([
  ['run_shell_command', 'Bash'],
  ['replace', 'Edit'],
  ['write_file', 'Write'],
  ['read_file', 'Read'],
  ['glob', 'Glob'],
  ['grep_search', 'Grep'],
  ['search_file_content', 'Grep'],
  ['google_web_search', 'WebSearch'],
  ['web_fetch', 'WebFetch'],
]);
const TIMED_OUT = /^Command was automatically cancelled because it exceeded the timeout of [\d.]+ minutes without output\./;
const PATH_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'Read']);

const CLOSE = '</untrusted_context>';
const THROUGH_OPEN = /^[^]*?<untrusted_context(?: [^>]*)?>\n/;
/**
 * The text inside the `<untrusted_context>` wrapper. Two things the executor does to a long or hook-modified shell result leave the closing tag short of the end of
 * the text, so the LAST closing tag decides (the wrapper escapes any inside the output, utils/textUtils.ts:182): a hook note appended after the wrapper
 * (scheduler/tool-executor.ts:131-133), and a truncation that rewrites the wrapped text to a header line, the first 20%, a marker, and the last 80%
 * (utils/fileUtils.ts:828-833, tool-executor.ts:219-236). The header and anything before the opening tag go; the tail, which holds the trailer, stays.
 */
const unwrap = (text: string): string => {
  const trimmed = text.trim();
  const end = trimmed.lastIndexOf(CLOSE);
  if (end === -1) return text;
  return trimmed.slice(0, end).replace(/\n$/, '').replace(THROUGH_OPEN, '');
};
/** The vendor's `Error: Tool call execution failed. Reason: ` prefix on a failed call's text (tools/tools.ts:670). */
const unprefixed = (text: string): string => text.replace(/^Error: Tool call execution failed\. Reason: /, '');

/** What a call's result holds: the `functionResponse` output and error, else any plain text. */
const responseOf = (result: unknown): { output: string; error: string | undefined } => {
  const responses = partsOf(result).flatMap((part) => (isObj(part.functionResponse) && isObj(part.functionResponse.response) ? [part.functionResponse.response] : []));
  const output = responses.map((response) => str(response.output)).find((text) => text !== undefined);
  return { output: output ?? (responses.length === 0 ? textOf(result) : ''), error: responses.map((response) => str(response.error)).find((text) => text !== undefined) };
};

/** A shell result's trailer, in the order the tool writes it (tools/shell.ts:953-979): `Exit Code`, `Signal`, `Background PIDs`, `Process Group PGID`. */
const shellResult = (text: string): { output: string; exit: number | undefined; signal: string | undefined } => {
  const lines = unwrap(text).split('\n');
  const pop = (prefix: string): string | undefined => {
    const last = lines.at(-1);
    if (last === undefined || !last.startsWith(prefix)) return undefined;
    lines.pop();
    return last.slice(prefix.length);
  };
  pop('Process Group PGID: ');
  pop('Background PIDs: ');
  const signal = pop('Signal: ');
  const code = pop('Exit Code: ');
  const exit = code !== undefined && /^-?\d+$/.test(code) ? Number(code) : undefined;
  const body = lines.join('\n').replace(/^Output: /, '');
  return { output: body === '(empty)' ? '' : body, exit, signal };
};

/** A nonzero exit code is a failure whatever `status` says; a negative one is no exit status, so the output stands as the error line. */
const failureOf = (exit: number, text: string): string => (exit < 0 && text.trim() !== '' ? text : `Exit code ${String(exit)}\n${text}`);

/** The chat file as the lines `captureSession` reads; `cwd` is the project folder (`.project_root`), the only working directory Gemini CLI records. */
export const chatLines = (text: string, fallbackId: string, cwd: string | null): Obj[] => {
  const { meta, messages } = foldChat(text);
  const lines: Obj[] = [];
  const base: Obj = { sessionId: str(meta.sessionId) ?? fallbackId, ...(cwd === null ? {} : { cwd }) };
  let at: string | undefined;
  let sequence = 0;
  const stamp = (value: unknown): string => {
    const candidate = iso(value);
    if (candidate !== undefined && (at === undefined || Date.parse(candidate) >= Date.parse(at))) at = candidate;
    return at ?? new Date(0).toISOString();
  };
  const result = (id: string, failure: string | undefined, when: string, output: string): void => {
    sequence += 1;
    lines.push({
      ...base,
      type: 'user',
      uuid: `${fallbackId}-r${String(sequence)}`,
      timestamp: when,
      // A call has one time, not a start and an end, so no duration is claimed.
      noDuration: true,
      // The output follows an `Exit code 0` line, the shape a Claude Code Bash result has, so a `[branch sha]` line is still found for commit survival.
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: failure !== undefined, content: failure ?? (output === '' ? '' : `Exit code 0\n${output}`) }] },
    });
  };

  for (const message of messages) {
    const when = stamp(message.timestamp);
    if (message.type === 'user') {
      // A user message made of tool results is the model's own turn (geminiChat.ts), not a prompt.
      if (partsOf(message.content).some((part) => isObj(part.functionResponse))) continue;
      // The vendor's filter reads the text SENT (`content`, chatRecordingService.ts:220-227); a custom command sends its expansion and shows `/cmd` (nonInteractiveCli.ts:289-300),
      // so the shown text is only what is recorded.
      const sent = textOf(message.content).trim();
      if (sent === '' || NOT_TYPED.some((prefix) => sent.startsWith(prefix))) continue;
      const shown = textOf(message.displayContent);
      const typed = shown.trim() === '' ? textOf(message.content) : shown;
      sequence += 1;
      lines.push({ ...base, type: 'user', uuid: `${fallbackId}-u${String(sequence)}`, timestamp: when, message: { role: 'user', content: [{ type: 'text', text: typed }] } });
    } else if (message.type === 'gemini') {
      const answer = textOf(message.content);
      const calls = (Array.isArray(message.toolCalls) ? message.toolCalls : []).filter(isObj);
      const tokens = isObj(message.tokens) ? message.tokens : undefined;
      // A response of only a thought (the synthetic "binary content" note) says nothing.
      if (answer.trim() === '' && calls.length === 0 && tokens === undefined) continue;
      const content: Obj[] = answer.trim() === '' ? [] : [{ type: 'text', text: answer }];
      const held: { id: string; native: string; shell: boolean; call: Obj }[] = [];
      for (const entry of calls) {
        const id = str(entry.id);
        const native = str(entry.name);
        if (id === undefined || native === undefined) continue;
        const args = isObj(entry.args) ? entry.args : {};
        const name = RENAMED.get(native) ?? native;
        const path = str(args.file_path);
        const input = name === 'Bash' ? (str(args.command) === undefined ? {} : { command: args.command }) : PATH_TOOLS.has(name) ? (path === undefined ? {} : { file_path: path }) : args;
        content.push({ type: 'tool_use', id, name, ...(name === native ? {} : { native }), input });
        held.push({ id, native, shell: native === 'run_shell_command', call: entry });
      }
      sequence += 1;
      const cached = num(tokens?.cached) ?? 0;
      const thoughts = num(tokens?.thoughts);
      const usage =
        tokens === undefined
          ? {}
          : {
              usage: {
                // `input` is the prompt count and includes the cache reads (uiTelemetry.ts:317-320); capture's fields are disjoint.
                input_tokens: Math.max((num(tokens.input) ?? 0) - cached, 0),
                cache_read_input_tokens: cached,
                cache_creation_input_tokens: 0,
                // `output` is candidatesTokenCount and `thoughts` is counted apart from it (chatRecordingTypes.ts:21-25), but thinking is part of the output, which verify holds.
                output_tokens: (num(tokens.output) ?? 0) + (thoughts ?? 0),
                ...(thoughts === undefined ? {} : { output_tokens_details: { thinking_tokens: thoughts } }),
              },
            };
      const model = str(message.model);
      lines.push({
        ...base,
        type: 'assistant',
        uuid: `${fallbackId}-a${String(sequence)}`,
        requestId: str(message.id) ?? `${String(base.sessionId)}-resp${String(sequence)}`,
        timestamp: when,
        ...(model === undefined ? {} : { requestedModel: model }),
        message: { role: 'assistant', content, ...usage },
      });
      for (const { id, shell, call } of held) {
        const status = str(call.status);
        if (status !== 'success' && status !== 'error' && status !== 'cancelled') continue;
        const finished = stamp(call.timestamp);
        const { output: raw, error } = responseOf(call.result);
        const parsed = shell ? shellResult(raw) : undefined;
        const output = parsed?.output ?? '';
        // On the inactivity timeout the tool writes one sentence and no trailer, and the executor still records `success` (tools/shell.ts:929-933, tool-executor.ts:144-154).
        const timedOut = TIMED_OUT.exec(output);
        let failure: string | undefined;
        if (status !== 'success' || error !== undefined) {
          failure = error ?? unprefixed(unwrap(raw)).trim();
          if (failure === '') failure = 'tool failed';
        } else if (parsed?.exit !== undefined && parsed.exit !== 0) {
          failure = failureOf(parsed.exit, output);
        } else if (parsed?.signal !== undefined) {
          failure = output === '' ? `Signal: ${parsed.signal}` : output;
        } else if (timedOut !== null) {
          failure = timedOut[0];
        }
        result(id, failure, finished, output);
      }
    }
  }
  return lines;
};

const projectRootOf = async (slug: string): Promise<string | null> => {
  try {
    return str((await readFile(join(slug, '.project_root'), 'utf8')).trim()) ?? null;
  } catch {
    // A pre-slug folder (named for a hash of the path) has no marker; its sessions get no folder.
    return null;
  }
};

/** The session id and kind (`main` or `subagent`) a chat file's head names, read from the first line of a `.jsonl` file or the object of a `.json` file. */
const headOf = (file: string, text: string): { id: string | undefined; kind: string | undefined } => {
  const first = extname(file) === '.json' ? wholeObject(text) : parse(lineTexts(text)[0] ?? '');
  return { id: isObj(first) ? str(first.sessionId) : undefined, kind: isObj(first) ? str(first.kind) : undefined };
};

/** True when the file holds no prompt or response: a head written at a chat's start and nothing after it (chatRecordingService.ts:855-865). A torn file is not empty; it is named when read. */
const holdsNothing = (text: string, id: string): boolean => {
  try {
    return chatLines(text, id, null).length === 0;
  } catch {
    return false;
  }
};

export const openGeminiStore = async (root: string): Promise<GeminiStore | undefined> => {
  const base = join(root, 'tmp');
  const unreadable: { file: string; reason: string }[] = [];
  let slugs;
  try {
    slugs = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return undefined;
    return { sessions: [], transcript: () => Promise.reject(new Error('no sessions')), rejected: 0, unreadable: [{ file: base, reason: reasonOf(error, base) }] };
  }
  const found = new Map<string, GeminiSession>();
  let rejected = 0;
  const list = async (dir: string): Promise<{ name: string; directory: boolean }[]> => {
    try {
      return (await readdir(dir, { withFileTypes: true })).map((entry) => ({ name: entry.name, directory: entry.isDirectory() })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      // A project folder with no chats yet is no session; any other failure is reported.
      if (!missing(error)) unreadable.push({ file: dir, reason: reasonOf(error, dir) });
      return [];
    }
  };
  const add = async (file: string, folder: string | null, parent: string | null): Promise<void> => {
    const name = basename(file, extname(file));
    try {
      const info = await stat(file);
      const text = await readFile(file, 'utf8');
      const head = headOf(file, text);
      // A subagent with no parent set is written at the root of `chats/` (chatRecordingService.ts:787,813-814), and the vendor's own listing skips it by `kind` (cli/src/utils/sessionUtils.ts:301).
      if (parent === null && head.kind === 'subagent') return;
      // A subagent's file is named for the agent, which is unique under its parent; a main session's id is the head's.
      const named = parent === null ? (head.id ?? name) : name;
      const id = parent === null ? named : `${parent}-${named}`;
      if (!SAFE_ID.test(id)) {
        rejected += 1;
        return;
      }
      // Every new chat appends a head (geminiChat.ts:453), so a launch and quit, or a /clear, leaves a file with nothing in it: no session, and not an unreadable one.
      if (holdsNothing(text, named)) return;
      const session: GeminiSession = { id, folder, file, size: info.size, mtimeMs: Math.floor(info.mtimeMs), parent };
      // A `.json` file migrated to `.jsonl` can leave both; the newer one is the session.
      const held = found.get(id);
      if (held === undefined || held.mtimeMs < session.mtimeMs) found.set(id, session);
    } catch (error) {
      unreadable.push({ file, reason: reasonOf(error, file) });
    }
  };
  for (const slug of slugs.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(base, slug.name);
    const folder = await projectRootOf(dir);
    const chats = join(dir, 'chats');
    for (const entry of await list(chats)) {
      if (!entry.directory) {
        if (['.json', '.jsonl'].includes(extname(entry.name))) await add(join(chats, entry.name), folder, null);
      } else if (SAFE_ID.test(entry.name)) {
        for (const inner of await list(join(chats, entry.name))) if (!inner.directory && extname(inner.name) === '.jsonl') await add(join(chats, entry.name, inner.name), folder, entry.name);
      } else {
        rejected += 1;
      }
    }
  }
  const sessions = [...found.values()].sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
  return {
    sessions,
    rejected,
    unreadable,
    transcript: async (session) => {
      const raw = await readFile(session.file, 'utf8');
      const lines = [...chatLines(raw, session.id, session.folder).map((line) => JSON.stringify(line)), ...chatBadLines(raw)];
      return lines.join('\n') + (lines.length === 0 ? '' : '\n');
    },
  };
};
