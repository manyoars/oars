import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { books, measure } from './query.js';
import { harnessOf, type SessionObservation } from './schema.js';
import { deposit, loadStore, paths } from './store.js';
import { cleanup, composers, folders, NOW, stage, stageCursor } from './test-support.js';

afterEach(cleanup);

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null;

const options = (allow: string[]) => ({ allow, redactDomains: [], now: () => NOW });

const staged = async () => {
  const s = stage();
  const { repo, plain } = folders(s.root);
  const user = await stageCursor(s.root, composers(repo, plain));
  return { ...s, user, runtime: { ...s.runtime, cursorRoot: user } };
};

describe('depositing the Cursor source', () => {
  it('captures each composer session as a cursor-harness session, and a second deposit adds nothing', async () => {
    const s = await staged();
    const first = await deposit(s.runtime, options(['cursor']));
    expect(first).toMatchObject({ cursor: 3, sessions: 3, unchanged: 0 });
    const store = await loadStore(s.storeDir);
    expect(store.sessions.map((session) => [session.session, harnessOf(session)]).sort()).toEqual([
      ['cursor-agent', 'cursor'],
      ['cursor-chat', 'cursor'],
      ['cursor-loose', 'cursor'],
    ]);
    const log = readFileSync(paths(s.storeDir).observations, 'utf8');
    const second = await deposit(s.runtime, options(['cursor']));
    expect(second).toMatchObject({ cursor: 0, sessions: 0, unchanged: 3 });
    expect(readFileSync(paths(s.storeDir).observations, 'utf8')).toBe(log);
    const state: unknown = JSON.parse(readFileSync(paths(s.storeDir).state, 'utf8'));
    const tracked = isRecord(state) && isRecord(state.files) ? state.files : {};
    expect(Object.keys(tracked).sort()).toEqual(['cursor/agent', 'cursor/chat', 'cursor/loose']);
    expect(tracked['cursor/agent']).toMatchObject({ size: 5, mtimeMs: Date.parse('2025-03-02T09:30:00Z') });
  });

  it('puts a session in the project slug of its workspace folder and a loose one under cursor', async () => {
    const s = await staged();
    await deposit(s.runtime, options(['cursor']));
    const projects = Object.fromEntries((await loadStore(s.storeDir)).sessions.map((session) => [session.session, session.project]));
    expect(projects['cursor-agent']).toMatch(/work-app$/);
    expect(projects['cursor-loose']).toBe('cursor');
  });

  it('does not read the store unless --allow names cursor', async () => {
    const s = await staged();
    expect(await deposit(s.runtime, options(['nothing-here']))).toMatchObject({ cursor: 0, sessions: 0 });
    expect(await deposit(s.runtime, options(['*']))).toMatchObject({ cursor: 3 });
  });

  it('skips silently when Cursor is absent or the runtime names no store', async () => {
    const s = stage();
    expect(await deposit({ ...s.runtime, cursorRoot: s.root }, options(['cursor']))).toMatchObject({ cursor: 0, unchanged: 0 });
    expect(await deposit(s.runtime, options(['cursor']))).toMatchObject({ cursor: 0 });
  });

  it('captures a session again when Cursor writes it after the deposit', async () => {
    const s = await staged();
    await deposit(s.runtime, options(['cursor']));
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(`${s.user}/globalStorage/state.vscdb`);
    const row = db.prepare("select cast(value as text) as v from cursorDiskKV where key = 'composerData:chat'").get();
    const parsed: unknown = JSON.parse(String(row?.v));
    const composer = isRecord(parsed) ? parsed : {};
    composer.lastUpdatedAt = Number(composer.lastUpdatedAt) + 1000;
    db.prepare("update cursorDiskKV set value = ? where key = 'composerData:chat'").run(JSON.stringify(composer));
    db.close();
    const again = await deposit(s.runtime, { ...options(['cursor']), now: () => NOW + 1 });
    expect(again).toMatchObject({ cursor: 1, unchanged: 2 });
    const highest = (await loadStore(s.storeDir)).sessions.filter((session) => session.session === 'cursor-chat');
    expect(highest).toHaveLength(1);
  });
});

describe('recall, books, and measure over Cursor skeletons', () => {
  it('books groups by harness, and a Claude Code session beside a Cursor one stays separate', async () => {
    const s = await staged();
    await deposit(s.runtime, options(['*']));
    const store = await loadStore(s.storeDir);
    const rows = books(store, 'harness', NOW);
    const claude = rows.find((row) => row.key === 'claude-code');
    const cursor = rows.find((row) => row.key === 'cursor');
    expect(cursor?.prompts).toBe(3);
    expect((claude?.prompts ?? 0) + (cursor?.prompts ?? 0)).toBe(store.prompts.length);
    expect(books(store, 'class', NOW).reduce((total, row) => total + row.prompts, 0)).toBe(store.prompts.length);
  });

  it('measure counts Cursor sessions in its window with no special case', async () => {
    const s = await staged();
    await deposit(s.runtime, options(['cursor']));
    const store = await loadStore(s.storeDir);
    const signal = measure(store, [], [], 5);
    expect(signal.last.sessions).toBe(3);
  });

  it('a session without a harness reads as Claude Code', () => {
    const bare: Pick<SessionObservation, 'harness'> = {};
    expect(harnessOf(bare)).toBe('claude-code');
  });
});
