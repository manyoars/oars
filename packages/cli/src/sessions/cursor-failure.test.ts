import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CursorSession, CursorStore } from './cursor.js';

// Both cases need `openCursorStore` to fail or misbehave in ways a real database cannot be made to, so the Cursor module is replaced.
vi.mock('./cursor.js', async (importOriginal) => ({ ...(await importOriginal<object>()), openCursorStore: vi.fn() }));

const { openCursorStore } = await import('./cursor.js');
const { readHookCalls } = await import('./hook-calls.js');
const { runHook } = await import('./hooks.js');
const { deposit, loadStore } = await import('./store.js');
const { cleanup, NOW, stage } = await import('./test-support.js');

afterEach(cleanup);

const opened = vi.mocked(openCursorStore);
const options = { allow: ['cursor'], redactDomains: [], now: () => NOW };

const session = (composerId: string): CursorSession => ({ composerId, folder: null, createdAt: 1, lastUpdatedAt: 2, messages: 1 });
const line = (text: string): string => `${JSON.stringify({ type: 'user', timestamp: '2026-06-02T00:00:00Z', message: { role: 'user', content: text } })}\n`;

describe('a Cursor read that fails after the store opened', () => {
  it('reports the store as unreadable, keeps the sessions read before it, and closes the database', async () => {
    const s = stage();
    const close = vi.fn();
    const transcript = vi.fn((target: CursorSession): string => {
      if (target.composerId === 'second') throw new Error('bubble read failed');
      return line('hello');
    });
    const store: CursorStore = { sessions: [session('first'), session('second')], transcript, rejected: 0, close };
    opened.mockResolvedValue(store);
    const result = await deposit({ ...s.runtime, cursorRoot: join(s.root, 'User') }, options);
    expect(result.cursorUnreadable).toHaveLength(1);
    expect(result.cursorUnreadable[0]).toContain('bubble read failed');
    expect(result).toMatchObject({ cursor: 1, sessions: 1 });
    expect((await loadStore(s.storeDir)).sessions.map((kept) => kept.session)).toEqual(['cursor-first']);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('a Cursor failure recorded by the nightly hook', () => {
  it('carries no home folder: the user name stays out of the hook-call error', async () => {
    const s = stage();
    opened.mockResolvedValueOnce(undefined);
    await deposit({ ...s.runtime, cursorRoot: join(s.root, 'User') }, options);
    opened.mockRejectedValueOnce(new Error(`EPERM: operation not permitted, open '${join(homedir(), 'AppData', 'Cursor', 'workspace.json')}'`));
    await runHook('nightly', '', { ...s.runtime, cursorRoot: join(s.root, 'User') }, () => NOW);
    const [call] = await readHookCalls(s.storeDir);
    expect(call?.hit).toBe(true);
    expect(call?.error).toContain('<home>');
    expect(call?.error).not.toContain(homedir());
  });
});
