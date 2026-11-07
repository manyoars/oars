// The OpenCode source: an OpenCode session becomes the same capture records a Claude Code transcript does.
//
// FIXTURE-DERIVED: written from the public source of OpenCode (github.com/sst/opencode @ 21bf6b493b76efcf3769ade999f05163760d61af, MIT, packages cli and core 2.2.5), not
// from a live store. Nothing was copied; the reader is original. No vendor text promises the database layout (the repository promises deprecation aliases for the SDK and
// plugin API only, AGENTS.md:174-180), and no hook or SDK surface carries history, so `docs/sessions-store.md` says what a live run would still have to prove.
//
// Where it reads from (`opencodeRoot`): `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`, on every platform (packages/util/src/global-roots.ts:5,
// global.ts:13); the file is `opencode.db` (packages/cli/src/database-path.ts:4-12; `OPENCODE_DB` and a channel build's `opencode-<channel>.db` are not read). It is
// SQLite in WAL mode, opened read-only. Three tables hold a session (packages/core/src/session/sql.ts):
//   session_v2       :29   id (`ses_...`), parent_id (a subagent's parent), fork_session_id, directory (the latest cwd), version (the OpenCode version), agent, time_updated
//   session_message  :87   id, session_id, type, seq, time_created, data: the message minus `type` and `id` (projector.ts:662), times in epoch milliseconds
//     user       {text, files}                                   the operator's prompt
//     assistant  {agent, model {id, providerID}, content[], tokens {input, output, reasoning, cache {read, write}}, time {created}}   one model step
//     shell      {command, status, exit, output {output}}        the operator's own `!cmd`
//     location-switched {location {directory}, previous {location {directory}}}   a directory change (schema/src/session-message.ts:59-70)
//     synthetic, system, skill, compaction, idle, agent-switched, model-switched   not a prompt and not read
//   session_part     :108  message_id, ordinal, type, data: an assistant's content as rows, written only when `experimental.part_rows` is on (projector.ts:316-320). Upstream
//                          reads the parts first and any inline content after them (session/history.ts:90-125), and so does this reader.
// A content block is `text`, `reasoning` (not read), or `tool {id, name, state, time}`; `state.status` is streaming, running, completed, or error. A tool that is still
// streaming or running has no outcome. The shell tool completes whatever the exit code and records it in `state.metadata.exit` (core/src/shell/result.ts:41-47), with a notice
// line appended to the text (:30-35), so the exit code decides, not the status; a thrown failure is `state.error {type, message}`.
// A fork copies its parent's messages as `msg_<event id>_<seq>` (projector.ts:198, :226); those are the parent's and are skipped. A subagent is its own session with `parent_id`.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

/** The OpenCode data folder for an environment; a test passes its own so it never reads the real one. */
export const opencodeRoot = (env: { [name: string]: string | undefined }, home: string = homedir()): string => {
  const set = env.XDG_DATA_HOME;
  return join(set === undefined || set === '' ? join(home, '.local', 'share') : set, 'opencode');
};

/** A stored path in the form this platform uses: OpenCode stores a Windows path with forward slashes (core/src/database/path.ts:6-34). */
export const platformPath = (path: string, platform: NodeJS.Platform = process.platform): string => (platform === 'win32' && /^(?:[A-Za-z]:\/|\/\/)/.test(path) ? path.replaceAll('/', '\\') : path);

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

/** A session found in the store, before its messages are read. */
export interface OpencodeSession {
  /** The `ses_...` id, which names the skeleton. */
  id: string;
  /** `session_v2.directory`; null when it names none. */
  folder: string | null;
  /** The parent session's id for a subagent, else null. */
  parent: string | null;
  agent: string | null;
  version: string | null;
  /** Whether the session was forked from another, whose messages it copied. */
  forked: boolean;
  createdAt: number;
  /** Messages the session holds; with `mtimeMs` (its `time_updated`) the cursor `state.json` keeps. */
  size: number;
  mtimeMs: number;
}

export interface OpencodeStore {
  sessions: OpencodeSession[];
  /** The session as transcript text for `captureSession`; throws when it holds no parseable message. */
  transcript: (session: OpencodeSession) => string;
  /** Sessions skipped because their id is not a safe file name (it names a skeleton), counted so the skip is never silent. */
  rejected: number;
  close: () => void;
}

interface Database {
  prepare: (sql: string) => { all: (...params: string[]) => { [column: string]: unknown }[] };
  close: () => void;
}

/** `node:sqlite` is loaded only when an OpenCode store exists: it prints an experimental-feature warning on first use. */
const open = async (file: string): Promise<Database> => {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
};

const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;
const DATABASE = 'opencode.db';
/** A message a fork copied from its parent: `msg_<event id>_<seq>`; OpenCode's own ids hold no underscore after the prefix (schema/src/identifier.ts:5-9). */
const COPIED = /^msg_[0-9A-Za-z]+_\d+$/;
const Y2000 = Date.parse('2000-01-01T00:00:00Z');
const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
/** The notice the shell tool appends to its text for a nonzero exit, a signal, or a timeout (core/src/shell/result.ts:30-35); the reader writes its own header. */
const NOTICE = /(?:^|\n)(?:Exited with code \d+|Killed by \S+|Timed out before completion)$/;

/** OpenCode's tool names, in the vocabulary prompt classes and `files` are computed in. A name with no counterpart keeps its own. */
const TOOL_NAMES: { [opencode: string]: string } = { shell: 'Bash', edit: 'Edit', write: 'Write', patch: 'Edit', read: 'Read', grep: 'Grep', glob: 'Glob' };

/** A path the model named, made absolute against the session's folder; the folder's own style (POSIX or Windows) decides the join. */
const absolute = (path: string, cwd: string | undefined): string => {
  if (cwd === undefined || posix.isAbsolute(path) || win32.isAbsolute(path)) return path;
  return (cwd.startsWith('/') ? posix : win32).join(cwd, path);
};

/** The text parts of a tool state's `content[]` (`{type: "text", text}`, schema/src/tool.ts:67-71). */
const contentText = (state: Obj): string =>
  (Array.isArray(state.content) ? state.content : []).flatMap((part) => (isObj(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])).join('\n');

/** The files a call changes or touches, from the keys its input declares (`path` for edit, write, and read; the headers of `patchText` for patch). */
const pathsOf = (name: string, input: Obj, cwd: string | undefined): string[] => {
  if (name === 'patch') return [...(str(input.patchText) ?? '').matchAll(PATCH_HEADER)].map((match) => absolute(String(match[1]).trim(), cwd));
  const path = str(input.path);
  return path === undefined ? [] : [absolute(path, cwd)];
};

interface Outcome {
  settled: boolean;
  failure: string | undefined;
  output: string;
}

/** What a tool state says happened. A shell call is read by its recorded exit, signal, and timeout, not by `status`. */
const outcomeOf = (name: string, state: Obj): Outcome => {
  const status = str(state.status);
  const text = contentText(state);
  if (status === 'error') {
    const error = isObj(state.error) ? str(state.error.message) : undefined;
    // Only the message goes on the line: the wrapper (`{type, message, status, response}`) would never match a Claude Code error signature.
    return { settled: true, failure: error ?? (text === '' ? 'tool failed' : text), output: '' };
  }
  if (status !== 'completed') return { settled: false, failure: undefined, output: '' };
  if (name !== 'shell') return { settled: true, failure: undefined, output: '' };
  const meta = isObj(state.metadata) ? state.metadata : {};
  const exit = num(meta.exit);
  const signal = str(meta.signal);
  const body = text.replace(NOTICE, '');
  if (exit !== undefined && exit !== 0) return { settled: true, failure: `Exit code ${String(exit)}\n${body}`, output: '' };
  if (meta.timeout === true) return { settled: true, failure: body === '' ? 'Timed out before completion' : body, output: '' };
  if (signal !== undefined) return { settled: true, failure: body === '' ? `Killed by ${signal}` : body, output: '' };
  return { settled: true, failure: undefined, output: body };
};

interface Reading {
  lines: Obj[];
  bad: number;
}

/** One session's rows as the lines `captureSession` reads. */
const linesOf = (session: OpencodeSession, rows: { [column: string]: unknown }[], parts: Map<string, Obj[]>): Reading => {
  const lines: Obj[] = [];
  let bad = 0;
  const parsed = rows.flatMap((row) => {
    const data = parse(row.data);
    const id = str(row.id);
    const type = str(row.type);
    if (!isObj(data) || id === undefined || type === undefined) {
      bad += 1;
      return [];
    }
    // A fork's copied prefix is its parent's session, with the parent's usage and prompts.
    return session.forked && COPIED.test(id) ? [] : [{ id, type, data, created: num(row.time_created) }];
  });
  if (rows.length > 0 && parsed.length === 0 && bad > 0) throw new Error('no parseable message');
  // The folder the session started in: the latest `directory` holds for a session that moved, so the first switch's `previous` names the earlier one.
  const firstSwitch = parsed.find((row) => row.type === 'location-switched');
  const previous = firstSwitch !== undefined && isObj(firstSwitch.data.previous) && isObj(firstSwitch.data.previous.location) ? str(firstSwitch.data.previous.location.directory) : undefined;
  let cwd: string | undefined = previous === undefined ? (session.folder ?? undefined) : platformPath(previous);
  let clock = session.createdAt >= Y2000 ? session.createdAt : 0;
  // A missing, relative, or earlier time says nothing about when: the latest time so far stands, so no time goes backward.
  const stamp = (value: unknown, fallback: number | undefined): string => {
    const own = num(value);
    const known = own !== undefined && own >= Y2000 ? own : fallback !== undefined && fallback >= Y2000 ? fallback : undefined;
    if (known !== undefined && known > clock) clock = known;
    return new Date(clock).toISOString();
  };
  const timeOf = (data: Obj, key: string): unknown => (isObj(data.time) ? data.time[key] : undefined);
  const base = (): Obj => ({ sessionId: session.id, ...(cwd === undefined ? {} : { cwd }), ...(session.version === null ? {} : { version: session.version }) });
  for (const row of parsed) {
    const { id, data } = row;
    if (row.type === 'location-switched') {
      const to = isObj(data.location) ? str(data.location.directory) : undefined;
      if (to !== undefined) cwd = platformPath(to);
      continue;
    }
    if (row.type === 'user') {
      const text = str(data.text);
      const files = Array.isArray(data.files) && data.files.length > 0;
      if (text === undefined && !files) continue;
      lines.push({ ...base(), type: 'user', uuid: id, timestamp: stamp(timeOf(data, 'created'), row.created), message: { role: 'user', content: [text === undefined ? { type: 'image' } : { type: 'text', text }] } });
      continue;
    }
    if (row.type === 'shell') {
      const command = str(data.command);
      if (command === undefined) continue;
      const callId = str(data.shellID) ?? id;
      const started = stamp(timeOf(data, 'created'), row.created);
      lines.push({ ...base(), type: 'assistant', uuid: id, requestId: id, timestamp: started, message: { role: 'assistant', id, content: [{ type: 'tool_use', id: callId, name: 'Bash', native: 'shell', input: { command } }] } });
      const status = str(data.status);
      if (status !== 'exited' && status !== 'timeout' && status !== 'killed') continue;
      const exit = num(data.exit);
      const output = isObj(data.output) ? (str(data.output.output) ?? '') : '';
      const failure = exit !== undefined && exit !== 0 ? `Exit code ${String(exit)}\n${output}` : status === 'exited' ? undefined : output === '' ? `Shell ${status}` : output;
      lines.push({ ...base(), type: 'user', uuid: `${id}-result`, timestamp: stamp(timeOf(data, 'completed'), row.created), noDuration: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, is_error: failure !== undefined, content: failure ?? (output === '' ? '' : `Exit code 0\n${output}`) }] } });
      continue;
    }
    if (row.type !== 'assistant') continue;
    const model = isObj(data.model) ? str(data.model.id) : undefined;
    const content: Obj[] = [];
    const results: { id: string; outcome: Outcome; at: unknown }[] = [];
    const blocks = [...(parts.get(id) ?? []), ...(Array.isArray(data.content) ? data.content.filter(isObj) : [])];
    const started = stamp(timeOf(data, 'created'), row.created);
    for (const block of blocks) {
      if (block.type === 'text') {
        const text = str(block.text);
        if (text !== undefined) content.push({ type: 'text', text });
        continue;
      }
      const name = block.type === 'tool' ? str(block.name) : undefined;
      const callId = str(block.id);
      if (name === undefined || callId === undefined) continue;
      const state = isObj(block.state) ? block.state : {};
      const input = isObj(state.input) ? state.input : {};
      const claude = TOOL_NAMES[name];
      const files = claude === 'Edit' || claude === 'Write' || claude === 'Read' ? pathsOf(name, input, cwd) : [];
      const shaped: Obj =
        name === 'shell'
          ? { command: str(input.command) }
          : files[0] !== undefined
            ? { file_path: files[0] }
            : name === 'grep' || name === 'glob'
              ? { pattern: str(input.pattern), path: str(input.path) }
              : name === 'skill'
                ? { skill: str(input.id) }
                : input;
      content.push({ type: 'tool_use', id: callId, name: claude ?? name, native: name, input: Object.fromEntries(Object.entries(shaped).filter(([, value]) => value !== undefined)) });
      const outcome = outcomeOf(name, state);
      const time = isObj(block.time) ? block.time : {};
      if (outcome.settled) results.push({ id: callId, outcome, at: time.completed ?? time.ran });
      // A patch names several files; the first rides the call's own block, and each other gets its own in the same response, with the same outcome.
      for (const [index, extra] of files.slice(1).entries()) {
        const extraId = `${callId}:${String(index + 2)}`;
        content.push({ type: 'tool_use', id: extraId, name: 'Edit', native: name, input: { file_path: extra } });
        if (outcome.settled) results.push({ id: extraId, outcome, at: time.completed ?? time.ran });
      }
    }
    const tokens = isObj(data.tokens) ? data.tokens : {};
    const cache = isObj(tokens.cache) ? tokens.cache : {};
    const input = num(tokens.input) ?? 0;
    const output = num(tokens.output) ?? 0;
    const reasoning = num(tokens.reasoning) ?? 0;
    const read = num(cache.read) ?? 0;
    const write = num(cache.write) ?? 0;
    // `tokens.input` is the non-cached part (core/src/session/usage.ts:12), already disjoint from the cache fields, so it is not reduced again; `output` excludes the reasoning
    // tokens (ai/src/schema/events.ts:88-90), while Claude Code's `output_tokens` includes them, so the two are added and the reasoning is kept as `thinking`.
    // All five zero means OpenCode recorded no figure (usage.ts:9-12 turns a missing one into zeros), so no usage is written rather than a measured zero.
    const reported = input + output + reasoning + read + write > 0;
    const message: Obj = { role: 'assistant', id, content };
    if (reported) message.usage = { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output + reasoning, output_tokens_details: { thinking_tokens: reasoning } };
    if (content.length === 0 && !reported) continue;
    lines.push({ ...base(), type: 'assistant', uuid: id, requestId: id, timestamp: started, ...(model === undefined ? {} : { requestedModel: model }), message });
    for (const [index, result] of results.entries()) {
      lines.push({
        ...base(),
        type: 'user',
        uuid: `${id}-r${String(index + 1)}`,
        timestamp: stamp(result.at, undefined),
        // The call's start is not paired with its completion here, so no duration is claimed.
        noDuration: true,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: result.id, is_error: result.outcome.failure !== undefined, content: result.outcome.failure ?? (result.outcome.output === '' ? '' : `Exit code 0\n${result.outcome.output}`) }] },
      });
    }
  }
  return { lines, bad };
};

/** Opens the OpenCode store under `root`; undefined when it holds no database, so a machine without OpenCode is skipped silently. A database that cannot be read throws. */
export const openOpencodeStore = async (root: string): Promise<OpencodeStore | undefined> => {
  const file = join(root, DATABASE);
  if (!existsSync(file)) return undefined;
  const db = await open(file);
  const sessions: OpencodeSession[] = [];
  let rejected = 0;
  try {
    const found = db
      .prepare(
        'select s.id as id, s.parent_id as parent_id, s.fork_session_id as fork_session_id, s.directory as directory, s.version as version, s.agent as agent, s.time_created as time_created, ' +
          // Upstream settles a tool call, a `!cmd`, and text in place through updateMessage and part updates (projector.ts:337-339, :539-560, :1076-1113), which bump only
          // the message and part rows, so the cursor is the newest of the three.
          'max(s.time_updated, coalesce((select max(m.time_updated) from session_message m where m.session_id = s.id), 0), coalesce((select max(p.time_updated) from session_part p where p.session_id = s.id), 0)) as time_updated, ' +
          '(select count(*) from session_message m where m.session_id = s.id) as messages from session_v2 s',
      )
      .all();
    // Read here so a database without the message tables throws at open, where the deposit warns naming the file.
    db.prepare('select 1 from session_part limit 1').all();
    for (const row of found) {
      const id = str(row.id);
      const messages = num(row.messages) ?? 0;
      if (id === undefined || !SAFE_ID.test(id)) {
        rejected += 1;
        continue;
      }
      // A session with no message was opened and left; it has nothing to capture.
      if (messages === 0) continue;
      const directory = str(row.directory);
      sessions.push({
        id,
        folder: directory === undefined ? null : platformPath(directory),
        parent: str(row.parent_id) ?? null,
        agent: str(row.agent) ?? null,
        version: str(row.version) ?? null,
        forked: str(row.fork_session_id) !== undefined,
        createdAt: num(row.time_created) ?? 0,
        size: messages,
        mtimeMs: num(row.time_updated) ?? 0,
      });
    }
  } catch (error) {
    db.close();
    throw error;
  }
  sessions.sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
  return {
    sessions,
    rejected,
    close: () => {
      db.close();
    },
    transcript: (session) => {
      const rows = db.prepare('select id, type, time_created, data from session_message where session_id = ? order by seq').all(session.id);
      const parts = new Map<string, Obj[]>();
      for (const row of db.prepare('select message_id, type, data from session_part where session_id = ? order by message_id, ordinal').all(session.id)) {
        const messageId = str(row.message_id);
        const data = parse(row.data);
        if (messageId === undefined || !isObj(data)) continue;
        parts.set(messageId, [...(parts.get(messageId) ?? []), { type: str(row.type), ...data }]);
      }
      const { lines, bad } = linesOf(session, rows, parts);
      // A row that is not JSON is kept as a line that is not JSON, so `captureSession` counts it and the deposit line does not under-report.
      const text = [...lines.map((line) => JSON.stringify(line)), ...Array.from({ length: bad }, () => '<unreadable session_message row>')];
      return text.join('\n') + (text.length === 0 ? '' : '\n');
    },
  };
};
