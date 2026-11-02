// The Cursor source (t728): a Cursor user's chat and composer history becomes the same capture records a Claude Code transcript does.
//
// Cursor keeps history in SQLite, not in one JSON event per line. The reader opens the store read-only and writes each composer
// session out as the transcript lines `captureSession` already reads (user and assistant lines, `tool_use` and `tool_result` blocks, one
// `cwd` per line), so redaction, the 1,000-character `line` cap, the salted `fileHashes`, the repository identity, and the skeleton are
// the Claude Code path's own code, not a second copy of it. What Cursor has no equivalent of (cache tokens, subagents, hooks, a harness
// version, `cost-state`) stays at the value capture gives an absent field: zero, empty, or null.
//
// Where it reads from (`cursorRoot`): Cursor's `User` folder, `%APPDATA%\Cursor\User` on Windows, `~/Library/Application Support/Cursor/User`
// on macOS, `$XDG_CONFIG_HOME/Cursor/User` (else `~/.config/Cursor/User`) on Linux. Inside it:
//   globalStorage/state.vscdb       table cursorDiskKV: `composerData:<composerId>` (one JSON document per composer session, with
//                                   `fullConversationHeadersOnly`, the ordered `{bubbleId, type}` list) and `bubbleId:<composerId>:<bubbleId>`
//                                   (one JSON document per message; type 1 is the user, type 2 the assistant).
//   workspaceStorage/<hash>/        `workspace.json` names the folder; `state.vscdb` table ItemTable key `composer.composerData` lists
//                                   the composer sessions opened in that workspace.
// A composer session no workspace lists has no working directory: it is captured with none, so its paths hash as written (base `cwd`).

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Cursor `User` folder for a platform; the caller passes the environment so a test never reads the real one. */
export const cursorRoot = (platform: NodeJS.Platform, env: { [name: string]: string | undefined }, home: string = homedir()): string => {
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Cursor', 'User');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Cursor', 'User');
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Cursor', 'User');
};

type Obj = { [key: string]: unknown };
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** Cursor's tool names, in the vocabulary prompt classes and `files` are computed in. A name with no counterpart keeps its own. */
const TOOL_NAMES: { [cursor: string]: string } = {
  read_file: 'Read',
  edit_file: 'Edit',
  search_replace: 'Edit',
  reapply: 'Edit',
  write: 'Write',
  run_terminal_cmd: 'Bash',
  grep_search: 'Grep',
  grep: 'Grep',
  codebase_search: 'Grep',
  file_search: 'Glob',
  glob_file_search: 'Glob',
  list_dir: 'Glob',
  web_search: 'WebSearch',
};

/** A tool call's input in the keys the extractor reads: the path as `file_path` (or `path` for a directory), the command, the query. */
const inputOf = (params: unknown): Obj => {
  if (!isObj(params)) return {};
  const input: Obj = {};
  const file = str(params.relativeWorkspacePath) ?? str(params.targetFile);
  if (file !== undefined) input.file_path = file;
  const directory = str(params.directoryPath) ?? str(params.targetDirectory);
  if (directory !== undefined) input.path = directory;
  const command = str(params.command);
  if (command !== undefined) input.command = command;
  const query = str(params.searchTerm) ?? str(params.query);
  if (query !== undefined) input.query = query;
  return input;
};

const parse = (text: unknown): unknown => {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A composer session found in the store, before its messages are read. */
export interface CursorSession {
  composerId: string;
  /** The workspace folder (a path) the session was opened in; null when no workspace lists it or the workspace is remote. */
  folder: string | null;
  createdAt: number;
  lastUpdatedAt: number;
  /** Messages the session holds: the cursor `state.json` keeps, with `lastUpdatedAt`, to tell a changed session from one already deposited. */
  messages: number;
}

export interface CursorStore {
  sessions: CursorSession[];
  /** The session as transcript text for `captureSession`. */
  transcript: (session: CursorSession) => string;
  /** Composers skipped because their id is not a safe file name (it names a skeleton), counted so the skip is never silent. */
  rejected: number;
  close: () => void;
}

interface Database {
  prepare: (sql: string) => { all: (...params: string[]) => { [column: string]: unknown }[]; get: (...params: string[]) => { [column: string]: unknown } | undefined };
  close: () => void;
}

/** `node:sqlite` is loaded only when a Cursor store exists: it prints an experimental-feature warning on first use. */
const open = async (file: string): Promise<Database> => {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
};

const folderOf = (workspace: unknown): string | null => {
  if (!isObj(workspace)) return null;
  const uri = str(workspace.folder) ?? str(workspace.workspace);
  if (uri === undefined || !uri.startsWith('file:')) return null;
  let path: string;
  try {
    path = fileURLToPath(uri);
  } catch {
    // A `file:` URI that names no path on this platform (a POSIX path on Windows, a host that is not local) has no folder here.
    return null;
  }
  // A `.code-workspace` file stands for its folder.
  return str(workspace.folder) === undefined ? join(path, '..') : path;
};

/** Composer id to workspace folder, from every `workspaceStorage/<hash>/`; the first workspace to list a session names its folder. */
const workspaceFolders = async (root: string): Promise<Map<string, string>> => {
  const folders = new Map<string, string>();
  let names: string[];
  try {
    names = (await readdir(join(root, 'workspaceStorage'))).sort();
  } catch {
    return folders;
  }
  for (const name of names) {
    const dir = join(root, 'workspaceStorage', name);
    if (!existsSync(join(dir, 'workspace.json')) || !existsSync(join(dir, 'state.vscdb'))) continue;
    const folder = folderOf(parse(await readFile(join(dir, 'workspace.json'), 'utf8')));
    if (folder === null) continue;
    // A workspace store that cannot be read (locked, corrupt) only leaves its sessions without a folder.
    let db: Database;
    try {
      db = await open(join(dir, 'state.vscdb'));
    } catch {
      continue;
    }
    try {
      const row = db.prepare("select cast(value as text) as v from ItemTable where key = 'composer.composerData'").get();
      const listed = parse(row?.v);
      const all = isObj(listed) && Array.isArray(listed.allComposers) ? listed.allComposers : [];
      for (const entry of all) {
        const id = isObj(entry) ? str(entry.composerId) : undefined;
        if (id !== undefined && !folders.has(id)) folders.set(id, folder);
      }
    } catch {
      continue;
    } finally {
      db.close();
    }
  }
  return folders;
};

interface Bubble {
  id: string;
  document: Obj;
}

/** The session's messages in order: the headers list when present, else the inline `conversation` older Cursor versions wrote. */
const bubblesOf = (db: Database, composerId: string, composer: Obj): Bubble[] => {
  const headers = Array.isArray(composer.fullConversationHeadersOnly) ? composer.fullConversationHeadersOnly : [];
  const found: Bubble[] = [];
  if (headers.length > 0) {
    const prefix = `bubbleId:${composerId}:`;
    const rows = db.prepare('select cast(key as text) as k, cast(value as text) as v from cursorDiskKV where key >= ? and key < ?').all(prefix, `${prefix}\u{10ffff}`);
    const byId = new Map<string, Obj>();
    for (const row of rows) {
      const document = parse(row.v);
      if (isObj(document) && typeof row.k === 'string') byId.set(row.k.slice(prefix.length), document);
    }
    for (const header of headers) {
      const id = isObj(header) ? str(header.bubbleId) : undefined;
      const document = id === undefined ? undefined : byId.get(id);
      if (id !== undefined && document !== undefined) found.push({ id, document });
    }
    return found;
  }
  const inline = Array.isArray(composer.conversation) ? composer.conversation : [];
  for (const [index, document] of inline.entries()) if (isObj(document)) found.push({ id: str(document.bubbleId) ?? String(index), document });
  return found;
};

const iso = (millis: number | undefined): string | undefined => (millis === undefined ? undefined : new Date(millis).toISOString());

/** The message of a failed call's `error`: Cursor wraps it as JSON with a model-visible and a client-visible text. */
const errorText = (raw: unknown): string => {
  const wrapper = parse(raw);
  const message = isObj(wrapper) ? (str(wrapper.modelVisibleErrorMessage) ?? str(wrapper.clientVisibleErrorMessage)) : undefined;
  return message ?? str(raw) ?? 'error';
};

/** An aborted terminal call (the user stopped it) has no outcome: it reads `none`, as a cancelled edit does, so it never counts as a fix. */
const aborted = (call: Obj, name: string): boolean => {
  const result = name === 'run_terminal_cmd' ? parse(call.result) : undefined;
  return isObj(result) && (str(result.endedReason) ?? '').endsWith('_ABORTED');
};

/**
 * Why a call failed, undefined when it did not. Cursor writes a failed shell command as `completed` with a nonzero `exitCodeV2` in the JSON
 * `result` (the shape Claude Code's `Exit code N` text takes), so the exit code is read, not only `status`.
 */
const failureOf = (call: Obj, name: string): string | undefined => {
  if (call.status === 'error') return errorText(call.error ?? call.result);
  const result = name === 'run_terminal_cmd' ? parse(call.result) : undefined;
  const exit = isObj(result) ? num(result.exitCodeV2) : undefined;
  return exit === undefined || exit === 0 ? undefined : `Exit code ${String(exit)}
${isObj(result) ? (str(result.output) ?? '') : ''}`;
};

/** One message, as the lines `captureSession` reads. `at` is the best time known: the message's own, else the one before it. */
const linesOf = (bubble: Bubble, base: Obj, at: string, model: string | undefined): Obj[] => {
  const { document } = bubble;
  if (document.type === 1) {
    const text = str(document.text) ?? '';
    return text === '' ? [] : [{ ...base, type: 'user', uuid: bubble.id, timestamp: at, message: { role: 'user', content: [{ type: 'text', text }] } }];
  }
  const content: Obj[] = [];
  const text = str(document.text);
  if (text !== undefined) content.push({ type: 'text', text });
  const call = isObj(document.toolFormerData) ? document.toolFormerData : undefined;
  const name = call === undefined ? undefined : str(call.name);
  const callId = call === undefined ? undefined : (str(call.toolCallId) ?? bubble.id);
  if (call !== undefined && name !== undefined) content.push({ type: 'tool_use', id: callId, name: TOOL_NAMES[name] ?? name, input: inputOf(parse(call.params)) });
  const tokens = isObj(document.tokenCount) ? document.tokenCount : {};
  const input = num(tokens.inputTokens) ?? 0;
  const output = num(tokens.outputTokens) ?? 0;
  const message: Obj = { role: 'assistant', id: bubble.id, content };
  // A zero count means Cursor did not record one, so no usage is written rather than a measured zero.
  if (input > 0 || output > 0) message.usage = { input_tokens: input, output_tokens: output };
  const lines: Obj[] = [{ ...base, type: 'assistant', uuid: bubble.id, requestId: bubble.id, timestamp: at, ...(model === undefined ? {} : { requestedModel: model }), message }];
  if (call !== undefined && name !== undefined && (call.status === 'error' || call.status === 'completed') && !aborted(call, name)) {
    const failure = failureOf(call, name);
    lines.push({
      ...base,
      type: 'user',
      uuid: `${bubble.id}-result`,
      timestamp: at,
      // Cursor stamps a result with the call's own time, so the gap is not a measured duration: the extractor leaves durationMs null.
      noDuration: true,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, is_error: failure !== undefined, content: failure ?? '' }] },
    });
  }
  // A bubble with token counts but no text or tool call still carries usage, so it is kept.
  return content.length === 0 && message.usage === undefined ? [] : lines;
};

/** Opens the Cursor store under `root`; undefined when it holds no global store, so a machine without Cursor is skipped silently. */
export const openCursorStore = async (root: string): Promise<CursorStore | undefined> => {
  const globalFile = join(root, 'globalStorage', 'state.vscdb');
  if (!existsSync(globalFile)) return undefined;
  const db = await open(globalFile);
  const composers = new Map<string, Obj>();
  const sessions: CursorSession[] = [];
  let rejected: number;
  try {
    rejected = await collect(db, root, composers, sessions);
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    sessions,
    rejected,
    close: () => {
      db.close();
    },
    transcript: (session) => {
      const composer = composers.get(session.composerId) ?? {};
      const modelConfig = isObj(composer.modelConfig) ? composer.modelConfig : {};
      const base: Obj = { sessionId: session.composerId, ...(session.folder === null ? {} : { cwd: session.folder }) };
      const bubbles = bubblesOf(db, session.composerId, composer);
      // A bubble's own `createdAt`, else `timingInfo.clientStartTime` when it is an epoch time at or after the composer's start (a smaller
      // value is a relative clock and says nothing about when); a user bubble with neither takes the next assistant bubble's time.
      const own = (bubble: Bubble): string | undefined => {
        const created = str(bubble.document.createdAt);
        if (created !== undefined && !Number.isNaN(Date.parse(created))) return created;
        const timing = isObj(bubble.document.timingInfo) ? num(bubble.document.timingInfo.clientStartTime) : undefined;
        return timing !== undefined && session.createdAt > 0 && timing >= session.createdAt ? iso(timing) : undefined;
      };
      const stamps = bubbles.map(own);
      const stamped = (index: number): string | undefined => {
        const known = stamps[index];
        if (known !== undefined || bubbles[index]?.document.type !== 1) return known;
        return stamps.find((next, after) => after > index && bubbles[after]?.document.type !== 1 && next !== undefined);
      };
      // Cursor does not keep bubble times in order (14 of 9,712 lines in the 2026-11-02 copy ran backward), and the store's own timestamp
      // invariant holds that time never steps back: a bubble earlier than the one before it takes the one before it. The session starts at
      // its first stamped bubble (the composer's `createdAt` only when none is stamped), so a bubble with no time never precedes a stamped one.
      let at = stamps.find((first) => first !== undefined) ?? iso(session.createdAt) ?? new Date(0).toISOString();
      const lines: Obj[] = [];
      for (const [index, bubble] of bubbles.entries()) {
        const time = stamped(index);
        if (time !== undefined && Date.parse(time) >= Date.parse(at)) at = time;
        const info = isObj(bubble.document.modelInfo) ? bubble.document.modelInfo : {};
        lines.push(...linesOf(bubble, base, at, str(info.modelName) ?? str(modelConfig.modelName)));
      }
      return lines.map((line) => JSON.stringify(line)).join('\n') + (lines.length === 0 ? '' : '\n');
    },
  };
};

/** Reads every composer session's header out of the global store and returns how many it rejected; a throw leaves the caller to close `db`. */
/** A composer id becomes `skeletons/cursor-<id>.json`, so only the id shape the store writes is accepted: no separator, not all dots. */
const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;

const collect = async (db: Database, root: string, composers: Map<string, Obj>, sessions: CursorSession[]): Promise<number> => {
  let rejected = 0;
  const folders = await workspaceFolders(root);
  for (const row of db.prepare("select cast(key as text) as k, cast(value as text) as v from cursorDiskKV where key like 'composerData:%'").all()) {
    const composer = parse(row.v);
    if (!isObj(composer) || typeof row.k !== 'string') continue;
    const composerId = str(composer.composerId) ?? row.k.slice('composerData:'.length);
    const headers = Array.isArray(composer.fullConversationHeadersOnly) ? composer.fullConversationHeadersOnly.length : 0;
    const inline = Array.isArray(composer.conversation) ? composer.conversation.length : 0;
    if (!SAFE_ID.test(composerId)) {
      rejected += 1;
      continue;
    }
    // A composer with no message was opened and left; it has nothing to capture.
    if (headers + inline === 0) continue;
    const createdAt = num(composer.createdAt) ?? 0;
    composers.set(composerId, composer);
    sessions.push({ composerId, folder: folders.get(composerId) ?? null, createdAt, lastUpdatedAt: num(composer.lastUpdatedAt) ?? createdAt, messages: headers > 0 ? headers : inline });
  }
  sessions.sort((a, b) => a.createdAt - b.createdAt || a.composerId.localeCompare(b.composerId));
  return rejected;
};
