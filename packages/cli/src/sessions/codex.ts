// The OpenAI Codex CLI source (t749): a Codex session log becomes the same capture records a Claude Code transcript does.
//
// FIXTURE-DERIVED: written from the open-source Codex CLI (github.com/openai/codex, Apache-2.0, commit ac558e2a, 2026-11-03), not from a live
// store. Each field read below cites the file it comes from; `docs/sessions-store.md` says what a live run would still have to prove.
//
// Where it reads from (`codexRoot`): `$CODEX_HOME`, else `~/.codex` (`%USERPROFILE%\.codex` on Windows); the same on every OS
// (codex-rs/utils/home-dir/src/lib.rs:5-18). Inside it, `sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl` and `archived_sessions/` hold one
// file per session (a reverted thread's session spans several); Codex compresses an old one to `.jsonl.zst` and reads either (rollout/src/compression.rs), so this reader does too.
// A line is `{timestamp, type, payload}` (history/src/lib.rs `RolloutLine`, rollout_payload.rs). Like cursor.ts, the reader writes each session
// out as the transcript lines `captureSession` already reads, so redaction, the 1,000-character line cap, the salted file hashes, and the
// skeleton are the Claude Code path's own code:
//   session_meta        {id, cwd, cli_version, timestamp, history_mode, parent_thread_id, forked_from_id, subagent_history_start_ordinal}: the
//                       working directory and the harness version; only the first one in the file (recorder.rs:1157-1158). A spawned agent has `parent_thread_id` (protocol.rs:3464); records whose
//                       `ordinal` is below its `subagent_history_start_ordinal` (:3511-3516) are the parent's prefix (ordinal.rs:86-89), and are dropped. A Referenced fork copies none: its `history_base` points at the parent (:3508-3510; core/src/session/session.rs:1139-1140). A Copied fork, in either mode, does copy the parent's history and writes no `history_base`
//                       (`fork_thread_from_history` is `ForkPersistence::Copied`, core/src/thread_manager.rs:1680; session.rs:1139; app-server takes it when no prepared fork exists, app-server/src/request_processors/thread_processor.rs:5724-5728). Ordinals exist
//                       only in a Paginated rollout (ordinal.rs:37), the CLI's default (thread-store/src/local/mod.rs:512-515), which holds item_completed TurnItems
//                       (UserMessage, AgentMessage, FileChange, McpToolCall) in place of the legacy events below (rollout/src/policy.rs:142-156, `persisted_item_completed_event` :232, its Paginated arm :253); both are read.
//                       A Copied fork's history, in either mode, is dropped by matching the parent's lineage as of the fork's start, record for record
//   turn_context        {model, cwd}: the model, and the directory when it changes
//   event_msg user_message {message}            a prompt (the `response_item` user messages also hold injected context, so they are not read)
//   event_msg agent_message {message}           the assistant's text
//   event_msg token_count {info.last_token_usage}  one model response's usage, closing the lines since the last one
//   response_item function_call / local_shell_call / custom_tool_call   a tool call
//   response_item function_call_output {call_id, output}   a shell call's outcome: the text `Exit code: N` / `Process exited with code N` then `Output:`
//                       (the unified-exec emitter's own text, core/src/tools/events.rs:400, :416, :423; context.rs:556), the real exit code; `execution error: ...` (core/src/tools/events.rs:438) is a
//                       call that failed to spawn. `write_stdin` (handlers/shell_spec.rs:113) is a shell call too: the process it polls ends only where the
//                       poll reports its exit code; a poll that failed (`write_stdin failed: ...`, write_stdin.rs:123) is its own error and settles nothing else
//   event_msg item_completed CommandExecution {id, exit_code, status, aggregated_output}   Paginated mode only (policy.rs:253 arm, kept by `_ =>` :284; Legacy
//                       keeps none, :238-251). `id` is the exec_command's call id (events.rs:571), written when the process exits (events.rs:561-590):
//                       by the exit watcher for a process the model never polled (unified_exec/async_watcher.rs:158, :224), or by the call itself when it exits in
//                       its first yield (process_manager.rs:827). It settles a known unresolved shell call from the real `exit_code` and the output; a
//                       `declined` one (exit code -1, events.rs:552-554) settles nothing. A `failed` one with exit code -1 is a failure with no exit status (a tool
//                       failure message, events.rs:538-542; a process with none, async_watcher.rs:213, :409), so its text is the error line. So a backgrounded process keeps its failure and its commit sha
//                       even with no `write_stdin` poll; only a Legacy rollout leaves it unsettled until a poll, and there the poll settles it
//   event_msg mcp_tool_call_end {call_id, result}   an MCP call's outcome: `result.Err`, or `result.Ok.isError` (protocol.rs:3047, :3076); Legacy mode only
//   event_msg patch_apply_end {call_id, success, stderr, status}   an apply_patch call's outcome (Legacy mode only); a declined one settles nothing, and a
//                       patch with no end event stays unsettled (a rejected patch is only a `RespondToModel` output, tools/handlers/apply_patch.rs)
//   event_msg exec_command_end                  never persisted at ac558e2 (policy.rs:165) nor at rust-v0.46.0, so it is not read: the CommandExecution item and the call's output are the two sources
// Older shapes: the JSON `{output, metadata.exit_code}` wrapper of a shell output (rust-v0.46.0 core/src/tools/mod.rs:186-210).
// What Codex has no equivalent of (cost) stays at the value capture gives an absent field; message ids and duration are persisted and not read.

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough, pipeline } from 'node:stream';
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';

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
  /** The rollout's key: the thread uuid in the file name (Codex's own session id), `<thread>_<rollout>` for a reverted thread's file when the thread itself is not in the store (else its file is folded into the thread's, `revisions`), else the file's stem. */
  id: string;
  /** `session_meta.cwd`; null when the first line names none. */
  folder: string | null;
  /** `session_meta.parent_thread_id`: set for a spawned agent's rollout, which is deposited as a subagent of that thread. */
  parent: string | null;
  /** `session_meta.agent_role` (protocol.rs:3486), when the spawned agent has one. */
  agentRole: string | null;
  /** `session_meta.forked_from_id`: the thread whose history a fork copied, to match its copied records against. */
  forkedFrom: string | null;
  /**
   * The rollouts of the thread's reverts, folded into this one (thread-store/src/local/revert_thread.rs:15-18): each starts at `from`, the ordinal it
   * takes from `history_base.end_ordinal_exclusive`, and supersedes the records at or after it in every earlier file. Empty for a thread never reverted.
   */
  revisions: { file: string; from: number; at: number }[];
  /** `session_meta.timestamp` in milliseconds (a fresh `started_at` for each new rollout, rollout/src/recorder.rs:953-966); 0 when absent. A fork is matched against the lineage as of this time. */
  started: number;
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

/**
 * A rollout file name is `rollout-<timestamp>-<thread>.jsonl`, optionally `.zst`; a reverted thread's is `rollout-<timestamp>-<thread>_<rollout>.jsonl`
 * (rollout/src/rollout_file_name.rs:12-14, parsed at :41-47, rendered at :66-73).
 */
const ROLLOUT = /^rollout-.+\.jsonl(\.zst)?$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROLLOUT_NAME = new RegExp(String.raw`^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(${UUID})(?:_(${UUID}))?\.jsonl(?:\.zst)?$`, 'i');
const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;

/** The key a rollout is deposited under, and the thread it belongs to when it is a reverted copy of one (folded into that thread's lineage when the thread is in the store). */
const idOf = (name: string): { id: string; thread: string | null } => {
  const match = ROLLOUT_NAME.exec(name);
  const thread = match?.[1]?.toLowerCase();
  const reverted = match?.[2]?.toLowerCase();
  if (thread === undefined) return { id: name.replace(/^rollout-/, '').replace(/\.jsonl(\.zst)?$/, ''), thread: null };
  return reverted === undefined || reverted === thread ? { id: thread, thread: null } : { id: `${thread}_${reverted}`, thread };
};

const textOf = async (file: string): Promise<string> => {
  const bytes = await readFile(file);
  return (file.endsWith('.zst') ? zstdDecompressSync(bytes) : bytes).toString('utf8');
};

/** The first line of a rollout, read without loading the rest: a compressed file is decompressed as a stream and the read stops at the line, so the cost does not grow with the file. */
const firstLine = async (file: string): Promise<string> => {
  const source = createReadStream(file);
  const stream = new PassThrough({ encoding: 'utf8' });
  // pipeline hands a failure in either stage (a missing file, a corrupt frame) to `stream`, and the early destroy below ends it with a premature close nobody awaits.
  if (file.endsWith('.zst')) pipeline(source, createZstdDecompress(), stream, () => undefined);
  else pipeline(source, stream, () => undefined);
  const failed = new Promise<never>((_, reject) => stream.once('error', reject));
  failed.catch(() => undefined);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const first = async (): Promise<string> => {
    for await (const line of lines) return line;
    return '';
  };
  try {
    return await Promise.race([first(), failed]);
  } finally {
    lines.close();
    stream.destroy();
  }
};

/** An error's message with `file` cut to its base name, so a reason that is logged names no folder. */
const reasonOf = (error: unknown, file: string): string => (error instanceof Error ? error.message : String(error)).split(file).join(basename(file));

/** Lists rollout files under `dir`; only a missing folder is silent, any other failure (EACCES, ENOTDIR) is reported against `dir`. */
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
/** The namespace upstream fills in for a top-level function (codex-rs/protocol/src/tool_name.rs:6-7); with none and an empty one, it is the plain tool (:46-50). */
const DEFAULT_FUNCTION_NAMESPACE = 'functions';

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
/**
 * The message of a call that failed before it produced an exit code, written as the whole output (no `Output:` header): `execution error: ` for a
 * shell call (core/src/tools/events.rs:438), and for the default unified-exec tool (ConfigShellToolType is only `UnifiedExec | Disabled`,
 * protocol/src/openai_models.rs:330-333) `exec_command failed: ` (core/src/tools/handlers/unified_exec/exec_command.rs:270), `write_stdin failed: `
 * (write_stdin.rs:123), and `write_stdin approval failed: ` (:121). `write_stdin rejected: ` (:118) is a declined call and stays unsettled.
 */
const SPAWN_ERROR = /^(?:execution error|exec_command failed|write_stdin(?: approval)? failed): /;

/** The text of a `function_call_output` body: a bare string, or an array of `{type: input_text, text}` items (protocol/src/models.rs:2376). */
const bodyText = (raw: unknown): string => {
  if (!Array.isArray(raw)) return str(raw) ?? '';
  return raw.map((item) => (isObj(item) ? (str(item.text) ?? '') : '')).filter((text) => text !== '').join('\n');
};

/**
 * What a shell output says: the real exit code and the text after the `Output:` line, which is what an error line is cut from. The two header
 * forms are the unified-exec emitter's own `Exit code: N` (core/src/tools/events.rs:400, :416, :423; `shell` and `shell_command` are older names for it) and
 * core/src/tools/context.rs:556 (`Process exited with code N`); no code and no `Process running with session ID N` line means the call failed before it
 * ran (`SPAWN_ERROR` above), was declined (`... rejected by user`, events.rs:456), or is a process with no exit status, whose reply header gets neither line
 * (`None` writes none, context.rs:555-557; its -1 goes to the item only, process_manager.rs:823, :839). An older Codex wrote JSON `{output, metadata.exit_code}` (rust-v0.46.0 core/src/tools/mod.rs:186-210).
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

/**
 * A failed call's error text. A negative code is no exit status: upstream writes -1 for a tool failure message (core/src/tools/events.rs:538-542) and for a
 * process with none (unified_exec/async_watcher.rs:213, :409; process_manager.rs:823), and capture's `Exit code (\d+)` (extract.ts, `EXIT_RE`) cannot read it, so
 * an `Exit code -1` line would be the error line and the message lost. The message stands alone then, and a code is the line capture skips.
 */
const failureOf = (exit: number | undefined, text: string): string | undefined =>
  exit === undefined || exit === 0 ? undefined : exit < 0 && text.trim() !== '' ? text : `Exit code ${String(exit)}\n${text}`;

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
  // A unified-exec process still running, by its session id, to the exec_command that started it: in a Legacy rollout the `write_stdin` that sees it exit settles both.
  const running = new Map<string, string>();
  // Records below this ordinal are the parent prefix a subagent's rollout copied (ordinal.rs:86-89), not the session's own. Only a Paginated rollout
  // holds ordinals (rollout/src/ordinal.rs:29-30, :37).
  let inherited: number | undefined;
  // Only the first session_meta is the rollout's own; later ones are copied from fork history (rollout/src/recorder.rs:1157-1158, :1173).
  let seenMeta = false;
  // A Paginated rollout holds the exit watcher's item, which carries the whole output, so there a poll that sees the exit settles only itself.
  let paginated = false;
  // A Copied fork's file holds the parent's records first (no ordinal marks them: a Paginated one numbers them afresh from 0, ordinal.rs:28-33, and a Legacy
  // one has none), so the leading records equal to the parent's, in order, are its copied history, in either mode. Null once it stops matching.
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
  // A failure is the error text; a success carries the call's own output when it has one, which capture reads transiently, as on the Claude Code
  // path: a shell call's `[branch sha]` line is how a commit's sha is found. The output follows an `Exit code 0` line, the shape a Claude Code Bash
  // result has (fixtures/proj/errors-a.jsonl:15): capture marks a result whose text starts `Exit code <nonzero>` as failed (`isErrorResult` in extract.ts), and a
  // call that exited 0 may print such a line (`cat ci.log`). The commit patterns read every line (`COMMIT_LINE` and `HASH_LINE` in extract.ts, both `gm`), so the sha is still found.
  const result = (id: string, failure: string | undefined, when: string, output = ''): void => {
    sequence += 1;
    lines.push({
      ...base,
      type: 'user',
      uuid: `${fallbackId}-r${String(sequence)}`,
      timestamp: when,
      // Codex stamps a result with its own time, but the call's start is not paired to it, so no duration is claimed.
      noDuration: true,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: failure !== undefined, content: failure ?? (output === '' ? '' : `Exit code 0\n${output}`) }] },
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
  // A shell call settles on its exit code, or on a failure to spawn, whether that comes from its own output or from a CommandExecution item. A
  // process still running was remembered by its session id, so in a Legacy rollout the `write_stdin` that polled it and read its exit
  // code settles both calls (in a Paginated one an item settles only its own exec_command). A poll that failed instead (`write_stdin failed: ...`, `exited` false) says nothing about the process: a
  // non-empty write to one with no tty is `StdinClosed` (unified_exec/process_manager.rs:1021-1026) and it runs on, so only the poll is the error.
  const settleShell = (id: string, failure: string | undefined, output: string, when: string, exited = true): void => {
    const known = calls.get(id);
    if (known?.kind !== 'shell' || resolved.has(id)) return;
    resolved.add(id);
    result(id, failure, when, output);
    const pending = known.session === undefined ? undefined : running.get(known.session);
    if (exited && !paginated && pending !== undefined && !resolved.has(pending)) {
      resolved.add(pending);
      result(pending, failure, when, output);
    }
  };
  // The text of a TurnItem's content array. Each variant tags its own parts: a UserMessage's `UserInput` is snake_case, `text` (user_input.rs:16), but an
  // AgentMessage's `AgentMessageContent` has no rename_all, so it is `Text` (items.rs:131-135).
  const contentText = (content: unknown, tag: string): string => (Array.isArray(content) ? content.map((part) => (isObj(part) && part.type === tag ? (str(part.text) ?? '') : '')).filter((part) => part !== '').join('\n') : '');
  // A completed TurnItem, the Paginated mode's replacement for the legacy events (policy.rs:142-156).
  const completed = (item: Obj, when: string): void => {
    const kind = str(item.type);
    const id = str(item.id);
    if (kind === 'UserMessage') {
      const message = contentText(item.content, 'text');
      if (message !== '') prompted(message, when);
    } else if (kind === 'AgentMessage') {
      const message = contentText(item.content, 'Text');
      if (message !== '') assistant([{ type: 'text', text: message }], when);
    } else if (kind === 'FileChange' && id !== undefined && (item.status === 'completed' || item.status === 'failed')) {
      settlePatch(id, item.status === 'failed' ? (str(item.stderr) ?? 'patch failed') : undefined, when);
    } else if (kind === 'CommandExecution' && id !== undefined && (item.status === 'completed' || item.status === 'failed')) {
      // The exec_command's own item: `id` is its call id, written when the process exits, even one the model never polled (header). It carries the
      // real exit code and the output. A `declined` one has exit code -1 and no outcome, so it stays unsettled, as a declined output does.
      const exit = num(item.exit_code);
      const output = str(item.aggregated_output) ?? '';
      if (exit !== undefined) settleShell(id, failureOf(exit, output), output, when);
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
      inherited = num(payload.subagent_history_start_ordinal);
      paginated = payload.history_mode === 'paginated';
      if (inherited === undefined && parentText !== undefined && str(payload.forked_from_id) !== undefined && !isObj(payload.history_base)) copied = { keys: parentKeys(parentText), at: 0 };
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
      if (kind === 'web_search_call') {
        // A search is its own response item (protocol/src/models.rs:1270; persisted, rollout/src/policy.rs:94), with no call_id and no output item: the item
        // is the finished call (`response.output_item.done`, models.rs:1262-1269), so it carries no failure signal and is recorded ok, as another non-shell call is.
        // Only a `search` action has a query (`query`, else the first of `queries`; models.rs:2125-2132); `open_page` and `find_in_page` carry a url (:2134-2145).
        const action = isObj(payload.action) ? payload.action : {};
        const first = Array.isArray(action.queries) ? str(action.queries[0]) : undefined;
        const query = action.type === 'search' ? (str(action.query) ?? first) : undefined;
        const id = str(payload.id) ?? `${fallbackId}-ws${String(sequence + 1)}`;
        assistant([{ type: 'tool_use', id, name: 'WebSearch', native: 'web_search', input: query === undefined ? {} : { query } }], when);
        result(id, undefined, when);
      } else if (kind === 'function_call' || kind === 'local_shell_call' || kind === 'custom_tool_call') {
        const id = str(payload.call_id) ?? str(payload.id);
        const bare = str(payload.name) ?? 'shell';
        // A namespaced function (models.rs:1154) is not its bare name: only a plain one is Codex's own shell or patch tool. The router makes every
        // function_call's ToolName with the default namespace filled in (core/src/tools/router.rs:285), and none, an empty string, and `functions`
        // all flatten to the bare name (protocol/src/tool_name.rs:46-50; core/src/tools/mod.rs:51-53), so `functions` is no namespace here.
        const declared = str(payload.namespace);
        const namespace = declared === DEFAULT_FUNCTION_NAMESPACE ? undefined : declared;
        // Upstream flattens any other namespace to namespace + name with no delimiter (core/src/tools/mod.rs:55-60; codex-mcp/src/tools.rs:296), and
        // an MCP namespace carries its own trailing `__` (tools.rs:253), so that form joins a Claude Code MCP name as written. The `__` added to a
        // namespace without one is this reader's own choice (models.rs:3485-3486: `collaboration` + `spawn_agent`), not upstream's flat name.
        const joiner = namespace?.endsWith('__') === true ? '' : '__';
        const name = namespace === undefined || bare.startsWith(namespace) ? bare : `${namespace}${joiner}${bare}`;
        const args = kind === 'custom_tool_call' ? { input: str(payload.input) } : parse(payload.arguments);
        const input: Obj = isObj(args) ? args : {};
        const action = isObj(payload.action) ? payload.action : {};
        if (id === undefined) continue;
        if (kind === 'local_shell_call' || (namespace === undefined && SHELL_CALLS.has(name))) {
          const command = commandOf(kind === 'local_shell_call' ? action : input);
          const polled = name === 'write_stdin' ? (str(input.session_id) ?? (num(input.session_id) === undefined ? undefined : String(num(input.session_id)))) : undefined;
          calls.set(id, { kind: 'shell', ids: [id], ...(polled === undefined ? {} : { session: polled }) });
          // `native` keeps Codex's own name for the action table (the contract at extract.ts, as cursor.ts does); a `local_shell_call` has no name field.
          assistant([{ type: 'tool_use', id, name: 'Bash', native: kind === 'local_shell_call' ? 'local_shell' : name, input: command === undefined ? {} : { command } }], when);
        } else if (namespace === undefined && PATCH_CALLS.has(name)) {
          const files = patchFiles(str(input.input) ?? str(input.patch) ?? '');
          const ids = (files.length === 0 ? [''] : files).map((_, index) => `${id}#${String(index)}`);
          calls.set(id, { kind: 'patch', ids });
          assistant(
            ids.map((part, index) => ({ type: 'tool_use', id: part, name: 'Edit', native: name, input: files[index] === undefined ? {} : { file_path: files[index] } })),
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
            // session id, so in a Legacy rollout the `write_stdin` that sees it exit settles it too. A declined call has neither, and stays unsettled.
            if (out.exit !== undefined || out.spawnError) settleShell(id, out.spawnError ? out.text : failureOf(out.exit, out.text), out.text, when, out.exit !== undefined);
            else if (out.running !== undefined && known.session === undefined) running.set(out.running, id);
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

/**
 * The thread a rollout is deposited under, or null for a main session. A spawned agent's `session_meta` names `parent_thread_id` (protocol.rs:3463-3464); a
 * delegate Codex starts for itself, such as a review, gets its parent's thread id there too (core/src/codex_delegate.rs:138, through core/src/session/session.rs:1126
 * and thread-store/src/local/create_thread.rs:35 into rollout/src/recorder.rs:965). Yet `SubAgentSource::parent_thread_id` is Some for ThreadSpawn only
 * (protocol.rs:3376-3386), so the rollout's `source` decides when it is absent: upstream's `is_non_root_agent` is `Internal(_) | SubAgent(_)` (:3280-3285), and
 * `SessionMeta.source` (:3477) serializes lowercase and externally tagged (:3141-3144, :3223-3226), so `{subagent: ...}` or `{internal: ...}`. Such a rollout belongs
 * to `session_id`, "equal to the root thread's ID" (:3451-3452), or else names itself. A reverted file's parent is its own thread.
 */
const parentOf = (head: Obj, id: string, thread: string | null): string | null => {
  const parent = str(head.parent_thread_id)?.toLowerCase() ?? thread;
  if (parent !== null) return parent;
  const source = head.source;
  const nonRoot = isObj(source) && (Object.hasOwn(source, 'subagent') || Object.hasOwn(source, 'internal'));
  return nonRoot ? (str(head.session_id)?.toLowerCase() ?? id) : null;
};

/**
 * A thread's records as one text: its own file, then each revert's file in the order they were written. A later file supersedes the records at or after
 * its `from` ordinal in every earlier one (the prefix a revert retains is below it), so the turns a revert dropped are not read. A record with no
 * ordinal (a line that is not a Paginated record) is kept, and so is a line that is not JSON, which `captureSession` counts. Only the reverts written at
 * or before `before` count: a fork copied the lineage as it stood when it started, so a revert written later has not dropped anything from its copy.
 */
const lineageText = async (session: CodexSession, before = Infinity): Promise<string> => {
  const read = (file: string): Promise<string> =>
    textOf(file).catch((error: unknown) => {
      throw new Error(reasonOf(error, file));
    });
  const revisions = session.revisions.filter((revision) => revision.at <= before).sort((a, b) => a.at - b.at);
  if (revisions.length === 0) return read(session.file);
  const parts = [{ file: session.file, from: Infinity }, ...revisions];
  const texts: string[] = [];
  for (const [index, part] of parts.entries()) {
    const cut = Math.min(...parts.slice(index + 1).map((later) => later.from), Infinity);
    const kept = (await read(part.file)).split('\n').filter((raw) => {
      const entry = parse(raw);
      const ordinal = isObj(entry) ? num(entry.ordinal) : undefined;
      return ordinal === undefined || ordinal < cut;
    });
    texts.push(kept.join('\n'));
  }
  return texts.join('\n');
};

/** Opens the Codex store under `root`; undefined when it holds no `sessions` folder, so a machine without Codex is skipped silently. */
export const openCodexStore = async (root: string): Promise<CodexStore | undefined> => {
  const files: string[] = [];
  const unreadable: { file: string; reason: string }[] = [];
  await walk(join(root, 'sessions'), files, unreadable);
  await walk(join(root, 'archived_sessions'), files, unreadable);
  if (files.length === 0 && unreadable.length === 0) return undefined;
  const sessions = new Map<string, CodexSession>();
  const reverts = new Map<string, { thread: string; from: number; at: number }>();
  let rejected = 0;
  for (const file of files) {
    const { id, thread } = idOf(basename(file));
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
      const base = isObj(head.history_base) ? head.history_base : {};
      const started = Date.parse(str(head.timestamp) ?? '') || 0;
      if (thread !== null && isObj(meta)) reverts.set(id, { thread, from: num(base.end_ordinal_exclusive) ?? 0, at: started });
      sessions.set(id, { id, folder: str(head.cwd) ?? null, parent: parentOf(head, id, thread), agentRole: str(head.agent_role) ?? null, forkedFrom: str(head.forked_from_id)?.toLowerCase() ?? null, revisions: [], started, file, size: info.size, mtimeMs: Math.floor(info.mtimeMs) });
    } catch (error) {
      unreadable.push({ file, reason: reasonOf(error, file) });
    }
  }
  // A reverted thread is one lineage: the new file holds only the records written after the revert, so it is folded into the thread's own session, whose
  // retained prefix and these records read as one. A reverted file whose thread is not in the store stays a session of its own, a subagent of that thread.
  for (const [id, revert] of reverts) {
    const origin = sessions.get(revert.thread);
    const own = sessions.get(id);
    if (origin === undefined || own === undefined) continue;
    origin.revisions.push({ file: own.file, from: revert.from, at: revert.at });
    origin.size += own.size;
    origin.mtimeMs = Math.max(origin.mtimeMs, own.mtimeMs);
    sessions.delete(id);
  }
  const ordered = [...sessions.values()].sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
  return {
    sessions: ordered,
    rejected,
    unreadable,
    transcript: async (session) => {
      // A rollout that vanished after it was listed (Codex compresses an old one) fails with its reason, which names no path.
      const text = await lineageText(session);
      // A Copied fork's history is found by matching it against the parent's lineage as of the fork's start; a parent outside the store (or unreadable) leaves it whole.
      const parent = session.forkedFrom === null ? undefined : sessions.get(session.forkedFrom);
      const parentText = parent === undefined ? undefined : await lineageText(parent, session.started).catch(() => undefined);
      const lines = [...rolloutLines(text, session.id, parentText).map((line) => JSON.stringify(line)), ...rolloutBadLines(text)];
      return lines.join('\n') + (lines.length === 0 ? '' : '\n');
    },
  };
};
