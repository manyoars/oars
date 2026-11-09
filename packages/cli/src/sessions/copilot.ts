// The GitHub Copilot CLI source: a Copilot CLI session log becomes the same capture records a Claude Code transcript does.
//
// FIXTURE-DERIVED: written from the public SDK's generated event types (github.com/github/copilot-sdk @ d28a136, MIT,
// nodejs/src/generated/session-events.ts, "generated from session-events.schema.json") and its docs, not from a live store. Nothing was copied; the
// reader is original. The CLI itself (github/copilot-cli) is closed source, so the schema is the only statement of the file's shape, and no vendor
// text promises the on-disk format. `docs/sessions-store.md` says what a live run would still have to prove.
//
// Where it reads from (`copilotRoot`): `$COPILOT_HOME`, else `~/.copilot` (`%USERPROFILE%\.copilot` on Windows). Inside it,
// `session-state/<sessionId>/events.jsonl` is one session (docs/features/session-persistence.md, "Linked event journals", which names the file; the
// SDK's `session.resume.eventsFileSizeBytes`, session-events.ts, is a second mention; the changelog's 0.0.342 entry moved new sessions there). The older
// `history-session-state` is migrated by the CLI on resume and is not read. A rotated archive `events.N.jsonl` is read, oldest N first, then the live
// file, as one session (`joinFiles`). Its head file holds a `session.journal_link` and `checkpoint: true` events that replay earlier state; with the archives
// read those replays are dropped (and any repeated event id), and `eventLines` itself reads a lone head like any other line (a fixture in copilot.test.ts holds one) and ignores `session.journal_link`.
// A line is `{id, parentId, timestamp, type, data, agentId?, ephemeral?, checkpoint?}`. An `ephemeral` event is never written to disk (session-events.ts,
// the `ephemeral` field), which is why `assistant.usage` is not read: it is not there. Like codex.ts, the reader writes each session out as the
// transcript lines `captureSession` reads, so redaction, the 1,000-character line cap, the salted hashes, and the skeleton are the Claude Code
// path's own code:
//   session.start        data {sessionId, copilotVersion, selectedModel, context.cwd}: the id, the harness version, the model, and the working directory
//   session.model_change data {newModel}: the model from then on
//   session.resume       data {selectedModel, context.cwd}, and session.context_changed data {cwd}: the model and working directory from then on
//   user.message         data {content}: a prompt; one with `isAutopilotContinuation`, or a `source` starting `skill-` (a hidden skill injection) or `agent-`
//                        (a prompt from another agent), is the harness writing, not the operator, and is not read
//   assistant.message    data {content, model, outputTokens, requestId, apiCallId, messageId, toolRequests[{toolCallId, name, arguments, mcpServerName, mcpToolName}]}
//                        one model call may be several chunks sharing `requestId`/`apiCallId`: they are one response. A request for an edit tool
//                        (`edit`, `str_replace_editor`, `apply_patch`, `write_file`) is an `Edit` by name, so a failed one is still an edit
//   tool.execution_start data {toolCallId, toolName, shellToolInfo}: a call with `shellToolInfo` is a shell call whatever its name (the schema lists no tool
//                        names and the vendor's own hook examples disagree), so a shell call is read by shape
//   tool.execution_complete data {toolCallId, success, error.message, result.content, shellExecution.exitCode, fileEdits[{kind, path}]}
//                        the outcome: `shellExecution` (which also marks a shell call the start did not) gives the real exit code and it decides, whatever
//                        `success` says; `success` decides only a call with no exit code. `fileEdits` makes a call an edit and overrides the path
//   session.shutdown     data {agentMetrics.main.modelMetrics, else modelMetrics: [model].usage{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens}}:
//                        per-model totals (the main conversation's when the runtime writes them, since the session-wide ones include subagents), the only
//                        place this reader takes them from (a `session.usage_checkpoint` may hold per-model totals; see the docs); they land once on the first line of the model's last response
// Events that carry an `agentId` (or the deprecated `parentToolCallId`) are a subagent's own and are not read; the parent's call that spawned it is. `session.error` and `abort` are not read:
// a call they cut short has no completion event and stays `none`.

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { holdsOnlyKinds } from './head-only.js';

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
  /** The live `events.jsonl`. */
  file: string;
  /** Rotated archives `events.N.jsonl`, oldest first (by N); the session is these, then `file`. */
  archives: string[];
  /** The bytes of every file of the session, so a new archive or a longer live file changes the cursor. */
  size: number;
  /** The newest modification time among the session's files. */
  mtimeMs: number;
}

export interface CopilotStore {
  sessions: CopilotSession[];
  /** The session as transcript text for `captureSession`; throws when the file cannot be read or holds no parseable line. */
  transcript: (session: CopilotSession) => Promise<string>;
  /** True when the log holds only head records (`eventHeadOnly`); `sessions verify` counts such a file as empty, not unreadable. */
  headOnly: (session: CopilotSession) => Promise<boolean>;
  /** Folders skipped because their name is not a safe file name (it names a skeleton), counted so the skip is never silent. */
  rejected: number;
  /** Sessions that could not be inspected, reported once each and never fatal; the reason names no path. */
  unreadable: { file: string; reason: string }[];
}

const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;
const EVENTS = 'events.jsonl';
/** A rotated archive's name; N counts up as the log rotates (docs/features/session-persistence.md, "Linked event journals"); the reader orders by N and does not follow each head's `previousFile`. */
const ARCHIVE = /^events\.(\d+)\.jsonl$/;
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

/** Event types that carry no turn by design: the session's own start, resume, context, model, and shutdown records. A log of these alone is a session started and quit. */
const EVENT_HEAD_KINDS: ReadonlySet<string> = new Set(['session.start', 'session.resume', 'session.context_changed', 'session.model_change', 'session.shutdown', 'session.journal_link', 'session.usage_checkpoint', 'session.error', 'abort']);
export const eventHeadOnly = (text: string): boolean => holdsOnlyKinds(text, EVENT_HEAD_KINDS);

/**
 * The exit code of a shell call: `shellExecution.exitCode` (session-events.ts, ToolExecutionCompleteData, "Experimental shell completion facts"). The
 * schema's `result.contents` also has `shell_exit` parts, but it says `shellExecution` is captured before persisted result contents are stripped, and no
 * source shows a persisted line holding them, so they are not read.
 */
const exitOf = (data: Obj): number | undefined => (isObj(data.shellExecution) ? num(data.shellExecution.exitCode) : undefined);

/** A nonzero exit code is a failure whatever `success` says; a negative one is no exit status, so the output stands as the error line. */
const failureOf = (exit: number, text: string): string => (exit < 0 && text.trim() !== '' ? text : `Exit code ${String(exit)}\n${text}`);

/** An `assistant.message` line, kept until the end so its usage can be settled once per response. */
interface Response {
  key: string;
  model: string | undefined;
  message: Obj;
  /** The line's own `outputTokens`. */
  own: number;
  /** The output the shutdown totals hold beyond what the responses reported; set on a response's first line. */
  residual: number;
}

/**
 * Splits `total` over lines in proportion to their `capacities`, whole tokens, none above its capacity; what the capacities cannot hold
 * (a total above their sum) is dropped. The remainder after rounding down goes to the first lines with room, so the split is stable.
 */
const shareOut = (total: number, capacities: readonly number[]): number[] => {
  const room = capacities.reduce((sum, capacity) => sum + capacity, 0);
  const wanted = Math.min(total, room);
  const shares = capacities.map((capacity) => (room === 0 ? 0 : Math.floor((wanted * capacity) / room)));
  let rest = wanted - shares.reduce((sum, share) => sum + share, 0);
  for (let index = 0; index < shares.length && rest > 0; index += 1) {
    const add = Math.min(rest, (capacities[index] ?? 0) - (shares[index] ?? 0));
    shares[index] = (shares[index] ?? 0) + add;
    rest -= add;
  }
  return shares;
};

/** Tools that are edits by name, for when the runtime writes no `fileEdits` or the edit failed. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['edit', 'str_replace_editor', 'apply_patch', 'write_file']);

/** One session as the lines `captureSession` reads. */
export const eventLines = (text: string, fallbackId: string): Obj[] => {
  const nonblank = text.split('\n').filter((raw) => raw.trim() !== '');
  if (nonblank.length > 0 && !nonblank.some((raw) => isObj(parse(raw)))) throw new Error('no parseable line');
  const lines: Obj[] = [];
  const base: Obj = { sessionId: fallbackId };
  let at: string | undefined;
  let model: string | undefined;
  let sequence = 0;
  // Each model's latest shutdown totals. Upstream's accounting is session-wide and kept for resume (the SDK usage doc, session-events.ts:4450), so a later
  // shutdown replaces an earlier one instead of adding to it (inferred, see the docs: no line states that a resumed count continues).
  const totals = new Map<string, Obj>();
  const responses: Response[] = [];
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
  const usageOf = (usage: Obj): Obj => {
    return {
      // `inputTokens` already includes the cache reads and writes (the SDK usage doc, line 58), and capture's fields are disjoint, so only the uncached part is input.
      input_tokens: Math.max((num(usage.inputTokens) ?? 0) - (num(usage.cacheReadTokens) ?? 0) - (num(usage.cacheWriteTokens) ?? 0), 0),
      cache_read_input_tokens: num(usage.cacheReadTokens) ?? 0,
      cache_creation_input_tokens: num(usage.cacheWriteTokens) ?? 0,
    };
  };
  // The tool's own words say it is a shell call: a start with `shellToolInfo`, or a completion with `shellExecution`.
  const asShell = (known: { block: Obj; shell: boolean }, command: string | undefined): void => {
    known.shell = true;
    known.block.native = known.block.native ?? known.block.name;
    known.block.name = 'Bash';
    known.block.input = command === undefined ? {} : { command };
  };

  for (const raw of nonblank) {
    const entry = parse(raw);
    if (!isObj(entry) || !isObj(entry.data) || str(entry.type) === undefined) continue;
    // A subagent's own events are inline in the file; the parent's call that spawned it is the record.
    // `parentToolCallId` is the deprecated spelling of the same fact (session-events.ts, "when this event originates from a sub-agent").
    if (str(entry.agentId) !== undefined || str(entry.data.parentToolCallId) !== undefined) continue;
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
    } else if (type === 'session.resume') {
      // A resume may happen elsewhere: its context and model are the session's from here on.
      const cwd = isObj(data.context) ? str(data.context.cwd) : undefined;
      if (cwd !== undefined) base.cwd = cwd;
      model = str(data.selectedModel) ?? model;
    } else if (type === 'session.context_changed') {
      base.cwd = str(data.cwd) ?? base.cwd;
    } else if (type === 'session.model_change') {
      model = str(data.newModel) ?? model;
    } else if (type === 'user.message') {
      const content = str(data.content);
      // `source` marks text the harness wrote: a skill injected as a hidden message (`skill-<name>`) or a prompt from another agent (`agent-<id>`).
      const source = str(data.source) ?? '';
      if (content !== undefined && data.isAutopilotContinuation !== true && !source.startsWith('skill-') && !source.startsWith('agent-')) {
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
        const input = isObj(request.arguments) ? request.arguments : {};
        const block: Obj = { type: 'tool_use', id, name: server !== undefined && tool !== undefined ? `mcp__${server}__${tool}` : name, input };
        // A tool known by name as an edit is one even when it fails or the runtime writes no `fileEdits`; `fileEdits` still overrides the path on completion.
        if (EDIT_TOOLS.has(name) && server === undefined) {
          const path = str(input.path) ?? str(input.file_path);
          block.native = name;
          block.name = 'Edit';
          block.input = path === undefined ? {} : { file_path: path };
        }
        content.push(block);
        calls.set(id, { block, shell: false });
      }
      if (content.length > 0) {
        sequence += 1;
        const modelOf = str(data.model) ?? model;
        const output = num(data.outputTokens);
        const message: Obj = { role: 'assistant', content, ...(output === undefined ? {} : { usage: { output_tokens: output } }) };
        // One model call can be written as several chunks (`chunkCount`, `chunkIndex`) that share `requestId` and `apiCallId`; the response is keyed on the
        // first of those the line has, else its own message id, so the chunks of one call are one response and its totals land once.
        const requestId = str(data.requestId) ?? str(data.apiCallId) ?? str(data.messageId) ?? `${String(base.sessionId)}-resp${String(sequence)}`;
        lines.push({ ...base, type: 'assistant', uuid: `${fallbackId}-a${String(sequence)}`, requestId, timestamp: when, ...(modelOf === undefined ? {} : { requestedModel: modelOf }), message });
        const held: Response = { key: requestId, model: modelOf, message, own: output ?? 0, residual: 0 };
        responses.push(held);
      }
    } else if (type === 'tool.execution_start') {
      const id = str(data.toolCallId);
      const known = id === undefined ? undefined : calls.get(id);
      if (known !== undefined && isObj(data.shellToolInfo)) {
        const args = isObj(data.arguments) ? data.arguments : {};
        const command = str(args.command) ?? str(data.shellToolInfo.displayCommand);
        asShell(known, command);
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
        known.block.native = known.block.native ?? known.block.name;
        known.block.name = 'Edit';
        known.block.input = { file_path: edits[0] };
      }
      // The completion can name a shell call the start did not (`shellToolInfo` is optional); its exit code then decides like any other.
      const exit = exitOf(data);
      if (exit !== undefined && !known.shell && edits.length === 0) {
        const input = isObj(known.block.input) ? known.block.input : {};
        asShell(known, str(input.command));
      }
      let failure: string | undefined;
      if (exit !== undefined && exit !== 0) failure = failureOf(exit, output === '' ? (message ?? '') : output);
      else if (exit === undefined && failed) failure = message ?? (output === '' ? 'tool failed' : output);
      result(id, failure, when, known.shell ? output : '');
      for (const [index, path] of edits.slice(1).entries()) {
        const extra = `${id}:${String(index + 2)}`;
        const line = lines.find((candidate) => isObj(candidate.message) && Array.isArray(candidate.message.content) && candidate.message.content.includes(known.block));
        if (line !== undefined && isObj(line.message) && Array.isArray(line.message.content)) line.message.content.push({ type: 'tool_use', id: extra, name: 'Edit', native: known.block.native, input: { file_path: path } });
        result(extra, failure, when);
      }
    } else if (type === 'session.shutdown') {
      // The session-wide totals include subagents; the main conversation's own are under `agentMetrics.main` when the runtime writes them.
      const agents = isObj(data.agentMetrics) ? data.agentMetrics : {};
      const main = isObj(agents.main) && isObj(agents.main.modelMetrics) ? agents.main.modelMetrics : undefined;
      const metrics = main ?? (isObj(data.modelMetrics) ? data.modelMetrics : {});
      for (const [name, value] of Object.entries(metrics)) {
        if (isObj(value) && isObj(value.usage)) totals.set(name, value.usage);
      }
    }
  }
  // Each model's last totals go on the first line of that model's last response; output beyond what all of its responses reported is the residual.
  const reasoning = new Map<string, number>();
  for (const [name, usage] of totals) {
    const last = responses.findLast((candidate) => candidate.model === name);
    const first = last === undefined ? undefined : responses.find((candidate) => candidate.key === last.key);
    if (first === undefined) continue;
    first.message.usage = { ...usageOf(usage), output_tokens: 0 };
    const thinking = num(usage.reasoningTokens);
    if (thinking !== undefined) reasoning.set(name, thinking);
    first.residual = Math.max(0, (num(usage.outputTokens) ?? 0) - responses.filter((candidate) => candidate.model === name).reduce((sum, candidate) => sum + candidate.own, 0));
  }
  // Extract counts a response's usage once, from its first line, so that line carries the output of every chunk of the response.
  for (const first of responses) {
    if (responses.find((candidate) => candidate.key === first.key) !== first) continue;
    const output = responses.filter((candidate) => candidate.key === first.key).reduce((sum, candidate) => sum + candidate.own, 0) + first.residual;
    if (output > 0 || isObj(first.message.usage)) first.message.usage = { ...(isObj(first.message.usage) ? first.message.usage : {}), output_tokens: output };
  }
  // The shutdown totals hold one reasoning figure per model, not one per response, and verify holds each line's thinking to its own output. So the
  // figure is shared out over the model's responses by their output (the model cannot think more than it wrote, so the total fits), and no line
  // reads thinking above output.
  for (const [name, total] of reasoning) {
    const firsts = responses.filter((candidate) => candidate.model === name && responses.find((other) => other.key === candidate.key) === candidate && isObj(candidate.message.usage));
    const outputs = firsts.map((candidate) => (isObj(candidate.message.usage) ? (num(candidate.message.usage.output_tokens) ?? 0) : 0));
    shareOut(total, outputs).forEach((thinking, index) => {
      const usage = firsts[index]?.message.usage;
      if (isObj(usage)) usage.output_tokens_details = { thinking_tokens: thinking };
    });
  }
  return lines;
};

/**
 * The session's files as one transcript text. A rotated head replays earlier state as `checkpoint: true` events, which the archives already hold in full,
 * so a checkpoint line in a file after the first is dropped, and any other line whose event `id` was already seen is too: each event is read once.
 * A line that is not JSON is kept, so it is still counted.
 */
const joinFiles = (texts: readonly string[]): string => {
  const seen = new Set<string>();
  const kept: string[] = [];
  texts.forEach((text, index) => {
    for (const raw of text.split('\n')) {
      if (raw.trim() === '') continue;
      const entry = parse(raw);
      if (isObj(entry)) {
        if (index > 0 && entry.checkpoint === true) continue;
        const id = str(entry.id);
        if (id !== undefined) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
      }
      kept.push(raw);
    }
  });
  return kept.join('\n') + (kept.length === 0 ? '' : '\n');
};

/** The session's events as one text; a session with no archives is read as it is, and only a rotated one has replayed events to drop. */
const logText = async (session: CopilotSession): Promise<string> => {
  const texts = await Promise.all([...session.archives, session.file].map((path) => readFile(path, 'utf8')));
  return session.archives.length === 0 ? (texts[0] ?? '') : joinFiles(texts);
};

export const openCopilotStore = async (root: string): Promise<CopilotStore | undefined> => {
  const base = join(root, 'session-state');
  const unreadable: { file: string; reason: string }[] = [];
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return undefined;
    return { sessions: [], transcript: () => Promise.reject(new Error('no sessions')), headOnly: () => Promise.resolve(false), rejected: 0, unreadable: [{ file: base, reason: reasonOf(error, base) }] };
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
      const archives = (await readdir(join(base, entry.name)))
        .flatMap((name) => {
          const n = ARCHIVE.exec(name)?.[1];
          return n === undefined ? [] : [{ n: Number(n), path: join(base, entry.name, name) }];
        })
        .sort((a, b) => a.n - b.n)
        .map((archive) => archive.path);
      let size = info.size;
      let mtimeMs = info.mtimeMs;
      for (const archive of archives) {
        const archived = await stat(archive);
        size += archived.size;
        mtimeMs = Math.max(mtimeMs, archived.mtimeMs);
      }
      // The oldest file holds the real `session.start`; the live head of a rotated log only replays it.
      let folder: string | null = null;
      for (const candidate of [...archives, file]) {
        folder = await startFolder(candidate);
        if (folder !== null) break;
      }
      sessions.push({ id: entry.name, folder, file, archives, size, mtimeMs: Math.floor(mtimeMs) });
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
    headOnly: async (session) => eventHeadOnly(await logText(session)),
    transcript: async (session) => {
      const text = await logText(session);
      const lines = [...eventLines(text, session.id).map((line) => JSON.stringify(line)), ...eventBadLines(text)];
      return lines.join('\n') + (lines.length === 0 ? '' : '\n');
    },
  };
};
