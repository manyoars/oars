
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { cursorRoot, openCursorStore, type CursorSession } from './cursor.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import { cleanup, composers, folders, stage, stageCursor } from './test-support.js';

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
    expect(errorLines.map((e) => [e.tool, e.line])).toEqual([['Bash', 'exit code 1: 2 tests failed']]);
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
});
