// The Pi source: a Pi coding agent session file becomes the same capture records a Claude Code transcript does.
//
// FIXTURE-DERIVED: written from the public source and docs of the agent (github.com/badlogic/pi-mono, now earendil-works/pi, @ 085c84e98e7f4c950f2be606466fff4f75d8fe7c,
// packages/coding-agent/, npm `@earendil-works/pi-coding-agent` 1.5.0; the earlier `@mariozechner/pi-coding-agent` wrote the same files), not from a live store. Nothing was copied; the
// reader is original. No vendor text promises the format (docs/session-format.md names the file version and says an older file is migrated when loaded, and sends programs to the SDK),
// so `docs/sessions-store.md` says what a live run would still have to prove.
//
// Where it reads from (`piSessionsDir`): `$PI_CODING_AGENT_SESSION_DIR` when set (a flat folder of session files, session-manager.ts:942-955, main.ts:749-753), else `sessions/` under (`piRoot`): `$PI_CODING_AGENT_DIR`, else `~/.pi/agent` (`%USERPROFILE%\.pi\agent` on Windows) (src/config.ts:610, :613-614, :630-636, docs/environment-variables.md:81). A session is
// `sessions/--<cwd with its leading separator removed and / \ : turned into ->--/<ISO time with : . turned into ->_<session id>.jsonl` (docs/session-format.md:10-14,
// session-manager.ts:590-593). `--session-dir` and the `sessionDir` setting can also move it (docs/sessions.md:60); this reader does not follow those.
// A file is written only once a conversation exists, then appended to (session-manager.ts:1176-1190). Line 1 is the header and every later line is an entry:
//   session           {version, id, timestamp, cwd, parentSession?}: `version` is the FILE format's (1 linear, 2 tree, 3 `hookMessage` renamed `custom`), not Pi's; no app version is recorded.
//                     The session's cwd is fixed (docs/sessions.md:15): a `cd` inside a command is not tracked, and a resume from another folder runs in this one.
//   message           {id, parentId, timestamp (ISO), message}: `message.timestamp` is Unix ms (docs/message-types.md:5). Roles read here: `user` (content a string or text/image
//                     blocks), `assistant` (content text/thinking/toolCall blocks, `model`, `responseModel?`, `usage`, `stopReason`), `toolResult` (toolCallId, content text blocks,
//                     `isError`), and `bashExecution` (the operator's own `!cmd`: command, output, exitCode, cancelled). Every other role (`custom`, `hookMessage`, `branchSummary`,
//                     `compactionSummary`, `system`) is an extension's or the harness's text, not a prompt.
//   every other type  `model_change`, `thinking_level_change`, `usage`, `compaction`, `branch_summary`, `custom`, `custom_message`, `context_edit`, `label`, `session_info`: not read. The usage
//                     on a `compaction`, a `branch_summary`, and a `usage` entry is model work that is not a response, and a tool result's `usage` and `nestedCalls` are nested work
//                     (docs/message-types.md:177): none is a response of this session.
// Entries form a tree (`id`, `parentId`) and the leaf is the LAST entry in the file (session-manager.ts:1104-1112), so the branch the session is on is the path from the last entry to its
// root; that path is what is read, and an abandoned branch is not. A version 1 file has no ids and is one chain in file order (session-manager.ts:287-313). A fork or clone is a new file
// that starts with its parent's path and keeps the old entry times (createBranchedSession, session-manager.ts:1643-1735); its header names `parentSession` and carries the time the
// copy was made, so an entry timed before that is the parent's and is not this session's.
// `usage.input` is the uncached part already: Pi takes the cache reads and writes out of the provider's prompt count (packages/ai/src/api/openai-completions.ts:1536-1550, packages/ai/src/api/openai-responses-shared.ts:636-642;
// Anthropic's `input_tokens` is disjoint), and `reasoning` is inside `output` (docs/message-types.md:90), so the figures map one for one onto capture's disjoint fields. A response that
// ended in an error or an abort with every figure zero never reached the provider's count (packages/ai/src/api/anthropic-messages.ts:824 starts them at zero), so it has no usage rather than a zero one.
// Pi has no sub-agent in core (README.md:19); the example extension runs `pi --no-session` (examples/extensions/subagent/index.ts:389), which writes no file, so the parent's call is the record.

import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, posix, win32 } from 'node:path';
import { holdsOnlyKinds } from './head-only.js';

/** Pi expands a leading ~ in its path settings (config.ts:614, utils/paths.ts:134-137). */
const expandHome = (path: string, home: string): string => (path === '~' ? home : /^~[/\\]/.test(path) ? join(home, path.slice(2)) : path);

/** The Pi agent folder for an environment; a test passes its own so it never reads the real one. */
export const piRoot = (env: { [name: string]: string | undefined }, home: string = homedir()): string => {
  const set = env.PI_CODING_AGENT_DIR;
  return set === undefined || set === '' ? join(home, '.pi', 'agent') : expandHome(set, home);
};

/**
 * The folder the reader reads Pi sessions from. The user's own `PI_CODING_AGENT_SESSION_DIR` wins when set and non-empty: Pi writes session files straight into it, with no per-project
 * subfolder (session-manager.ts:1766-1768, main.ts:749-753), and lists only the `.jsonl` files directly in it (listSessionsFromDir, session-manager.ts:942-955). Otherwise it is `sessions/`
 * under the agent folder, whose files sit in `--<cwd>--` subfolders. `--session-dir` and the `sessionDir` setting are not read by this reader.
 */
export const piSessionsDir = (env: { [name: string]: string | undefined }, home: string = homedir()): string => {
  const set = env.PI_CODING_AGENT_SESSION_DIR;
  return set === undefined || set === '' ? join(piRoot(env, home), 'sessions') : expandHome(set, home);
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
export interface PiSession {
  /** The id in the file name, which names the skeleton. */
  id: string;
  /** The header's `cwd`; null when it names none. */
  folder: string | null;
  /** The session file. */
  file: string;
  size: number;
  mtimeMs: number;
}

export interface PiStore {
  sessions: PiSession[];
  /** The session as transcript text for `captureSession`; throws when the file cannot be read or holds no parseable line. */
  transcript: (session: PiSession) => Promise<string>;
  /** True when the file holds only its header and entries that carry no turn (`piHeadOnly`); `sessions verify` counts such a file as empty, not unreadable. */
  headOnly: (session: PiSession) => Promise<boolean>;
  /** Files skipped because their id is not a safe file name (it names a skeleton), counted so the skip is never silent. */
  rejected: number;
  /** Sessions that could not be inspected, reported once each and never fatal; the reason names no path. */
  unreadable: { file: string; reason: string }[];
}

const SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;
/** The tools that run a command (docs/cli.md:144-146); `bashExecution` is the operator's own. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell']);
/** The tools that change a file; each names it in `path` (tools/edit.ts:29-31, tools/write.ts:10-12). */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['edit', 'write']);
/** What a non-zero exit appends to the output (tools/bash.ts:436). */
const EXIT_SUFFIX = /(?:^|\n\n)Command exited with code (-?\d+)$/;
/** The header is one short line; a file whose first 64 KiB hold no line end is not a Pi file. */
const HEADER_BYTES = 65536;

/** An error's message with `file` cut to its base name, so a reason that is logged names no folder. */
const reasonOf = (error: unknown, file: string): string => (error instanceof Error ? error.message : String(error)).split(file).join(basename(file));
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** The non-blank lines that are not JSON (a torn write), kept so `captureSession` counts them and the deposit line reports them. */
export const piBadLines = (text: string): string[] => text.split('\n').filter((raw) => raw.trim() !== '' && parse(raw) === undefined);

/** The session header and the ten entry kinds the format defines that carry no turn (the list at the top of this file). A file of them alone is a session started and quit. */
const PI_HEAD_KINDS: ReadonlySet<string> = new Set(['session', 'model_change', 'thinking_level_change', 'usage', 'compaction', 'branch_summary', 'custom', 'custom_message', 'context_edit', 'label', 'session_info']);
export const piHeadOnly = (text: string): boolean => holdsOnlyKinds(text, PI_HEAD_KINDS);

/** A time in milliseconds, or undefined when it is not an absolute time after 2000. */
const MIN_MS = Date.parse('2000-01-01T00:00:00Z');
const absoluteMs = (ms: number | undefined): number | undefined => (ms !== undefined && ms >= MIN_MS ? ms : undefined);
const isoMs = (value: unknown): number | undefined => {
  const text = str(value);
  return text === undefined ? undefined : absoluteMs(Date.parse(text) || undefined);
};

/** An entry's time: its ISO `timestamp`, else the message's own Unix ms. */
const timeOf = (entry: Obj): number | undefined => isoMs(entry.timestamp) ?? (isObj(entry.message) ? absoluteMs(num(entry.message.timestamp)) : undefined);

/** A failed shell call's error line: a nonzero exit says so first, then the output. */
const failureOf = (exit: number, output: string): string => (exit < 0 && output.trim() !== '' ? output : `Exit code ${String(exit)}${output === '' ? '' : `\n${output}`}`);

/** The text of a content value: a string, or the text blocks of an array joined by line ends. */
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((block) => (isObj(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n');
};

/** A path the model named, made absolute against the session's folder; the folder's own style (POSIX or Windows) decides the join. */
const absolute = (path: string, cwd: string | undefined): string => {
  if (cwd === undefined || posix.isAbsolute(path) || win32.isAbsolute(path)) return path;
  return (cwd.startsWith('/') ? posix : win32).join(cwd, path);
};

/** The entries on the branch the session is on, in order: the path from the last entry to its root (version 2 and later), or every entry (version 1, which has no ids). */
const activePath = (header: Obj | undefined, body: Obj[]): Obj[] => {
  const version = num(header?.version) ?? 1;
  if (version < 2) return body;
  const byId = new Map<string, Obj>();
  for (const entry of body) {
    const id = str(entry.id);
    if (id !== undefined) byId.set(id, entry);
  }
  const path: Obj[] = [];
  const seen = new Set<string>();
  // The leaf is the last entry written (session-manager.ts:1104-1112); an id seen twice ends a cycle, and a parent that is gone ends a broken chain.
  let current: Obj | undefined = body.findLast((entry) => str(entry.id) !== undefined);
  while (current !== undefined) {
    const id = str(current.id);
    if (id === undefined || seen.has(id)) break;
    seen.add(id);
    path.push(current);
    const parent = str(current.parentId);
    current = parent === undefined ? undefined : byId.get(parent);
  }
  return path.reverse();
};

/** One session as the lines `captureSession` reads. */
export const piLines = (text: string, fallbackId: string): Obj[] => {
  const nonblank = text.split('\n').filter((raw) => raw.trim() !== '');
  if (nonblank.length > 0 && !nonblank.some((raw) => isObj(parse(raw)))) throw new Error('no parseable line');
  const entries = nonblank.map(parse).filter(isObj);
  const header = entries.find((entry) => entry.type === 'session');
  const headerMs = isoMs(header?.timestamp);
  // A fork or clone starts with its parent's path, which keeps the old times; the header's time is when the copy was made (session-manager.ts:1643-1735).
  const copiedBefore = str(header?.parentSession) === undefined ? undefined : headerMs;
  const kept = activePath(
    header,
    entries.filter((entry) => entry.type !== 'session'),
  ).filter((entry) => {
    const when = timeOf(entry);
    return copiedBefore === undefined || when === undefined || when >= copiedBefore;
  });
  const cwd = str(header?.cwd);
  const base: Obj = { sessionId: str(header?.id) ?? fallbackId, ...(cwd === undefined ? {} : { cwd }) };
  const lines: Obj[] = [];
  const calls = new Map<string, { shell: boolean }>();
  const settled = new Set<string>();
  let sequence = 0;
  let at = headerMs ?? 0;
  // The last assistant line since the last prompt, which the operator's own `!cmd` joins rather than counting as a response of its own.
  let lastResponse: { content: Obj[] } | undefined;
  const stamp = (entry: Obj): string | undefined => {
    const when = timeOf(entry);
    // A missing or earlier time says nothing about when: the latest time so far stands.
    if (when !== undefined && when > at) at = when;
    return at === 0 ? undefined : new Date(at).toISOString();
  };
  const result = (id: string, when: string | undefined, failure: string | undefined, output = ''): void => {
    sequence += 1;
    lines.push({
      ...base,
      type: 'user',
      uuid: `${fallbackId}-r${String(sequence)}`,
      ...(when === undefined ? {} : { timestamp: when }),
      // The result is stamped with its own time, but the call's start is not paired to it here, so no duration is claimed.
      noDuration: true,
      // The output follows an `Exit code 0` line, the shape a Claude Code Bash result has, so a `[branch sha]` line is still found for commit survival.
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: failure !== undefined, content: failure ?? (output === '' ? '' : `Exit code 0\n${output}`) }] },
    });
  };
  const response = (when: string | undefined, content: Obj[], extra: Obj = {}, message: Obj = {}): void => {
    sequence += 1;
    lines.push({
      ...base,
      type: 'assistant',
      uuid: `${fallbackId}-a${String(sequence)}`,
      // Every assistant line carries a requestId (`verify --strict` needs one), and each response has its own, so its usage counts once.
      requestId: `${fallbackId}-resp${String(sequence)}`,
      ...(when === undefined ? {} : { timestamp: when }),
      ...extra,
      message: { role: 'assistant', content, ...message },
    });
    lastResponse = { content };
  };
  const toolUse = (block: Obj): Obj => {
    const id = str(block.id) ?? '';
    const name = str(block.name) ?? '?';
    const input = isObj(block.arguments) ? block.arguments : {};
    if (SHELL_TOOLS.has(name)) {
      calls.set(id, { shell: true });
      const command = str(input.command);
      return { type: 'tool_use', id, name: 'Bash', native: name, input: command === undefined ? {} : { command } };
    }
    calls.set(id, { shell: false });
    if (EDIT_TOOLS.has(name)) {
      const path = str(input.path);
      return { type: 'tool_use', id, name: 'Edit', native: name, input: path === undefined ? {} : { file_path: absolute(path, cwd) } };
    }
    return { type: 'tool_use', id, name, input };
  };
  /** The usage a response reported; undefined when it reported none, or errored before the provider counted anything. */
  const usageOf = (message: Obj): Obj | undefined => {
    const raw = message.usage;
    if (!isObj(raw)) return undefined;
    const figures = { input: num(raw.input), read: num(raw.cacheRead), write: num(raw.cacheWrite), output: num(raw.output), thinking: num(raw.reasoning) };
    const stopped = message.stopReason === 'error' || message.stopReason === 'aborted';
    if (stopped && [figures.input, figures.read, figures.write, figures.output].every((figure) => (figure ?? 0) === 0)) return undefined;
    return {
      ...(figures.input === undefined ? {} : { input_tokens: figures.input }),
      ...(figures.read === undefined ? {} : { cache_read_input_tokens: figures.read }),
      ...(figures.write === undefined ? {} : { cache_creation_input_tokens: figures.write }),
      ...(figures.output === undefined ? {} : { output_tokens: figures.output }),
      ...(figures.thinking === undefined ? {} : { output_tokens_details: { thinking_tokens: figures.thinking } }),
    };
  };

  for (const entry of kept) {
    if (entry.type !== 'message' || !isObj(entry.message)) continue;
    const message = entry.message;
    const role = str(message.role);
    const when = stamp(entry);
    if (role === 'user') {
      const body = textOf(message.content);
      const image = Array.isArray(message.content) && message.content.some((block) => isObj(block) && block.type === 'image');
      if (body === '' && !image) continue;
      sequence += 1;
      lastResponse = undefined;
      // An image-only prompt keeps its line (an image block with no data); capture counts a turn only for a prompt with text, so it is not a counted turn.
      lines.push({ ...base, type: 'user', uuid: `${fallbackId}-u${String(sequence)}`, ...(when === undefined ? {} : { timestamp: when }), message: { role: 'user', content: [body === '' ? { type: 'image' } : { type: 'text', text: body }] } });
    } else if (role === 'assistant') {
      const content: Obj[] = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isObj(block)) continue;
        if (block.type === 'text' && str(block.text) !== undefined) content.push({ type: 'text', text: String(block.text) });
        else if (block.type === 'toolCall') content.push(toolUse(block));
      }
      const model = str(message.model);
      const reported = str(message.responseModel);
      const usage = usageOf(message);
      response(when, content, model === undefined ? {} : { requestedModel: model }, { ...(reported === undefined ? {} : { model: reported }), ...(usage === undefined ? {} : { usage }) });
    } else if (role === 'toolResult') {
      const id = str(message.toolCallId);
      const call = id === undefined ? undefined : calls.get(id);
      if (id === undefined || call === undefined || settled.has(id)) continue;
      settled.add(id);
      const output = textOf(message.content);
      if (message.isError !== true) {
        result(id, when, undefined, call.shell ? output : '');
      } else if (call.shell) {
        // A non-zero exit ends the text with the code (tools/bash.ts:434-440), the one place the persisted result keeps it; an abort, a timeout, and a spawn error carry no such suffix and stand as written.
        const exit = EXIT_SUFFIX.exec(output);
        result(id, when, exit === null ? (output === '' ? 'tool failed' : output) : failureOf(Number(exit[1]), output.slice(0, exit.index)));
      } else {
        result(id, when, output === '' ? 'tool failed' : output);
      }
    } else if (role === 'bashExecution') {
      // The operator's own `!cmd`: a real exit code, no model behind it.
      sequence += 1;
      const id = `${fallbackId}-bang${String(sequence)}`;
      const command = str(message.command);
      const block: Obj = { type: 'tool_use', id, name: 'Bash', native: 'bash', input: command === undefined ? {} : { command } };
      if (lastResponse === undefined) response(when, [block]);
      else lastResponse.content.push(block);
      const output = typeof message.output === 'string' ? message.output : '';
      const exit = num(message.exitCode);
      let failure: string | undefined;
      if (message.cancelled === true) failure = output === '' ? 'Command cancelled' : output;
      else if (exit === undefined) failure = output === '' ? 'Command ended without an exit code' : output;
      else if (exit !== 0) failure = failureOf(exit, output);
      result(id, when, failure, output);
    }
  }
  return lines;
};

/** The first line of a file, read from its first 64 KiB; undefined when the file is empty. */
const firstLine = async (file: string): Promise<string | undefined> => {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const line = text.split('\n', 1)[0] ?? '';
    return line.trim() === '' ? undefined : line;
  } finally {
    await handle.close();
  }
};

/** `base` is the sessions folder (`piSessionsDir`): its subfolders hold the files Pi groups by project, and a `.jsonl` file directly in it is one Pi wrote to a session folder the user chose. */
export const openPiStore = async (base: string): Promise<PiStore | undefined> => {
  const unreadable: { file: string; reason: string }[] = [];
  let folders;
  try {
    folders = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return undefined;
    return { sessions: [], transcript: () => Promise.reject(new Error('no sessions')), headOnly: () => Promise.resolve(false), rejected: 0, unreadable: [{ file: base, reason: reasonOf(error, base) }] };
  }
  const sessions: PiSession[] = [];
  let rejected = 0;
  const places = [base, ...folders.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).map((folder) => join(base, folder.name))];
  for (const dir of places) {
    let files;
    try {
      files = dir === base ? folders : await readdir(dir, { withFileTypes: true });
    } catch (error) {
      unreadable.push({ file: dir, reason: reasonOf(error, dir) });
      continue;
    }
    for (const entry of files.filter((candidate) => candidate.isFile() && candidate.name.endsWith('.jsonl')).sort((a, b) => a.name.localeCompare(b.name))) {
      // `<timestamp>_<id>.jsonl`: the timestamp has no underscore, so the id is everything after the first one (docs/session-format.md:11-14).
      const stem = entry.name.slice(0, -'.jsonl'.length);
      const id = stem.includes('_') ? stem.slice(stem.indexOf('_') + 1) : stem;
      if (!SAFE_ID.test(id)) {
        rejected += 1;
        continue;
      }
      const file = join(dir, entry.name);
      try {
        const first = await firstLine(file);
        const header = first === undefined ? undefined : parse(first);
        if (!isObj(header) || header.type !== 'session') {
          unreadable.push({ file, reason: 'no session header on the first line' });
          continue;
        }
        const info = await stat(file);
        sessions.push({ id, folder: str(header.cwd) ?? null, file, size: info.size, mtimeMs: Math.floor(info.mtimeMs) });
      } catch (error) {
        if (!missing(error)) unreadable.push({ file, reason: reasonOf(error, file) });
      }
    }
  }
  sessions.sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
  return {
    sessions,
    rejected,
    unreadable,
    headOnly: async (session) => piHeadOnly(await readFile(session.file, 'utf8')),
    transcript: async (session) => {
      const text = await readFile(session.file, 'utf8');
      const lines = [...piLines(text, session.id).map((line) => JSON.stringify(line)), ...piBadLines(text)];
      return lines.join('\n') + (lines.length === 0 ? '' : '\n');
    },
  };
};
