// The source table: one entry per non-Claude harness whose sessions `deposit` can read. `--allow <name>` opens an entry, the nightly hook
// runtime, `allow.unmatched`, the deposit lines, `measure`, and `verify` read this table, so a new harness is one entry here plus its reader file.
// Claude Code is not an entry: its transcripts are files the deposit walks itself (`depositLocked`), and its behavior does not change.

import { join } from 'node:path';
import { codexRoot, openCodexStore } from './codex.js';
import { copilotRoot, openCopilotStore } from './copilot.js';
import { cursorRoot, openCursorStore } from './cursor.js';
import { grokRoot, openGrokStore } from './grok.js';
import type { SubagentOrigin } from './extract.js';
import { geminiRoot, openGeminiStore } from './gemini.js';
import { openPiStore, piSessionsDir } from './pi.js';
import { openOtelStore, otelRoot } from './otel.js';
import type { Harness } from './schema.js';
import { opencodeRoot, openOpencodeStore } from './opencode.js';
import { openVscodeCopilotStore, vscodeAppData } from './vscode-copilot.js';

/** A session found in a source, before its transcript is read. */
export interface SourceSession {
  /** Names the skeleton (`<source>-<id>`), so it is a safe file name. */
  id: string;
  /** The working folder (a path); null when the source names none. */
  folder: string | null;
  /** With `mtimeMs`, the cursor `state.json` keeps to tell a changed session from one already deposited. */
  size: number;
  mtimeMs: number;
  /** Set when the session is a spawned agent's: it is deposited as a subagent of its parent, so session counts stay main sessions. */
  subagent?: SubagentOrigin;
  /**
   * Set when a later read folded this session into another (`<id>` of that one): the deposit records the supersede for a session it already holds, with no transcript,
   * and records nothing for one it never held. `size` and `mtimeMs` are 0, a cursor no read session has.
   */
  supersededBy?: string;
}

export interface SourceStore {
  sessions: SourceSession[];
  /** The session as transcript text for `captureSession`; throws when it cannot be read. */
  transcript: (session: SourceSession) => string | Promise<string>;
  /** True when the session's file holds only the harness's own head records and no turn, so `sessions verify` counts it as empty, not unreadable; absent when the format has no such form. */
  headOnly?: (session: SourceSession) => boolean | Promise<boolean>;
  /** Sessions skipped because their id is not a safe file name, counted so the skip is never silent. */
  rejected: number;
  /** Files the reader dropped before they were sessions that held records in a shape it does not know; only `sessions verify` reads it, as seen and unreadable. Absent when the format has no such drop. */
  shapeMoved?: number;
  /** Items that could not be inspected, warned about once each and never fatal; `reason` names no path. */
  unreadable: readonly { file: string; reason: string }[];
  /** The file to blame when `transcript` throws for a session; the store's own file when a source keeps one. */
  where: (session: SourceSession) => string;
  close: () => void;
}

export interface Source {
  /** The `--allow` name, the first segment of its `state.json` keys, and the prefix of its skeleton names. */
  name: string;
  harness: Harness;
  /** How the deposit lines name it ("Cursor": `Read 3 Cursor sessions.`). */
  label: string;
  /** Where its store lives; the caller passes the environment so a test never reads the real one. */
  root: (platform: NodeJS.Platform, env: { [name: string]: string | undefined }, home: string) => string;
  /** The file reported when the store as a whole cannot be opened. */
  storeFile: (root: string) => string;
  /** A session whose transcript cannot be read ends this source's deposit (Cursor's, as it was before the table) instead of skipping to the next. */
  stopOnTranscriptError?: boolean;
  /** Opens the store read-only; undefined when the machine has none, so a missing store is skipped silently. */
  open: (root: string) => Promise<SourceStore | undefined>;
}

/** A session handed back to its own store was listed by it, so a miss is a bug in the caller. */
const need = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('session not listed by its source');
  return value;
};

const cursor: Source = {
  name: 'cursor',
  harness: 'cursor',
  label: 'Cursor',
  stopOnTranscriptError: true,
  root: (platform, env, home) => cursorRoot(platform, env, home),
  storeFile: (root) => join(root, 'globalStorage', 'state.vscdb'),
  open: async (root) => {
    const store = await openCursorStore(root);
    if (store === undefined) return undefined;
    const byId = new Map(store.sessions.map((session) => [session.composerId, session]));
    return {
      sessions: store.sessions.map((session) => ({ id: session.composerId, folder: session.folder, size: session.messages, mtimeMs: session.lastUpdatedAt })),
      transcript: (session) => store.transcript(need(byId.get(session.id))),
      rejected: store.rejected,
      unreadable: [],
      where: () => join(root, 'globalStorage', 'state.vscdb'),
      close: store.close,
    };
  },
};

const codex: Source = {
  name: 'codex',
  harness: 'codex',
  label: 'Codex',
  root: (_platform, env, home) => codexRoot(env, home),
  storeFile: (root) => join(root, 'sessions'),
  open: async (root) => {
    const store = await openCodexStore(root);
    if (store === undefined) return undefined;
    const byId = new Map(store.sessions.map((session) => [session.id, session]));
    return {
      sessions: store.sessions.map((session) => ({
        id: session.id,
        folder: session.folder,
        size: session.size,
        mtimeMs: session.mtimeMs,
        ...(session.parent === null ? {} : { subagent: { parent: `codex-${session.parent}`, agentType: session.agentRole, spawnedBy: null } }),
      })),
      transcript: async (session) => await store.transcript(need(byId.get(session.id))),
      headOnly: async (session) => await store.headOnly(need(byId.get(session.id))),
      rejected: store.rejected,
      unreadable: store.unreadable,
      where: (session) => byId.get(session.id)?.file ?? root,
      close: () => undefined,
    };
  },
};

const copilot: Source = {
  name: 'copilot',
  harness: 'copilot',
  label: 'Copilot',
  root: (_platform, env, home) => copilotRoot(env, home),
  storeFile: (root) => join(root, 'session-state'),
  open: async (root) => {
    const store = await openCopilotStore(root);
    if (store === undefined) return undefined;
    const byId = new Map(store.sessions.map((session) => [session.id, session]));
    return {
      sessions: store.sessions.map((session) => ({ id: session.id, folder: session.folder, size: session.size, mtimeMs: session.mtimeMs })),
      transcript: async (session) => await store.transcript(need(byId.get(session.id))),
      headOnly: async (session) => await store.headOnly(need(byId.get(session.id))),
      rejected: store.rejected,
      unreadable: store.unreadable,
      where: (session) => byId.get(session.id)?.file ?? root,
      close: () => undefined,
    };
  },
};

const gemini: Source = {
  name: 'gemini',
  harness: 'gemini',
  label: 'Gemini',
  root: (_platform, env, home) => geminiRoot(env, home),
  storeFile: (root) => join(root, 'tmp'),
  open: async (root) => {
    const store = await openGeminiStore(root);
    if (store === undefined) return undefined;
    const byId = new Map(store.sessions.map((session) => [session.id, session]));
    return {
      sessions: store.sessions.map((session) => ({
        id: session.id,
        folder: session.folder,
        size: session.size,
        mtimeMs: session.mtimeMs,
        ...(session.parent === null ? {} : { subagent: { parent: `gemini-${session.parent}`, agentType: null, spawnedBy: null } }),
      })),
      transcript: async (session) => await store.transcript(need(byId.get(session.id))),
      rejected: store.rejected,
      shapeMoved: store.shapeMoved,
      unreadable: store.unreadable,
      where: (session) => byId.get(session.id)?.file ?? root,
      close: () => undefined,
    };
  },
};

const grok: Source = {
  name: 'grok',
  harness: 'grok',
  label: 'Grok Build',
  root: (_platform, env, home) => grokRoot(env, home),
  storeFile: (root) => join(root, 'sessions'),
  open: async (root) => {
    const store = await openGrokStore(root);
    if (store === undefined) return undefined;
    const byId = new Map(store.sessions.map((session) => [session.id, session]));
    return {
      sessions: store.sessions.map((session) => ({ id: session.id, folder: session.folder, size: session.size, mtimeMs: session.mtimeMs })),
      transcript: async (session) => await store.transcript(need(byId.get(session.id))),
      rejected: store.rejected,
      unreadable: store.unreadable,
      where: (session) => join(byId.get(session.id)?.dir ?? root, 'updates.jsonl'),
      close: () => undefined,
    };
  },
};

const opencode: Source = {
  name: 'opencode',
  harness: 'opencode',
  label: 'OpenCode',
  root: (_platform, env, home) => opencodeRoot(env, home),
  storeFile: (root) => join(root, 'opencode.db'),
  open: async (root) => {
    const store = await openOpencodeStore(root);
    if (store === undefined) return undefined;
    const byId = new Map(store.sessions.map((session) => [session.id, session]));
    return {
      sessions: store.sessions.map((session) => ({
        id: session.id,
        folder: session.folder,
        size: session.size,
        mtimeMs: session.mtimeMs,
        ...(session.parent === null ? {} : { subagent: { parent: `opencode-${session.parent}`, agentType: session.agent, spawnedBy: null } }),
      })),
      transcript: (session) => store.transcript(need(byId.get(session.id))),
      rejected: store.rejected,
      unreadable: [],
      where: () => join(root, 'opencode.db'),
      close: store.close,
    };
  },
};

const pi: Source = {
  name: 'pi',
  harness: 'pi',
  label: 'Pi',
  root: (_platform, env, home) => piSessionsDir(env, home),
  storeFile: (root) => root,
  open: async (root) => {
    const store = await openPiStore(root);
    if (store === undefined) return undefined;
    const byId = new Map(store.sessions.map((session) => [session.id, session]));
    return {
      sessions: store.sessions.map((session) => ({ id: session.id, folder: session.folder, size: session.size, mtimeMs: session.mtimeMs })),
      transcript: async (session) => await store.transcript(need(byId.get(session.id))),
      headOnly: async (session) => await store.headOnly(need(byId.get(session.id))),
      rejected: store.rejected,
      unreadable: store.unreadable,
      where: (session) => byId.get(session.id)?.file ?? root,
      close: () => undefined,
    };
  },
};

const vscodeCopilot: Source = {
  name: 'vscode-copilot',
  harness: 'vscode-copilot',
  label: 'VS Code Copilot Chat',
  root: (platform, env, home) => vscodeAppData(platform, env, home),
  storeFile: (root) => root,
  open: async (root) => {
    const store = await openVscodeCopilotStore(root);
    if (store === undefined) return undefined;
    const byId = new Map(store.sessions.map((session) => [session.id, session]));
    return {
      sessions: store.sessions.map((session) => ({ id: session.id, folder: session.folder, size: session.size, mtimeMs: session.mtimeMs })),
      transcript: async (session) => await store.transcript(need(byId.get(session.id))),
      headOnly: async (session) => await store.headOnly(need(byId.get(session.id))),
      rejected: store.rejected,
      unreadable: store.unreadable,
      where: (session) => byId.get(session.id)?.files[0] ?? root,
      close: () => undefined,
    };
  },
};

// A folder of OTLP JSON trace files (`$OARS_OTEL_TRACES`, else the config folder's `otel-traces`): a configured folder rather than an `import` command, so the cursor, the
// allowlist, the nightly run, and the fail-open reads are the ones every other source has.
const otel: Source = {
  name: 'otel',
  harness: 'otel',
  label: 'OpenTelemetry GenAI',
  root: (platform, env, home) => otelRoot(env, home, platform),
  storeFile: (root) => root,
  open: async (root) => {
    const store = await openOtelStore(root);
    if (store === undefined) return undefined;
    const byId = new Map(store.sessions.map((session) => [session.id, session]));
    return {
      sessions: [
        ...store.sessions.map((session) => ({ id: session.id, folder: session.folder, size: session.size, mtimeMs: session.mtimeMs, ...(session.subagent === undefined ? {} : { subagent: session.subagent }) })),
        ...store.superseded.map((entry) => ({ id: entry.id, folder: null, size: 0, mtimeMs: 0, supersededBy: entry.by })),
      ],
      transcript: (session) => (session.supersededBy === undefined ? store.transcript(need(byId.get(session.id))) : ''),
      headOnly: (session) => session.supersededBy === undefined && store.headOnly(need(byId.get(session.id))),
      rejected: store.rejected,
      shapeMoved: store.shapeMoved,
      unreadable: store.unreadable,
      where: (session) => byId.get(session.id)?.file ?? root,
      close: () => undefined,
    };
  },
};

/** Every non-Claude source, in the order the deposit reads them. */
export const SOURCES: readonly Source[] = [cursor, codex, copilot, gemini, grok, opencode, pi, vscodeCopilot, otel];

/** How a source is named in a deposit line; a name the table does not know (a test's) is its own label. */
export const sourceLabel = (name: string, table: readonly Source[] = SOURCES): string => table.find((source) => source.name === name)?.label ?? name;
