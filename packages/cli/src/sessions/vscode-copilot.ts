// The VS Code Copilot Chat source: the chat sessions VS Code itself writes become the same capture records a Claude Code transcript does. This is
// the editor's own serialized chat model, not the Copilot CLI's event log (`copilot.ts`): a different surface with a different shape.
//
// FIXTURE-DERIVED: written from the public source of microsoft/vscode @ f92b8f3adcd9bc034e6b9ade05c093dd59b99c5f (MIT; the Copilot Chat extension lives
// in-tree at `extensions/copilot/`), and never run against a live store. Nothing was copied. Paths below are under `src/vs/workbench/contrib/chat/common/`.
// No vendor text promises the format; the log form is behind `chat.useLogSessionStorage` with a `remove after stabilizing` note (model/chatSessionStore.ts:739),
// and the schema is versioned (`version: 3`, with 1 and 2 migrated, model/chatModel.ts:2593).
//
// Where it reads from (`vscodeAppData`): the folder that holds one folder per VS Code build, named by the build's `nameShort`: `%APPDATA%` on Windows,
// `~/Library/Application Support` on macOS, `$XDG_CONFIG_HOME` (else `~/.config`) on Linux; `VSCODE_APPDATA` replaces it
// (platform/environment/node/userDataPath.ts:57-109). The builds read are `Code` (Stable), `Code - Insiders`, and the pinned source's own `Code - OSS`; the first two names
// come from Microsoft's release `product.json`, not from the pin. A build with another `nameShort`, a portable install, or `--user-data-dir` is not discovered.
// Inside a build's `User` folder:
//   workspaceStorage/<hash>/chatSessions/<id>.json|.jsonl   a workspace's sessions (model/chatSessionStore.ts:72-76, :738-741)
//   workspaceStorage/<hash>/workspace.json                  `{folder}` or `{workspace}`, a uri: how the hash leads to a working directory
//                                                           (platform/storage/electron-main/storageMain.ts:425,481-492)
//   globalStorage/emptyWindowChatSessions/<id>.json|.jsonl  sessions from a window with no folder (no working directory)
//   workspaceStorage/no-workspace/chatSessions              the older spelling of the last one, read the same way
// A session moved between workspaces is copied and the original kept (chatSessionStore.ts:150-175), so one id can sit in two folders: the newest copy is read.
//
// `.json` is one `JSON.stringify(ISerializableChatData)`. `.jsonl` is an append log, one entry per line (model/objectMutationLog.ts:195-215, 345-390):
// `{kind:0,v}` the initial value, `{kind:1,k,v}` a set at path `k`, `{kind:2,k,v,i}` a push (the array is cut to `i` first), `{kind:3,k}` a delete. VS Code reads the
// `.jsonl` first and the `.json` only when that is unreadable (chatSessionStore.ts:655-672), and so does this. VS Code throws on a malformed log line; this skips it and
// counts it, so the deposit line reports it. Like codex.ts, a session is written out as the transcript lines `captureSession` reads, so redaction, the
// 1,000-character line cap, the salted hashes, and the skeleton are the Claude Code path's own code.
//
// One request is one prompt and one response (ISerializableChatRequestData, model/chatModel.ts:2230-2259):
//   message          `message.text`, or the string itself (old format): the prompt. A request with `isSystemInitiated`, `requestHiddenFromTranscript`, or
//                    `hiddenFromTranscript` is the harness writing, not the operator, and its prompt is not read; its response still is
//   timestamp        epoch milliseconds, `responseTimestamp` for the response. A missing or implausible one is never made up: the time carries forward
//   modelId          the model
//   response[]       a markdown part is a bare `{value}` (a string in the old format); `kind:'thinking'` is skipped;
//                    `kind:'toolInvocationSerialized'` is a tool call (service/chatService.ts:1246-1270); `kind:'textEditGroup'` or `'notebookEditGroup'` `{uri}` is a file edited
//   usage            `completionTokens` the whole turn's output (model/chatModel.ts:1929-1934), `modelTotals[{model, inputTokens, cachedTokens, outputTokens}]`
//                    (chatService.ts:176-188) the only per-model figure. `promptTokens` is the last model call alone, so it is not read as consumption. The source does not
//                    say whether `inputTokens` includes `cachedTokens`, so it is not subtracted: that is a stated limit (a store that includes it counts the cache twice)
// A tool call's `toolId` is the bare name (`run_in_terminal`) or the contributed one (`copilot_applyPatch`), both in extensions/copilot/src/extension/tools/common/toolNames.ts.
// A call with `subAgentInvocationId` is a subagent's own and is not read; the parent's `runSubagent` call is. Tool inputs are not persisted (model/chatToolInvocation.ts:504-533),
// so only a terminal command (`toolSpecificData.commandLine`) and an edit's file (the `textEditGroup` after the call) are known. A shell call's outcome is its exit code
// alone (`terminalCommandState.exitCode`, chatService.ts:803-807), never a status field; with none and no error, it is unknown and stays `none`.
// A refusal is `isConfirmed` `{type:0}` (Denied) or `{type:5}` (Skipped) with a `source` (ToolConfirmKind, chatService.ts:901-913), or `false` (before VS Code 1.104). The Skip
// button of a confirmation is the decline button and writes `{type:5, source:'user'}` (browser/widget/chatContentParts/toolInvocationParts/abstractToolConfirmationSubPart.ts:225,
// chatTerminalToolConfirmationSubPart.ts:380,507; browser/tools/languageModelToolsService.ts:711), so a user's refusal (`source` `user`) reads as Claude Code's refusal text and
// stores `user-rejected`; a hook's or a risk assessment's (languageModelToolsService.ts:683,1051) reads as a permission denial. A `{type:5}` with no `source` is the skip after
// approval (model/chatProgressTypes/chatToolInvocation.ts:516) and has no outcome. The file holds no harness version and no working-directory change.

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folder that holds one folder per VS Code build; a test passes its own so it never reads the real one. */
export const vscodeAppData = (platform: NodeJS.Platform, env: { [name: string]: string | undefined }, home: string = homedir()): string => {
  const set = env.VSCODE_APPDATA;
  if (set !== undefined && set !== '') return set;
  if (platform === 'win32') return env.APPDATA ?? join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME ?? join(home, '.config');
};

/** The `nameShort` of each build read. */
const CHANNELS = ['Code', 'Code - Insiders', 'Code - OSS'] as const;

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

/** A `file:` uri string as a path; undefined for any other scheme or a string that is no uri. */
const fileUriPath = (value: unknown): string | undefined => {
  const text = str(value);
  if (text === undefined || !text.startsWith('file:')) return undefined;
  try {
    return fileURLToPath(text);
  } catch {
    return undefined;
  }
};

/** The working directory a `workspaceStorage/<hash>/workspace.json` names: a folder, or the folder that holds a `.code-workspace` file. A remote uri is none. */
const workspaceFolder = (text: string): string | null => {
  const entry = parse(text);
  if (!isObj(entry)) return null;
  const folder = fileUriPath(entry.folder);
  if (folder !== undefined) return folder;
  const file = fileUriPath(entry.workspace);
  return file === undefined ? null : dirname(file);
};

/** The path of a serialized uri (`{scheme, path, fsPath?}`, or a string) when it is a local file. */
const editPath = (uri: unknown): string | undefined => {
  if (typeof uri === 'string') return fileUriPath(uri);
  if (!isObj(uri) || (str(uri.scheme) !== undefined && uri.scheme !== 'file')) return undefined;
  const fsPath = str(uri.fsPath);
  if (fsPath !== undefined) return fsPath;
  const path = str(uri.path);
  // A Windows file uri's path is `/c:/dir/file`.
  return path === undefined ? undefined : /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
};

/** A session found in the store, before it is read. */
export interface VscodeSession {
  /** The file's name without its extension, which is the session id (chatSessionStore.ts:738-741) and names the skeleton. */
  id: string;
  /** The workspace's folder; null for an empty window or a remote workspace. */
  folder: string | null;
  /** The files that hold it, in the order VS Code tries them: the `.jsonl`, then the `.json`. */
  files: string[];
  size: number;
  mtimeMs: number;
}

export interface VscodeStore {
  sessions: VscodeSession[];
  /** The session as transcript text for `captureSession`; throws when no file of it can be read or holds no parseable entry. */
  transcript: (session: VscodeSession) => Promise<string>;
  /** Files skipped because their name is not a safe file name (it names a skeleton), counted so the skip is never silent. */
  rejected: number;
  /** Folders and files that could not be inspected, reported once each and never fatal; the reason names no path. */
  unreadable: { file: string; reason: string }[];
}

const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;
/** An error's message with `file` cut to its base name, so a reason that is logged names no folder. */
const reasonOf = (error: unknown, file: string): string => (error instanceof Error ? error.message : String(error)).split(file).join(basename(file));
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

/** The non-blank log lines that are not JSON (a torn write), kept so `captureSession` counts them and the deposit line reports them. */
export const chatBadLines = (text: string): string[] => text.split('\n').filter((raw) => raw.trim() !== '' && parse(raw) === undefined);

/** One step down a mutation-log path: an object's key or an array's index; anything else leads nowhere. */
const child = (node: unknown, key: string): unknown => (isObj(node) ? (Object.hasOwn(node, key) ? node[key] : undefined) : Array.isArray(node) ? node[Number(key)] : undefined);

/** A path key that would reach `Object.prototype` or a constructor; file content must never write through one. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Replays one mutation-log entry onto `state` (objectMutationLog.ts:345-390); an entry whose path does not lead anywhere is dropped. */
const apply = (state: unknown, entry: Obj): unknown => {
  if (entry.kind === 0) return entry.v;
  const path: unknown[] = Array.isArray(entry.k) ? entry.k : [];
  if (path.some((key) => UNSAFE_KEYS.has(String(key)))) return state;
  if (path.length === 0) return entry.kind === 1 ? entry.v : state;
  let holder: unknown = state;
  for (const key of path.slice(0, -1)) holder = child(holder, String(key));
  const last = String(path[path.length - 1]);
  if (!isObj(holder) && !Array.isArray(holder)) return state;
  const write = (value: unknown): void => {
    if (isObj(holder)) holder[last] = value;
    else if (Array.isArray(holder)) holder[Number(last)] = value;
  };
  if (entry.kind === 1) write(entry.v);
  else if (entry.kind === 3) Reflect.deleteProperty(holder, last);
  else if (entry.kind === 2) {
    const current = child(holder, last);
    const target: unknown[] = Array.isArray(current) ? current : [];
    const cut = num(entry.i);
    if (cut !== undefined) target.length = Math.min(Math.max(cut, 0), target.length);
    const added: unknown[] = Array.isArray(entry.v) ? entry.v : [];
    for (const item of added) target.push(item);
    write(target);
  }
  return state;
};

/** The chat data a file holds: the `.json` form is the object itself, the `.jsonl` form is replayed. Throws when nothing parses. */
export const chatData = (text: string, jsonl: boolean): Obj => {
  if (!jsonl) {
    const whole = parse(text);
    if (!isObj(whole)) throw new Error('no parseable chat data');
    return whole;
  }
  const entries = text.split('\n').flatMap((raw) => {
    const entry = raw.trim() === '' ? undefined : parse(raw);
    return isObj(entry) ? [entry] : [];
  });
  if (entries.length === 0 && text.trim() !== '') throw new Error('no parseable line');
  let state: unknown = {};
  for (const entry of entries) state = apply(state, entry);
  if (!isObj(state)) throw new Error('no parseable chat data');
  return state;
};

const MIN_MS = Date.parse('2000-01-01T00:00:00Z');
/** An absolute time only: a missing or relative one (not a date after 2000) says nothing about when. */
const isoOf = (value: unknown): string | undefined => {
  const ms = num(value);
  return ms !== undefined && ms >= MIN_MS ? new Date(ms).toISOString() : undefined;
};

/** Tools that edit a file, under both spellings (toolNames.ts: `ToolName` and `ContributedToolName`). */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['apply_patch', 'copilot_applyPatch', 'replace_string_in_file', 'copilot_replaceString', 'multi_replace_string_in_file', 'copilot_multiReplaceString', 'insert_edit_into_file', 'copilot_insertEdit', 'edit_notebook_file', 'copilot_editNotebook']);
const WRITE_TOOLS: ReadonlySet<string> = new Set(['create_file', 'copilot_createFile', 'create_new_jupyter_notebook', 'copilot_createNewJupyterNotebook']);

/** A failed shell call's error: the exit code leads, as a Claude Code Bash result's does, so its `error-line` joins the same signature. A negative code is no exit status. */
const failureOf = (exit: number, text: string): string => (exit < 0 && text.trim() !== '' ? text : `Exit code ${String(exit)}\n${text}`);

const USER_REFUSAL = "The user doesn't want to proceed with this tool use. The tool use was rejected";

/** What a tool's own error field says: a string, or `true` for a failure with no words. */
const errorText = (part: Obj): string | undefined => {
  if (typeof part.resultError === 'string' && part.resultError !== '') return part.resultError;
  if (part.resultError === true) return 'tool failed';
  if (!isObj(part.resultDetails) || part.resultDetails.isError !== true) return undefined;
  const output = part.resultDetails.output;
  // `output` is an array of `{type:'embed', value, isText}` (common/tools/languageModelToolsService.ts:290-296, written as an array at contrib/mcp/common/
  // mcpLanguageModelToolContribution.ts:279-280): the first text embed is the message. A plain string is the older spelling (`isToolResultInputOutputDetails`, :305).
  const embed = Array.isArray(output) ? output.find((entry) => isObj(entry) && entry.isText === true && str(entry.value) !== undefined) : undefined;
  return (isObj(embed) ? str(embed.value) : str(output)) ?? 'tool failed';
};

/** One chat session as the lines `captureSession` reads. */
export const chatLines = (data: Obj, fallbackId: string, folder: string | null): Obj[] => {
  const requests = Array.isArray(data.requests) ? data.requests.filter(isObj) : [];
  const lines: Obj[] = [];
  const base: Obj = { sessionId: str(data.sessionId) ?? fallbackId };
  // The session's own working directory (a sessions-window field, ISerializableChatData3.workingDirectory) wins over its workspace's folder.
  const cwd = fileUriPath(data.workingDirectory) ?? folder;
  if (cwd !== null) base.cwd = cwd;
  let at: string | undefined = isoOf(data.creationDate);
  let sequence = 0;
  const stamp = (value: unknown): string => {
    const candidate = isoOf(value);
    if (candidate !== undefined && (at === undefined || Date.parse(candidate) >= Date.parse(at))) at = candidate;
    return at ?? new Date(0).toISOString();
  };
  for (const request of requests) {
    const when = stamp(request.timestamp);
    const message = request.message;
    const text = typeof message === 'string' ? str(message) : isObj(message) ? str(message.text) : undefined;
    const hidden = request.isSystemInitiated === true || request.requestHiddenFromTranscript === true || request.hiddenFromTranscript === true;
    sequence += 1;
    if (text !== undefined && !hidden) lines.push({ ...base, type: 'user', uuid: `${fallbackId}-u${String(sequence)}`, timestamp: when, message: { role: 'user', content: [{ type: 'text', text }] } });

    const content: Obj[] = [];
    // Each call's result, in call order, written after the response line: a tool call has its result in the next transcript line.
    const results: { id: string; failure: string | undefined; output: string; when: string }[] = [];
    let pending = '';
    let current: { block: Obj; id: string; failure: string | undefined; edits: number; when: string } | undefined;
    const flush = (): void => {
      if (pending !== '') content.push({ type: 'text', text: pending });
      pending = '';
    };
    for (const part of Array.isArray(request.response) ? request.response : []) {
      if (typeof part === 'string') pending += part;
      else if (!isObj(part)) continue;
      else if (part.kind === undefined && typeof part.value === 'string') pending += part.value;
      else if (part.kind === 'textEditGroup' || part.kind === 'notebookEditGroup') {
        const path = editPath(part.uri);
        if (current === undefined || path === undefined) continue;
        if (current.edits === 0) current.block.input = { file_path: path };
        else {
          const id = `${current.id}:${String(current.edits + 1)}`;
          content.push({ type: 'tool_use', id, name: current.block.name, native: current.block.native, input: { file_path: path } });
          results.push({ id, failure: current.failure, output: '', when: current.when });
        }
        current.edits += 1;
      } else if (part.kind === 'toolInvocationSerialized') {
        // A subagent's own call is inline in the parent's response; the parent's `runSubagent` call is the record.
        current = undefined;
        if (str(part.subAgentInvocationId) !== undefined) continue;
        const toolId = str(part.toolId) ?? 'unknown';
        const id = str(part.toolCallId) ?? `${fallbackId}-t${String(sequence)}-${String(content.length)}`;
        const specific = isObj(part.toolSpecificData) ? part.toolSpecificData : {};
        const terminal = specific.kind === 'terminal' && isObj(specific.commandLine) ? specific.commandLine : undefined;
        const block: Obj = { type: 'tool_use', id, name: toolId, input: {} };
        const isShell = terminal !== undefined || toolId === 'run_in_terminal';
        if (isShell) {
          const command = terminal === undefined ? undefined : (str(terminal.userEdited) ?? str(terminal.original));
          block.native = toolId;
          block.name = 'Bash';
          block.input = command === undefined ? {} : { command };
        } else if (EDIT_TOOLS.has(toolId) || WRITE_TOOLS.has(toolId)) {
          block.native = toolId;
          block.name = WRITE_TOOLS.has(toolId) ? 'Write' : 'Edit';
        }
        flush();
        content.push(block);
        const confirmed = part.isConfirmed;
        // `Denied` (0) is a refusal; `Skipped` (5) with a `source` is one too, since the Skip button of a confirmation writes `{type:5, source:'user'}` and a risk assessment's
        // denial `{type:5, source:'riskAssessment'}`; a `Skipped` with no source is the skip after approval (chatToolInvocation.ts:516), which names no outcome.
        const refusedBy = isObj(confirmed) && (confirmed.type === 0 || confirmed.type === 5) ? str(confirmed.source) : undefined;
        const denied = confirmed === false || (isObj(confirmed) && (confirmed.type === 0 || (confirmed.type === 5 && refusedBy !== undefined)));
        const skipped = isObj(confirmed) && confirmed.type === 5 && refusedBy === undefined;
        const callWhen = stamp(part.completedAt);
        const output = isObj(specific.terminalCommandOutput) ? (str(specific.terminalCommandOutput.text) ?? '') : '';
        const exit = isObj(specific.terminalCommandState) ? num(specific.terminalCommandState.exitCode) : undefined;
        const error = errorText(part);
        let failure: string | undefined;
        let known = true;
        if (denied) {
          // A user's refusal (`source` `user`, or the boolean `false` of VS Code before 1.104) is Claude Code's own wording; a hook's or a risk assessment's is a
          // permission denial. A denial with no `source` names no actor (chatService.ts:910), so it claims neither.
          failure = confirmed === false || refusedBy === 'user' ? USER_REFUSAL : refusedBy === undefined ? 'The tool call was denied' : `Permission to use ${toolId} has been denied`;
        } else if (skipped) known = false;
        else if (isShell && exit !== undefined) failure = exit === 0 ? undefined : failureOf(exit, output === '' ? (error ?? '') : output);
        else if (error !== undefined) failure = error;
        // `toJSON` always writes `isComplete: true`; a call that never finished carries `summary.kind` `incomplete` and, before confirmation, no `isConfirmed`
        // (model/chatProgressTypes/chatToolInvocation.ts:508,516-517). Neither says it succeeded.
        else if (isShell || confirmed === undefined || (isObj(part.summary) && part.summary.kind === 'incomplete')) known = false;
        if (known) results.push({ id, failure, output: isShell ? output : '', when: callWhen });
        if (block.name === 'Edit' || block.name === 'Write') current = { block, id, failure, edits: 0, when: callWhen };
      }
    }
    flush();
    const totals = Array.isArray(request.modelTotals) ? request.modelTotals.filter(isObj) : [];
    const completion = num(request.completionTokens);
    const sum = (field: string): number => totals.reduce((total, entry) => total + (num(entry[field]) ?? 0), 0);
    // `inputTokens` is taken whole: the source does not say whether it includes `cachedTokens`.
    const usage: Obj | undefined =
      totals.length > 0
        ? { input_tokens: sum('inputTokens'), cache_read_input_tokens: sum('cachedTokens'), output_tokens: sum('outputTokens') }
        : completion === undefined
          ? undefined
          : { output_tokens: completion };
    if (content.length > 0 || usage !== undefined) {
      const model = str(request.modelId);
      const answered = stamp(request.responseTimestamp);
      lines.push({
        ...base,
        type: 'assistant',
        uuid: `${fallbackId}-a${String(sequence)}`,
        requestId: str(request.requestId) ?? `${fallbackId}-req${String(sequence)}`,
        timestamp: answered,
        ...(model === undefined ? {} : { requestedModel: model }),
        message: { role: 'assistant', content: content.length > 0 ? content : [{ type: 'text', text: '' }], ...(usage === undefined ? {} : { usage }) },
      });
    }
    for (const result of results) {
      sequence += 1;
      lines.push({
        ...base,
        type: 'user',
        uuid: `${fallbackId}-r${String(sequence)}`,
        timestamp: result.when,
        // The call's own time is not paired to a start here, so no duration is claimed.
        noDuration: true,
        // The output follows an `Exit code 0` line, the shape a Claude Code Bash result has, so a `[branch sha]` line is still found for commit survival.
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: result.id, is_error: result.failure !== undefined, content: result.failure ?? (result.output === '' ? '' : `Exit code 0\n${result.output}`) }] },
      });
    }
  }
  return lines;
};

export const openVscodeCopilotStore = async (root: string): Promise<VscodeStore | undefined> => {
  const unreadable: { file: string; reason: string }[] = [];
  const found = new Map<string, VscodeSession>();
  let rejected = 0;
  let present = false;
  const note = (file: string, error: unknown): void => {
    if (!missing(error)) unreadable.push({ file, reason: reasonOf(error, file) });
  };
  /** One `chatSessions` folder: each id once, its `.jsonl` ahead of its `.json`. */
  const scan = async (dir: string, folder: string | null): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch (error) {
      note(dir, error);
      return;
    }
    const byId = new Map<string, string[]>();
    for (const name of names.sort()) {
      const ext = name.endsWith('.jsonl') ? '.jsonl' : name.endsWith('.json') ? '.json' : undefined;
      if (ext === undefined) continue;
      const id = name.slice(0, -ext.length);
      if (!SAFE_ID.test(id)) {
        rejected += 1;
        continue;
      }
      const files = byId.get(id) ?? [];
      files[ext === '.jsonl' ? 'unshift' : 'push'](join(dir, name));
      byId.set(id, files);
    }
    for (const [id, files] of byId) {
      const first = files[0] ?? '';
      try {
        const info = await stat(first);
        const mtimeMs = Math.floor(info.mtimeMs);
        const earlier = found.get(id);
        if (earlier === undefined || mtimeMs > earlier.mtimeMs) found.set(id, { id, folder, files, size: info.size, mtimeMs });
      } catch (error) {
        note(first, error);
      }
    }
  };
  for (const channel of CHANNELS) {
    const user = join(root, channel, 'User');
    try {
      await stat(user);
    } catch (error) {
      note(user, error);
      continue;
    }
    present = true;
    await scan(join(user, 'globalStorage', 'emptyWindowChatSessions'), null);
    const storage = join(user, 'workspaceStorage');
    let hashes: string[];
    try {
      hashes = (await readdir(storage, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch (error) {
      note(storage, error);
      continue;
    }
    for (const hash of hashes) {
      let folder: string | null = null;
      try {
        folder = workspaceFolder(await readFile(join(storage, hash, 'workspace.json'), 'utf8'));
      } catch {
        // No `workspace.json` (the `no-workspace` folder has none) or an unreadable one: the sessions have no working directory.
      }
      await scan(join(storage, hash, 'chatSessions'), folder);
    }
  }
  if (!present && unreadable.length === 0) return undefined;
  const sessions = [...found.values()].sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
  return {
    sessions,
    rejected,
    unreadable,
    transcript: async (session) => {
      let failure: unknown = new Error('no file');
      for (const file of session.files) {
        try {
          const text = await readFile(file, 'utf8');
          const jsonl = file.endsWith('.jsonl');
          const lines = [...chatLines(chatData(text, jsonl), session.id, session.folder).map((line) => JSON.stringify(line)), ...(jsonl ? chatBadLines(text) : [])];
          return lines.join('\n') + (lines.length === 0 ? '' : '\n');
        } catch (error) {
          failure = error;
        }
      }
      throw failure;
    },
  };
};
