// Where a replay reads: the raw transcripts of the allowed folders, the harness's copy first and then what only the archive still holds. Reads only.
import { join } from 'node:path';
import type { Allow } from '../sessions/allow.js';
import { INJECTED_TAGS, isErrorResult, isObj, LEADING_TAG, resultText, type Obj } from '../sessions/extract.js';
import type { Redactor } from '../sessions/redact.js';
import { SOURCES } from '../sessions/sources.js';
import { listDir, logLines, sessionFolders, subagentFiles } from '../sessions/store.js';
import { checkCall, type Crossing, type Removal, type UnreadShape } from './checks.js';
import { permissionOf, type Miss, type Origin, type Permission, type Status } from './record.js';

export interface TranscriptFile {
  file: string;
  project: string;
  /** The main session: a subagent's is its parent's. */
  session: string;
  /** The subagent transcript's own name; null on a main transcript. */
  agent: string | null;
}

const projectTranscripts = async (folder: string, project: string, seen: Set<string>): Promise<TranscriptFile[]> => {
  const found: TranscriptFile[] = [];
  const add = (file: TranscriptFile, relative: string): void => {
    if (seen.has(`${project}/${relative}`)) return;
    seen.add(`${project}/${relative}`);
    found.push(file);
  };
  for (const entry of await listDir(folder)) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) add({ file: join(folder, entry.name), project, session: entry.name.slice(0, -'.jsonl'.length), agent: null }, entry.name);
  }
  for (const { dir, path, parent, name } of await subagentFiles(folder, await sessionFolders(folder))) {
    add({ file: join(dir, name), project, session: parent, agent: name.slice(0, -'.jsonl'.length) }, [parent, 'subagents', ...path, name].join('/'));
  }
  return found;
};

/** One copy per project and relative path. `raw/` hard-links the same file, and the harness's copy, when it still has one, is at least as long. */
export const discover = async (roots: readonly string[], allow: Allow): Promise<{ files: TranscriptFile[]; unreadable: number }> => {
  const seen = new Set<string>();
  const files: TranscriptFile[] = [];
  let unreadable = 0;
  for (const root of roots) {
    // Replay reads only the harness's transcript format: a source-table folder (Cursor, Codex, Copilot, Gemini CLI, Grok Build) is not that format, and a project folder is never named for one.
    const projects = (await listDir(root)).filter((entry) => entry.isDirectory() && !SOURCES.some((source) => source.name === entry.name) && allow.allows(entry.name));
    for (const project of projects) {
      try {
        files.push(...(await projectTranscripts(join(root, project.name), project.name, seen)));
      } catch {
        unreadable += 1;
      }
    }
  }
  return { files, unreadable };
};

export interface Found {
  crossing: Crossing;
  ts: string | null;
  /** In memory only: where a registry option would ask. Never written. */
  cwd: string | null;
  toolUseId: string | null;
  permission: Permission;
  /** The call's position in its transcript, and the line it sits on. */
  call: number;
  line: number;
  side: boolean;
  status: Status;
  miss: Miss;
}

export interface FoundRemoval {
  removal: Removal;
  ts: string | null;
  status: Status;
}

/** A call's answer can sit in another file when a resumed transcript holds it, so the entries are shared across a run. */
interface CallEntry {
  found: Found[];
  removals: FoundRemoval[];
}

export type CallsSeen = Map<string, CallEntry>;

/** What a call that named nothing leaves in `CallsSeen`: shared, since nothing is ever added to it. */
const NO_ENTRY: CallEntry = { found: [], removals: [] };

export interface TranscriptRead {
  found: Found[];
  removals: FoundRemoval[];
  unread: UnreadShape[];
  /** The positions of the calls that pipe a download into a shell: a way around a stopped install. */
  pipes: number[];
  /** Every tool call line in this transcript, a replay of a resumed transcript's included: the position `Found.call` and `pipes` count in. */
  calls: number;
  /** The calls this transcript added to the run: those a transcript read earlier had not already shown. The run row's `calls`. */
  fresh: number;
  badLines: number;
}

const stringOf = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const blocksOf = (line: Obj): Obj[] => {
  const content = isObj(line.message) ? line.message.content : undefined;
  return Array.isArray(content) ? content.filter(isObj) : [];
};

const REFUSED = /^The user doesn't want to (?:proceed|take)/;

/** What a failed result says when the thing named does not exist. Read here and never kept: the record holds only the closed value. */
const NOT_FOUND: readonly RegExp[] = [
  /\bE404\b|404 Not Found|is not in this registry|could not determine executable/i,
  /No matching distribution|Could not find a version|404 Client Error|Package .{0,200} not found/i,
  // The harness says "No such tool available". A server's own "unknown tool" names one of its actions (a batch step), so the server exists.
  /No such tool available|server .{0,200} not (?:found|connected)/i,
  /Unknown skill|skill .{0,200} not found/i,
];

const statusOf = (block: Obj, text: string): Status => {
  if (!isErrorResult(block, text)) return 'ok';
  return REFUSED.test(text) ? 'refused' : 'error';
};

const settle = (entry: CallEntry, block: Obj): void => {
  if (entry.found.every((one) => one.status !== 'none') && entry.removals.every((one) => one.status !== 'none')) return;
  const text = resultText(block);
  const status = statusOf(block, text);
  const miss: Miss = status === 'error' && NOT_FOUND.some((pattern) => pattern.test(text)) ? 'not-found' : 'none';
  for (const found of entry.found) {
    found.status = status;
    found.miss = miss;
  }
  for (const removal of entry.removals) removal.status = status;
};

const parseLine = (raw: string): { line: Obj | null; bad: boolean } => {
  if (raw === '') return { line: null, bad: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    return { line: isObj(parsed) && parsed.type !== 'api-request-blob' ? parsed : null, bad: false };
  } catch {
    return { line: null, bad: true };
  }
};

/** The first pass: every call and its answer. Text is read only to settle a status; nothing of it leaves this function. */
export const readCalls = async (file: string, agent: string | null, redact: Redactor, seen: CallsSeen): Promise<TranscriptRead> => {
  const read: TranscriptRead = { found: [], removals: [], unread: [], pipes: [], calls: 0, fresh: 0, badLines: 0 };
  let position = -1;
  let permission: Permission = 'unknown';
  const readUse = (line: Obj, block: Obj): void => {
    read.calls += 1;
    const id = stringOf(block.id);
    if (id !== null && seen.has(id)) return;
    read.fresh += 1;
    const check = checkCall({ tool: stringOf(block.name) ?? '', input: block.input }, redact);
    if (check.crossings.length === 0 && check.unread.length === 0 && check.removals.length === 0) {
      // Seen all the same, so a transcript that replays this call does not count it twice.
      if (id !== null) seen.set(id, NO_ENTRY);
      return;
    }
    const ts = stringOf(line.timestamp);
    const side = agent !== null || line.isSidechain === true;
    const found = check.crossings.map((crossing): Found => ({ crossing, ts, cwd: stringOf(line.cwd), toolUseId: id, permission, call: read.calls, line: position, side, status: 'none', miss: 'none' }));
    const removals = check.removals.map((removal): FoundRemoval => ({ removal, ts, status: 'none' }));
    read.found.push(...found);
    read.removals.push(...removals);
    read.unread.push(...check.unread);
    if (check.unread.includes('pipe-to-shell')) read.pipes.push(read.calls);
    if (id !== null) seen.set(id, { found, removals });
  };
  for await (const raw of logLines(file)) {
    position += 1;
    const { line, bad } = parseLine(raw);
    if (bad) read.badLines += 1;
    if (line === null) continue;
    const mode = stringOf(line.permissionMode);
    if (mode !== null) permission = permissionOf(mode);
    for (const block of blocksOf(line)) {
      if (block.type === 'tool_use') readUse(line, block);
      else if (block.type === 'tool_result') {
        const entry = seen.get(stringOf(block.tool_use_id) ?? '');
        if (entry !== undefined) settle(entry, block);
      }
    }
  }
  return read;
};

const REPO_TOOLS: ReadonlySet<string> = new Set(['Read', 'NotebookRead', 'Grep', 'Glob', 'LS']);
const WEB_TOOLS: ReadonlySet<string> = new Set(['WebFetch', 'WebSearch']);

const resultSource = (tool: string | undefined): Origin => {
  if (tool === undefined) return 'tool-output';
  if (REPO_TOOLS.has(tool)) return 'repo-file';
  if (WEB_TOOLS.has(tool)) return 'web';
  return tool === 'Skill' ? 'skill' : 'tool-output';
};

/** A meta line is a skill's or a command's body. A leading tag the harness injects is the harness speaking, not the operator. */
const textSource = (line: Obj, text: string): Origin => {
  if (line.isMeta === true) return 'skill';
  const tag = LEADING_TAG.exec(text)?.[1];
  return tag !== undefined && INJECTED_TAGS.has(tag) ? 'harness' : 'prompt';
};

type Sourced = readonly [Origin, string];

const sourcedTexts = (line: Obj, tools: Map<string, string>): readonly Sourced[] => {
  if (line.type === 'attachment') return isObj(line.attachment) ? [['harness', JSON.stringify(line.attachment)]] : [];
  if (line.type === 'assistant') {
    for (const block of blocksOf(line)) {
      const id = stringOf(block.id);
      const name = stringOf(block.name);
      if (block.type === 'tool_use' && id !== null && name !== null) tools.set(id, name);
    }
    return [];
  }
  if (line.type !== 'user') return [];
  const content = isObj(line.message) ? line.message.content : undefined;
  if (typeof content === 'string') return [[textSource(line, content), content]];
  return blocksOf(line).flatMap((block): readonly Sourced[] => {
    if (block.type === 'tool_result') return [[resultSource(tools.get(stringOf(block.tool_use_id) ?? '')), resultText(block)]];
    const text = block.type === 'text' ? stringOf(block.text) : null;
    return text === null ? [] : [[textSource(line, text), text]];
  });
};

const canon = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');

const patternOf = (name: string): string =>
  name
    .split(/[-_.]+/)
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'))
    .join('[-_.]+');

/**
 * The second pass, only for a transcript with a crossing, so the text of the rest is not read twice. A name's origin is what first showed it before
 * its first crossing in this transcript, because after that the crossing's own output names it. Nothing shown, and it is `none-seen`, which says the
 * transcript shows no source; the agent's own words do not count, since they are the thing being asked about.
 */
export interface Origins {
  origins: Map<string, Origin>;
  /** Names a main-line or subagent prompt showed before their first crossing, whatever showed them first: the operator typing a name is a decision whoever saw it first. */
  prompted: Set<string>;
}

export const readOrigins = async (file: string, firstLines: ReadonlyMap<string, number>, servers: ReadonlySet<string>): Promise<Origins> => {
  const origins = new Map<string, Origin>();
  const prompted = new Set<string>();
  const byCanon = new Map<string, string[]>();
  for (const name of firstLines.keys()) byCanon.set(canon(name), [...(byCanon.get(canon(name)) ?? []), name]);
  const alternatives = [...firstLines.keys()]
    .sort((one, two) => two.length - one.length)
    .map(patternOf)
    .join('|');
  // Not inside a longer word or a path: `lib` is neither `lib-extra` nor `other/lib`, while `/lib` is how a skill is typed.
  // An MCP server reaches the agent only as `mcp__<server>__<tool>`, which that rule refuses (`_` joins words), so that spelling is a mention too,
  // but only of a name that crossed as a server, so a listed server that was never called lends its name to nothing; origins are keyed by name, so a package that also crossed as that server in the same transcript shares its origin. With no server the branch is
  // left out, since an empty alternation matches everywhere.
  const serverNames = [...servers]
    .sort((one, two) => two.length - one.length)
    .map(patternOf)
    .join('|');
  const serverBranch = serverNames === '' ? '' : `|(?<=(?<!\\w)mcp__)(?:${serverNames})(?=__)`;
  const words = new RegExp(`(?<![\\w@.-])(?<![\\w.-]/)(?:${alternatives})(?![\\w-]|\\.\\w)${serverBranch}`, 'gi');
  const last = Math.max(...firstLines.values());
  const tools = new Map<string, string>();
  let position = -1;
  for await (const raw of logLines(file)) {
    position += 1;
    if (position >= last) break;
    const { line } = parseLine(raw);
    if (line === null) continue;
    for (const [source, text] of sourcedTexts(line, tools)) {
      for (const match of text.matchAll(words)) {
        for (const name of byCanon.get(canon(match[0])) ?? []) {
          if (position >= (firstLines.get(name) ?? 0)) continue;
          if (!origins.has(name)) origins.set(name, source);
          if (source === 'prompt') prompted.add(name);
        }
      }
    }
  }
  return { origins, prompted };
};

