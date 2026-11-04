
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { cursorRoot, openCursorStore, type CursorSession } from './cursor.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import { cleanup, composers, folders, stage, stageCursor, stageRawCursor, type FixtureBubble } from './test-support.js';

afterEach(cleanup);


const capture = (transcript: string, session: string) =>
  captureSession({
    text: transcript,
    session,
    project: 'p',
    rev: 1,
    at: '2026-01-01T00:00:00Z',
    bytes: transcript.length,
    redact: makeRedactor(),
    salt: 'salt',
    sid: 'abcd1234',
    repoRoot: makeRepoRoot(),
    repoIdentity: makeRepoIdentity(),
  });

const opened = async () => {
  const staged = stage();
  const { repo, plain } = folders(staged.root);
  const store = await openCursorStore(await stageCursor(staged.root, composers(repo, plain)));
  if (store === undefined) throw new Error('the fixture store did not open');
  const session = (id: string): CursorSession => {
    const found = store.sessions.find((candidate) => candidate.composerId === id);
    if (found === undefined) throw new Error(`no session ${id}`);
    return found;
  };
  return { staged, repo, plain, store, session };
};

describe('cursorRoot', () => {
  it('names the User folder of each platform', () => {
    expect(cursorRoot('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a')).toBe(join('C:\\Users\\a\\AppData\\Roaming', 'Cursor', 'User'));
    expect(cursorRoot('win32', {}, '/home/a')).toBe(join('/home/a', 'AppData', 'Roaming', 'Cursor', 'User'));
    expect(cursorRoot('darwin', {}, '/Users/a')).toBe(join('/Users/a', 'Library', 'Application Support', 'Cursor', 'User'));
    expect(cursorRoot('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/a')).toBe(join('/cfg', 'Cursor', 'User'));
    expect(cursorRoot('linux', {}, '/home/a')).toBe(join('/home/a', '.config', 'Cursor', 'User'));
  });
});

describe('the Cursor reader', () => {
  it('returns nothing for a machine without Cursor', async () => {
    expect(await openCursorStore(stage().root)).toBeUndefined();
  });

  it('lists sessions with messages, maps each to its workspace folder, and skips an empty or torn composer', async () => {
    const { store, repo, plain } = await opened();
    expect(store.sessions.map((s) => [s.composerId, s.folder, s.messages])).toEqual([
      ['chat', plain, 2],
      ['agent', repo, 5],
      ['loose', null, 2],
    ]);
    store.close();
  });

  it('captures a chat: a prompt, a response, usage only where Cursor counted it, no tools', async () => {
    const { store, session } = await opened();
    const { session: captured, prompts, tools } = capture(store.transcript(session('chat')), 'chat');
    expect(captured.userTurns).toBe(1);
    expect(captured.assistantTurns).toBe(1);
    expect(captured.tsFirst).toBe('2025-03-01T10:00:00.000Z');
    expect(captured.usage).toEqual({ input: 120, cacheWrite: 0, cacheRead: 0, output: 40, thinking: 0 });
    expect(captured.models).toEqual({ default: 1 });
    expect(captured.versions).toEqual([]);
    expect(captured.repo).toBeNull();
    expect(prompts[0]?.head).toBe('explain the plan for the notes');
    expect(prompts[0]?.wallSec).toBe(9);
    expect(tools).toEqual([]);
    store.close();
  });

  it('captures a composer session with file edits: tool names, hashed repo-relative files, a failed command as an error line', async () => {
    const { store, session } = await opened();
    const { session: captured, tools, errorLines } = capture(store.transcript(session('agent')), 'agent');
    expect(tools.map((t) => [t.tool, t.status, t.targetBase])).toEqual([
      ['Read', 'ok', 'repo'],
      ['Edit', 'ok', 'repo'],
      ['Bash', 'error', null],
    ]);
    expect(tools[0]?.target).toBe(tools[1]?.target);
    expect(tools[2]?.target).toBe('npm test');
    expect(captured.files).toEqual(['src/parser.ts']);
    expect(captured.fileHashes[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(captured.fileHashes).toHaveLength(1);
    expect(captured.repo).toMatch(/^[0-9a-f]{16}$/);
    expect(captured.bashCmds).toBe(1);
    expect(errorLines.map((e) => [e.tool, e.line])).toEqual([['Bash', '2 tests failed']]);
    expect(captured.usage.input).toBe(900);
    store.close();
  });

  it('captures a chat no workspace lists with no repository', async () => {
    const { store, session } = await opened();
    expect(session('loose').folder).toBeNull();
    const { session: captured } = capture(store.transcript(session('loose')), 'loose');
    expect(captured.repo).toBeNull();
    expect(captured.userTurns).toBe(1);
    store.close();
  });

  it('gives a bubble with token counts and no text or tool call its usage, with a request id the verifier groups on', async () => {
    const staged = stage();
    const user = await stageCursor(staged.root, [{ id: 'u', createdAt: 1, lastUpdatedAt: 2, bubbles: [{ type: 1, text: 'hello' }, { type: 2, tokens: [10, 5] }] }]);
    const store = await openCursorStore(user);
    const session = store?.sessions[0];
    if (store === undefined || session === undefined) throw new Error('no store');
    const lines = store.transcript(session).trim().split('\n').map((line): unknown => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(capture(store.transcript(session), 'u').session.usage).toMatchObject({ input: 10, output: 5 });
    store.close();
  });
});

describe('the Cursor reader: the Claude Code redaction and caps', () => {
  it('redacts a secret and an email in a prompt and a tool error, cuts a long error at 1,000 characters, and bases a plain folder paths on cwd', async () => {
    const staged = stage();
    const { plain } = folders(staged.root);
    const user = await stageCursor(staged.root, [
      {
        id: 'r',
        createdAt: Date.parse('2025-04-01T00:00:00Z'),
        lastUpdatedAt: Date.parse('2025-04-01T00:05:00Z'),
        folder: plain,
        bubbles: [
          { type: 1, text: 'use key sk-ant-abcdefghijklmnop1234 and mail dev@example.com', createdAt: '2025-04-01T00:00:00.000Z' },
          { type: 2, tool: { name: 'read_file', params: { relativeWorkspacePath: 'notes.md' }, status: 'completed' }, createdAt: '2025-04-01T00:00:01.000Z' },
          { type: 2, tool: { name: 'run_terminal_cmd', params: { command: 'make' }, status: 'error', error: `failed for dev@example.com with AKIAABCDEFGHIJKLMNOP ${'x'.repeat(1500)}` }, createdAt: '2025-04-01T00:00:02.000Z' },
        ],
      },
    ]);
    const store = await openCursorStore(user);
    const session = store?.sessions[0];
    if (store === undefined || session === undefined) throw new Error('no store');
    const { prompts, errorLines, tools } = capture(store.transcript(session), 'r');
    expect(prompts[0]?.head).toBe('use key <secret> and mail <email>');
    expect(errorLines[0]?.line).not.toMatch(/dev@example|AKIA/);
    expect(errorLines[0]?.line).toContain('<email>');
    expect(Array.from(errorLines[0]?.line ?? '')).toHaveLength(1000);
    expect(tools[0]?.targetBase).toBe('cwd');
    store.close();
  });
});

describe('the Cursor reader: workspace shapes', () => {
  it('reads a .code-workspace as its folder, a remote workspace as no folder, and an inline conversation as messages; a torn workspace store is skipped', async () => {
    const staged = stage();
    const { repo, plain } = folders(staged.root);
    const inline = { composerId: 'inline', createdAt: 5, conversation: [{ type: 1, text: 'old style', bubbleId: 'i0' }, { type: 2, text: 'reply' }] };
    const headed = (id: string) => ({ composerId: id, createdAt: 6, fullConversationHeadersOnly: [{ bubbleId: 'b0', type: 1 }] });
    const user = await stageRawCursor(
      staged.root,
      [
        { id: 'inline', document: inline },
        { id: 'code', document: headed('code') },
        { id: 'remote', document: headed('remote') },
        { id: 'torn', document: headed('torn') },
      ],
      [
        { json: { workspace: pathToFileURL(join(repo, 'app.code-workspace')).href }, listed: ['code', 'inline'] },
        { json: { folder: 'vscode-remote://ssh-remote+box/home/a/app' }, listed: ['remote'] },
        { json: { folder: pathToFileURL(plain).href } },
      ],
    );
    const store = await openCursorStore(user);
    if (store === undefined) throw new Error('no store');
    const found = Object.fromEntries(store.sessions.map((s) => [s.composerId, [s.folder, s.messages]]));
    expect(found.code).toEqual([repo, 1]);
    expect(found.remote).toEqual([null, 1]);
    expect(found.torn).toEqual([null, 1]);
    expect(found.inline).toEqual([repo, 2]);
    const session = store.sessions.find((s) => s.composerId === 'inline');
    if (session === undefined) throw new Error('no session');
    const { session: captured, prompts } = capture(store.transcript(session), 'inline');
    expect(captured.userTurns).toBe(1);
    expect(prompts[0]?.head).toBe('old style');
    store.close();
  });
});

const only = async (bubbles: FixtureBubble[], createdAt = '2025-06-01T00:00:00Z') => {
  const staged = stage();
  const user = await stageCursor(staged.root, [{ id: 'x', createdAt: Date.parse(createdAt), lastUpdatedAt: Date.parse(createdAt) + 60_000, bubbles }]);
  const store = await openCursorStore(user);
  const session = store?.sessions[0];
  if (store === undefined || session === undefined) throw new Error('no store');
  return { store, session };
};

const timesOf = (transcript: string): string[] =>
  transcript
    .trim()
    .split(String.fromCharCode(10))
    .map((line): unknown => JSON.parse(line))
    .map((line) => (typeof line === 'object' && line !== null && 'timestamp' in line ? String(line.timestamp) : ''));

describe('the Cursor reader: shell results and error wrappers', () => {
  const shell = (status: 'completed' | 'error', extra: Partial<NonNullable<FixtureBubble['tool']>>): FixtureBubble => ({
    type: 2,
    createdAt: '2025-06-01T00:00:02.000Z',
    tool: { name: 'run_terminal_cmd', params: { command: 'make' }, status, ...extra },
  });

  it('reads a completed shell command with a nonzero exitCodeV2 as an error, and one with exit 0 as ok', async () => {
    const { store, session } = await only([
      { type: 1, text: 'build it', createdAt: '2025-06-01T00:00:00.000Z' },
      shell('completed', { result: { exitCodeV2: 2, output: 'make: *** no rule' } }),
      shell('completed', { result: { exitCodeV2: 0, output: 'fine' } }),
      shell('completed', {}),
    ]);
    const { tools, errorLines } = capture(store.transcript(session), 'x');
    expect(tools.map((t) => [t.tool, t.status])).toEqual([
      ['Bash', 'error'],
      ['Bash', 'ok'],
      ['Bash', 'ok'],
    ]);
    expect(errorLines.map((e) => e.line)).toEqual(['make: *** no rule']);
    expect(store.transcript(session)).toContain('Exit code 2');
    store.close();
  });

  it('logs the message of a JSON error wrapper, the model-visible one first, then the client-visible, then the string as written', async () => {
    const wrapper = (fields: unknown): string => JSON.stringify(fields);
    const { store, session } = await only([
      { type: 1, text: 'go', createdAt: '2025-06-01T00:00:00.000Z' },
      shell('error', { error: wrapper({ clientVisibleErrorMessage: 'client text', modelVisibleErrorMessage: 'model text' }) }),
      shell('error', { error: wrapper({ clientVisibleErrorMessage: 'client only' }) }),
      shell('error', { error: wrapper({ other: 1 }) }),
      shell('error', { error: 'plain text' }),
    ]);
    const { errorLines } = capture(store.transcript(session), 'x');
    expect(errorLines.map((e) => e.line)).toEqual(['model text', 'client only', '{"other":1}', 'plain text']);
    store.close();
  });
});

describe('the Cursor reader: client start times', () => {
  it('falls back to timingInfo.clientStartTime when it is at or after the composer start, and ignores a relative clock', async () => {
    const { store, session } = await only([
      { type: 1, text: 'asked', createdAt: '2025-06-01T00:00:01.000Z' },
      { type: 2, text: 'epoch', clientStart: Date.parse('2025-06-01T00:00:30Z') },
      { type: 2, text: 'relative', clientStart: 1234 },
    ]);
    expect(timesOf(store.transcript(session))).toEqual(['2025-06-01T00:00:01.000Z', '2025-06-01T00:00:30.000Z', '2025-06-01T00:00:30.000Z']);
    store.close();
  });

  it('gives a user bubble with no time the time of the next assistant bubble', async () => {
    const { store, session } = await only([
      { type: 1, text: 'asked' },
      { type: 2, text: 'answer', createdAt: '2025-06-01T00:00:20.000Z' },
      { type: 1, text: 'asked again' },
      { type: 2, text: 'again', createdAt: '2025-06-01T00:01:00.000Z' },
    ]);
    expect(timesOf(store.transcript(session))).toEqual(['2025-06-01T00:00:20.000Z', '2025-06-01T00:00:20.000Z', '2025-06-01T00:01:00.000Z', '2025-06-01T00:01:00.000Z']);
    store.close();
  });
});

describe('the Cursor reader: times', () => {
  it('never steps a bubble time back, and starts a session at its first stamped bubble', async () => {
    const staged = stage();
    const user = await stageCursor(staged.root, [
      {
        id: 't',
        createdAt: Date.parse('2025-05-01T00:00:00Z'),
        lastUpdatedAt: Date.parse('2025-05-01T00:10:00Z'),
        bubbles: [
          { type: 1, text: 'no time yet' },
          { type: 2, text: 'stamped', createdAt: '2025-04-30T23:00:00.000Z' },
          { type: 1, text: 'out of order', createdAt: '2025-04-30T22:00:00.000Z' },
          { type: 2, text: 'later', createdAt: '2025-04-30T23:30:00.000Z' },
        ],
      },
    ]);
    const store = await openCursorStore(user);
    const session = store?.sessions[0];
    if (store === undefined || session === undefined) throw new Error('no store');
    const stamps = store.transcript(session).trim().split(String.fromCharCode(10)).map((line): unknown => JSON.parse(line));
    const times = stamps.map((line) => (typeof line === 'object' && line !== null && 'timestamp' in line ? String(line.timestamp) : ''));
    expect(times).toEqual(['2025-04-30T23:00:00.000Z', '2025-04-30T23:00:00.000Z', '2025-04-30T23:00:00.000Z', '2025-04-30T23:30:00.000Z']);
    store.close();
  });
});

describe('the Cursor reader: outcomes', () => {
  const shell = (extra: Partial<NonNullable<FixtureBubble['tool']>>): FixtureBubble => ({
    type: 2,
    createdAt: '2025-06-01T00:00:02.000Z',
    tool: { name: 'run_terminal_cmd', params: { command: 'make' }, status: 'completed', ...extra },
  });
  const user: FixtureBubble = { type: 1, text: 'go', createdAt: '2025-06-01T00:00:00.000Z' };

  it('records an aborted terminal call as no outcome, not ok', async () => {
    const { store, session } = await only([user, shell({ result: { exitCodeV2: 0, output: '', endedReason: 'RUN_TERMINAL_COMMAND_ENDED_REASON_EXECUTION_ABORTED' } })]);
    const { tools, errorLines } = capture(store.transcript(session), 'x');
    expect(tools.map((t) => t.status)).toEqual(['none']);
    expect(errorLines).toEqual([]);
    store.close();
  });

  it('reads toolFormerData.userDecision: a rejected call is a user-rejected failure, any other value is not', async () => {
    const { store, session } = await only([
      user,
      shell({ decision: 'accepted', result: { exitCodeV2: 0, output: 'fine' } }),
      shell({ decision: 'rejected', status: 'cancelled' }),
      shell({ result: { exitCodeV2: 0, output: 'fine' } }),
      shell({ decision: 'maybe', result: { exitCodeV2: 0, output: 'fine' } }),
    ]);
    const { tools } = capture(store.transcript(session), 'x');
    expect(tools.map((t) => [t.status, t.errorCode ?? null])).toEqual([['ok', null], ['error', 'user-rejected'], ['ok', null], ['ok', null]]);
    store.close();
  });

  it('leaves durationMs null on a Cursor tool call, not a measured zero', async () => {
    const { store, session } = await only([user, shell({ result: { exitCodeV2: 0, output: 'fine' } })]);
    const { tools } = capture(store.transcript(session), 'x');
    expect(tools.map((t) => [t.status, t.durationMs])).toEqual([['ok', null]]);
    store.close();
  });

  it('refuses a relative clientStartTime when the composer has no createdAt', async () => {
    const { store, session } = await only([{ type: 2, text: 'relative', clientStart: 1234 }], '1970-01-01T00:00:00Z');
    expect(timesOf(store.transcript(session)).every((time) => !time.startsWith('1970-01-01T00:00:01'))).toBe(true);
    store.close();
  });

  it('logs a nonzero exit with no output as Exit code <n> alone', async () => {
    const { store, session } = await only([user, shell({ result: { exitCodeV2: 2 } })]);
    const { errorLines } = capture(store.transcript(session), 'x');
    expect(errorLines.map((e) => e.line)).toEqual(['Exit code 2']);
    store.close();
  });
});
