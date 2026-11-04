// The Grok Build source (t818): a Grok Build session log becomes the same capture records a Claude Code transcript does.
//
// FIXTURE-DERIVED: written from the public source of the CLI (github.com/xai-org/grok-build @ 2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8, Apache-2.0, Rust,
// under crates/codegen/) and the Agent Client Protocol schema it implements (github.com/agentclientprotocol/agent-client-protocol @ 0e486bcd, schema/v1/
// schema.json), not from a live store. Nothing was copied; the reader is original. No vendor text promises the on-disk format (the user guide, `17-sessions.md`,
// steers readers to `grok usage` instead of the files), so `docs/sessions-store.md` says what a live run would still have to prove.
//
// Where it reads from (`grokRoot`): `$GROK_HOME`, else `~/.grok` (`%USERPROFILE%\.grok` on Windows) (xai-dirs lib.rs:51-57; user guide 17-sessions.md:18). A
// session is `sessions/<percent-encoded cwd>/<session id>/` (17-sessions.md:22-40), holding
//   summary.json  {info: {id, cwd}, created_at, current_model_id, num_messages, session_kind?, forked_at?}: the authoritative cwd (the folder name can be a hash for a
//                 long path), the model the session ended on, and what kind of session it is
//   updates.jsonl "the authoritative conversation log" (17-sessions.md:42): one `{timestamp, method, params: {sessionId, update}}` per line, `timestamp` epoch
//                 SECONDS (serde default 0), `update` an ACP SessionUpdate tagged by `sessionUpdate`:
//     user_message_chunk   content {type: "text", text}: the operator's prompt; chunks merge until the agent speaks. `_meta.hostTurn` (a turn boundary marker) ends a
//                          prompt and `_meta.interjection` (a mid-turn steer whose text is a model-facing frame) is not one (storage/mod.rs:966, :974)
//     agent_message_chunk  content {type: "text", text}: the response, chunks merged
//     tool_call            {toolCallId, title, kind, rawInput}: `title` IS the tool's name (tool_calls.rs:1487). A shell call is a name in SHELL_TOOLS or `kind` execute
//                          (the user's `!cmd` is `bash-mode-<uuid>` titled "Execute `cmd`", tool_dispatch.rs:213, :245)
//     tool_call_update     {toolCallId, status, content[], rawOutput}: the outcome. A shell call's `rawOutput` is `{type: "Bash", exit_code, output: bytes,
//                          output_for_prompt, signal, timed_out, current_dir}` (types/output.rs:384-405). The agent path marks a shell call `failed` only on a timeout
//                          or a signal, so exit 2 arrives `completed` (acp_conversion.rs:241-250): the exit code decides, not the status. Any other tool's error text is its
//                          `content[]` text; its `rawOutput` is a tagged wrapper that is never the error line. `current_dir` is the cwd after the command, the only
//                          place a directory change shows
//   usage.json    {turns: [{endedAt, inputTokens, outputTokens, cachedReadTokens, cacheCreationTokens, reasoningTokens, primaryModelId}]} (usage_file.rs:10-80): per-TURN
//                 deltas (`session` is their sum, :230-300), so every turn is added once. `inputTokens` is the FULL prompt, cache reads and writes included (xai-grok-sampling-types
//                 conversation.rs:771-773: `prompt_tokens` "is always the FULL prompt size"), and capture's fields are disjoint, so the uncached part is
//                 input - cache reads - cache writes. A turn's totals land on the last response before its `endedAt` (turn numbers are not used: a rewind renumbers).
// A fork copies its parent's lines with their old timestamps and its parent's usage.json (copy.rs:229, persistence.rs:2608); `summary.forked_at` is the cut, so
// older lines and turns are not this session's. A subagent (`session_kind` subagent or subagent_fork) is its own session in the same tree: it is not listed, and the
// parent's `task` call is the record. `events.jsonl` (telemetry), `chat_history.jsonl` (the model-facing copy), and the rest of the folder are not read.

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** The Grok home for an environment; a test passes its own so it never reads the real one. */
export const grokRoot = (env: { [name: string]: string | undefined }, home: string = homedir()): string => {
  const set = env.GROK_HOME;
  return set === undefined || set === '' ? join(home, '.grok') : set;
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

/** A session found in the store, before its lines are read. */
export interface GrokSession {
  /** The session folder's name, which is the session id and names the skeleton. */
  id: string;
  /** `summary.json` `info.cwd`; null when it names none. */
  folder: string | null;
  /** The session's folder. */
  dir: string;
  size: number;
  mtimeMs: number;
}

export interface GrokStore {
  sessions: GrokSession[];
  /** The session as transcript text for `captureSession`; throws when a file cannot be read or holds no parseable line. */
  transcript: (session: GrokSession) => Promise<string>;
  /** Folders skipped because their name is not a safe file name (it names a skeleton), counted so the skip is never silent. */
  rejected: number;
  /** Sessions that could not be inspected, reported once each and never fatal; the reason names no path. */
  unreadable: { file: string; reason: string }[];
}

const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;
const UPDATES = 'updates.jsonl';
const SUMMARY = 'summary.json';
const USAGE = 'usage.json';
/** A subagent is its own session in the same tree (`session_kind`, persistence.rs:3016, subagent/mod.rs:1136). */
const SUBAGENT_KINDS: ReadonlySet<string> = new Set(['subagent', 'subagent_fork']);
/** The tools that run a command; a call of `kind` execute is one whatever its name. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['run_terminal_cmd', 'run_terminal_command', 'bash']);
/** The tools that change files, named so a failed edit is still an edit. Their path keys are `file_path` and, for `apply_patch`, the `*** <Add|Update|Delete> File:` headers of `patch`. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['search_replace', 'apply_patch', 'edit', 'write', 'hashline_edit']);
const PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

/** An error's message with `file` cut to its base name, so a reason that is logged names no folder. */
const reasonOf = (error: unknown, file: string): string => (error instanceof Error ? error.message : String(error)).split(file).join(basename(file));

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** A JSON object file; undefined when it does not exist, a throw when it is not an object. */
const readObject = async (file: string): Promise<Obj | undefined> => {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const value = parse(text);
  if (!isObj(value)) throw new Error(`${basename(file)} is not a JSON object`);
  return value;
};

/** The non-blank lines that are not JSON (a torn write), kept so `captureSession` counts them and the deposit line reports them. */
export const grokBadLines = (text: string): string[] => text.split('\n').filter((raw) => raw.trim() !== '' && parse(raw) === undefined);

/** A time as ISO text, or undefined when it is not an absolute time after 2000. */
const isoOf = (ms: number): string | undefined => (ms >= Date.parse('2000-01-01T00:00:00Z') ? new Date(ms).toISOString() : undefined);
const timeOf = (value: unknown): number | undefined => {
  const text = str(value);
  const ms = text === undefined ? NaN : Date.parse(text);
  return Number.isNaN(ms) || isoOf(ms) === undefined ? undefined : ms;
};

/** A failed shell call's error line: the output, but a nonzero exit says so first; a negative one is no exit status, so the output stands. */
const failureOf = (exit: number, text: string): string => (exit < 0 && text.trim() !== '' ? text : `Exit code ${String(exit)}\n${text}`);

/** The text parts of a tool update's `content[]` (ACP ToolCallContent `content`/`text`), the error text of a tool that failed. */
const contentText = (update: Obj): string | undefined => {
  const parts = (Array.isArray(update.content) ? update.content : []).flatMap((part) => (isObj(part) && part.type === 'content' && isObj(part.content) && str(part.content.text) !== undefined ? [String(part.content.text)] : []));
  return parts.length === 0 ? undefined : parts.join('\n');
};

/** A shell call's output: the ANSI-stripped text, else the bytes. */
const shellText = (raw: Obj, update: Obj): string => {
  const bytes = Array.isArray(raw.output) ? raw.output.filter((byte): byte is number => typeof byte === 'number') : [];
  return str(raw.output_for_prompt) ?? str(Buffer.from(bytes).toString('utf8')) ?? contentText(update) ?? '';
};

/** The files a request names: `file_path`, or the headers of an `apply_patch` patch. */
const requestedPaths = (input: Obj): string[] => {
  const path = str(input.file_path);
  if (path !== undefined) return [path];
  const patch = str(input.patch);
  return patch === undefined ? [] : [...patch.matchAll(PATCH_HEADER)].map((match) => String(match[1]).trim());
};

/** The files a completion reports having changed: the `diff` parts of `content[]` (ACP ToolCallContent `diff`, `path`). */
const diffPaths = (update: Obj): string[] =>
  (Array.isArray(update.content) ? update.content : []).flatMap((part) => (isObj(part) && part.type === 'diff' && str(part.path) !== undefined ? [String(part.path)] : []));

/** A response (one assistant line), kept until the end so a turn's usage can land on it. */
interface Response {
  line: Obj;
  message: Obj;
  content: Obj[];
  at: number;
}

interface Call {
  block: Obj;
  content: Obj[];
  shell: boolean;
  /** The files the request names (for an edit); the block keeps only the first. */
  paths: string[];
}

/** One session as the lines `captureSession` reads. */
export const grokLines = (text: string, fallbackId: string, summary: Obj, usage: Obj | undefined): Obj[] => {
  const nonblank = text.split('\n').filter((raw) => raw.trim() !== '');
  if (nonblank.length > 0 && !nonblank.some((raw) => isObj(parse(raw)))) throw new Error('no parseable line');
  const info = isObj(summary.info) ? summary.info : {};
  const model = str(summary.current_model_id);
  const forkedAt = timeOf(summary.forked_at);
  const lines: Obj[] = [];
  const base: Obj = { sessionId: str(info.id) ?? fallbackId, ...(str(info.cwd) === undefined ? {} : { cwd: str(info.cwd) }) };
  let at = timeOf(summary.created_at) ?? 0;
  let sequence = 0;
  let pending: { text: string; when: number } | undefined;
  let open: Response | undefined;
  const responses: Response[] = [];
  const calls = new Map<string, Call>();
  const resolved = new Set<string>();
  const stamp = (seconds: unknown): number => {
    const value = num(seconds);
    // A missing, zero, or earlier time (the vendor's serde default is 0) says nothing about when: the latest time so far stands.
    if (value !== undefined && value * 1000 > at) at = value * 1000;
    return at;
  };
  const iso = (ms: number): string => new Date(ms).toISOString();
  const flushPrompt = (): void => {
    if (pending === undefined) return;
    sequence += 1;
    lines.push({ ...base, type: 'user', uuid: `${fallbackId}-u${String(sequence)}`, timestamp: iso(pending.when), message: { role: 'user', content: [{ type: 'text', text: pending.text }] } });
    pending = undefined;
  };
  const response = (when: number): Response => {
    if (open !== undefined) return open;
    sequence += 1;
    const content: Obj[] = [];
    const message: Obj = { role: 'assistant', content };
    // Every assistant line carries a requestId (`verify --strict` needs one), and each response has its own, so its usage counts once.
    const line: Obj = { ...base, type: 'assistant', uuid: `${fallbackId}-a${String(sequence)}`, requestId: `${fallbackId}-resp${String(sequence)}`, timestamp: iso(when), ...(model === undefined ? {} : { requestedModel: model }), message };
    lines.push(line);
    open = { line, message, content, at: when };
    responses.push(open);
    return open;
  };
  const result = (id: string, failure: string | undefined, when: number, output = ''): void => {
    sequence += 1;
    lines.push({
      ...base,
      type: 'user',
      uuid: `${fallbackId}-r${String(sequence)}`,
      timestamp: iso(when),
      // The completion is stamped with its own time, but the call's start is not paired to it here, so no duration is claimed.
      noDuration: true,
      // The output follows an `Exit code 0` line, the shape a Claude Code Bash result has, so a `[branch sha]` line is still found for commit survival.
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: failure !== undefined, content: failure ?? (output === '' ? '' : `Exit code 0\n${output}`) }] },
    });
  };

  for (const raw of nonblank) {
    const entry = parse(raw);
    if (!isObj(entry) || !isObj(entry.params) || !isObj(entry.params.update)) continue;
    const update = entry.params.update;
    const kind = str(update.sessionUpdate);
    const seconds = num(entry.timestamp);
    // A fork's file starts with its parent's lines, each with the parent's time; the cut is the second the fork was made.
    if (kind === undefined || (forkedAt !== undefined && seconds !== undefined && seconds > 0 && seconds < Math.floor(forkedAt / 1000))) continue;
    const when = stamp(seconds);
    const meta = isObj(update._meta) ? update._meta : {};
    const part = isObj(update.content) ? str(update.content.text) : undefined;
    if (kind === 'user_message_chunk') {
      if (meta.hostTurn === true) flushPrompt();
      if (meta.hostTurn === true || meta.interjection === true || part === undefined) continue;
      open = undefined;
      pending = { text: (pending?.text ?? '') + part, when: pending?.when ?? when };
    } else if (kind === 'agent_message_chunk') {
      flushPrompt();
      if (part === undefined) continue;
      const current = response(when);
      const last = current.content[current.content.length - 1];
      if (last?.type === 'text') last.text = String(last.text) + part;
      else current.content.push({ type: 'text', text: part });
    } else if (kind === 'tool_call') {
      flushPrompt();
      const id = str(update.toolCallId);
      const title = str(update.title);
      if (id === undefined || title === undefined) continue;
      const current = response(when);
      const input = isObj(update.rawInput) ? update.rawInput : {};
      const block: Obj = { type: 'tool_use', id, name: title.includes('__') ? `mcp__${title}` : title, input };
      const shell = SHELL_TOOLS.has(title) || update.kind === 'execute';
      const paths = EDIT_TOOLS.has(title) ? requestedPaths(input) : [];
      if (shell) {
        // The user's `!cmd` carries its command only in the title: "Execute `cmd`".
        const command = str(input.command) ?? /`([^`]+)`/.exec(title)?.[1];
        block.native = title;
        block.name = 'Bash';
        block.input = command === undefined ? {} : { command };
      } else if (EDIT_TOOLS.has(title)) {
        const path = paths[0];
        block.native = title;
        block.name = 'Edit';
        block.input = path === undefined ? {} : { file_path: path };
      }
      current.content.push(block);
      calls.set(id, { block, content: current.content, shell, paths });
    } else if (kind === 'tool_call_update') {
      const id = str(update.toolCallId);
      const status = str(update.status);
      const known = id === undefined ? undefined : calls.get(id);
      // Only an outcome settles a call; a progress update leaves it `none`, and the call settles once.
      if (id === undefined || known === undefined || resolved.has(id) || (status !== 'completed' && status !== 'failed')) continue;
      resolved.add(id);
      open = undefined;
      const output = isObj(update.rawOutput) ? update.rawOutput : {};
      let failure: string | undefined;
      let shown = '';
      if (known.shell) {
        const exit = num(output.exit_code);
        const dir = str(output.current_dir);
        if (dir !== undefined) base.cwd = dir;
        shown = shellText(output, update);
        if (exit !== undefined && exit !== 0) failure = failureOf(exit, shown);
        else if (status === 'failed') failure = shown === '' ? 'tool failed' : shown;
      } else if (status === 'failed') {
        failure = contentText(update) ?? 'tool failed';
      }
      result(id, failure, when, shown);
      if (EDIT_TOOLS.has(str(known.block.native) ?? '')) {
        // The first file rides the call's own block; any other gets its own, in the same response.
        const paths = [...new Set([...known.paths, ...diffPaths(update)])];
        if (paths[0] !== undefined) known.block.input = { file_path: paths[0] };
        for (const [index, path] of paths.slice(1).entries()) {
          const extra = `${id}:${String(index + 2)}`;
          known.content.push({ type: 'tool_use', id: extra, name: 'Edit', native: known.block.native, input: { file_path: path } });
          result(extra, failure, when);
        }
      }
    }
  }
  flushPrompt();
  // Each turn's totals land on the last response before the turn ended, else the first. `turns[]` are per-turn deltas (usage_file.rs:230-300), so each is added
  // once; a fork copied its parent's turns, which end at or before `forked_at`.
  const turns = (Array.isArray(usage?.turns) ? usage.turns : []).flatMap((turn) => {
    const ended = isObj(turn) ? timeOf(turn.endedAt) : undefined;
    return isObj(turn) && ended !== undefined && (forkedAt === undefined || ended > forkedAt) ? [{ turn, ended }] : [];
  });
  const landed = new Map<Response, { input: number; read: number; write: number; output: number; thinking: number }>();
  for (const { turn, ended } of turns.sort((a, b) => a.ended - b.ended)) {
    const target = responses.findLast((candidate) => candidate.at <= ended) ?? responses[0];
    if (target === undefined) continue;
    const held = landed.get(target) ?? { input: 0, read: 0, write: 0, output: 0, thinking: 0 };
    const read = num(turn.cachedReadTokens) ?? 0;
    const write = num(turn.cacheCreationTokens) ?? 0;
    // `inputTokens` includes the cache reads and writes (conversation.rs:771-773), and capture's fields are disjoint, so only the uncached part is input.
    held.input += Math.max((num(turn.inputTokens) ?? 0) - read - write, 0);
    held.read += read;
    held.write += write;
    held.output += num(turn.outputTokens) ?? 0;
    held.thinking += num(turn.reasoningTokens) ?? 0;
    landed.set(target, held);
    const turnModel = str(turn.primaryModelId);
    if (turnModel !== undefined) target.line.requestedModel = turnModel;
  }
  for (const [target, held] of landed) {
    target.message.usage = { input_tokens: held.input, cache_read_input_tokens: held.read, cache_creation_input_tokens: held.write, output_tokens: held.output, output_tokens_details: { thinking_tokens: held.thinking } };
  }
  return lines;
};

export const openGrokStore = async (root: string): Promise<GrokStore | undefined> => {
  const base = join(root, 'sessions');
  const unreadable: { file: string; reason: string }[] = [];
  let folders;
  try {
    folders = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return undefined;
    return { sessions: [], transcript: () => Promise.reject(new Error('no sessions')), rejected: 0, unreadable: [{ file: base, reason: reasonOf(error, base) }] };
  }
  const sessions: GrokSession[] = [];
  let rejected = 0;
  for (const folder of folders.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    let entries;
    try {
      entries = await readdir(join(base, folder.name), { withFileTypes: true });
    } catch (error) {
      unreadable.push({ file: join(base, folder.name), reason: reasonOf(error, join(base, folder.name)) });
      continue;
    }
    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!SAFE_ID.test(entry.name)) {
        rejected += 1;
        continue;
      }
      const dir = join(base, folder.name, entry.name);
      try {
        const summary = await readObject(join(dir, SUMMARY));
        const updates = await stat(join(dir, UPDATES));
        // A folder with no summary or no log (a started, never-used session) is no session; a subagent is its parent's `task` call; an unused one holds nothing.
        if (summary === undefined || (str(summary.session_kind) !== undefined && SUBAGENT_KINDS.has(String(summary.session_kind))) || summary.num_messages === 0) continue;
        const used = await stat(join(dir, USAGE)).catch(() => undefined);
        const info = isObj(summary.info) ? summary.info : {};
        sessions.push({ id: entry.name, folder: str(info.cwd) ?? null, dir, size: updates.size + (used?.size ?? 0), mtimeMs: Math.floor(Math.max(updates.mtimeMs, used?.mtimeMs ?? 0)) });
      } catch (error) {
        if (!missing(error)) unreadable.push({ file: dir, reason: reasonOf(error, dir) });
      }
    }
  }
  sessions.sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
  return {
    sessions,
    rejected,
    unreadable,
    transcript: async (session) => {
      const text = await readFile(join(session.dir, UPDATES), 'utf8');
      const summary = await readObject(join(session.dir, SUMMARY));
      if (summary === undefined) throw new Error(`${SUMMARY} is gone`);
      const lines = [...grokLines(text, session.id, summary, await readObject(join(session.dir, USAGE))).map((line) => JSON.stringify(line)), ...grokBadLines(text)];
      return lines.join('\n') + (lines.length === 0 ? '' : '\n');
    },
  };
};
