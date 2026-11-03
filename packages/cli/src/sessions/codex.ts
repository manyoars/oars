// The OpenAI Codex CLI source (t749): a Codex session log becomes the same capture records a Claude Code transcript does.
//
// FIXTURE-DERIVED: written from the open-source Codex CLI (github.com/openai/codex, Apache-2.0, commit ac558e2a, 2026-11-03), not from a live
// store. Each field read below cites the file it comes from; `docs/sessions-store.md` says what a live run would still have to prove.
//
// Where it reads from (`codexRoot`): `$CODEX_HOME`, else `~/.codex` (`%USERPROFILE%\.codex` on Windows); the same on every OS
// (codex-rs/rollout/src/list.rs). Inside it, `sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl` and `archived_sessions/` hold one
// file per session; Codex compresses an old one to `.jsonl.zst` and reads either (rollout/src/compression.rs), so this reader does too.
// A line is `{timestamp, type, payload}` (history/src/lib.rs `RolloutLine`, rollout_payload.rs). Like cursor.ts, the reader writes each session
// out as the transcript lines `captureSession` already reads, so redaction, the 1,000-character line cap, the salted file hashes, and the
// skeleton are the Claude Code path's own code:
//   session_meta        {id, cwd, cli_version, timestamp, history_mode, parent_thread_id, forked_from_ordinal_exclusive, subagent_history_start_ordinal}: the
//                       working directory and the harness version; only the first one in the file (recorder.rs:1157-1158). A spawned agent has `parent_thread_id` (protocol.rs:3464); records whose
//                       `ordinal` is below its `subagent_history_start_ordinal` (:3511) or a fork's `forked_from_ordinal_exclusive` (:3462) are the parent's, and are dropped. Ordinals exist
//                       only in a Paginated rollout (ordinal.rs:37), the CLI's default (thread-store/src/local/mod.rs:512-515), which holds item_completed TurnItems
//                       (UserMessage, AgentMessage, FileChange, McpToolCall) in place of the legacy events below (rollout/src/policy.rs:164-176); both are read.
//                       A Legacy fork's copied history is dropped by matching the parent rollout record for record
//   turn_context        {model, cwd}: the model, and the directory when it changes
//   event_msg user_message {message}            a prompt (the `response_item` user messages also hold injected context, so they are not read)
//   event_msg agent_message {message}           the assistant's text
//   event_msg token_count {info.last_token_usage}  one model response's usage, closing the lines since the last one
//   response_item function_call / local_shell_call / custom_tool_call   a tool call
//   response_item function_call_output {call_id, output}   a shell call's outcome: the text `Exit code: N` / `Process exited with code N` then `Output:`
//                       (core/src/tools/mod.rs:107-113, context.rs:556), the real exit code; `execution error: ...` (core/src/tools/events.rs:438) is a
//                       call that failed to spawn. `write_stdin` (handlers/shell_spec.rs:113) is a shell call too: the process it polls ends there
//   event_msg mcp_tool_call_end {call_id, result}   an MCP call's outcome: `result.Err`, or `result.Ok.isError` (protocol.rs:3047, :3076); Legacy mode only
//   event_msg patch_apply_end {call_id, success, stderr, status}   an apply_patch call's outcome (Legacy mode only); a declined one settles nothing, and a
//                       patch with no end event stays unsettled (a rejected patch is only a `RespondToModel` output, tools/handlers/apply_patch.rs)
//   event_msg exec_command_end                  never persisted at ac558e2 (policy.rs:165) nor at rust-v0.46.0; read only if a rollout carries one
// Older shapes: the JSON `{output, metadata.exit_code}` wrapper of a shell output (rust-v0.46.0 core/src/tools/mod.rs:186-210).
// What Codex has no equivalent of (cost, a message id) stays at the value capture gives an absent field.

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { zstdDecompressSync } from 'node:zlib';

/** The Codex home for an environment; a test passes its own so it never reads the real one. */
export const codexRoot = (env: { [name: string]: string | undefined }, home: string = homedir()): string => {
  const set = env.CODEX_HOME;
  return set === undefined || set === '' ? join(home, '.codex') : set;
};

type Obj = { [key: string]: unknown };
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const parse = (text: unknown): unknown => {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A rollout file found in the store, before its lines are read. */
export interface CodexSession {
  /** The thread uuid in the file name (Codex's own session id), else the file's stem. */
  id: string;
  /** `session_meta.cwd`; null when the first line names none. */
  folder: string | null;
  /** `session_meta.parent_thread_id`: set for a spawned agent's rollout, which is deposited as a subagent of that thread. */
  parent: string | null;
  /** `session_meta.agent_role` (protocol.rs:3486), when the spawned agent has one. */
  agentRole: string | null;
  /** `session_meta.forked_from_id`: the thread whose history a fork copied, to match its copied records against. */
  forkedFrom: string | null;
  file: string;
  size: number;
  mtimeMs: number;
}

export interface CodexStore {
  sessions: CodexSession[];
  /** The session as transcript text for `captureSession`; throws when the file cannot be read. */
  transcript: (session: CodexSession) => Promise<string>;
  /** Files skipped because their id is not a safe file name (it names a skeleton), counted so the skip is never silent. */
  rejected: number;
  /** Files that could not be inspected, reported once each and never fatal; the reason names no path, so a log line built from it leaks none. */
  unreadable: { file: string; reason: string }[];
}

/** A rollout file name is `rollout-<timestamp>-<uuid>.jsonl`, optionally `.zst`; the uuid is the thread id. */
const ROLLOUT = /^rollout-.+\.jsonl(\.zst)?$/;
const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/i;
const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;

const idOf = (name: string): string => UUID_TAIL.exec(name)?.[1]?.toLowerCase() ?? name.replace(/^rollout-/, '').replace(/\.jsonl(\.zst)?$/, '');

const textOf = async (file: string): Promise<string> => {
  const bytes = await readFile(file);
  return (file.endsWith('.zst') ? zstdDecompressSync(bytes) : bytes).toString('utf8');
};

/** The first line of a plain file read without loading the rest; a compressed file is decompressed whole. */
const firstLine = async (file: string): Promise<string> => {
  if (file.endsWith('.zst')) return ((await textOf(file)).split('\n')[0] ?? '');
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) return line;
    return '';
  } finally {
    lines.close();
    stream.destroy();
  }
};

/** Lists rollout files under `dir`; only a missing folder is silent, any other failure (EACCES, ENOTDIR) is reported against `dir`. */
const reasonOf = (error: unknown, file: string): string => (error instanceof Error ? error.message : String(error)).split(file).join(basename(file));

const walk = async (dir: string, found: string[], unreadable: { file: string; reason: string }[]): Promise<void> => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) unreadable.push({ file: dir, reason: reasonOf(error, dir) });
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) await walk(join(dir, entry.name), found, unreadable);
    else if (entry.isFile() && ROLLOUT.test(entry.name)) found.push(join(dir, entry.name));
  }
};

const iso = (value: unknown): string | undefined => {
  const text = str(value);
  // An absolute time only: a missing or relative one (not a date after 2000) says nothing about when.
  return text !== undefined && Date.parse(text) >= Date.parse('2000-01-01T00:00:00Z') ? text : undefined;
};

/** The tool vocabulary prompt classes and `files` are computed in; a Codex name with no counterpart keeps its own. */
const SHELL_CALLS = new Set(['shell', 'shell_command', 'exec_command', 'local_shell', 'container.exec', 'write_stdin']);
const PATCH_CALLS = new Set(['apply_patch']);

const commandOf = (args: Obj): string | undefined => {
  const command = args.command ?? args.cmd;
  if (Array.isArray(command)) return command.filter((part): part is string => typeof part === 'string').join(' ');
  return str(command);
};

/** The paths an `apply_patch` input touches (`*** Add|Update|Delete File: <path>`, the grammar of codex-rs/apply-patch). */
const patchFiles = (input: string): string[] => [...input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => (match[1] ?? '').trim());

const EXIT_LINE = /^(?:Exit code: |Process exited with code )(-?\d+)\s*$/m;
const OUTPUT_MARK = /(?:^|\n)Output:\n?/;
const RUNNING_LINE = /^Process running with session ID (\S+)\s*$/m;
/** core/src/tools/events.rs:438: the message of a call that failed before it produced an exit code. */
const SPAWN_ERROR = /^execution error: /;

/** The text of a `function_call_output` body: a bare string, or an array of `{type: input_text, text}` items (protocol/src/models.rs:2376). */
const bodyText = (raw: unknown): string => {
  if (!Array.isArray(raw)) return str(raw) ?? '';
  return raw.map((item) => (isObj(item) ? (str(item.text) ?? '') : '')).filter((text) => text !== '').join('\n');
};

/**
 * What a shell output says: the real exit code and the text after the `Output:` line, which is what an error line is cut from. The two header
 * forms are core/src/tools/mod.rs:107-113 (`Exit code: N`) and core/src/tools/context.rs:556 (`Process exited with code N`); no code and no
 * `Process running with session ID N` line means the call failed to spawn (`execution error: ...`, events.rs:438) or was declined (`... rejected by user`, :456). An older Codex wrote JSON `{output, metadata.exit_code}` (rust-v0.46.0 core/src/tools/mod.rs:186-210).
 */
const outcomeOf = (raw: unknown): { text: string; exit: number | undefined; spawnError: boolean; running: string | undefined } => {
  const body = bodyText(raw);
  const wrapped = parse(body);
  if (isObj(wrapped) && typeof wrapped.output === 'string') return { text: wrapped.output, exit: isObj(wrapped.metadata) ? num(wrapped.metadata.exit_code) : undefined, spawnError: false, running: undefined };
  const mark = OUTPUT_MARK.exec(body);
  if (mark === null) return { text: body, exit: undefined, spawnError: SPAWN_ERROR.test(body), running: undefined };
  const head = body.slice(0, mark.index);
  const code = EXIT_LINE.exec(head)?.[1];
  return { text: body.slice(mark.index + mark[0].length), exit: code === undefined ? undefined : Number(code), spawnError: false, running: RUNNING_LINE.exec(head)?.[1] };
};

const failureOf = (exit: number | undefined, text: string): string | undefined => (exit === undefined || exit === 0 ? undefined : `Exit code ${String(exit)}\n${text}`);

const usageOf = (info: unknown): Obj | undefined => {
  const last = isObj(info) && isObj(info.last_token_usage) ? info.last_token_usage : undefined;
  if (last === undefined) return undefined;
  const input = num(last.input_tokens) ?? 0;
  const cached = Math.min(num(last.cached_input_tokens) ?? 0, input);
  const output = num(last.output_tokens) ?? 0;
  // A zero total means Codex recorded none, so no usage is written rather than a measured zero.
  if (input === 0 && output === 0) return undefined;
  const reasoning = num(last.reasoning_output_tokens);
  const written = num(last.cache_write_input_tokens) ?? 0;
  // Codex counts cached and written tokens both inside `input_tokens` (input 100 = cached 40 + write 60, codex-api/src/sse/responses.rs:889-911); capture's
  // `input` excludes cache reads and creation, as the Claude Code path's does, so each token is counted once.
  return {
    input_tokens: Math.max(input - cached - written, 0),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
    output_tokens: output,
    ...(reasoning === undefined ? {} : { output_tokens_details: { thinking_tokens: reasoning } }),
  };
};

/** The non-blank lines of a rollout that are not JSON (a torn write), kept so `captureSession` counts them and the deposit line reports them. */
export const rolloutBadLines = (text: string): string[] => text.split('\n').filter((raw) => raw.trim() !== '' && parse(raw) === undefined);

/** One rollout as the lines `captureSession` reads. */
export const rolloutLines = (text: string, fallbackId: string, parentText?: string): Obj[] => {
  const nonblank = text.split('\n').filter((raw) => raw.trim() !== '');
  if (nonblank.length > 0 && !nonblank.some((raw) => isObj(parse(raw)))) throw new Error('no parseable line');
  const lines: Obj[] = [];
  const base: Obj = { sessionId: fallbackId };
  let at: string | undefined;
  let model: string | undefined;
  let sequence = 0;
  let response = 0;
  // The assistant lines since the last counted token_count share one response id; the first of them carries its usage.
  let open: Obj | undefined;
  let lastTotal: number | undefined;
  const calls = new Map<string, { kind: 'shell' | 'patch' | 'other'; ids: string[]; session?: string }>();
  // A unified-exec process still running, by its session id, to the exec_command that started it: the `write_stdin` that sees it exit settles both.
  const running = new Map<string, string>();
  // Records below this ordinal are inherited from a parent thread (a subagent's or a fork's), not the session's own. Only a Paginated rollout
  // holds ordinals (rollout/src/ordinal.rs:28, :37).
  let inherited: number | undefined;
  // Only the first session_meta is the rollout's own; later ones are copied from fork history (rollout/src/recorder.rs:1157-1158, :1173).
  let seenMeta = false;
  // A Legacy fork has no ordinals: the leading records equal to the parent's, in order, are its copied history. Null once it stops matching.
  let copied: { keys: string[]; at: number } | null = null;
  const resolved = new Set<string>();
  const stamp = (value: unknown): string => {
    const candidate = iso(value);
    if (candidate !== undefined && (at === undefined || Date.parse(candidate) >= Date.parse(at))) at = candidate;
    return at ?? new Date(0).toISOString();
  };
  const assistant = (content: Obj[], when: string): void => {
    sequence += 1;
    const message: Obj = { role: 'assistant', content };
    // The id is set here, not when a token_count closes the response: a line no token_count follows (an aborted turn, a local model) still has one.
    const requestId = `${String(base.sessionId)}-resp${String(response + 1)}`;
    const line: Obj = { ...base, type: 'assistant', uuid: `${fallbackId}-a${String(sequence)}`, requestId, timestamp: when, ...(model === undefined ? {} : { requestedModel: model }), message };
    lines.push(line);
    open ??= line;
  };
  const result = (id: string, failure: string | undefined, when: string): void => {
    sequence += 1;
    lines.push({
      ...base,
      type: 'user',
      uuid: `${fallbackId}-r${String(sequence)}`,
      timestamp: when,
      // Codex stamps a result with its own time, but the call's start is not paired to it, so no duration is claimed.
      noDuration: true,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: failure !== undefined, content: failure ?? '' }] },
    });
  };
  const prompted = (message: string, when: string): void => {
    sequence += 1;
    lines.push({ ...base, type: 'user', uuid: `${fallbackId}-u${String(sequence)}`, timestamp: when, message: { role: 'user', content: [{ type: 'text', text: message }] } });
  };
  const settlePatch = (id: string, failure: string | undefined, when: string): void => {
    const known = calls.get(id);
    if (known?.kind !== 'patch' || resolved.has(id)) return;
    resolved.add(id);
    for (const part of known.ids) result(part, failure, when);
  };
  const settleMcp = (id: string, failure: string | undefined, when: string): void => {
    if (calls.get(id)?.kind !== 'other' || resolved.has(id)) return;
    resolved.add(id);
    result(id, failure, when);
  };
  // The text of a TurnItem's content array: {type: text, text} items (items.rs:134 AgentMessageContent, user_input.rs:17 UserInput).
  const contentText = (content: unknown): string => (Array.isArray(content) ? content.map((part) => (isObj(part) && part.type === 'text' ? (str(part.text) ?? '') : '')).filter((part) => part !== '').join('\n') : '');
  // A completed TurnItem, the Paginated mode's replacement for the legacy events (policy.rs:164-176).
  const completed = (item: Obj, when: string): void => {
    const kind = str(item.type);
    const id = str(item.id);
    if (kind === 'UserMessage') {
      const message = contentText(item.content);
      if (message !== '') prompted(message, when);
    } else if (kind === 'AgentMessage') {
      const message = contentText(item.content);
      if (message !== '') assistant([{ type: 'text', text: message }], when);
    } else if (kind === 'FileChange' && id !== undefined && (item.status === 'completed' || item.status === 'failed')) {
      settlePatch(id, item.status === 'failed' ? (str(item.stderr) ?? 'patch failed') : undefined, when);
    } else if (kind === 'McpToolCall' && id !== undefined && (item.status === 'completed' || item.status === 'failed')) {
      const refused = isObj(item.result) && item.result.isError === true;
      const failed = item.status === 'failed' || refused;
      const text = isObj(item.error) ? (str(item.error.message) ?? '') : isObj(item.result) ? bodyText(item.result.content) : '';
      settleMcp(id, failed ? (text === '' ? 'mcp tool call failed' : text) : undefined, when);
    }
  };
  const parentKeys = (parent: string): string[] =>
    parent
      .split('\n')
      .map((raw) => parse(raw))
      .filter((parsed): parsed is Obj => isObj(parsed) && isObj(parsed.payload) && parsed.type !== 'session_meta')
      .map((parsed) => JSON.stringify([parsed.type, parsed.payload]));
  for (const raw of text.split('\n')) {
    const entry = parse(raw);
    if (!isObj(entry) || !isObj(entry.payload)) continue;
    const payload = entry.payload;
    const ordinal = num(entry.ordinal);
    if (inherited !== undefined && ordinal !== undefined && ordinal < inherited) continue;
    const type = str(entry.type);
    if (type !== 'session_meta' && copied !== null) {
      if (copied.keys[copied.at] === JSON.stringify([entry.type, payload])) {
        copied.at += 1;
        continue;
      }
      copied = null;
    }
    if (type === 'session_meta' && seenMeta) continue;
    const when = stamp(entry.timestamp);
    if (type === 'session_meta') {
      seenMeta = true;
      const id = str(payload.id);
      if (id !== undefined) base.sessionId = id;
      const cwd = str(payload.cwd);
      if (cwd !== undefined) base.cwd = cwd;
      const version = str(payload.cli_version);
      if (version !== undefined) base.version = version;
      stamp(payload.timestamp);
      inherited = Math.max(num(payload.subagent_history_start_ordinal) ?? 0, num(payload.forked_from_ordinal_exclusive) ?? 0) || undefined;
      if (inherited === undefined && parentText !== undefined && str(payload.forked_from_id) !== undefined) copied = { keys: parentKeys(parentText), at: 0 };
    } else if (type === 'turn_context') {
      model = str(payload.model) ?? model;
      const cwd = str(payload.cwd);
      if (cwd !== undefined) base.cwd = cwd;
    } else if (type === 'event_msg') {
      const kind = str(payload.type);
      if (kind === 'user_message') {
        const message = str(payload.message);
        if (message !== undefined) prompted(message, when);
      } else if (kind === 'item_completed') {
        if (isObj(payload.item)) completed(payload.item, when);
      } else if (kind === 'agent_message') {
        const message = str(payload.message);
        if (message !== undefined) assistant([{ type: 'text', text: message }], when);
      } else if (kind === 'token_count') {
        const info = isObj(payload.info) ? payload.info : undefined;
        const total = info !== undefined && isObj(info.total_token_usage) ? num(info.total_token_usage.total_tokens) : undefined;
        const usage = usageOf(info);
        // Codex repeats a token_count whose totals did not move; counting it twice would double the response.
        // A token_count with no assistant line before it (a reasoning-only response) has nothing to attach to, so its usage is not counted.
        if (usage !== undefined && (total === undefined || total !== lastTotal) && open !== undefined) {
          const first = open.message;
          if (isObj(first)) first.usage = usage;
          lastTotal = total;
          response += 1;
          open = undefined;
        }
      } else if (kind === 'exec_command_end') {
        const id = str(payload.call_id);
        const known = id === undefined ? undefined : calls.get(id);
        if (id !== undefined && known?.kind === 'shell' && !resolved.has(id) && payload.status !== 'declined') {
          resolved.add(id);
          const exit = num(payload.exit_code);
          const output = str(payload.aggregated_output) ?? '';
          // The struct requires exit_code; a missing one with status failed is still a failure.
          result(id, exit === undefined && payload.status === 'failed' ? `Exit code unknown\n${output}` : failureOf(exit, output), when);
        }
      } else if (kind === 'mcp_tool_call_end') {
        const id = str(payload.call_id);
        const outcome = isObj(payload.result) ? payload.result : {};
        const refused = isObj(outcome.Ok) && outcome.Ok.isError === true;
        const text = typeof outcome.Err === 'string' ? outcome.Err : isObj(outcome.Ok) ? bodyText(outcome.Ok.content) : '';
        if (id !== undefined) settleMcp(id, typeof outcome.Err === 'string' || refused ? (text === '' ? 'mcp tool call failed' : text) : undefined, when);
      } else if (kind === 'patch_apply_end') {
        const id = str(payload.call_id);
        if (id !== undefined && payload.status !== 'declined') settlePatch(id, payload.success === false ? (str(payload.stderr) ?? 'patch failed') : undefined, when);
      }
    } else if (type === 'response_item') {
      const kind = str(payload.type);
      if (kind === 'function_call' || kind === 'local_shell_call' || kind === 'custom_tool_call') {
        const id = str(payload.call_id) ?? str(payload.id);
        const bare = str(payload.name) ?? 'shell';
        // A namespaced function (models.rs:1154) is not its bare name: only an un-namespaced one is Codex's own shell or patch tool.
        const namespace = str(payload.namespace);
        const name = namespace === undefined || bare.startsWith(namespace) ? bare : `${namespace}__${bare}`;
        const args = kind === 'custom_tool_call' ? { input: str(payload.input) } : parse(payload.arguments);
        const input: Obj = isObj(args) ? args : {};
        const action = isObj(payload.action) ? payload.action : {};
        if (id === undefined) continue;
        if (kind === 'local_shell_call' || (namespace === undefined && SHELL_CALLS.has(name))) {
          const command = commandOf(kind === 'local_shell_call' ? action : input);
          const polled = name === 'write_stdin' ? (str(input.session_id) ?? (num(input.session_id) === undefined ? undefined : String(num(input.session_id)))) : undefined;
          calls.set(id, { kind: 'shell', ids: [id], ...(polled === undefined ? {} : { session: polled }) });
          assistant([{ type: 'tool_use', id, name: 'Bash', input: command === undefined ? {} : { command } }], when);
        } else if (namespace === undefined && PATCH_CALLS.has(name)) {
          const files = patchFiles(str(input.input) ?? str(input.patch) ?? '');
          const ids = (files.length === 0 ? [''] : files).map((_, index) => `${id}#${String(index)}`);
          calls.set(id, { kind: 'patch', ids });
          assistant(
            ids.map((part, index) => ({ type: 'tool_use', id: part, name: 'Edit', input: files[index] === undefined ? {} : { file_path: files[index] } })),
            when,
          );
        } else {
          calls.set(id, { kind: 'other', ids: [id] });
          const file = str(input.path) ?? str(input.file_path);
          const query = str(input.query);
          assistant([{ type: 'tool_use', id, name, input: { ...(file === undefined ? {} : { file_path: file }), ...(query === undefined ? {} : { query }) } }], when);
        }
      } else if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
        const id = str(payload.call_id);
        const known = id === undefined ? undefined : calls.get(id);
        if (id !== undefined && known !== undefined && !resolved.has(id)) {
          const out = outcomeOf(payload.output);
          if (known.kind === 'shell') {
            // A shell call settles on its exit code, or on a failure to spawn. A process still running stays unsettled and is remembered by its
            // session id, so the `write_stdin` that sees it exit settles it too. A declined call has neither, and stays unsettled.
            if (out.exit !== undefined || out.spawnError) {
              resolved.add(id);
              const failure = out.spawnError ? out.text : failureOf(out.exit, out.text);
              result(id, failure, when);
              const pending = known.session === undefined ? undefined : running.get(known.session);
              if (pending !== undefined && !resolved.has(pending)) {
                resolved.add(pending);
                result(pending, failure, when);
              }
            } else if (out.running !== undefined && known.session === undefined) running.set(out.running, id);
          } else if (known.kind === 'other') {
            // Another call's output carries no failure signal (an MCP call's comes from its mcp_tool_call_end), and a patch settles only from its
            // patch_apply_end, because a rejected patch comes back as plain output text (tools/handlers/apply_patch.rs).
            resolved.add(id);
            result(id, undefined, when);
          }
        }
      }
    }
  }
  return lines;
};

/** Opens the Codex store under `root`; undefined when it holds no `sessions` folder, so a machine without Codex is skipped silently. */
export const openCodexStore = async (root: string): Promise<CodexStore | undefined> => {
  const files: string[] = [];
  const unreadable: { file: string; reason: string }[] = [];
  await walk(join(root, 'sessions'), files, unreadable);
  await walk(join(root, 'archived_sessions'), files, unreadable);
  if (files.length === 0 && unreadable.length === 0) return undefined;
  const sessions = new Map<string, CodexSession>();
  let rejected = 0;
  for (const file of files) {
    const id = idOf(basename(file));
    if (!SAFE_ID.test(id)) {
      rejected += 1;
      continue;
    }
    // The active copy wins over an archived one of the same thread.
    if (sessions.has(id)) continue;
    try {
      const info = await stat(file);
      const meta = parse(await firstLine(file));
      const head = isObj(meta) && isObj(meta.payload) ? meta.payload : {};
      sessions.set(id, { id, folder: str(head.cwd) ?? null, parent: str(head.parent_thread_id)?.toLowerCase() ?? null, agentRole: str(head.agent_role) ?? null, forkedFrom: str(head.forked_from_id)?.toLowerCase() ?? null, file, size: info.size, mtimeMs: Math.floor(info.mtimeMs) });
    } catch (error) {
      unreadable.push({ file, reason: reasonOf(error, file) });
    }
  }
  const ordered = [...sessions.values()].sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
  return {
    sessions: ordered,
    rejected,
    unreadable,
    transcript: async (session) => {
      const text = await textOf(session.file);
      // A Legacy fork's copied history is found by matching it against the parent's rollout; a parent outside the store (or unreadable) leaves it whole.
      const parent = session.forkedFrom === null ? undefined : sessions.get(session.forkedFrom);
      const parentText = parent === undefined ? undefined : await textOf(parent.file).catch(() => undefined);
      const lines = [...rolloutLines(text, session.id, parentText).map((line) => JSON.stringify(line)), ...rolloutBadLines(text)];
      return lines.join('\n') + (lines.length === 0 ? '' : '\n');
    },
  };
};
