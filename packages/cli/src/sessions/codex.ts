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
//   session_meta        {id, cwd, cli_version, timestamp}: the working directory and the harness version
//   turn_context        {model, cwd}: the model, and the directory when it changes
//   event_msg user_message {message}            a prompt (the `response_item` user messages also hold injected context, so they are not read)
//   event_msg agent_message {message}           the assistant's text
//   event_msg token_count {info.last_token_usage}  one model response's usage, closing the lines since the last one
//   response_item function_call / local_shell_call / custom_tool_call   a tool call
//   event_msg exec_command_end {call_id, exit_code, aggregated_output, status}   a shell call's REAL exit code (protocol/src/protocol.rs)
//   event_msg patch_apply_end {call_id, success, stderr, changes}   an apply_patch call's outcome
//   response_item function_call_output {call_id, output}   the outcome of any other call
// What Codex has no equivalent of (subagents, cost, hooks, a message id) stays at the value capture gives an absent field.

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
  /** Files that could not be inspected (`<path>: <reason>`), reported once each and never fatal. */
  unreadable: string[];
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

const walk = async (dir: string, found: string[]): Promise<void> => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) await walk(join(dir, entry.name), found);
    else if (entry.isFile() && ROLLOUT.test(entry.name)) found.push(join(dir, entry.name));
  }
};

const iso = (value: unknown): string | undefined => {
  const text = str(value);
  // An absolute time only: a missing or relative one (not a date after 2000) says nothing about when.
  return text !== undefined && Date.parse(text) >= Date.parse('2000-01-01T00:00:00Z') ? text : undefined;
};

/** The tool vocabulary prompt classes and `files` are computed in; a Codex name with no counterpart keeps its own. */
const SHELL_CALLS = new Set(['shell', 'shell_command', 'exec_command', 'local_shell', 'container.exec']);
const PATCH_CALLS = new Set(['apply_patch']);

const commandOf = (args: Obj): string | undefined => {
  const command = args.command ?? args.cmd;
  if (Array.isArray(command)) return command.filter((part): part is string => typeof part === 'string').join(' ');
  return str(command);
};

/** The paths an `apply_patch` input touches (`*** Add|Update|Delete File: <path>`, the grammar of codex-rs/apply-patch). */
const patchFiles = (input: string): string[] => [...input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => (match[1] ?? '').trim());

/** The text of a `function_call_output`: Codex wraps shell output as JSON `{output, metadata}`; the inner text is what a signature joins on. */
const outputText = (raw: unknown): { text: string; exit: number | undefined; success: boolean | undefined } => {
  const value = isObj(raw) ? raw : parse(raw);
  if (isObj(value)) {
    const metadata = isObj(value.metadata) ? value.metadata : {};
    const inner = str(value.output) ?? str(value.content) ?? '';
    return { text: inner, exit: num(metadata.exit_code), success: typeof value.success === 'boolean' ? value.success : undefined };
  }
  return { text: str(raw) ?? '', exit: undefined, success: undefined };
};

const usageOf = (info: unknown): Obj | undefined => {
  const last = isObj(info) && isObj(info.last_token_usage) ? info.last_token_usage : undefined;
  if (last === undefined) return undefined;
  const input = num(last.input_tokens) ?? 0;
  const cached = Math.min(num(last.cached_input_tokens) ?? 0, input);
  const output = num(last.output_tokens) ?? 0;
  // A zero total means Codex recorded none, so no usage is written rather than a measured zero.
  if (input === 0 && output === 0) return undefined;
  const reasoning = num(last.reasoning_output_tokens);
  // Codex counts cached tokens inside `input_tokens`; capture's `input` excludes cache reads, as the Claude Code path's does.
  return {
    input_tokens: input - cached,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: num(last.cache_write_input_tokens) ?? 0,
    output_tokens: output,
    ...(reasoning === undefined ? {} : { output_tokens_details: { thinking_tokens: reasoning } }),
  };
};

/** One rollout as the lines `captureSession` reads. */
export const rolloutLines = (text: string, fallbackId: string): Obj[] => {
  const lines: Obj[] = [];
  const base: Obj = { sessionId: fallbackId };
  let at: string | undefined;
  let model: string | undefined;
  let sequence = 0;
  let response = 0;
  // The assistant lines since the last token_count share one response id; the first of them carries its usage.
  let open: Obj[] = [];
  let lastTotal: number | undefined;
  const calls = new Map<string, { kind: 'shell' | 'patch' | 'other'; ids: string[] }>();
  const resolved = new Set<string>();
  const stamp = (value: unknown): string => {
    const candidate = iso(value);
    if (candidate !== undefined && (at === undefined || Date.parse(candidate) >= Date.parse(at))) at = candidate;
    return at ?? new Date(0).toISOString();
  };
  const assistant = (content: Obj[], when: string): void => {
    sequence += 1;
    const message: Obj = { role: 'assistant', content };
    const line: Obj = { ...base, type: 'assistant', uuid: `${fallbackId}-a${String(sequence)}`, timestamp: when, ...(model === undefined ? {} : { requestedModel: model }), message };
    lines.push(line);
    open.push(line);
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
  for (const raw of text.split('\n')) {
    const entry = parse(raw);
    if (!isObj(entry) || !isObj(entry.payload)) continue;
    const payload = entry.payload;
    const when = stamp(entry.timestamp);
    const type = str(entry.type);
    if (type === 'session_meta') {
      const id = str(payload.id);
      if (id !== undefined) base.sessionId = id;
      const cwd = str(payload.cwd);
      if (cwd !== undefined) base.cwd = cwd;
      const version = str(payload.cli_version);
      if (version !== undefined) base.version = version;
      stamp(payload.timestamp);
    } else if (type === 'turn_context') {
      model = str(payload.model) ?? model;
      const cwd = str(payload.cwd);
      if (cwd !== undefined) base.cwd = cwd;
    } else if (type === 'event_msg') {
      const kind = str(payload.type);
      if (kind === 'user_message') {
        const message = str(payload.message);
        if (message !== undefined) {
          sequence += 1;
          lines.push({ ...base, type: 'user', uuid: `${fallbackId}-u${String(sequence)}`, timestamp: when, message: { role: 'user', content: [{ type: 'text', text: message }] } });
        }
      } else if (kind === 'agent_message') {
        const message = str(payload.message);
        if (message !== undefined) assistant([{ type: 'text', text: message }], when);
      } else if (kind === 'token_count') {
        const info = isObj(payload.info) ? payload.info : undefined;
        const total = info !== undefined && isObj(info.total_token_usage) ? num(info.total_token_usage.total_tokens) : undefined;
        const usage = usageOf(info);
        // Codex repeats a token_count whose totals did not move; counting it twice would double the response.
        if (usage !== undefined && (total === undefined || total !== lastTotal) && open[0] !== undefined) {
          const first = open[0].message;
          if (isObj(first)) first.usage = usage;
          lastTotal = total;
          response += 1;
          for (const line of open) line.requestId = `${String(base.sessionId)}-resp${String(response)}`;
          open = [];
        }
      } else if (kind === 'exec_command_end') {
        const id = str(payload.call_id);
        const known = id === undefined ? undefined : calls.get(id);
        if (id !== undefined && known?.kind === 'shell' && !resolved.has(id) && payload.status !== 'declined') {
          resolved.add(id);
          const exit = num(payload.exit_code);
          // The real exit code decides: `status` alone reads `completed` for a command that returned nonzero in some versions.
          result(id, exit === undefined || exit === 0 ? undefined : `Exit code ${String(exit)}\n${str(payload.aggregated_output) ?? ''}`, when);
        }
      } else if (kind === 'patch_apply_end') {
        const id = str(payload.call_id);
        const known = id === undefined ? undefined : calls.get(id);
        if (id !== undefined && known?.kind === 'patch' && !resolved.has(id)) {
          resolved.add(id);
          const failure = payload.success === false ? (str(payload.stderr) ?? 'patch failed') : undefined;
          for (const part of known.ids) result(part, failure, when);
        }
      }
    } else if (type === 'response_item') {
      const kind = str(payload.type);
      if (kind === 'function_call' || kind === 'local_shell_call' || kind === 'custom_tool_call') {
        const id = str(payload.call_id) ?? str(payload.id);
        const name = str(payload.name) ?? 'shell';
        const args = kind === 'custom_tool_call' ? { input: str(payload.input) } : parse(payload.arguments);
        const input: Obj = isObj(args) ? args : {};
        const action = isObj(payload.action) ? payload.action : {};
        if (id === undefined) continue;
        if (kind === 'local_shell_call' || SHELL_CALLS.has(name)) {
          const command = commandOf(kind === 'local_shell_call' ? action : input);
          calls.set(id, { kind: 'shell', ids: [id] });
          assistant([{ type: 'tool_use', id, name: 'Bash', input: command === undefined ? {} : { command } }], when);
        } else if (PATCH_CALLS.has(name)) {
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
          const out = outputText(payload.output);
          // A shell call is settled by its exec_command_end (the real exit code); the wrapper's metadata only stands in when that line is absent.
          const failed = out.success === false || (out.exit !== undefined && out.exit !== 0);
          if (known.kind !== 'shell' || out.exit !== undefined) {
            resolved.add(id);
            for (const part of known.ids) result(part, failed ? (out.exit === undefined ? out.text : `Exit code ${String(out.exit)}\n${out.text}`) || 'error' : undefined, when);
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
  await walk(join(root, 'sessions'), files);
  await walk(join(root, 'archived_sessions'), files);
  if (files.length === 0) return undefined;
  const sessions = new Map<string, CodexSession>();
  const unreadable: string[] = [];
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
      const folder = isObj(meta) && isObj(meta.payload) ? (str(meta.payload.cwd) ?? null) : null;
      sessions.set(id, { id, folder, file, size: info.size, mtimeMs: Math.floor(info.mtimeMs) });
    } catch (error) {
      unreadable.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const ordered = [...sessions.values()].sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
  return {
    sessions: ordered,
    rejected,
    unreadable,
    transcript: async (session) => {
      const lines = rolloutLines(await textOf(session.file), session.id);
      return lines.map((line) => JSON.stringify(line)).join('\n') + (lines.length === 0 ? '' : '\n');
    },
  };
};
