import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
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

export interface FixtureBubble {
  type: 1 | 2;
  text?: string;
  createdAt?: string;
  tokens?: [number, number];
  /** `result` is written as Cursor does, a JSON string; a failed shell command is `completed` with a nonzero `exitCodeV2` in it. */
  tool?: { name: string; params: unknown; status: 'completed' | 'error'; error?: string; result?: unknown };
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
            : { toolFormerData: { name: bubble.tool.name, toolCallId: `tc${String(index)}`, status: bubble.tool.status, params: JSON.stringify(bubble.tool.params), ...(bubble.tool.error === undefined ? {} : { error: bubble.tool.error }), ...(bubble.tool.result === undefined ? {} : { result: JSON.stringify(bubble.tool.result) }) } }),
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
}

/** A Copilot home holding the given sessions under `session-state/<id>/events.jsonl`; returns the home. */
export const stageCopilot = (root: string, files: readonly CopilotFixture[]): string => {
  const home = join(root, 'copilot-home');
  for (const file of files) {
    const dir = join(home, 'session-state', file.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), typeof file.lines === 'string' ? file.lines : `${file.lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  }
  return home;
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
    if (file.legacy === true) writeFileSync(join(dir, `session-2026-06-01T10-00-${file.id.slice(0, 8)}.json`), text);
    else writeFileSync(join(dir, file.parent === undefined ? `session-2026-06-01T10-00-${file.id.slice(0, 8)}.jsonl` : `${file.id}.jsonl`), text);
  }
  return gemini;
};
