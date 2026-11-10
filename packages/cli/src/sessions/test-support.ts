import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import { defaultConfigDir } from '../credentials.js';
import type { CodexHookRuntime } from './codex-hook.js';
import { appendOwnerOnly } from './owner-only.js';
import type { SessionsRuntime } from './store.js';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

const dirs: string[] = [];

const HELD = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);
const ATTEMPTS = 50;
const DELAY_MS = 200;

/**
 * Removes a temp folder a git child may still hold as its cwd (a test that timed out leaves the child running). On Windows that is an
 * EPERM, and `rmSync`'s own `maxRetries` does not retry it for a live child's cwd on Node 24, so the retry is written out here.
 * Synchronous so the `afterEach` call sites stay as they are; the wait is `Atomics.wait`, which does not spin.
 */
export const removeHeld = (dir: string): void => {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= ATTEMPTS || !(error instanceof Error && 'code' in error && typeof error.code === 'string' && HELD.has(error.code))) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DELAY_MS);
    }
  }
};

/**
 * A folder a process had as its working directory, or held a file open in, cannot be renamed or removed on Windows until the system has closed that process's handles, which comes a moment after its exit is seen: CI failed
 * twice on `rm` of a temp home with `EPERM` after the detached child's pid was already gone (`hook-bin-stop.test.ts`, `hook-bin-machine.test.ts`). Renaming the folder is the probe for "no process holds it": it changes nothing the
 * test reads, fails as removal does while a handle is open, and succeeds the moment the handles are closed, so the wait ends on that condition and not on a delay. Anywhere but Windows the first try succeeds. Returns the folder
 * to remove (the renamed one), or the folder itself when it is already gone.
 */
export const waitUntilFree = async (folder: string): Promise<string> => {
  if (!existsSync(folder)) return folder;
  const moved = `${folder}.free`;
  await vi.waitFor(
    () => {
      renameSync(folder, moved);
    },
    { timeout: 25_000, interval: 50 },
  );
  return moved;
};

export const cleanup = (): void => {
  for (const dir of dirs.splice(0)) removeHeld(dir);
};

export interface Staged {
  root: string;
  projectsRoot: string;
  storeDir: string;
  runtime: SessionsRuntime;
  stdin: PassThrough;
  written: string[];
}

/** A fresh projects root holding `proj` (the fixtures) and an empty store beside it. */
export const stage = (project = 'proj'): Staged => {
  const root = mkdtempSync(join(tmpdir(), 'oars-sessions-test-'));
  dirs.push(root);
  const projectsRoot = join(root, 'projects');
  mkdirSync(projectsRoot);
  cpSync(join(FIXTURES, 'proj'), join(projectsRoot, project), { recursive: true });
  const stdin = new PassThrough();
  const written: string[] = [];
  const storeDir = join(root, 'store');
  return { root, projectsRoot, storeDir, stdin, written, runtime: { storeDir, projectsRoot, stdin, stdout: { write: (text: string) => written.push(text) } } };
};

/** Adds a project folder with one session file of the given lines. */
export const addProject = (staged: Staged, project: string, name: string, lines: readonly string[]): string => {
  const folder = join(staged.projectsRoot, project);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${name}.jsonl`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
};

export const NOW = Date.parse('2026-06-10T00:00:00Z');

/** The `floor` a test bundle states. The client reads the floor from the bundle and applies none of its own, so any count would do; the pool's own default is `DEFAULT_PUBLIC_FLOOR` (`packages/pool/src/floors.ts`). */
export const TEST_FLOOR = 3;

/** A clock past the ideal end of every file a test writes: the deposit command reads a session whose files are newer than six hours as still in progress. */
export const settledClock = (): number => Date.now() + 7 * 60 * 60 * 1000;

export interface FixtureBubble {
  type: 1 | 2;
  text?: string;
  createdAt?: string;
  tokens?: [number, number];
  /** `result` is written as Cursor does, a JSON string; a failed shell command is `completed` with a nonzero `exitCodeV2` in it. */
  tool?: { name: string; params: unknown; status: 'completed' | 'error' | 'cancelled'; error?: string; result?: unknown; decision?: string };
  /** `timingInfo.clientStartTime`, epoch milliseconds (or a small relative clock). */
  clientStart?: number;
}

export interface FixtureComposer {
  id: string;
  createdAt: number;
  lastUpdatedAt: number;
  /** The workspace folder that lists this composer; absent leaves it in no workspace. */
  folder?: string;
  bubbles: FixtureBubble[];
}

/** A synthetic Cursor `User` folder: one global store and one workspace store per distinct folder. No real prompt text is ever used here. */
export const stageCursor = async (root: string, composers: readonly FixtureComposer[]): Promise<string> => {
  const { DatabaseSync } = await import('node:sqlite');
  const user = join(root, 'Cursor', 'User');
  mkdirSync(join(user, 'globalStorage'), { recursive: true });
  const global = new DatabaseSync(join(user, 'globalStorage', 'state.vscdb'));
  global.exec('create table ItemTable (key text unique on conflict replace, value blob); create table cursorDiskKV (key text unique on conflict replace, value blob)');
  const put = global.prepare('insert into cursorDiskKV (key, value) values (?, ?)');
  const byFolder = new Map<string, FixtureComposer[]>();
  for (const composer of composers) {
    put.run(
      `composerData:${composer.id}`,
      JSON.stringify({
        composerId: composer.id,
        createdAt: composer.createdAt,
        lastUpdatedAt: composer.lastUpdatedAt,
        modelConfig: { modelName: 'default' },
        fullConversationHeadersOnly: composer.bubbles.map((_, index) => ({ bubbleId: `b${String(index)}`, type: composer.bubbles[index]?.type })),
      }),
    );
    composer.bubbles.forEach((bubble, index) => {
      put.run(
        `bubbleId:${composer.id}:b${String(index)}`,
        JSON.stringify({
          type: bubble.type,
          bubbleId: `b${String(index)}`,
          text: bubble.text ?? '',
          ...(bubble.createdAt === undefined ? {} : { createdAt: bubble.createdAt }),
          ...(bubble.clientStart === undefined ? {} : { timingInfo: { clientStartTime: bubble.clientStart } }),
          tokenCount: { inputTokens: bubble.tokens?.[0] ?? 0, outputTokens: bubble.tokens?.[1] ?? 0 },
          ...(bubble.tool === undefined
            ? {}
            : { toolFormerData: { name: bubble.tool.name, toolCallId: `tc${String(index)}`, status: bubble.tool.status, params: JSON.stringify(bubble.tool.params), ...(bubble.tool.decision === undefined ? {} : { userDecision: bubble.tool.decision }), ...(bubble.tool.error === undefined ? {} : { error: bubble.tool.error }), ...(bubble.tool.result === undefined ? {} : { result: JSON.stringify(bubble.tool.result) }) } }),
        }),
      );
    });
    if (composer.folder !== undefined) byFolder.set(composer.folder, [...(byFolder.get(composer.folder) ?? []), composer]);
  }
  // A composer that was opened and left holds no message.
  put.run('composerData:empty', JSON.stringify({ composerId: 'empty', createdAt: 1, fullConversationHeadersOnly: [] }));
  put.run('composerData:torn', '{not json');
  global.close();
  let index = 0;
  for (const [folder, listed] of byFolder) {
    const dir = join(user, 'workspaceStorage', `ws${String(index++)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(folder).href }));
    const workspace = new DatabaseSync(join(dir, 'state.vscdb'));
    workspace.exec('create table ItemTable (key text unique on conflict replace, value blob)');
    workspace.prepare('insert into ItemTable (key, value) values (?, ?)').run('composer.composerData', JSON.stringify({ allComposers: listed.map((composer) => ({ composerId: composer.id })) }));
    workspace.close();
  }
  return user;
};

/** A repository with an origin remote, and a plain folder, under the staged root. */
export const folders = (root: string): { repo: string; plain: string } => {
  const repo = join(root, 'work', 'app');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://example.com/acme/app.git\n');
  const plain = join(root, 'notes');
  mkdirSync(plain, { recursive: true });
  return { repo, plain };
};

export const composers = (repo: string, plain: string): FixtureComposer[] => [
  {
    id: 'chat',
    createdAt: Date.parse('2025-03-01T10:00:00Z'),
    lastUpdatedAt: Date.parse('2025-03-01T10:05:00Z'),
    folder: plain,
    bubbles: [
      { type: 1, text: 'explain the plan for the notes', createdAt: '2025-03-01T10:00:00.000Z' },
      { type: 2, text: 'here is the plan', createdAt: '2025-03-01T10:00:09.000Z', tokens: [120, 40] },
    ],
  },
  {
    id: 'agent',
    createdAt: Date.parse('2025-03-02T09:00:00Z'),
    lastUpdatedAt: Date.parse('2025-03-02T09:30:00Z'),
    folder: repo,
    bubbles: [
      { type: 1, text: 'fix the parser and run the tests', createdAt: '2025-03-02T09:00:00.000Z' },
      { type: 2, tool: { name: 'read_file', params: { relativeWorkspacePath: 'src/parser.ts' }, status: 'completed' }, createdAt: '2025-03-02T09:00:05.000Z' },
      { type: 2, tool: { name: 'edit_file', params: { relativeWorkspacePath: 'src/parser.ts', contents: 'x' }, status: 'completed' }, createdAt: '2025-03-02T09:00:10.000Z' },
      { type: 2, tool: { name: 'run_terminal_cmd', params: { command: 'npm test' }, status: 'completed', result: { exitCodeV2: 1, output: '2 tests failed' } }, createdAt: '2025-03-02T09:00:20.000Z' },
      { type: 2, text: 'done', createdAt: '2025-03-02T09:00:30.000Z', tokens: [900, 60] },
    ],
  },
  {
    id: 'loose',
    createdAt: Date.parse('2025-03-03T08:00:00Z'),
    lastUpdatedAt: Date.parse('2025-03-03T08:01:00Z'),
    bubbles: [
      { type: 1, text: 'a chat no workspace lists' },
      { type: 2, text: 'ok' },
    ],
  },
];


/** A hand-built Cursor store for shapes `stageCursor` does not write: a `.code-workspace`, a remote folder, an inline `conversation`, a torn workspace store. */
export interface RawWorkspace {
  /** The `workspace.json` document. */
  json: unknown;
  /** Composer ids the workspace store lists; absent writes a file that is not a database. */
  listed?: string[];
}

export const stageRawCursor = async (root: string, composerDocs: readonly { id: string; document: unknown }[], workspaces: readonly RawWorkspace[]): Promise<string> => {
  const { DatabaseSync } = await import('node:sqlite');
  const user = join(root, 'Cursor', 'User');
  mkdirSync(join(user, 'globalStorage'), { recursive: true });
  const global = new DatabaseSync(join(user, 'globalStorage', 'state.vscdb'));
  global.exec('create table cursorDiskKV (key text unique on conflict replace, value blob)');
  const put = global.prepare('insert into cursorDiskKV (key, value) values (?, ?)');
  for (const composer of composerDocs) put.run(`composerData:${composer.id}`, JSON.stringify(composer.document));
  global.close();
  workspaces.forEach((workspace, index) => {
    const dir = join(user, 'workspaceStorage', `raw${String(index)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify(workspace.json));
    if (workspace.listed === undefined) {
      writeFileSync(join(dir, 'state.vscdb'), 'this is not a database');
      return;
    }
    const db = new DatabaseSync(join(dir, 'state.vscdb'));
    db.exec('create table ItemTable (key text unique on conflict replace, value blob)');
    db.prepare('insert into ItemTable (key, value) values (?, ?)').run('composer.composerData', JSON.stringify({ allComposers: workspace.listed.map((composerId) => ({ composerId })) }));
    db.close();
  });
  return user;
};

/** One Codex rollout line: `{timestamp, type, payload}` (codex-rs/history/src/lib.rs `RolloutLine`, openai/codex ac558e2). */
export const rolloutLine = (timestamp: string, type: string, payload: unknown): { timestamp: string; type: string; payload: unknown } => ({ timestamp, type, payload });

export interface CodexFixture {
  /** The thread uuid in the file name. */
  id: string;
  /** Lines as objects, or raw text for a torn file. */
  lines: readonly unknown[] | string;
  /** `archived_sessions/` instead of `sessions/YYYY/MM/DD/`. */
  archived?: boolean;
  /** Written as `.jsonl.zst`, which Codex reads transparently (rollout/src/compression.rs). */
  compressed?: boolean;
}

/** A Codex home holding the given rollouts under `sessions/2026/06/01/rollout-2026-06-01T10-00-00-<id>.jsonl`; returns the home. */
export const stageCodex = (root: string, files: readonly CodexFixture[]): string => {
  const home = join(root, 'codex-home');
  for (const file of files) {
    const dir = file.archived === true ? join(home, 'archived_sessions') : join(home, 'sessions', '2026', '06', '01');
    mkdirSync(dir, { recursive: true });
    const text = typeof file.lines === 'string' ? file.lines : `${file.lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
    const name = `rollout-2026-06-01T10-00-00-${file.id}.jsonl`;
    if (file.compressed === true) writeFileSync(join(dir, `${name}.zst`), zstdCompressSync(Buffer.from(text)));
    else writeFileSync(join(dir, name), text);
  }
  return home;
};

/** One Copilot CLI event: `{id, parentId, timestamp, type, data}` (github/copilot-sdk @ d28a136, nodejs/src/generated/session-events.ts, every event's envelope). */
export const copilotEvent = (timestamp: string, type: string, data: unknown, extra: object = {}): { id: string; parentId: null; timestamp: string; type: string; data: unknown } => ({
  id: `00000000-0000-4000-8000-${String(Math.abs(Date.parse(timestamp)) % 1e12).padStart(12, '0')}`,
  parentId: null,
  timestamp,
  type,
  data,
  ...extra,
});

export interface CopilotFixture {
  /** The session folder's name, which is the session id. */
  id: string;
  /** Lines as objects, or raw text for a torn file. */
  lines: readonly unknown[] | string;
  /** Rotated archives `events.<n>.jsonl` beside the live file; `lines` is then the live file that follows them. */
  archives?: readonly { n: number; lines: readonly unknown[] | string }[];
}

/** A Copilot home holding the given sessions under `session-state/<id>/events.jsonl`; returns the home. */
export const stageCopilot = (root: string, files: readonly CopilotFixture[]): string => {
  const home = join(root, 'copilot-home');
  for (const file of files) {
    const dir = join(home, 'session-state', file.id);
    mkdirSync(dir, { recursive: true });
    const text = (lines: readonly unknown[] | string): string => (typeof lines === 'string' ? lines : `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    writeFileSync(join(dir, 'events.jsonl'), text(file.lines));
    for (const archive of file.archives ?? []) writeFileSync(join(dir, `events.${String(archive.n)}.jsonl`), text(archive.lines));
  }
  return home;
};

export interface VscodeFixture {
  /** The session id, which is the file's name without its extension. */
  id: string;
  /** The serialized chat data (`.json` form), or raw text for a torn file. */
  data?: object | string;
  /** The mutation-log entries (`.jsonl` form), or raw text. */
  log?: readonly unknown[] | string;
  /** The build's `nameShort` folder; `Code` when absent. */
  channel?: string;
  /** The workspace hash folder; absent writes the session under `globalStorage/emptyWindowChatSessions`. */
  hash?: string;
  /** What the hash's `workspace.json` holds, written once per hash; absent writes none. */
  workspace?: object;
}

/** A VS Code app-data folder (what `%APPDATA%` is) holding the given chat sessions; returns the folder. */
export const stageVscode = (root: string, files: readonly VscodeFixture[]): string => {
  const appData = join(root, 'vscode-appdata');
  for (const file of files) {
    const user = join(appData, file.channel ?? 'Code', 'User');
    const dir = file.hash === undefined ? join(user, 'globalStorage', 'emptyWindowChatSessions') : join(user, 'workspaceStorage', file.hash, 'chatSessions');
    mkdirSync(dir, { recursive: true });
    if (file.hash !== undefined && file.workspace !== undefined) writeFileSync(join(user, 'workspaceStorage', file.hash, 'workspace.json'), JSON.stringify(file.workspace));
    if (file.data !== undefined) writeFileSync(join(dir, `${file.id}.json`), typeof file.data === 'string' ? file.data : JSON.stringify(file.data));
    if (file.log !== undefined) writeFileSync(join(dir, `${file.id}.jsonl`), typeof file.log === 'string' ? file.log : `${file.log.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  }
  return appData;
};

/** A Gemini CLI chat-file line: the head metadata, a message, or a `$set`/`$patch`/`$rewindTo` record (google-gemini/gemini-cli @ 89e9d25d, packages/core/src/services/chatRecordingTypes.ts). */
export const geminiHead = (sessionId: string, extra: object = {}): object => ({ sessionId, projectHash: 'a1b2c3', startTime: '2026-06-01T10:00:00.000Z', lastUpdated: '2026-06-01T10:00:00.000Z', kind: 'main', ...extra });

export interface GeminiFixture {
  /** The session id, which is the head's `sessionId`; the file is `session-2026-06-01T10-00-<first 8>.jsonl`. */
  id: string;
  /** The project folder's name under `tmp/` (the vendor's slug). */
  slug?: string;
  /** What `.project_root` holds; null writes none (a pre-slug folder). */
  projectRoot?: string | null;
  /** Lines as objects, or raw text for a torn file. */
  lines: readonly unknown[] | string;
  /** Set for a subagent: its file is `chats/<parent>/<id>.jsonl`. */
  parent?: string;
  /** Written as a legacy `.json` file holding one pretty-printed object. */
  legacy?: boolean;
  /** The file's name without its extension, when it is not `session-2026-06-01T10-00-<first 8>`: a second chat file under one session id. */
  stem?: string;
}

/** A Gemini home holding the given sessions under `.gemini/tmp/<slug>/chats/`; returns the `.gemini` folder. */
export const stageGemini = (root: string, files: readonly GeminiFixture[]): string => {
  const gemini = join(root, 'gemini-home', '.gemini');
  for (const file of files) {
    const slug = join(gemini, 'tmp', file.slug ?? 'app');
    const dir = file.parent === undefined ? join(slug, 'chats') : join(slug, 'chats', file.parent);
    mkdirSync(dir, { recursive: true });
    if (file.projectRoot !== null) writeFileSync(join(slug, '.project_root'), file.projectRoot ?? join(root, 'not-a-repo'));
    const text = typeof file.lines === 'string' ? file.lines : `${file.lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
    const stem = file.stem ?? (file.parent === undefined ? `session-2026-06-01T10-00-${file.id.slice(0, 8)}` : file.id);
    writeFileSync(join(dir, `${stem}${file.legacy === true ? '.json' : '.jsonl'}`), text);
  }
  return gemini;
};

/**
 * One Grok Build `updates.jsonl` line: `{timestamp, method, params: {sessionId, update}}` (xai-org/grok-build @ 2bdd1d6, crates/codegen/xai-grok-shell
 * storage/mod.rs:721-725; `timestamp` is epoch seconds). `update` is an ACP `SessionUpdate`, tagged by `sessionUpdate`.
 */
export const grokUpdate = (timestamp: number, update: object, sessionId = 'sess'): { timestamp: number; method: string; params: { sessionId: string; update: object } } => ({
  timestamp,
  method: 'session/update',
  params: { sessionId, update },
});

export interface GrokFixture {
  /** The session folder's name, which is the session id. */
  id: string;
  /** The working directory: `summary.json` `info.cwd`, and the percent-encoded name of the folder above the session. */
  cwd: string;
  /** Lines as objects, or raw text for a torn file; null writes no `updates.jsonl`. */
  updates: readonly unknown[] | string | null;
  /** `usage.json`; absent writes none (a session that never finished a turn has no such file). */
  usage?: object;
  /** Merged over the `summary.json` this helper writes. */
  summary?: object;
}

/** A Grok home holding the given sessions under `sessions/<encoded-cwd>/<id>/` (docs/user-guide/17-sessions.md:22-40); returns the home, which is always under `root`. */
export const stageGrok = (root: string, files: readonly GrokFixture[]): string => {
  const home = join(root, 'grok-home');
  for (const file of files) {
    const dir = join(home, 'sessions', encodeURIComponent(file.cwd), file.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'summary.json'),
      JSON.stringify({ info: { id: file.id, cwd: file.cwd }, created_at: '2026-06-01T10:00:00Z', num_messages: 2, current_model_id: 'grok-build', ...file.summary }),
    );
    if (file.updates !== null) writeFileSync(join(dir, 'updates.jsonl'), typeof file.updates === 'string' ? file.updates : `${file.updates.map((line) => JSON.stringify(line)).join('\n')}\n`);
    if (file.usage !== undefined) writeFileSync(join(dir, 'usage.json'), JSON.stringify(file.usage));
  }
  return home;
};

/**
 * One Pi session-file line (badlogic/pi-mono @ 085c84e, packages/coding-agent/docs/session-format.md:49-59): every entry but the header is
 * `{type, id, parentId, timestamp}` plus its own fields.
 */
export const piEntry = (type: string, id: string, parentId: string | null, timestamp: string, rest: object = {}): { [key: string]: unknown } => ({ type, id, parentId, timestamp, ...rest });

/** The header, first line of every file (session-format.md:64-76); `version` is the file-format version, not Pi's. */
export const piHeader = (over: object = {}): { [key: string]: unknown } => ({ type: 'session', version: 3, id: 'sess', timestamp: '2026-06-01T10:00:00.000Z', cwd: '/work/app', ...over });

export interface PiFixture {
  /** The session id: the part of the file name after the timestamp. */
  id: string;
  /** The working directory the header names; the folder name above the file is derived from it as Pi does. */
  cwd: string;
  /** Lines as objects (the header first), or raw text for a torn file. */
  lines: readonly unknown[] | string;
}

/**
 * A Pi agent folder holding the given sessions under `sessions/--<cwd>--/<timestamp>_<id>.jsonl` (session-format.md:10-14; the folder name is
 * session-manager.ts:593); returns the agent folder, which is always under `root`.
 */
export const stagePi = (root: string, files: readonly PiFixture[]): string => {
  const home = join(root, 'pi-home');
  for (const file of files) {
    const dir = join(home, 'sessions', `--${file.cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `2026-06-01T10-00-00-000Z_${file.id}.jsonl`), typeof file.lines === 'string' ? file.lines : `${file.lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  }
  return home;
};

/** An OTLP JSON `AnyValue` (opentelemetry-proto v1.11.1 docs/specification.md:453-484: an int64 is a decimal string). */
export const otlpValue = (value: unknown): object => {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(otlpValue) } };
  if (typeof value !== 'object' || value === null) return { stringValue: String(value) };
  return { kvlistValue: { values: Object.entries(value).map(([key, held]) => ({ key, value: otlpValue(held) })) } };
};

export interface OtlpSpanInput {
  trace: string;
  id: string;
  parent?: string;
  name: string;
  /** Seconds after the fixture's base time; the span carries Unix nanoseconds as a decimal string (trace.proto:96-327). */
  start?: number;
  end?: number;
  attrs?: { [key: string]: unknown };
  /** The status code: 0 unset, 1 ok, 2 error (trace.proto:327). */
  code?: number;
  message?: string;
  events?: readonly { name: string; attrs: { [key: string]: unknown } }[];
}

export const OTLP_BASE = Date.parse('2026-06-01T10:00:00Z');
const nanos = (second: number): string => String((BigInt(OTLP_BASE) + BigInt(Math.round(second * 1000))) * 1_000_000n);

/** One span as `Span` in `trace.proto`, JSON-encoded (hex ids, integer enums, camelCase). */
export const otlpSpan = (input: OtlpSpanInput): object => ({
  traceId: input.trace,
  spanId: input.id,
  ...(input.parent === undefined ? {} : { parentSpanId: input.parent }),
  name: input.name,
  kind: 1,
  ...(input.start === undefined ? {} : { startTimeUnixNano: nanos(input.start) }),
  ...(input.end === undefined ? {} : { endTimeUnixNano: nanos(input.end) }),
  attributes: Object.entries(input.attrs ?? {}).map(([key, value]) => ({ key, value: otlpValue(value) })),
  events: (input.events ?? []).map((event) => ({ name: event.name, attributes: Object.entries(event.attrs).map(([key, value]) => ({ key, value: otlpValue(value) })) })),
  ...(input.code === undefined ? {} : { status: { code: input.code, ...(input.message === undefined ? {} : { message: input.message }) } }),
});

/** An `ExportTraceServiceRequest` (one line of a file exporter's output, file-exporter.md:64-75) holding the spans under one instrumentation scope. */
export const otlpRequest = (spans: readonly object[], scope = 'opentelemetry.instrumentation.langchain'): object => ({
  resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'support-agent' } }] }, scopeSpans: [{ scope: { name: scope }, spans }] }],
});

export interface OtelFixture {
  /** The file name in the folder. */
  name: string;
  /** Requests as objects (one a line), or raw text for a torn file. */
  lines: readonly unknown[] | string;
}

/** A folder of OTLP JSON trace files; returns it, always under `root`. */
export const stageOtel = (root: string, files: readonly OtelFixture[]): string => {
  const dir = join(root, 'otel-traces');
  mkdirSync(dir, { recursive: true });
  for (const file of files) writeFileSync(join(dir, file.name), typeof file.lines === 'string' ? file.lines : `${file.lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return dir;
};

/*
 * OpenCode (sst/opencode @ 21bf6b4, packages/cli and core 2.2.5). The store is one SQLite file, `<data>/opencode/opencode.db`; the tables below hold only the columns the
 * reader reads, in the shape core/src/session/sql.ts declares: `session_v2` (:29), `session_message` (:87, `data` is the message minus `type` and `id`, projector.ts:662),
 * and `session_part` (:108, written only when `experimental.part_rows` is on, projector.ts:316-320). Times are epoch milliseconds (schema/src/schema.ts DateTimeUtcFromMillis).
 */
export interface OpencodeMessageFixture {
  id: string;
  type: string;
  seq: number;
  created: number;
  data: object;
}

export interface OpencodePartFixture {
  messageId: string;
  ordinal: number;
  type: string;
  data: object;
}

export interface OpencodeFixture {
  id: string;
  directory: string;
  created: number;
  updated: number;
  messages: readonly OpencodeMessageFixture[];
  parts?: readonly OpencodePartFixture[];
  parentId?: string;
  /** `fork_session_id`: the session this one was forked from, whose messages it copies (projector.ts:160-250). */
  forkOf?: string;
  version?: string;
  agent?: string;
}

/** A user message (`session-message.ts` User: `text`, optional `files`). */
export const ocUser = (id: string, seq: number, created: number, text: string, extra: object = {}): OpencodeMessageFixture => ({ id, type: 'user', seq, created, data: { time: { created }, text, ...extra } });

/** A tool part of an assistant message (`AssistantTool`, session-message.ts:172-186): `id` is the call id, `state` one of streaming, running, completed, error. */
export const ocTool = (id: string, name: string, state: object, created = 0): object => ({ type: 'tool', id, name, state, time: { created } });

/** An assistant message (`Assistant`, session-message.ts:216-245); its content is inline unless `part_rows` is on. */
export const ocAssistant = (id: string, seq: number, created: number, content: readonly object[], extra: object = {}): OpencodeMessageFixture => ({
  id,
  type: 'assistant',
  seq,
  created,
  data: { agent: 'build', model: { id: 'claude-sonnet-5-5', providerID: 'anthropic' }, content, time: { created }, ...extra },
});

/** A shell tool state that completed: the shell tool records the exit in `metadata` (core/src/shell/result.ts:20-28, :36-43; written by core/src/tool/plugin/shell.ts:85-88), whatever the code. */
export const ocShellDone = (command: string, text: string, exit?: number, extra: object = {}): object => ({
  status: 'completed',
  input: { command },
  content: [{ type: 'text', text }],
  metadata: { truncated: false, ...(exit === undefined ? {} : { exit }), ...extra },
});

/** Writes an OpenCode data folder (`<root>/opencode-data/opencode/opencode.db`) and returns the folder, which is always under `root`. */
export const stageOpencode = async (root: string, sessions: readonly OpencodeFixture[], file = 'opencode.db'): Promise<string> => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = join(root, 'opencode-data', 'opencode');
  mkdirSync(dir, { recursive: true });
  // A second stage in one test replaces the store.
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dir, file + suffix), { force: true });
  const db = new DatabaseSync(join(dir, file));
  // OpenCode always opens its database in WAL mode (core/src/database/database.ts:42); the mode is stored in the file, so a reader meets a WAL database.
  db.exec('pragma journal_mode = wal');
  db.exec(`
    create table session_v2 (id text primary key, parent_id text, fork_session_id text, directory text not null, version text not null, agent text, time_created integer not null, time_updated integer not null);
    create table session_message (id text primary key, session_id text not null, type text not null, seq integer not null, time_created integer not null, time_updated integer not null, data text not null);
    create table session_part (message_id text not null, session_id text not null, ordinal integer not null, type text not null, call_id text, time_created integer not null, time_updated integer not null, data text not null, primary key (message_id, ordinal));
  `);
  for (const session of sessions) {
    db.prepare('insert into session_v2 (id, parent_id, fork_session_id, directory, version, agent, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?)').run(
      session.id,
      session.parentId ?? null,
      session.forkOf ?? null,
      session.directory,
      session.version ?? '2.2.5',
      session.agent ?? 'build',
      session.created,
      session.updated,
    );
    for (const message of session.messages) {
      db.prepare('insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)').run(message.id, session.id, message.type, message.seq, message.created, message.created, JSON.stringify(message.data));
    }
    for (const part of session.parts ?? []) {
      db.prepare('insert into session_part (message_id, session_id, ordinal, type, call_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?, ?)').run(part.messageId, session.id, part.ordinal, part.type, null, session.created, session.created, JSON.stringify(part.data));
    }
  }
  db.close();
  return dir;
};

// Shared by the Codex recording hook's tests: a store under a temp folder that the environment points at, and payloads built from the recorded schema fixture.
const hookDirs: string[] = [];

export const AT = Date.parse('2026-11-09T12:00:00Z');

export type Obj = { [key: string]: unknown };
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const rec = (value: unknown): Obj => (isObj(value) ? value : {});
const schema: Obj = rec(JSON.parse(readFileSync(join(FIXTURES, 'codex-hook-schema.json'), 'utf8')));

const sample = (kind: unknown): unknown => {
  if (kind === 'string') return 'x';
  if (kind === 'number') return 7;
  if (kind === 'null') return null;
  return Object.fromEntries(Object.entries(rec(kind)).map(([name, inner]) => [name, sample(inner)]));
};

/** A payload with every field the fixture lists for the event, each holding a stand-in of its kind; `over` replaces or adds fields. */
export const payloadOf = (event: 'SessionStart' | 'PostToolUse' | 'PostModelRequest', over: Obj = {}): Obj => ({
  ...rec(sample(schema.common)),
  ...rec(sample(schema[event])),
  hook_event_name: event,
  ...over,
});

export interface HookStore {
  root: string;
  home: string;
  storeDir: string;
  runtime: CodexHookRuntime;
  rows: () => Obj[];
  notes: () => Obj[];
  saveState: (text: string) => void;
}

export const linesOf = (file: string): Obj[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => rec(JSON.parse(line))) : []);

/** A fresh machine under a temp folder: APPDATA and XDG_CONFIG_HOME point there, and the store path is confirmed to be under it before anything runs. */
export const stageHook = (): HookStore => {
  const root = mkdtempSync(join(tmpdir(), 'oars-codex-hook-'));
  hookDirs.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  vi.stubEnv('APPDATA', join(root, 'appdata'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  const storeDir = join(defaultConfigDir(process.env, process.platform, home), 'oars', 'sessions');
  if (!storeDir.startsWith(root)) throw new Error(`The store path ${storeDir} is outside the temp folder ${root}.`);
  mkdirSync(storeDir, { recursive: true });
  return {
    root,
    home,
    storeDir,
    runtime: { storeDir, home, now: () => AT, append: appendOwnerOnly },
    rows: () => linesOf(join(storeDir, 'hook-rows.jsonl')),
    notes: () => linesOf(join(storeDir, 'hook-calls.jsonl')),
    saveState: (text) => {
      writeFileSync(join(storeDir, 'state.json'), text);
    },
  };
};

export const cleanHook = (): void => {
  vi.unstubAllEnvs();
  for (const dir of hookDirs.splice(0)) removeHeld(dir);
};
