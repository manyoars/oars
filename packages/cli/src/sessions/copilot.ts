// The GitHub Copilot CLI source (t802): a Copilot CLI session log becomes the same capture records a Claude Code transcript does.
//
// FIXTURE-DERIVED: written from the public SDK's generated event types (github.com/github/copilot-sdk @ d28a136, MIT,
// nodejs/src/generated/session-events.ts, "generated from session-events.schema.json") and its docs, not from a live store. Nothing was copied; the
// reader is original. The CLI itself (github/copilot-cli) is closed source, so the schema is the only statement of the file's shape, and no vendor
// text promises the on-disk format. `docs/sessions-store.md` says what a live run would still have to prove.
//
// Where it reads from (`copilotRoot`): `$COPILOT_HOME`, else `~/.copilot` (`%USERPROFILE%\.copilot` on Windows). Inside it,
// `session-state/<sessionId>/events.jsonl` is one session (docs/features/session-persistence.md, "What gets persisted"; the changelog's 0.0.342 entry
// moved new sessions there). The older `history-session-state` is migrated by the CLI on resume and is not read. A rotated archive `events.N.jsonl`
// is not read either: the head file holds checkpoint events that rebuild the session (the same document, "Linked event journals").
// A line is `{id, parentId, timestamp, type, data, agentId?, ephemeral?, checkpoint?}`. An `ephemeral` event is never written to disk (session-events.ts,
// the `ephemeral` field), which is why `assistant.usage` is not read: it is not there. Like codex.ts, the reader writes each session out as the
// transcript lines `captureSession` reads, so redaction, the 1,000-character line cap, the salted hashes, and the skeleton are the Claude Code
// path's own code:
//   session.start        data {sessionId, copilotVersion, selectedModel, context.cwd}: the id, the harness version, the model, and the working directory
//   session.model_change data {newModel}: the model from then on
//   user.message         data {content}: a prompt; one with `isAutopilotContinuation` is the harness continuing, not the operator, and is not read
//   assistant.message    data {content, model, outputTokens, requestId, toolRequests[{toolCallId, name, arguments, mcpServerName, mcpToolName}]}
//   tool.execution_start data {toolCallId, toolName, shellToolInfo}: a call with `shellToolInfo` is a shell call whatever its name (the schema lists no tool
//                        names and the vendor's own hook examples disagree), so a shell call is read by shape
//   tool.execution_complete data {toolCallId, success, error.message, result.content, shellExecution.exitCode, contents[shell_exit|terminal].exitCode, fileEdits[{kind, path}]}
//                        the outcome: the real exit code, else `success`; a call with `fileEdits` is an edit by shape too
//   session.shutdown     data {modelMetrics[model].usage{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens}}: per-model totals,
//                        the only place input and cache tokens persist
// Events that carry an `agentId` are a subagent's own and are not read; the parent's call that spawned it is. `session.error` and `abort` are not read:
// a call they cut short has no completion event and stays `none`.

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

/** The Copilot home for an environment; a test passes its own so it never reads the real one. */
export const copilotRoot = (env: { [name: string]: string | undefined }, home: string = homedir()): string => {
  const set = env.COPILOT_HOME;
  return set === undefined || set === '' ? join(home, '.copilot') : set;
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

/** A session found in the store, before its events are read. */
export interface CopilotSession {
  /** The session folder's name, which is the session id (docs/features/session-persistence.md) and names the skeleton. */
  id: string;
  /** `session.start` `context.cwd`; null when the head names none. */
  folder: string | null;
  file: string;
  size: number;
  mtimeMs: number;
}

export interface CopilotStore {
  sessions: CopilotSession[];
  /** The session as transcript text for `captureSession`; throws when the file cannot be read or holds no parseable line. */
  transcript: (session: CopilotSession) => Promise<string>;
  /** Folders skipped because their name is not a safe file name (it names a skeleton), counted so the skip is never silent. */
  rejected: number;
  /** Sessions that could not be inspected, reported once each and never fatal; the reason names no path. */
  unreadable: { file: string; reason: string }[];
}

const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;
const EVENTS = 'events.jsonl';
/** How many leading lines are searched for `session.start`; a rotated head may begin with a `session.journal_link` and checkpoint events. */
const HEAD_LINES = 8;

/** An error's message with `file` cut to its base name, so a reason that is logged names no folder. */
const reasonOf = (error: unknown, file: string): string => (error instanceof Error ? error.message : String(error)).split(file).join(basename(file));

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** The working directory `session.start` names, read from the first lines only so the cost does not grow with the file. */
const startFolder = async (file: string): Promise<string | null> => {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let seen = 0;
    for await (const line of lines) {
      const entry = parse(line);
      if (isObj(entry) && entry.type === 'session.start' && isObj(entry.data) && isObj(entry.data.context)) return str(entry.data.context.cwd) ?? null;
      seen += 1;
      if (seen >= HEAD_LINES) break;
    }
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
};

const iso = (value: unknown): string | undefined => {
  const text = str(value);
  // An absolute time only: a missing or relative one (not a date after 2000) says nothing about when.
  return text !== undefined && Date.parse(text) >= Date.parse('2000-01-01T00:00:00Z') ? text : undefined;
};

/** The non-blank lines that are not JSON (a torn write), kept so `captureSession` counts them and the deposit line reports them. */
export const eventBadLines = (text: string): string[] => text.split('\n').filter((raw) => raw.trim() !== '' && parse(raw) === undefined);

/** The exit code of a shell call: `shellExecution.exitCode`, else the first `shell_exit` or `terminal` content (session-events.ts, ToolExecutionComplete*). */
const exitOf = (data: Obj): number | undefined => {
  const direct = isObj(data.shellExecution) ? num(data.shellExecution.exitCode) : undefined;
  if (direct !== undefined) return direct;
  const result = isObj(data.result) ? data.result : {};
  const contents = Array.isArray(result.contents) ? result.contents : [];
  for (const part of contents) if (isObj(part) && (part.type === 'shell_exit' || part.type === 'terminal') && num(part.exitCode) !== undefined) return num(part.exitCode);
  return undefined;
};

/** A nonzero exit code is a failure whatever `success` says; a negative one is no exit status, so the output stands as the error line. */
const failureOf = (exit: number, text: string): string => (exit < 0 && text.trim() !== '' ? text : `Exit code ${String(exit)}\n${text}`);

/** One session as the lines `captureSession` reads. */
export const eventLines = (text: string, fallbackId: string): Obj[] => {
  const nonblank = text.split('\n').filter((raw) => raw.trim() !== '');
  if (nonblank.length > 0 && !nonblank.some((raw) => isObj(parse(raw)))) throw new Error('no parseable line');
  const lines: Obj[] = [];
  const base: Obj = { sessionId: fallbackId };
  let at: string | undefined;
  let model: string | undefined;
  let sequence = 0;
  // The assistant lines since the last shutdown, whose last line per model receives that shutdown's input and cache totals.
  let span: { model: string | undefined; message: Obj }[] = [];
  const calls = new Map<string, { block: Obj; shell: boolean }>();
  const resolved = new Set<string>();
  const stamp = (value: unknown): string => {
    const candidate = iso(value);
    if (candidate !== undefined && (at === undefined || Date.parse(candidate) >= Date.parse(at))) at = candidate;
    return at ?? new Date(0).toISOString();
  };
  const result = (id: string, failure: string | undefined, when: string, output = ''): void => {
    sequence += 1;
    lines.push({
      ...base,
      type: 'user',
      uuid: `${fallbackId}-r${String(sequence)}`,
      timestamp: when,
      // The completion event is stamped with its own time, but the start is not paired to it here, so no duration is claimed.
      noDuration: true,
      // The output follows an `Exit code 0` line, the shape a Claude Code Bash result has, so a `[branch sha]` line is still found for commit survival.
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: failure !== undefined, content: failure ?? (output === '' ? '' : `Exit code 0\n${output}`) }] },
    });
  };
  const usageOf = (metrics: Obj): Obj | undefined => {
    const usage = isObj(metrics.usage) ? metrics.usage : undefined;
    if (usage === undefined) return undefined;
    const reasoning = num(usage.reasoningTokens);
    return {
      input_tokens: num(usage.inputTokens) ?? 0,
      cache_read_input_tokens: num(usage.cacheReadTokens) ?? 0,
      cache_creation_input_tokens: num(usage.cacheWriteTokens) ?? 0,
      ...(reasoning === undefined ? {} : { output_tokens_details: { thinking_tokens: reasoning } }),
    };
  };

  for (const raw of nonblank) {
    const entry = parse(raw);
    if (!isObj(entry) || !isObj(entry.data) || str(entry.type) === undefined) continue;
    // A subagent's own events are inline in the file; the parent's call that spawned it is the record.
    if (str(entry.agentId) !== undefined) continue;
    const data = entry.data;
    const when = stamp(entry.timestamp);
    const type = entry.type;
    if (type === 'session.start') {
      base.sessionId = str(data.sessionId) ?? base.sessionId;
      base.version = str(data.copilotVersion) ?? base.version;
      model = str(data.selectedModel) ?? model;
      const cwd = isObj(data.context) ? str(data.context.cwd) : undefined;
      if (cwd !== undefined) base.cwd = cwd;
      stamp(data.startTime);
    } else if (type === 'session.model_change') {
      model = str(data.newModel) ?? model;
    } else if (type === 'user.message') {
      const content = str(data.content);
      if (content !== undefined && data.isAutopilotContinuation !== true) {
        sequence += 1;
        lines.push({ ...base, type: 'user', uuid: `${fallbackId}-u${String(sequence)}`, timestamp: when, message: { role: 'user', content: [{ type: 'text', text: content }] } });
      }
    } else if (type === 'assistant.message') {
      const content: Obj[] = [];
      const text = str(data.content);
      if (text !== undefined) content.push({ type: 'text', text });
      for (const request of Array.isArray(data.toolRequests) ? data.toolRequests : []) {
        const id = isObj(request) ? str(request.toolCallId) : undefined;
        const name = isObj(request) ? str(request.name) : undefined;
        if (!isObj(request) || id === undefined || name === undefined) continue;
        const server = str(request.mcpServerName);
        const tool = str(request.mcpToolName);
        const block: Obj = { type: 'tool_use', id, name: server !== undefined && tool !== undefined ? `mcp__${server}__${tool}` : name, input: isObj(request.arguments) ? request.arguments : {} };
        content.push(block);
        calls.set(id, { block, shell: false });
      }
      if (content.length > 0) {
        sequence += 1;
        const modelOf = str(data.model) ?? model;
        const output = num(data.outputTokens);
        const message: Obj = { role: 'assistant', content, ...(output === undefined ? {} : { usage: { output_tokens: output } }) };
        // The request id is Copilot's own when the line has one; else the message id, since each assistant.message is one model response.
        const requestId = str(data.requestId) ?? str(data.messageId) ?? `${String(base.sessionId)}-resp${String(sequence)}`;
        lines.push({ ...base, type: 'assistant', uuid: `${fallbackId}-a${String(sequence)}`, requestId, timestamp: when, ...(modelOf === undefined ? {} : { requestedModel: modelOf }), message });
        span.push({ model: modelOf, message });
      }
    } else if (type === 'tool.execution_start') {
      const id = str(data.toolCallId);
      const known = id === undefined ? undefined : calls.get(id);
      if (known !== undefined && isObj(data.shellToolInfo)) {
        const args = isObj(data.arguments) ? data.arguments : {};
        const command = str(args.command) ?? str(data.shellToolInfo.displayCommand);
        known.shell = true;
        known.block.native = known.block.name;
        known.block.name = 'Bash';
        known.block.input = command === undefined ? {} : { command };
      }
    } else if (type === 'tool.execution_complete') {
      const id = str(data.toolCallId);
      const known = id === undefined ? undefined : calls.get(id);
      if (id === undefined || known === undefined || resolved.has(id)) continue;
      resolved.add(id);
      const output = isObj(data.result) ? (str(data.result.content) ?? str(data.result.detailedContent) ?? '') : '';
      const failed = data.success === false;
      const message = isObj(data.error) ? str(data.error.message) : undefined;
      const edits = (Array.isArray(data.fileEdits) ? data.fileEdits : []).flatMap((edit) => (isObj(edit) && str(edit.path) !== undefined ? [String(edit.path)] : []));
      if (edits.length > 0) {
        // A call that changed files is an edit whatever the tool is called; the first path rides the call's own block and any other gets its own, in the same line.
        known.block.native = known.block.name;
        known.block.name = 'Edit';
        known.block.input = { file_path: edits[0] };
      }
      const exit = known.shell ? exitOf(data) : undefined;
      let failure: string | undefined;
      if (exit !== undefined && exit !== 0) failure = failureOf(exit, output);
      else if (failed) failure = message ?? (output === '' ? 'tool failed' : output);
      result(id, failure, when, known.shell ? output : '');
      for (const [index, path] of edits.slice(1).entries()) {
        const extra = `${id}:${String(index + 2)}`;
        const line = lines.find((candidate) => isObj(candidate.message) && Array.isArray(candidate.message.content) && candidate.message.content.includes(known.block));
        if (line !== undefined && isObj(line.message) && Array.isArray(line.message.content)) line.message.content.push({ type: 'tool_use', id: extra, name: 'Edit', native: known.block.native, input: { file_path: path } });
        result(extra, failure, when);
      }
    } else if (type === 'session.shutdown') {
      const metrics = isObj(data.modelMetrics) ? data.modelMetrics : {};
      for (const [name, value] of Object.entries(metrics)) {
        const totals = isObj(value) ? usageOf(value) : undefined;
        const last = span.findLast((candidate) => candidate.model === name);
        if (totals === undefined || last === undefined) continue;
        const own = isObj(last.message.usage) ? last.message.usage : {};
        last.message.usage = { ...totals, output_tokens: num(own.output_tokens) ?? 0 };
      }
      span = [];
    }
  }
  return lines;
};

export const openCopilotStore = async (root: string): Promise<CopilotStore | undefined> => {
  const base = join(root, 'session-state');
  const unreadable: { file: string; reason: string }[] = [];
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return undefined;
    return { sessions: [], transcript: () => Promise.reject(new Error('no sessions')), rejected: 0, unreadable: [{ file: base, reason: reasonOf(error, base) }] };
  }
  const sessions: CopilotSession[] = [];
  let rejected = 0;
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!SAFE_ID.test(entry.name)) {
      rejected += 1;
      continue;
    }
    const file = join(base, entry.name, EVENTS);
    try {
      const info = await stat(file);
      sessions.push({ id: entry.name, folder: await startFolder(file), file, size: info.size, mtimeMs: Math.floor(info.mtimeMs) });
    } catch (error) {
      // A folder with no events file (only a workspace.yaml or a plan) is no session; any other failure is reported.
      if (!missing(error)) unreadable.push({ file, reason: reasonOf(error, file) });
    }
  }
  sessions.sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
  return {
    sessions,
    rejected,
    unreadable,
    transcript: async (session) => {
      const text = await readFile(session.file, 'utf8');
      const lines = [...eventLines(text, session.id).map((line) => JSON.stringify(line)), ...eventBadLines(text)];
      return lines.join('\n') + (lines.length === 0 ? '' : '\n');
    },
  };
};
